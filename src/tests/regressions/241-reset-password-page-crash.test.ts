/**
 * Regression test for issue #241 (bug 3): visiting `/reset-password?token=...`
 * crashed with "Application error" in production. Server logs showed:
 *   "Attempted to call resetPasswordMode() from the server but
 *    resetPasswordMode is on the client"
 *
 * Root cause: `resetPasswordMode` was defined and exported from
 * `reset-password-form.tsx`, a `"use client"` module, and called directly
 * (not rendered as JSX) from the Server Component
 * `src/app/(auth)/reset-password/page.tsx`. React Server Components turns
 * every export of a `"use client"` file into a client reference when
 * consumed by server code -- calling one directly throws at request time.
 *
 * Fix: `resetPasswordMode` now lives in `src/lib/auth/reset-password-mode.ts`,
 * a plain module with no `"use client"` directive, importable from both the
 * server route and the client form.
 *
 * This test guards both the function's behavior and the module boundary
 * that caused the crash, so a future refactor can't silently reintroduce
 * the client-file export + server-side call pattern.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resetPasswordMode } from "@/lib/auth/reset-password-mode";

describe("resetPasswordMode", () => {
    it("is 'set' when a token is present and there is no error", () => {
        expect(resetPasswordMode("valid-token", undefined)).toBe("set");
    });

    it("is 'invalid' when there is no token", () => {
        expect(resetPasswordMode(undefined, undefined)).toBe("invalid");
    });

    it("is 'invalid' when better-auth signaled an error, even with a token", () => {
        expect(resetPasswordMode("some-token", "INVALID_TOKEN")).toBe(
            "invalid",
        );
    });
});

describe("resetPasswordMode module boundary", () => {
    const repoRoot = join(__dirname, "..", "..", "..");

    it('is not defined inside a "use client" module', () => {
        const source = readFileSync(
            join(repoRoot, "src/lib/auth/reset-password-mode.ts"),
            "utf-8",
        );
        expect(source.trimStart().startsWith('"use client"')).toBe(false);
    });

    it("the reset-password Server Component imports it from the shared module, not the client form", () => {
        const pageSource = readFileSync(
            join(repoRoot, "src/app/(auth)/reset-password/page.tsx"),
            "utf-8",
        );
        expect(pageSource).toContain('from "@/lib/auth/reset-password-mode"');
        // Guard against reintroducing the import from the "use client" form
        // file, which is what caused the production crash.
        const clientFormImportBlock = pageSource.match(
            /import\s*{[^}]*}\s*from\s*"@\/components\/auth\/reset-password-form";/,
        );
        expect(clientFormImportBlock).not.toBeNull();
        expect(clientFormImportBlock?.[0]).not.toContain("resetPasswordMode");
    });
});
