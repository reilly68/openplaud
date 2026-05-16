import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { requireApiSession } from "@/lib/auth-server";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { apiHandler } from "@/lib/errors";

type IdContext = { params: Promise<{ id: string }> };

export const POST = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id: recordingId } = await (context as IdContext).params;

    const [recording] = await db
        .select()
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);

    if (!recording) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [transcription] = await db
        .select()
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, session.user.id),
            ),
        )
        .limit(1);

    if (!transcription?.text) {
        return NextResponse.json(
            { error: "No transcription available" },
            { status: 422 },
        );
    }

    const transcriptionText = decryptText(transcription.text);
    const title = await generateTitleFromTranscription(
        session.user.id,
        transcriptionText,
    );

    if (!title) {
        return NextResponse.json(
            { error: "Title generation failed" },
            { status: 500 },
        );
    }

    await db
        .update(recordings)
        .set({ filename: encryptText(title), updatedAt: new Date() })
        .where(
            and(
                eq(recordings.id, recordingId),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        );

    return NextResponse.json({ title });
});
