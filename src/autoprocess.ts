/**
 * Auto-process worker — sync + transcribe + summarize new recordings.
 *
 * Runs as a background process inside the Docker container (started by
 * docker-entrypoint.sh alongside the Next.js server). Every 30 minutes:
 *   1. POST /api/plaud/sync  — pull new recordings from Plaud cloud
 *   2. Transcribe all recordings without a transcript (Whisper)
 *   3. Summarize all transcribed recordings without a summary (LLM)
 *
 * Uses Node.js http.request (not fetch) to avoid Bun's ~272 s timeout
 * ceiling on outbound HTTP calls. Session cookie is constructed from the
 * DB using HMAC-SHA256(token, BETTER_AUTH_SECRET) — no cookie file needed.
 */

import http from "http";

const WORKER_INTERVAL_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Session cookie helper
// ---------------------------------------------------------------------------

async function getSignedCookie(): Promise<string | null> {
    // Dynamic import so this file can be compiled standalone by Bun
    const { default: BunSql } = await import("bun:sql" as string);
    const db = new BunSql(process.env.DATABASE_URL!);
    try {
        const rows = await db`
            SELECT token, expires_at FROM sessions
            WHERE expires_at > NOW()
            ORDER BY expires_at DESC
            LIMIT 1
        `;
        if (!rows.length) return null;

        const token: string = rows[0].token;
        const secret = process.env.BETTER_AUTH_SECRET!;
        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
        );
        const sig = await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(token),
        );
        const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

        // Extend session if expiring within 60 days
        const expiresAt: Date | null = rows[0].expires_at;
        const daysLeft = expiresAt
            ? (expiresAt.getTime() - Date.now()) / 86_400_000
            : 999;
        if (daysLeft < 60) {
            await db`
                UPDATE sessions
                SET expires_at = NOW() + INTERVAL '365 days'
                WHERE token = ${token}
            `;
            console.log("[autoprocess] Session extended to 365 days");
        }

        return `better-auth.session_token=${encodeURIComponent(token + "." + sigB64)}`;
    } finally {
        await db.end();
    }
}

// ---------------------------------------------------------------------------
// Internal HTTP helper (bypasses Bun fetch timeout)
// ---------------------------------------------------------------------------

function httpPost(
    cookie: string,
    path: string,
    timeoutMs: number,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const body = "{}";
        const req = http.request(
            {
                hostname: "127.0.0.1",
                port: 3000,
                path,
                method: "POST",
                headers: {
                    Cookie: cookie,
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
                timeout: timeoutMs,
            },
            (res) => {
                let raw = "";
                res.on("data", (c: Buffer) => (raw += c));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(raw));
                    } catch {
                        reject(
                            new Error(
                                "JSON parse error: " + raw.slice(0, 120),
                            ),
                        );
                    }
                });
                res.on("error", reject);
            },
        );
        req.on("timeout", () =>
            req.destroy(new Error(`httpPost timeout after ${timeoutMs}ms`)),
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Main worker loop
// ---------------------------------------------------------------------------

async function runAutoProcess(): Promise<void> {
    console.log("[autoprocess] Starting...");
    let cookie: string | null;
    try {
        cookie = await getSignedCookie();
        if (!cookie) {
            console.log("[autoprocess] No valid session — skipping.");
            return;
        }
    } catch (e) {
        console.log(
            "[autoprocess] Cookie error:",
            e instanceof Error ? e.message : e,
        );
        return;
    }

    // Dynamic Bun SQL for queue queries
    const { default: BunSql } = await import("bun:sql" as string);
    const db = new BunSql(process.env.DATABASE_URL!);

    try {
        // 1. Sync new recordings from Plaud cloud
        try {
            const syncData = (await httpPost(
                cookie,
                "/api/plaud/sync",
                60_000,
            )) as { newRecordings?: number };
            console.log(
                `[autoprocess] Sync: ${syncData.newRecordings ?? "?"} new recordings`,
            );
        } catch (e) {
            console.log(
                "[autoprocess] Sync error:",
                e instanceof Error ? e.message : e,
            );
        }

        // 2. Transcribe recordings without a transcript
        const pendingTx = await db`
            SELECT r.id, r.duration FROM recordings r
            LEFT JOIN transcriptions t ON t.recording_id = r.id
            WHERE r.deleted_at IS NULL AND t.id IS NULL
            ORDER BY r.start_time ASC
        `;
        if (pendingTx.length > 0) {
            console.log(
                `[autoprocess] Transcription: ${pendingTx.length} recordings`,
            );
            for (const rec of pendingTx) {
                const durSec = Math.round((rec.duration ?? 0) / 1000);
                console.log(
                    `[autoprocess]   Transcribing ${rec.id} (${durSec}s)...`,
                );
                try {
                    // Timeout: 3× recording duration, min 2 min, max 2 h
                    const timeoutMs = Math.max(
                        120_000,
                        Math.min(7_200_000, (rec.duration ?? 300_000) * 3),
                    );
                    const data = (await httpPost(
                        cookie,
                        `/api/recordings/${rec.id}/transcribe`,
                        timeoutMs,
                    )) as { transcription?: string; error?: string };
                    if (data.transcription !== undefined) {
                        console.log(
                            `[autoprocess]   OK: ${rec.id} transcribed`,
                        );
                    } else {
                        console.log(
                            `[autoprocess]   ERR ${rec.id}:`,
                            JSON.stringify(data).slice(0, 100),
                        );
                    }
                } catch (e) {
                    console.log(
                        `[autoprocess]   ERR ${rec.id}:`,
                        e instanceof Error ? e.message : e,
                    );
                }
            }
        } else {
            console.log("[autoprocess] Transcription: nothing pending.");
        }

        // 3. Summarize transcribed recordings without a summary
        const pendingSum = await db`
            SELECT r.id FROM recordings r
            JOIN transcriptions t ON t.recording_id = r.id
            LEFT JOIN ai_enhancements a ON a.recording_id = r.id
            WHERE r.deleted_at IS NULL AND a.id IS NULL
            ORDER BY r.start_time ASC
        `;
        if (pendingSum.length > 0) {
            console.log(
                `[autoprocess] Summary: ${pendingSum.length} recordings`,
            );
            for (const rec of pendingSum) {
                console.log(`[autoprocess]   Summarizing ${rec.id}...`);
                try {
                    const data = (await httpPost(
                        cookie,
                        `/api/recordings/${rec.id}/summary`,
                        7_200_000,
                    )) as { summary?: string };
                    if (data.summary !== undefined) {
                        console.log(
                            `[autoprocess]   OK: ${rec.id} → ${String(data.summary).slice(0, 60)}`,
                        );
                    } else {
                        console.log(
                            `[autoprocess]   ERR ${rec.id}:`,
                            JSON.stringify(data).slice(0, 100),
                        );
                    }
                } catch (e) {
                    console.log(
                        `[autoprocess]   ERR ${rec.id}:`,
                        e instanceof Error ? e.message : e,
                    );
                }
            }
        } else {
            console.log("[autoprocess] Summary: nothing pending.");
        }
    } catch (e) {
        console.log(
            "[autoprocess] Unexpected error:",
            e instanceof Error ? e.message : e,
        );
    } finally {
        await db.end();
    }

    console.log("[autoprocess] Done.");
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

setTimeout(() => {
    runAutoProcess().catch((e) =>
        console.log("[autoprocess] Fatal:", e.message),
    );
    setInterval(() => {
        runAutoProcess().catch((e) =>
            console.log("[autoprocess] Fatal:", e.message),
        );
    }, WORKER_INTERVAL_MS);
}, STARTUP_DELAY_MS);

console.log("[autoprocess] Scheduled (start in 60s, interval 30min).");
