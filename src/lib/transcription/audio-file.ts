/**
 * Audio file construction for the server-side OpenAI-style transcription
 * path. Shared by both the sync worker (`transcribeRecording`) and the
 * manual `/api/recordings/[id]/transcribe` route so they cannot drift.
 *
 * Why this exists separately from the call sites:
 *   - Plaud audio lands on disk as `.mp3` (sync hardcodes the extension)
 *     but storage adapters or direct uploads can also produce `.opus`,
 *     `.ogg`, `.wav`, `.m4a`, etc. The OpenAI SDK uses the `File`'s name
 *     + content-type to decide how to label the multipart part, so
 *     getting both right matters for non-mp3 inputs.
 *   - We sniff the OGG magic bytes (`OggS`) so an audio body that's
 *     actually OGG but happens to be stored under another extension still
 *     gets the right content-type. Without this, a renamed file confuses
 *     OpenAI into a 400.
 *   - Everything else routes through the shared `getAudioMimeType` map
 *     (wav, m4a, mp4, flac, webm, aac, ...) so the manual upload path
 *     can transcribe a `.wav` direct upload without being misreported as
 *     opus.
 */

import { getAudioMimeType } from "@/lib/utils";

export interface BuildAudioFileResult {
    file: File;
    contentType: string;
}

/**
 * Detect OGG by magic bytes (`OggS`). All Plaud opus files we've seen
 * are actually OGG-Opus containers; sniffing the header is more reliable
 * than trusting the filename extension.
 */
function isOggContainer(audioBuffer: Buffer): boolean {
    if (audioBuffer.length < 4) return false;
    return (
        audioBuffer[0] === 0x4f && // O
        audioBuffer[1] === 0x67 && // g
        audioBuffer[2] === 0x67 && // g
        audioBuffer[3] === 0x53 // S
    );
}

/**
 * Detect RIFF container by magic bytes (`RIFF`). Some encoders produce
 * RIFF-wrapped audio (WAV or RIFF-MP3) even when the filename says `.mp3`.
 * Sending such a file as `audio/mpeg` makes ffmpeg fail with "invalid start
 * code ID3[4] in RIFF header"; labelling it as WAV lets ffmpeg parse the
 * RIFF container correctly.
 */
function isRiffContainer(audioBuffer: Buffer): boolean {
    if (audioBuffer.length < 4) return false;
    return (
        audioBuffer[0] === 0x52 && // R
        audioBuffer[1] === 0x49 && // I
        audioBuffer[2] === 0x46 && // F
        audioBuffer[3] === 0x46 // F
    );
}

/**
 * Build the `File` object passed to `openai.audio.transcriptions.create`.
 *
 * - `storagePath` is the on-disk path (used as an extension hint when the
 *   buffer is not OGG).
 * - `decryptedFilename` is the user-facing filename (already decrypted
 *   via `decryptText`). We append the correct extension if the title
 *   doesn't already carry one so providers that key off the filename
 *   get a clean hint.
 */
export function buildAudioFile(
    audioBuffer: Buffer,
    storagePath: string,
    decryptedFilename: string,
): BuildAudioFileResult {
    const isOgg = isOggContainer(audioBuffer);
    const isRiff = !isOgg && isRiffContainer(audioBuffer);

    const ext = isOgg
        ? "ogg"
        : isRiff
          ? "wav"
          : storagePath.split(".").pop()?.toLowerCase() || "mp3";

    // Trust magic bytes over path-derived guesses: OGG → audio/ogg,
    // RIFF → audio/wav (covers RIFF-wrapped MP3 and standard WAV),
    // otherwise delegate to the shared MIME map.
    const contentType = isOgg
        ? "audio/ogg"
        : isRiff
          ? "audio/wav"
          : getAudioMimeType(storagePath);

    const filename = decryptedFilename.match(/\.\w{2,4}$/)
        ? decryptedFilename
        : `${decryptedFilename}.${ext}`;

    // Zero-copy view over the existing Buffer. We can't pass the Buffer
    // straight to `new File([...])` because the DOM `BlobPart` type
    // requires `ArrayBufferView<ArrayBuffer>`, and Node's `Buffer.buffer`
    // is `ArrayBufferLike` (potentially `SharedArrayBuffer`). Node never
    // backs a `Buffer` with a `SharedArrayBuffer` in normal flows, so the
    // cast is safe and avoids the extra full-audio-buffer copy that the
    // previous `new Uint8Array(audioBuffer)` form caused.
    const view = new Uint8Array(
        audioBuffer.buffer as ArrayBuffer,
        audioBuffer.byteOffset,
        audioBuffer.byteLength,
    );
    const file = new File([view], filename, {
        type: contentType,
    });

    return { file, contentType };
}
