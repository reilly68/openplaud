"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import { useSession } from "@/lib/auth-client";

/**
 * Identifies the current user to PostHog once their session resolves,
 * covering the case where a returning visitor's session is already
 * authenticated on page load (login/register forms only identify on
 * a fresh sign-in/sign-up). Resets on sign-out so the next session
 * starts fresh.
 */
export function PostHogIdentify() {
    const { data, isPending } = useSession();

    useEffect(() => {
        if (!posthog.__loaded || isPending) return;

        if (data?.user) {
            // Distinct id only -- no email/name person properties. Keeps
            // PostHog out of GDPR-deletion scope for account data; the
            // user's id already joins back to our DB for any investigation.
            posthog.identify(data.user.id);
        } else {
            posthog.reset();
        }
    }, [data, isPending]);

    return null;
}
