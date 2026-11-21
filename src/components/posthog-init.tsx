"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

interface PostHogInitProps {
    apiKey: string;
    uiHost: string;
}

/**
 * Calls `posthog.init()` once on mount. Only ever rendered by
 * `<PostHogAnalytics>` after the `IS_HOSTED` + `POSTHOG_KEY` gate has
 * already passed server-side -- `apiKey` is never empty here.
 */
export function PostHogInit({ apiKey, uiHost }: PostHogInitProps) {
    useEffect(() => {
        if (posthog.__loaded) return;

        posthog.init(apiKey, {
            api_host: "/psthg",
            ui_host: uiHost,
            defaults: "2026-01-30",
            capture_exceptions: true,
            debug: process.env.NODE_ENV === "development",
        });
    }, [apiKey, uiHost]);

    return null;
}
