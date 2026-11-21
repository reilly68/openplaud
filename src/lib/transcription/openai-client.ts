import { OpenAI } from "openai";
import { fetchTranscription } from "@/lib/transcription/fetch";

interface TranscriptionClientOptions {
    apiKey: string;
    baseURL?: string;
    timeoutMs: number;
}

// Bare NaN / Infinity in value position (after `:`, `,` or `[`). Python's
// `json.dumps` emits these by default (`allow_nan=True`).
const NON_FINITE_JSON_VALUE = /([:,[]\s*)(?:NaN|-?Infinity)(?=\s*[,\]}])/g;

/**
 * Fork: replace non-standard NaN / Infinity tokens with `null`.
 *
 * Self-hosted Whisper servers written in Python (pascal's MLX server) return
 * `"avg_logprob": NaN` for segments decoded on a temperature fallback. That
 * is not valid JSON, so the OpenAI SDK fails with "Failed to parse JSON" and
 * the recording can never be transcribed. Only those numeric segment stats
 * are affected; the transcript text itself is untouched in practice.
 */
export function sanitizeNonFiniteJson(body: string): string {
    return body.replace(NON_FINITE_JSON_VALUE, "$1null");
}

/**
 * Wrap a provider response so `json()` tolerates NaN / Infinity. Lazy: the
 * body is only read when the SDK parses it, so streaming, deadlines and
 * aborts behave exactly as with the original response.
 */
function withFiniteJson(response: Response): Response {
    return new Proxy(response, {
        get(target, prop) {
            if (prop === "json") {
                return async () =>
                    JSON.parse(sanitizeNonFiniteJson(await target.text()));
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

/** Create an OpenAI-compatible client for long-running audio transcription. */
export function createTranscriptionClient({
    apiKey,
    baseURL,
    timeoutMs,
}: TranscriptionClientOptions): OpenAI {
    return new OpenAI({
        apiKey,
        baseURL,
        timeout: timeoutMs,
        maxRetries: 0,
        fetch: async (input, init) =>
            withFiniteJson(
                await fetchTranscription(input, init ?? {}, timeoutMs),
            ),
    });
}
