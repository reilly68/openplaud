/**
 * makeNodeFetch — Node.js http.request-based fetch replacement.
 *
 * Bun 1.x has a hard ~272 s timeout on its built-in `fetch`. Whisper
 * transcription of a 60-minute audio file takes 10-20 minutes; LLM summary
 * of the resulting transcript can take several more minutes. Both calls easily
 * exceed 272 s, which makes Bun kill the connection before the server
 * responds.
 *
 * Node.js `http.request` / `https.request` have no such built-in timeout
 * ceiling (the `timeout` option is idle-data timeout, not a wall-clock cap).
 * Returning it as a drop-in `fetch`-compatible function and passing it to
 * `new OpenAI({ fetch: makeNodeFetch() })` bypasses Bun's limit entirely.
 *
 * Additional responsibility: sanitise NaN literals in JSON responses.
 * MLX Whisper occasionally emits `"avg_logprob": NaN` in its verbose_json
 * output. JSON.parse rejects that as invalid syntax, crashing the transcription
 * route. We replace `: NaN` → `: null` in the raw response body before
 * handing it to the SDK's JSON parser.
 */

import http from "node:http";
import https from "node:https";

const TWO_HOURS_MS = 7_200_000;

export function makeNodeFetch(timeoutMs = TWO_HOURS_MS): typeof fetch {
    return async function nodeFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        const urlStr =
            input instanceof URL
                ? input.href
                : typeof input === "string"
                  ? input
                  : (input as Request).url;

        const parsed = new URL(urlStr);
        const isHttps = parsed.protocol === "https:";
        const transport = isHttps ? https : http;

        // Resolve body and content-type for both JSON and multipart/form-data
        let bodyBuf: Buffer | null = null;
        let contentType: string | undefined;

        const existingHeaders = (init?.headers ?? {}) as Record<string, string>;

        if (init?.body != null) {
            const body = init.body;
            if (
                body !== null &&
                typeof body === "object" &&
                typeof (body as FormData).entries === "function"
            ) {
                // FormData — used by OpenAI SDK for /v1/audio/transcriptions
                const fd = body as FormData;
                const boundary = `openplaud${Date.now().toString(16)}`;
                const parts: Buffer[] = [];
                for (const [key, value] of fd.entries()) {
                    if (typeof value === "string") {
                        parts.push(
                            Buffer.from(
                                `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
                            ),
                        );
                    } else {
                        const fileLike = value as File;
                        const ab = await fileLike.arrayBuffer();
                        parts.push(
                            Buffer.from(
                                `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${fileLike.name || key}"\r\nContent-Type: ${fileLike.type || "application/octet-stream"}\r\n\r\n`,
                            ),
                        );
                        parts.push(Buffer.from(ab));
                        parts.push(Buffer.from("\r\n"));
                    }
                }
                parts.push(Buffer.from(`--${boundary}--\r\n`));
                bodyBuf = Buffer.concat(parts);
                contentType = `multipart/form-data; boundary=${boundary}`;
            } else {
                bodyBuf = Buffer.from(body as string);
                contentType =
                    existingHeaders["content-type"] ?? "application/json";
            }
        }

        const reqHeaders: Record<string, string> = { ...existingHeaders };
        if (contentType) reqHeaders["content-type"] = contentType;
        if (bodyBuf) reqHeaders["content-length"] = String(bodyBuf.length);
        // Remove content-type header that would conflict with our boundary
        delete reqHeaders["Content-Type"];

        return new Promise<Response>((resolve, reject) => {
            const req = transport.request(
                {
                    hostname: parsed.hostname,
                    port: parsed.port
                        ? Number(parsed.port)
                        : isHttps
                          ? 443
                          : 80,
                    path: parsed.pathname + parsed.search,
                    method: (init?.method ?? "GET").toUpperCase(),
                    headers: reqHeaders,
                    timeout: timeoutMs,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (chunk: Buffer) => chunks.push(chunk));
                    res.on("end", () => {
                        let raw = Buffer.concat(chunks).toString("utf8");
                        // Sanitise invalid JSON values emitted by some Whisper
                        // servers (e.g. MLX Whisper emits NaN in avg_logprob).
                        raw = raw.replace(/:\s*NaN\b/g, ": null");
                        const responseHeaders: Record<string, string> = {};
                        for (const [k, v] of Object.entries(res.headers)) {
                            if (typeof v === "string") responseHeaders[k] = v;
                            else if (Array.isArray(v))
                                responseHeaders[k] = v.join(", ");
                        }
                        resolve(
                            new Response(raw, {
                                status: res.statusCode ?? 200,
                                headers: responseHeaders,
                            }),
                        );
                    });
                    res.on("error", reject);
                },
            );

            req.on("timeout", () =>
                req.destroy(
                    new Error(`nodeFetch timeout after ${timeoutMs}ms`),
                ),
            );
            req.on("error", reject);

            if (bodyBuf) req.write(bodyBuf);
            req.end();
        });
    };
}
