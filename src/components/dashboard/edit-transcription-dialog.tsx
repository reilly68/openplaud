"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { MetalButton } from "@/components/metal-button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface EditTranscriptionDialogProps {
    recordingId: string;
    initialText: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: (text: string) => void;
}

export function EditTranscriptionDialog({
    recordingId,
    initialText,
    open,
    onOpenChange,
    onSaved,
}: EditTranscriptionDialogProps) {
    const [text, setText] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (open) setText(initialText);
    }, [open, initialText]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!text.trim()) {
            toast.error("Transcript cannot be empty");
            return;
        }

        setIsLoading(true);
        try {
            const response = await fetch(
                `/api/recordings/${recordingId}/transcript`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: text.trim() }),
                },
            );

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(
                    (err as { error?: string }).error ?? "Failed to save",
                );
            }

            const data = (await response.json()) as {
                transcription: { text: string };
            };
            toast.success("Transcript updated");
            onSaved(data.transcription.text);
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save");
        } finally {
            setIsLoading(false);
        }
    };

    if (!open) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Edit transcript</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <Textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        disabled={isLoading}
                        className="min-h-[50vh] resize-y font-mono text-sm leading-relaxed"
                        autoFocus
                    />

                    <p className="text-xs text-muted-foreground">
                        Saving regenerates the summary from the corrected text.
                        A Whisper re-transcribe would overwrite these edits.
                    </p>

                    <div className="flex gap-2">
                        <MetalButton
                            type="button"
                            onClick={() => onOpenChange(false)}
                            disabled={isLoading}
                            className="flex-1"
                        >
                            Cancel
                        </MetalButton>
                        <MetalButton
                            type="submit"
                            disabled={isLoading}
                            className="flex-1"
                        >
                            {isLoading ? "Saving…" : "Save"}
                        </MetalButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
