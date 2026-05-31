import type {
    TranscriptionCreateParamsNonStreaming,
    TranscriptionDiarized,
    TranscriptionVerbose,
} from "openai/resources/audio/transcriptions";

export type ResponseFormat = "diarized_json" | "json" | "verbose_json";

/**
 * Pick the correct `response_format` for a given transcription model.
 *
 * - Models with "diarize" in the name support speaker-attributed output.
 * - gpt-4o models only accept plain "json" (not "verbose_json").
 * - Everything else (e.g. whisper-1) uses "verbose_json" which includes
 *   detected-language metadata.
 */
export function getResponseFormat(model: string): ResponseFormat {
    if (model.includes("diarize")) return "diarized_json";
    if (model.startsWith("gpt-4o")) return "json";
    return "verbose_json";
}

// Detects a self-describing "cleanup" preamble line. The cleanup LLM
// refers to itself ("vyčištěný přepis" / "cleaned transcript") -- the
// `CLEANUP_STEM` -- and lists what it changed. We require the stem plus
// at least two distinct change markers so a line of natural speech that
// merely contains e.g. "vyčistění" (a legit word) is never matched.
const CLEANUP_STEM = /vyči[sš]t|cleaned|cleanup/i;
const CLEANUP_MARKERS = [
    /halucinac|hallucinat/i,
    /interpunkc|punctuation/i,
    /nesrozumiteln|unintelligible|incomprehensibl/i,
    /opakuj|opaková|repetition|repeated/i,
    /rozpozn|\bASR\b|speech recognition/i,
    /logick\w*\s+odstavc|paragraph/i,
    /zachová|preserv|retain|kept/i,
    /\bfragment/i,
    /přepis|transcript/i,
];
const CLEANUP_SEPARATOR = /^\s*\*{3,}\s*$/;

function isCleanupMetaLine(line: string): boolean {
    if (!CLEANUP_STEM.test(line)) return false;
    let hits = 0;
    for (const m of CLEANUP_MARKERS) {
        if (m.test(line)) hits++;
        if (hits >= 2) return true;
    }
    return false;
}

/**
 * Strip leaked "cleanup" LLM meta-commentary from a transcript.
 *
 * The upstream transcription server runs an LLM cleanup pass (we send
 * `cleanup: "true"`). It occasionally emits a self-describing paragraph
 * ("Zde je vyčištěný přepis… odstraněny halucinace…", "Níže je vyčištěná
 * verze…", "Vyčistil jsem přepis…") sometimes followed by a `***`
 * separator. Because long audio is chunked and the chunks are
 * concatenated, such a block can land mid-transcript.
 *
 * We work line-by-line: drop any line that is a cleanup-meta paragraph,
 * plus an adjacent lone `***` delimiter. Anchored on the cleanup
 * self-reference + multiple change markers so legitimate content (incl. a
 * stray markdown `***` or a real word like "vyčistění") is untouched. We
 * intentionally do NOT span to the next `***`: a leaked block without its
 * own separator must not swallow the real text up to an unrelated one.
 *
 * The real fix lives in the transcription server's cleanup prompt; this
 * is a belt-and-suspenders guard against a nondeterministic LLM.
 */
export function stripCleanupArtifacts(text: string): string {
    const lines = text.split("\n");
    const keep = lines.map((line) => !isCleanupMetaLine(line));

    lines.forEach((line, i) => {
        if (!CLEANUP_SEPARATOR.test(line)) return;
        const adjacentRemoved =
            (i > 0 && !keep[i - 1]) ||
            (i > 1 && !keep[i - 2]) ||
            (i + 1 < lines.length && !keep[i + 1]) ||
            (i + 2 < lines.length && !keep[i + 2]);
        if (adjacentRemoved) keep[i] = false;
    });

    return lines
        .filter((_, i) => keep[i])
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Normalise the transcription response from any supported format into a
 * simple `{ text, detectedLanguage }` pair.
 */
export function parseTranscriptionResponse(
    transcription: unknown,
    responseFormat: ResponseFormat,
): { text: string; detectedLanguage: string | null } {
    if (responseFormat === "diarized_json") {
        const diarized = transcription as TranscriptionDiarized;
        const text = (diarized.segments ?? [])
            .map((seg) => `${seg.speaker}: ${seg.text}`)
            .join("\n");
        return { text: stripCleanupArtifacts(text), detectedLanguage: null };
    }

    if (responseFormat === "verbose_json") {
        const verbose = transcription as TranscriptionVerbose;
        return {
            text: stripCleanupArtifacts(verbose.text),
            detectedLanguage: verbose.language ?? null,
        };
    }

    // plain "json" — gpt-4o path
    const plain = transcription as { text?: string };
    const text =
        typeof transcription === "string" ? transcription : (plain.text ?? "");
    return { text: stripCleanupArtifacts(text), detectedLanguage: null };
}

/**
 * Build the parameter object passed to `openai.audio.transcriptions.create`.
 *
 * Centralised so the sync-worker path and the manual
 * `/api/recordings/[id]/transcribe` route cannot drift on required
 * parameters (issue #101 — `gpt-4o-transcribe-diarize` requires
 * `chunking_strategy`; OpenAI returns HTTP 400 without it).
 *
 * Rules encoded here:
 *  - When `response_format === "diarized_json"` we send
 *    `chunking_strategy: "auto"`. OpenAI rejects diarize requests that
 *    omit this field (documented as required for inputs >30s, in
 *    practice rejected for all diarize calls regardless of length).
 *  - `language` is only included when set. The SDK accepts it alongside
 *    diarize.
 */
export function buildTranscriptionParams(args: {
    file: File;
    model: string;
    responseFormat: ResponseFormat;
    language?: string;
}): TranscriptionCreateParamsNonStreaming & { cleanup: string } {
    const { file, model, responseFormat, language } = args;
    return {
        file,
        model,
        response_format: responseFormat,
        ...(responseFormat === "diarized_json"
            ? { chunking_strategy: "auto" as const }
            : {}),
        ...(language ? { language } : {}),
        cleanup: "true",
    };
}
