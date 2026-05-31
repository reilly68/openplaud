import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";

type IdContext = { params: Promise<{ id: string }> };

/**
 * Manually edit a recording's transcript text (correct Whisper errors,
 * rewrite paragraphs). The transcript is a single plaintext column
 * (encrypted at rest) -- no segment/timestamp bookkeeping -- so this is
 * a straight text replace.
 *
 * The write runs inside a transaction that takes a FOR UPDATE lock on the
 * parent recording, mirroring the transcribe worker
 * (src/lib/transcription/transcribe-recording.ts). That serializes this
 * edit against a concurrent Whisper re-transcribe or a delete tombstone,
 * so a manual edit can't interleave with an overwrite or resurrect a
 * tombstoned row.
 *
 * Sets `transcriptionType = "manual"` so the UI can warn that a Whisper
 * re-transcribe would discard the hand edits. Bumps `recordings.updatedAt`
 * like the transcribe/summary writers do.
 */
export const PATCH = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
    >;

    if (typeof body.text !== "string" || !body.text.trim()) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "text must be a non-empty string",
            400,
            { field: "text" },
        );
    }
    const text = body.text.trim();

    const updated = await db.transaction(async (tx) => {
        const [rec] = await tx
            .select({ deletedAt: recordings.deletedAt })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, session.user.id),
                ),
            )
            .for("update")
            .limit(1);
        if (!rec || rec.deletedAt) return null;

        const [row] = await tx
            .update(transcriptions)
            .set({ text: encryptText(text), transcriptionType: "manual" })
            .where(
                and(
                    eq(transcriptions.recordingId, id),
                    eq(transcriptions.userId, session.user.id),
                ),
            )
            .returning();
        if (!row) return null;

        await tx
            .update(recordings)
            .set({ updatedAt: new Date() })
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, session.user.id),
                ),
            );
        return row;
    });

    if (!updated) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording or transcription not found",
            404,
            { id },
        );
    }

    return NextResponse.json({
        transcription: { ...updated, text: decryptText(updated.text) },
    });
});
