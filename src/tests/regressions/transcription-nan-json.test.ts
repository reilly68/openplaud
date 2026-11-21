import { describe, expect, it } from "vitest";
import { sanitizeNonFiniteJson } from "@/lib/transcription/openai-client";

// pascal's Python Whisper server emits bare NaN in verbose_json segment
// stats (json.dumps allow_nan=True); the SDK then failed with
// "Failed to parse JSON" and the recording could never be transcribed.
describe("sanitizeNonFiniteJson", () => {
    it("turns NaN / Infinity values into null so JSON.parse succeeds", () => {
        const body =
            '{"text": "Dobrý den.", "segments": [{"tokens": [50365, 0, 50415], "temperature": 0.8, "avg_logprob": NaN, "compression_ratio": Infinity, "no_speech_prob": -Infinity}, [NaN, 1]]}';
        const parsed = JSON.parse(sanitizeNonFiniteJson(body));
        expect(parsed.text).toBe("Dobrý den.");
        expect(parsed.segments[0].avg_logprob).toBeNull();
        expect(parsed.segments[0].compression_ratio).toBeNull();
        expect(parsed.segments[0].no_speech_prob).toBeNull();
        expect(parsed.segments[0].temperature).toBe(0.8);
        expect(parsed.segments[1]).toEqual([null, 1]);
    });

    it("leaves valid JSON and NaN inside strings untouched", () => {
        const body = '{"text": "NaN Infinity: NaN", "avg_logprob": -0.21}';
        expect(sanitizeNonFiniteJson(body)).toBe(body);
    });
});

describe("createTranscriptionClient with a NaN-emitting provider", () => {
    it("parses verbose_json containing NaN", async () => {
        const { vi } = await import("vitest");
        const { createTranscriptionClient } = await import(
            "@/lib/transcription/openai-client"
        );
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockImplementation(
                    async () =>
                        new Response(
                            '{"text": "Ahoj", "language": "cs", "segments": [{"avg_logprob": NaN}]}',
                            { headers: { "content-type": "application/json" } },
                        ),
                ),
        );
        const client = createTranscriptionClient({
            apiKey: "k",
            baseURL: "http://localhost:9876/v1",
            timeoutMs: 60_000,
        });
        const result = await client.audio.transcriptions.create({
            file: new File(["audio"], "a.mp3", { type: "audio/mpeg" }),
            model: "whisper-large-v3",
            response_format: "verbose_json",
        });
        expect(result.text).toBe("Ahoj");
        vi.unstubAllGlobals();
    });
});
