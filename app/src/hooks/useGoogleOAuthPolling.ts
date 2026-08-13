import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';

export interface GoogleAccountInfo {
    account_email: string | null;
    connected: boolean;
    client_configured: boolean;
    client_id: string | null;
    client_secret: string | null;
}

interface GoogleOAuthPollResult {
    done: boolean;
    success: boolean;
    account_email?: string | null;
    error?: string | null;
}

/**
 * Drives the loopback Google OAuth flow: starts it (opens the consent page
 * in the system browser), then polls every 3s until the backend's one-shot
 * listener reports success/failure/timeout/cancel — the exact same
 * start-then-poll shape already used for Telegram QR login in
 * `AuthWizard.tsx`, extracted here so both `AuthWizard` and the Settings
 * "Google Account" tab can drive the same flow without duplicating it.
 */
export function useGoogleOAuthPolling(onConnected: (accountEmail: string | null) => void) {
    const [polling, setPolling] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const start = useCallback(async (): Promise<boolean> => {
        setError(null);
        try {
            const url = await invoke<string>('cmd_google_oauth_start');
            await open(url);
            setPolling(true);
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return false;
        }
    }, []);

    const cancel = useCallback(async () => {
        setPolling(false);
        try {
            await invoke('cmd_google_oauth_cancel');
        } catch {
            // non-critical
        }
    }, []);

    useEffect(() => {
        if (!polling) {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
            return;
        }

        pollRef.current = setInterval(async () => {
            try {
                const res = await invoke<GoogleOAuthPollResult>('cmd_google_oauth_poll');
                if (res.done) {
                    setPolling(false);
                    if (res.success) {
                        onConnected(res.account_email ?? null);
                    } else {
                        setError(res.error ?? 'Google sign-in failed.');
                    }
                }
                // done === false means still waiting — keep polling.
            } catch {
                // Polling error — keep trying silently.
            }
        }, 3000);

        return () => {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [polling]);

    return { polling, error, setError, start, cancel };
}
