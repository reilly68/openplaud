/**
 * `resetPasswordMode` lets both the `/reset-password` server route and the
 * client `ResetPasswordForm` compute the same "set" | "invalid" state from
 * the same `(token, error)` pair, so title/subtitle/UI never drift.
 *
 * This has no `"use client"` directive and no React/DOM dependency --
 * deliberately so it can be imported directly from a Server Component.
 * Exports from a `"use client"` module become client references when
 * consumed by server code; calling one directly (rather than rendering it
 * as JSX) throws at request time ("Attempted to call ... from the server
 * but ... is on the client"). This function used to live in
 * `reset-password-form.tsx` (a `"use client"` file) and was called
 * directly from `reset-password/page.tsx` (a Server Component), which hit
 * exactly that failure in production (issue #241, bug 3).
 */
export function resetPasswordMode(
    token: string | undefined,
    error: string | undefined,
): "set" | "invalid" {
    if (!token || error) return "invalid";
    return "set";
}
