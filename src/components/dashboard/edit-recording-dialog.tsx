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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Recording } from "@/types/recording";

interface EditRecordingDialogProps {
    recording: Recording;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: (updated: Pick<Recording, "id" | "filename" | "startTime">) => void;
}

export function EditRecordingDialog({
    recording,
    open,
    onOpenChange,
    onSaved,
}: EditRecordingDialogProps) {
    const [filename, setFilename] = useState("");
    const [startTime, setStartTime] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (open) {
            setFilename(recording.filename);
            // datetime-local input expects "YYYY-MM-DDTHH:MM" (local time, no seconds/Z)
            const d = new Date(recording.startTime);
            const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 16);
            setStartTime(local);
        }
    }, [open, recording]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!filename.trim()) {
            toast.error("Název nemůže být prázdný");
            return;
        }

        setIsLoading(true);
        try {
            const response = await fetch(`/api/recordings/${recording.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filename: filename.trim(),
                    startTime: new Date(startTime).toISOString(),
                }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(
                    (err as { error?: string }).error ?? "Uložení selhalo",
                );
            }

            const data = (await response.json()) as {
                recording: Recording;
            };
            toast.success("Nahrávka uložena");
            onSaved({
                id: data.recording.id,
                filename: data.recording.filename,
                startTime: data.recording.startTime,
            });
            onOpenChange(false);
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : "Uložení selhalo",
            );
        } finally {
            setIsLoading(false);
        }
    };

    if (!open) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Upravit nahrávku</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="edit-filename">Název</Label>
                        <Input
                            id="edit-filename"
                            type="text"
                            value={filename}
                            onChange={(e) => setFilename(e.target.value)}
                            disabled={isLoading}
                            autoFocus
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="edit-starttime">Datum a čas</Label>
                        <Input
                            id="edit-starttime"
                            type="datetime-local"
                            value={startTime}
                            onChange={(e) => setStartTime(e.target.value)}
                            disabled={isLoading}
                        />
                    </div>

                    <div className="flex gap-2">
                        <MetalButton
                            type="button"
                            onClick={() => onOpenChange(false)}
                            disabled={isLoading}
                            className="flex-1"
                        >
                            Zrušit
                        </MetalButton>
                        <MetalButton
                            type="submit"
                            disabled={isLoading}
                            className="flex-1"
                        >
                            {isLoading ? "Ukládám…" : "Uložit"}
                        </MetalButton>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
