/**
 * Regression: Plaud account migrated to another regional server.
 *
 * Observed live 2026-06/07 (mernas deploy): Plaud moved the account from
 * the global server to EU (api-euc1). The stored api_base kept pointing at
 * api.plaud.ai, which now answers every authenticated call with HTTP 200
 * and `{status: -302, msg: "user region mismatch", data: {domains: {...}}}`.
 * The workspace-token mint failed the same way, the client fell back to
 * the user token, and sync reported "0 new recordings" — silently — for
 * nine days.
 *
 * The fix: PlaudClient detects the -302 envelope on any authenticated
 * request, validates the advertised `data.domains.api` against the
 * plaud.ai allowlist, resets its workspace-token state, and replays the
 * request against the new base. `currentApiBase` exposes the healed base
 * so sync/transcription paths persist it back to plaud_connections.
 */

import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

// Mock env so importing PlaudClient (which transitively imports env via
// the proxy module) doesn't trip the DATABASE_URL/ENCRYPTION_KEY runtime
// checks. WEBSHARE_API_KEY is left undefined so plaudFetch falls through
// to the direct path.
const mockEnv = vi.hoisted(() => ({
    WEBSHARE_API_KEY: undefined as string | undefined,
}));

vi.mock("@/lib/env", () => ({
    env: mockEnv,
}));

import { PlaudClient } from "../../lib/plaud/client";

const OLD_BASE = "https://api.plaud.ai";
const NEW_BASE = "https://api-euc1.plaud.ai";
const WORKSPACE_ID = "ws_test123";

const redirectBody = {
    status: -302,
    msg: "user region mismatch",
    data: { domains: { api: NEW_BASE } },
};

function jsonResponse(body: unknown): {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
} {
    return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
    };
}

const originalFetch = global.fetch;
let mockFetch: Mock;

beforeAll(() => {
    mockFetch = vi.fn() as Mock;
    global.fetch = mockFetch as typeof global.fetch;
});

afterAll(() => {
    global.fetch = originalFetch;
});

beforeEach(() => {
    mockFetch.mockReset();
});

describe("PlaudClient region-switch auto-heal", () => {
    it("follows -302, re-mints WT on the new base, replays request", async () => {
        const client = new PlaudClient("UT-token", OLD_BASE, WORKSPACE_ID);

        const recordings = {
            status: 0,
            msg: "success",
            data_file_total: 1,
            data_file_list: [{ id: "rec-1" }],
        };

        // 1. WT mint on the old base → -302 (stale → relist)
        mockFetch.mockResolvedValueOnce(jsonResponse(redirectBody));
        // 2. workspace relist on the old base → -302 (throws → UT fallback)
        mockFetch.mockResolvedValueOnce(jsonResponse(redirectBody));
        // 3. GET /file/simple/web on the old base → -302 → heal + retry
        mockFetch.mockResolvedValueOnce(jsonResponse(redirectBody));
        // 4. WT mint on the NEW base → success
        mockFetch.mockResolvedValueOnce(
            jsonResponse({
                status: 0,
                data: { workspace_token: "WT-new" },
            }),
        );
        // 5. GET /file/simple/web on the NEW base → recordings
        mockFetch.mockResolvedValueOnce(jsonResponse(recordings));

        const result = await client.getRecordings(0, 50);

        expect(result.data_file_list).toHaveLength(1);
        expect(client.currentApiBase).toBe(NEW_BASE);

        // The replayed request went to the new base with the fresh WT.
        const lastCall = mockFetch.mock.calls.at(-1);
        expect(String(lastCall?.[0])).toContain(
            `${NEW_BASE}/file/simple/web`,
        );
        expect(lastCall?.[1]?.headers?.Authorization).toBe("Bearer WT-new");
    });

    it("throws REGION_REDIRECT_LOOP when servers bounce forever", async () => {
        const client = new PlaudClient("UT-token", OLD_BASE, WORKSPACE_ID);

        // Every endpoint on every base keeps answering -302.
        mockFetch.mockImplementation(() =>
            Promise.resolve(jsonResponse(redirectBody)),
        );

        await expect(client.getRecordings(0, 50)).rejects.toThrow(
            "Too many region redirects",
        );
    });

    it("surfaces a -302 without a target as a loud error", async () => {
        const client = new PlaudClient("UT-token", OLD_BASE, WORKSPACE_ID);

        const bareRedirect = { status: -302, msg: "user region mismatch" };
        mockFetch.mockImplementation(() =>
            Promise.resolve(jsonResponse(bareRedirect)),
        );

        await expect(client.getRecordings(0, 50)).rejects.toThrow(
            "user region mismatch",
        );
    });

    it("rejects a -302 pointing outside plaud.ai (SSRF guard)", async () => {
        const client = new PlaudClient("UT-token", OLD_BASE, WORKSPACE_ID);

        const evilRedirect = {
            status: -302,
            msg: "user region mismatch",
            data: { domains: { api: "https://evil.example.com" } },
        };
        mockFetch.mockImplementation(() =>
            Promise.resolve(jsonResponse(evilRedirect)),
        );

        await expect(client.getRecordings(0, 50)).rejects.toThrow(
            "user region mismatch",
        );
        expect(client.currentApiBase).toBe(OLD_BASE);
    });
});
