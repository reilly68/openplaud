"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CommandPalette } from "@/components/dashboard/command-palette";
import {
    RecordingList,
    type RecordingListHandle,
} from "@/components/dashboard/recording-list";
import { ShortcutsDialog } from "@/components/dashboard/shortcuts-dialog";
import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import { WorkstationEmptyState } from "@/components/dashboard/workstation-empty-state";
import { WorkstationHeader } from "@/components/dashboard/workstation-header";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { useAutoSync } from "@/hooks/use-auto-sync";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { useTheme } from "@/hooks/use-theme";
import { useTranscribeQueue } from "@/hooks/use-transcribe-queue";
import { useUploadQueue } from "@/hooks/use-upload-queue";
import {
    requestNotificationPermission,
    showNewRecordingNotification,
    showSyncCompleteNotification,
} from "@/lib/notifications/browser";
import type { InitialSettings } from "@/lib/settings/initial-settings";
import { SYNC_CONFIG } from "@/lib/sync-config";
import { cn } from "@/lib/utils";
import type { Recording } from "@/types/recording";

interface TranscriptionData {
    text?: string;
    language?: string;
    transcriptionType?: string;
}

interface Provider {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    createdAt: Date;
}

const EMPTY_PROVIDERS: Provider[] = [];

interface WorkstationProps {
    recordings: Recording[];
    transcriptions: Map<string, TranscriptionData>;
    /**
     * When true, an admin shortcut appears in the avatar menu. Set by
     * the server-rendered page based on env.ADMIN_EMAILS membership;
     * never trusted client-side -- the actual /admin gate runs
     * server-side.
     */
    isAdmin?: boolean;
    /**
     * Logged-in user's email. Passed down to the avatar menu for the
     * identity block. Server-supplied -- never derive from any client
     * state, which would risk a stale or attacker-influenced value.
     */
    userEmail?: string | null;
    initialSettings: InitialSettings;
    /**
     * True when running in OpenPlaud's hosted mode (`IS_HOSTED=true`).
     * Forwarded into SettingsDialog so hosted-only UI gating reflects
     * the deployment mode. Server-supplied; never derive client-side.
     * Required (no default) so a future caller can't silently regress
     * hosted-mode behavior by forgetting to thread the value through.
     */
    isHosted: boolean;
}

/**
 * Top-level dashboard component. Composition root for the recording
 * list, the detail pane (player + transcription), and the four
 * modals (CommandPalette, ShortcutsDialog, SettingsDialog,
 * OnboardingDialog).
 *
 * State ownership is split:
 *  - selection / mobile master-detail toggle live here
 *  - uploads -> useUploadQueue
 *  - transcribes -> useTranscribeQueue
 *  - sync loop -> useAutoSync
 *  - theme -> useTheme
 *  - keyboard nav -> useListKeyboardNav
 *  - deletes stay here because they need access to currentRecording
 *    / visibleRecordings to pick the next selection.
 */
export function Workstation({
    recordings,
    transcriptions,
    isAdmin = false,
    userEmail = null,
    initialSettings,
    isHosted,
}: WorkstationProps) {
    const { refresh } = useRouter();
    const [currentRecording, setCurrentRecording] = useState<Recording | null>(
        recordings.length > 0 ? recordings[0] : null,
    );
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [onboardingOpen, setOnboardingOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
    // Optimistic metadata edits (filename / startTime), keyed by id.
    // Applied on top of the server `recordings` prop so the list, detail
    // pane, and command palette all reflect an edit immediately. Cleared
    // per-id once the refreshed server data confirms the change.
    const [editedOverrides, setEditedOverrides] = useState<
        Map<string, Partial<Recording>>
    >(new Map());
    // Optimistic manual transcript edits, keyed by recordingId. Layered
    // on top of the server `transcriptions` prop so the detail pane and
    // list search reflect an edit immediately. Cleared per-id once the
    // refreshed server data confirms the new text.
    const [transcriptionOverrides, setTranscriptionOverrides] = useState<
        Map<string, string>
    >(new Map());
    // On <lg viewports the list and detail panes can't coexist -- we
    // toggle between them instead of stacking. Desktop ignores this
    // state entirely (both panes render via the grid).
    const [mobileView, setMobileView] = useState<"list" | "detail">("list");
    const [providers, setProviders] = useState<Provider[]>(EMPTY_PROVIDERS);

    const { theme, setTheme } = useTheme(initialSettings.theme);
    const listRef = useRef<RecordingListHandle>(null);

    // Filter out optimistically-hidden (deleted) rows, then layer on any
    // optimistic metadata edits so every consumer (list, detail pane,
    // command palette) sees the edit before the server refetch lands.
    const visibleRecordings = useMemo(() => {
        const base = recordings.filter((r) => !hiddenIds.has(r.id));
        if (editedOverrides.size === 0) return base;
        return base.map((r) => {
            const patch = editedOverrides.get(r.id);
            return patch ? { ...r, ...patch } : r;
        });
    }, [recordings, hiddenIds, editedOverrides]);

    // Layer optimistic transcript edits over the server-provided Map so
    // every consumer (detail pane, list search, command palette) sees a
    // manual edit before the refetch lands.
    const effectiveTranscriptions = useMemo(() => {
        if (transcriptionOverrides.size === 0) return transcriptions;
        const merged = new Map(transcriptions);
        for (const [id, text] of transcriptionOverrides) {
            const prev = merged.get(id);
            merged.set(id, {
                ...prev,
                text,
                transcriptionType: "manual",
            });
        }
        return merged;
    }, [transcriptions, transcriptionOverrides]);

    const currentTranscription = currentRecording
        ? effectiveTranscriptions.get(currentRecording.id)
        : undefined;

    // Keep currentRecording in sync with the recordings prop (updated
    // after refresh()). If the previously-selected recording is no
    // longer present (e.g. just deleted), clear the selection.
    useEffect(() => {
        setCurrentRecording((prev) => {
            if (!prev) return prev;
            const updated = recordings.find((r) => r.id === prev.id);
            return updated ?? null;
        });
        // When server data comes back, clear any optimistic hides whose
        // rows no longer exist server-side (deletion confirmed).
        setHiddenIds((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set<string>();
            const ids = new Set(recordings.map((r) => r.id));
            for (const id of prev) {
                if (ids.has(id)) next.add(id); // still present -> keep hidden until confirmed
            }
            return next.size === prev.size ? prev : next;
        });
        // Drop optimistic edit overrides once the refreshed server row
        // matches them (filename is decrypted server-side, startTime is an
        // ISO string -- both directly comparable to what we stored).
        setEditedOverrides((prev) => {
            if (prev.size === 0) return prev;
            const next = new Map(prev);
            for (const r of recordings) {
                const patch = next.get(r.id);
                if (!patch) continue;
                const filenameMatches =
                    patch.filename === undefined ||
                    patch.filename === r.filename;
                const startTimeMatches =
                    patch.startTime === undefined ||
                    patch.startTime === r.startTime;
                if (filenameMatches && startTimeMatches) next.delete(r.id);
            }
            return next.size === prev.size ? prev : next;
        });
    }, [recordings]);

    // Drop optimistic transcript overrides once the refreshed server Map
    // carries the same text (page.tsx decrypts before sending, so a plain
    // string compare is valid).
    useEffect(() => {
        setTranscriptionOverrides((prev) => {
            if (prev.size === 0) return prev;
            const next = new Map(prev);
            for (const [id, text] of prev) {
                if (transcriptions.get(id)?.text === text) next.delete(id);
            }
            return next.size === prev.size ? prev : next;
        });
    }, [transcriptions]);

    const {
        isAutoSyncing,
        lastSyncTime,
        nextSyncTime,
        lastSyncResult,
        manualSync,
    } = useAutoSync({
        interval: initialSettings.syncInterval ?? SYNC_CONFIG.defaultInterval,
        minInterval: SYNC_CONFIG.minInterval,
        syncOnMount: initialSettings.syncOnMount,
        syncOnVisibilityChange: initialSettings.syncOnVisibilityChange,
        enabled: initialSettings.autoSyncEnabled,
        onSuccess: (newRecordings) => {
            if (initialSettings.syncNotifications !== false) {
                if (newRecordings > 0) {
                    toast.success(
                        `Synced ${newRecordings} new recording${newRecordings !== 1 ? "s" : ""}`,
                    );
                } else {
                    toast.success("Sync complete - no new recordings");
                }
            }
            if (initialSettings.browserNotifications) {
                (async () => {
                    const granted = await requestNotificationPermission();
                    if (!granted) return;
                    if (newRecordings > 0) {
                        showNewRecordingNotification(newRecordings);
                    } else {
                        showSyncCompleteNotification();
                    }
                })();
            }
        },
        onError: (error) => {
            toast.error(error);
        },
    });

    const handleSync = useCallback(async () => {
        await manualSync();
    }, [manualSync]);

    // Settings dialog needs the provider list at open-time so the
    // Providers section seeds correctly. Fetching on open (rather
    // than on mount) avoids loading a list the user may never see.
    useEffect(() => {
        if (settingsOpen) {
            fetch("/api/settings/ai/providers")
                .then((res) => res.json())
                .then((data) => setProviders(data.providers || []))
                .catch(() => setProviders([]));
        }
    }, [settingsOpen]);

    const {
        isUploading,
        pendingUploads,
        uploadInputRef,
        handleUpload,
        triggerUpload,
    } = useUploadQueue({ onUploadComplete: refresh });

    const { inFlightActions, transcribeById } = useTranscribeQueue({
        onTranscribeComplete: refresh,
    });

    // Any transcribe in flight (across all recordings) blocks new
    // uploads. The previous `isTranscribing` boolean conflated "this
    // recording is being transcribed" with "some transcribe is
    // happening"; splitting them fixes a concurrency bug where two
    // pending transcribes would race each other's finally clauses.
    const anyTranscribing = Array.from(inFlightActions.values()).some(
        (kind) => kind === "transcribing",
    );
    const isCurrentTranscribing =
        currentRecording !== null &&
        inFlightActions.get(currentRecording.id) === "transcribing";
    const isProcessing = anyTranscribing || isUploading;

    const handleTranscribe = useCallback(async () => {
        if (!currentRecording) return;
        await transcribeById(currentRecording.id);
    }, [currentRecording, transcribeById]);

    const handleDelete = useCallback(
        async (recording: Recording) => {
            const id = recording.id;
            // Optimistic hide.
            setHiddenIds((prev) => new Set(prev).add(id));
            const wasCurrent = currentRecording?.id === id;
            if (wasCurrent) {
                const idx = visibleRecordings.findIndex((r) => r.id === id);
                const next =
                    visibleRecordings[idx + 1] ??
                    visibleRecordings[idx - 1] ??
                    null;
                setCurrentRecording(next);
            }
            try {
                const res = await fetch(`/api/recordings/${id}`, {
                    method: "DELETE",
                });
                if (!res.ok) throw new Error("Delete failed");
                toast.success("Recording deleted");
                refresh();
            } catch (err) {
                // Rollback
                setHiddenIds((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
                if (wasCurrent) setCurrentRecording(recording);
                throw err;
            }
        },
        [currentRecording, visibleRecordings, refresh],
    );

    // Apply a confirmed metadata edit (the PATCH already succeeded inside
    // the dialog). Optimistically layer it over the server data for the
    // list/detail/palette, update the open recording if it's the one
    // edited, then refetch so the override can reconcile away.
    const handleEdited = useCallback(
        (updated: Pick<Recording, "id" | "filename" | "startTime">) => {
            setEditedOverrides((prev) => {
                const next = new Map(prev);
                next.set(updated.id, {
                    filename: updated.filename,
                    startTime: updated.startTime,
                });
                return next;
            });
            setCurrentRecording((prev) =>
                prev && prev.id === updated.id ? { ...prev, ...updated } : prev,
            );
            refresh();
        },
        [refresh],
    );

    // Apply a saved manual transcript edit (the PATCH already succeeded in
    // the dialog). Layer it optimistically and refetch so the override can
    // reconcile away once server data confirms it.
    const handleTranscriptSaved = useCallback(
        (recordingId: string, text: string) => {
            setTranscriptionOverrides((prev) => {
                const next = new Map(prev);
                next.set(recordingId, text);
                return next;
            });
            refresh();
        },
        [refresh],
    );

    // Keyboard shortcuts (global). Disabled while any modal is open
    // so the modal owns keyboard focus exclusively. The shortcuts
    // dialog itself uses these very keys to navigate its rows.
    useListKeyboardNav({
        onNext: () => listRef.current?.next(),
        onPrev: () => listRef.current?.prev(),
        onFocusSearch: () => listRef.current?.focusSearch(),
        onOpenPalette: () => setPaletteOpen(true),
        onOpenShortcuts: () => setShortcutsOpen(true),
        onOpenSettings: () => setSettingsOpen(true),
        enabled:
            !settingsOpen && !onboardingOpen && !paletteOpen && !shortcutsOpen,
    });

    return (
        <>
            <div className="bg-background">
                <div className="container mx-auto max-w-7xl px-4 py-6">
                    <WorkstationHeader
                        isAdmin={isAdmin}
                        userEmail={userEmail}
                        initialTheme={initialSettings.theme}
                        lastSyncTime={lastSyncTime}
                        nextSyncTime={nextSyncTime}
                        isAutoSyncing={isAutoSyncing}
                        lastSyncResult={lastSyncResult}
                        onSync={handleSync}
                        isUploading={isUploading}
                        isProcessing={isProcessing}
                        uploadInputRef={uploadInputRef}
                        onTriggerUpload={triggerUpload}
                        onUploadInputChange={handleUpload}
                        onOpenPalette={() => setPaletteOpen(true)}
                        onOpenSettings={() => setSettingsOpen(true)}
                        onOpenShortcuts={() => setShortcutsOpen(true)}
                    />

                    {visibleRecordings.length === 0 &&
                    pendingUploads.length === 0 ? (
                        <WorkstationEmptyState
                            isSyncing={isAutoSyncing}
                            onSync={handleSync}
                            onUpload={triggerUpload}
                        />
                    ) : (
                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                            {/*
                              Mobile master/detail: on <lg, only one
                              pane renders at a time. `mobileView ===
                              "detail"` hides the list (via `hidden`)
                              while keeping its state mounted, so
                              scroll position, search query, and
                              selection survive the back-navigation.
                              The `lg:block` override brings the list
                              back on desktop where both panes coexist.
                            */}
                            <div
                                className={cn(
                                    "lg:col-span-1 lg:block",
                                    mobileView === "detail" && "hidden",
                                )}
                            >
                                <RecordingList
                                    ref={listRef}
                                    recordings={visibleRecordings}
                                    transcriptions={effectiveTranscriptions}
                                    currentRecording={currentRecording}
                                    pendingUploads={pendingUploads}
                                    inFlightActions={inFlightActions}
                                    onSelect={(r) => {
                                        setCurrentRecording(r);
                                        // Tapping a row on mobile
                                        // reveals the detail pane.
                                        // Desktop ignores this state.
                                        setMobileView("detail");
                                    }}
                                    onDelete={handleDelete}
                                    onEdited={handleEdited}
                                    initialDateTimeFormat={
                                        initialSettings.dateTimeFormat
                                    }
                                    initialSortOrder={
                                        initialSettings.recordingListSortOrder
                                    }
                                    initialDensity={initialSettings.listDensity}
                                    initialChunkSize={
                                        initialSettings.itemsPerPage
                                    }
                                />
                            </div>

                            <WorkstationDetailPane
                                currentRecording={currentRecording}
                                currentTranscription={currentTranscription}
                                isCurrentTranscribing={isCurrentTranscribing}
                                visibleRecordings={visibleRecordings}
                                onTranscribe={handleTranscribe}
                                onTranscriptSaved={handleTranscriptSaved}
                                onSelectRecording={setCurrentRecording}
                                onBackToList={() => setMobileView("list")}
                                hiddenOnMobile={mobileView === "list"}
                                initialPlaybackSpeed={
                                    initialSettings.defaultPlaybackSpeed
                                }
                                initialVolume={initialSettings.defaultVolume}
                                initialAutoPlayNext={
                                    initialSettings.autoPlayNext
                                }
                                scrubberStyle={initialSettings.playerScrubber}
                            />
                        </div>
                    )}
                </div>
            </div>

            <CommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                recordings={visibleRecordings}
                transcriptions={effectiveTranscriptions}
                currentRecording={currentRecording}
                inFlightActions={inFlightActions}
                currentTheme={theme}
                dateTimeFormat={initialSettings.dateTimeFormat}
                onSelectRecording={(r) => {
                    setCurrentRecording(r);
                    setMobileView("detail");
                }}
                onSync={handleSync}
                onUpload={triggerUpload}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenShortcuts={() => setShortcutsOpen(true)}
                onSetTheme={setTheme}
                onTranscribeRecording={transcribeById}
            />

            <ShortcutsDialog
                open={shortcutsOpen}
                onOpenChange={setShortcutsOpen}
            />

            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                initialProviders={providers}
                isHosted={isHosted}
                onReRunOnboarding={() => {
                    setSettingsOpen(false);
                    setOnboardingOpen(true);
                }}
            />

            <OnboardingDialog
                open={onboardingOpen}
                onOpenChange={setOnboardingOpen}
                onComplete={() => {
                    setOnboardingOpen(false);
                    refresh();
                }}
            />
        </>
    );
}
