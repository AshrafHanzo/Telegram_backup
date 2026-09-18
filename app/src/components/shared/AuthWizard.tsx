import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Key, Lock, ArrowRight, Settings, ShieldCheck, Sun, Moon, HelpCircle, ExternalLink, X, QrCode, Loader2, ChevronLeft, LogOut } from "lucide-react";
import { load } from '@tauri-apps/plugin-store';
import { useTheme } from '../../context/ThemeContext';
import { open } from '@tauri-apps/plugin-shell';
import { QRCodeSVG } from 'qrcode.react';
import { useGoogleOAuthPolling, GoogleAccountInfo } from '../../hooks/useGoogleOAuthPolling';
import { GoogleGlyph } from './GoogleGlyph';

import { useTranslation } from "react-i18next";

type Step = "setup" | "google-client-setup" | "google-connecting" | "phone" | "code" | "password" | "authenticator-code" | "authenticator-link";

interface DriveSyncPullResult {
    api_id: string | null;
    api_hash: string | null;
    has_app_lock: boolean;
    app_lock_email: string | null;
    encrypted_session: { nonce_b64: string; ciphertext_b64: string } | null;
}

function AuthThemeToggle() {
    const { theme, toggleTheme } = useTheme();
    return (
        <button
            onClick={toggleTheme}
            className="quiet-control absolute end-4 top-[calc(1rem+env(safe-area-inset-top,24px))] z-10 flex h-9 w-9 items-center justify-center border border-app-border bg-app-surface-raised text-app-text-secondary shadow-[var(--shadow-raised)] hover:text-app-text"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
            {theme === 'dark' ? (
                <Sun className="h-4 w-4" />
            ) : (
                <Moon className="h-4 w-4" />
            )}
        </button>
    );
}
export function AuthWizard({ onLogin }: { onLogin: () => void }) {
    const { t } = useTranslation();
    const isBrowser = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

    if (isBrowser) {
        return (
            <div className="auth-gradient flex h-full items-center justify-center p-6 text-center text-app-text">
              <div className="quiet-raised max-w-md p-6">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-container bg-app-danger/10">
                    <ShieldCheck className="h-6 w-6 text-app-danger" />
                </div>
                <h1 className="text-app-title font-semibold text-app-text">{t('auth.desktop_required')}</h1>
                <p className="mx-auto mt-2 max-w-sm text-ui leading-relaxed text-app-text-secondary">
                    {t('auth.desktop_required_desc')}
                </p>
                <div className="mt-5 rounded-control border border-app-border bg-app-surface-sunken/40 p-3 text-metadata text-app-text-secondary">
                    {t('auth.open_window_prompt')}
                </div>
              </div>
            </div>
        )
    }

    const [step, setStep] = useState<Step>("setup");
    const [loading, setLoading] = useState(false);

    const [apiId, setApiId] = useState("");
    const [apiHash, setApiHash] = useState("");

    const [phone, setPhone] = useState("");
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [floodWait, setFloodWait] = useState<number | null>(null);
    const [showHelp, setShowHelp] = useState(false);
    const [loginMethod, setLoginMethod] = useState<'phone' | 'qr'>('phone');
    const isMobile = typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent.toLowerCase());

    useEffect(() => {
        if (isMobile && loginMethod !== 'phone') {
            setLoginMethod('phone');
        }
    }, [isMobile, loginMethod]);
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [qrPolling, setQrPolling] = useState(false);
    const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // --- Google sign-in (Drive-synced api_id/api_hash) ---
    const [googleAccount, setGoogleAccount] = useState<GoogleAccountInfo | null>(null);
    const [googleClientId, setGoogleClientId] = useState("");
    const [googleClientSecret, setGoogleClientSecret] = useState("");

    // --- Authenticator (TOTP) — replaces redoing phone/code login on a
    // device that's already set up, by restoring a Drive-synced, TOTP-secret
    // -encrypted Telegram session instead. See commands/totp.rs. ---
    const [totpCode, setTotpCode] = useState("");
    const [totpSetupKey, setTotpSetupKey] = useState("");
    const [pendingCreds, setPendingCreds] = useState<{ apiId: string; apiHash: string } | null>(null);


    useEffect(() => {
        if (!floodWait) return;
        const interval = setInterval(() => {
            setFloodWait(prev => {
                if (prev === null || prev <= 1) return null;
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [floodWait]);

    useEffect(() => {
        const initStore = async () => {
            try {
                const store = await load('config.json');
                const savedId = await store.get<string>('api_id');
                const savedHash = await store.get<string>('api_hash');

                if (savedId && savedHash) {
                    setApiId(savedId);
                    setApiHash(savedHash);
                }
            } catch {
                // config not found, starting fresh
            }
        };
        initStore();
    }, []);

    const saveCredentials = async () => {
        try {
            const store = await load('config.json');
            await store.set('api_id', apiId);
            await store.set('api_hash', apiHash);
            await store.save();
        } catch {
            // store write failure, non-critical
        }
    };

    useEffect(() => {
        (async () => {
            try {
                const account = await invoke<GoogleAccountInfo>('cmd_get_google_account');
                setGoogleAccount(account);
            } catch {
                // Google sign-in is optional; leave it unset on failure.
            }
        })();
    }, []);

    const handleGoogleConnected = async (accountEmail: string | null) => {
        setGoogleAccount(prev => prev
            ? { ...prev, connected: true, account_email: accountEmail ?? prev.account_email }
            : { connected: true, account_email: accountEmail, client_configured: true, client_id: null, client_secret: null });
        try {
            const pull = await invoke<DriveSyncPullResult>('cmd_google_drive_sync_pull');
            if (pull.api_id && pull.api_hash) {
                setApiId(pull.api_id);
                setApiHash(pull.api_hash);
                setPendingCreds({ apiId: pull.api_id, apiHash: pull.api_hash });
                try {
                    const store = await load('config.json');
                    await store.set('api_id', pull.api_id);
                    await store.set('api_hash', pull.api_hash);
                    await store.save();
                } catch {
                    // non-critical
                }
            }

            // A synced encrypted session means a device somewhere already
            // completed a full phone/code login and set up the
            // authenticator — skip redoing that here entirely.
            if (pull.encrypted_session) {
                let totpEnabledLocally = false;
                try {
                    const status = await invoke<{ enabled: boolean }>('cmd_totp_status');
                    totpEnabledLocally = status.enabled;
                } catch {
                    // Treat as not-yet-linked on this device.
                }
                setStep(totpEnabledLocally ? 'authenticator-code' : 'authenticator-link');
                return;
            }

            setStep(pull.api_id && pull.api_hash ? 'phone' : 'setup');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStep('setup');
        }
    };

    // Fast path for a device that's already connected to Google this
    // session — skips replaying the OAuth popup and re-checks straight
    // from cache/Drive whether this device can restore via authenticator.
    const handleContinueWithAuthenticator = async () => {
        setLoading(true);
        setError(null);
        await handleGoogleConnected(googleAccount?.account_email ?? null);
        setLoading(false);
    };

    // Shared finish line for both authenticator paths: the session file has
    // already been restored to disk by the backend command that ran right
    // before this — now actually connect using it and, if that checks out,
    // let the user in without ever touching phone/code entry.
    const finalizeLoginAfterSessionRestore = async () => {
        const creds = pendingCreds ?? (apiId && apiHash ? { apiId, apiHash } : null);
        if (!creds) {
            setError('Missing API credentials — go back and use "Continue with Google" again.');
            return;
        }
        try {
            const idInt = parseInt(creds.apiId, 10);
            if (isNaN(idInt)) throw new Error('API ID must be a number');
            await invoke('cmd_connect', { apiId: idInt });
            const connected = await invoke<boolean>('cmd_check_connection');
            if (connected) {
                onLogin();
            } else {
                setError('The restored session could not be verified. Try "Continue with Google" instead to log in normally.');
                setStep('setup');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStep('setup');
        }
    };

    const handleVerifyAuthenticatorCode = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await invoke('cmd_totp_verify_and_restore_session', { code: totpCode.trim() });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
            return;
        }
        await finalizeLoginAfterSessionRestore();
        setLoading(false);
    };

    const handleLinkNewDevice = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            await invoke('cmd_totp_link_new_device', { setupKey: totpSetupKey.trim(), code: totpCode.trim() });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
            return;
        }
        await finalizeLoginAfterSessionRestore();
        setLoading(false);
    };

    const googleOauth = useGoogleOAuthPolling(handleGoogleConnected);

    // Surface the hook's own start/poll errors through the shared `error` banner.
    useEffect(() => {
        if (googleOauth.error) {
            setError(googleOauth.error);
            setStep('setup');
        }
    }, [googleOauth.error]);

    const startGoogleOAuth = async () => {
        setLoading(true);
        setError(null);
        const started = await googleOauth.start();
        setLoading(false);
        if (started) {
            setStep('google-connecting');
        }
    };

    const handleContinueWithGoogle = async () => {
        setError(null);
        setLoading(true);
        // Re-check fresh rather than trusting the background fetch from mount
        // — that fetch may not have resolved yet if this is clicked quickly
        // after the screen first appears, which would otherwise make an
        // already-configured client look unconfigured.
        let account = googleAccount;
        try {
            account = await invoke<GoogleAccountInfo>('cmd_get_google_account');
            setGoogleAccount(account);
        } catch {
            // Fall back to whatever we already had, if anything.
        }
        setLoading(false);
        if (!account?.client_configured) {
            setStep('google-client-setup');
            return;
        }
        await startGoogleOAuth();
    };

    const handleSaveGoogleClientAndContinue = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!googleClientId.trim() || !googleClientSecret.trim()) {
            setError('Both the Client ID and Client Secret are required.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const account = await invoke<GoogleAccountInfo>('cmd_set_google_oauth_client', {
                clientId: googleClientId.trim(),
                clientSecret: googleClientSecret.trim(),
            });
            setGoogleAccount(account);
            await startGoogleOAuth();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    const handleCancelGoogleOAuth = async () => {
        await googleOauth.cancel();
        setStep('setup');
    };

    const handleSetupSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (apiId.includes(' ') || apiHash.includes(' ')) {
            setError("API ID and API Hash cannot contain spaces. Please remove any spaces.");
            return;
        }

        if (!apiId || !apiHash) {
            setError("Both API ID and Hash are required.");
            return;
        }
        setError(null);
        await saveCredentials();
        if (googleAccount?.connected) {
            try {
                await invoke('cmd_google_drive_sync_push', {
                    apiId, apiHash, appLockEmail: null, appLockPasswordHash: null,
                });
            } catch {
                // Best-effort — a Drive sync hiccup shouldn't block logging in.
            }
        }
        setStep("phone");
        setLoginMethod('phone');
        setQrUrl(null);
        setQrPolling(false);
    };

    const handleQrLogin = async () => {
        setError(null);
        setLoading(true);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error("API ID must be a number");

            const url = await invoke<string>("cmd_auth_qr_login", {
                apiId: idInt,
                apiHash: apiHash
            });

            if (url === "__authorized__") {
                onLogin();
                return;
            }

            setQrUrl(url);
            setQrPolling(true);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    // QR polling effect
    useEffect(() => {
        if (!qrPolling) {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
            return;
        }

        qrPollRef.current = setInterval(async () => {
            try {
                const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_qr_poll");
                if (res.success) {
                    setQrPolling(false);
                    if (res.next_step === "password") {
                        setStep("password");
                    } else {
                        onLogin();
                    }
                }
                // If next_step === "waiting", keep polling
            } catch {
                // Polling error — keep trying silently
            }
        }, 3000);

        return () => {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
        };
    }, [qrPolling, apiId, apiHash]);

    const handlePhoneSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error("API ID must be a number");

            await invoke("cmd_auth_request_code", {
                phone,
                apiId: idInt,
                apiHash: apiHash
            });
            setStep("code");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : JSON.stringify(err);
            if (msg.includes("FLOOD_WAIT_")) {
                const parts = msg.split("FLOOD_WAIT_");
                if (parts[1]) {
                    const seconds = parseInt(parts[1]);
                    if (!isNaN(seconds)) {
                        setFloodWait(seconds);
                        return;
                    }
                }
            }
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const handleCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_sign_in", { code });
            if (res.success) {
                onLogin();
            } else if (res.next_step === "password") {
                setStep("password");
            } else {
                setError("Unknown error");
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_check_password", { password });
            if (res.success) {
                onLogin();
            } else {
                setError("Password verification failed.");
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-gradient relative flex h-full w-full items-center justify-center overflow-y-auto p-4 pt-[calc(1rem+env(safe-area-inset-top,24px))] text-app-text sm:p-6">
            <AuthThemeToggle />

            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="auth-glass my-auto w-full max-w-[26rem] rounded-overlay p-5 sm:p-6"
            >
                <div className="mb-6 text-center">
                    <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center">
                        <img src="/logo.svg" alt="Logo" className="w-full h-full" />
                    </div>
                    <h1 className="text-app-title font-semibold tracking-[-0.01em] text-app-text">Telegram Drive</h1>
                    <p className="mt-1 text-metadata text-app-text-secondary">Self-hosted secure storage</p>
                </div>

                <AnimatePresence mode="wait">
                    {floodWait ? (
                        <motion.div
                            key="flood"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="space-y-5 text-center"
                        >
                            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-container bg-app-danger/10">
                                <span className="text-xl">⏳</span>
                            </div>
                            <div>
                                <h2 className="text-app-title font-semibold text-app-text">Too Many Requests</h2>
                                <p className="mt-2 text-ui text-app-text-secondary">Telegram has temporarily limited your actions.</p>
                                <p className="text-ui text-app-text-secondary">Please wait before trying again.</p>
                            </div>

                            <div className="flex items-center justify-center font-mono text-3xl font-semibold tabular-nums text-app-accent">
                                {Math.floor(floodWait / 60)}:{(floodWait % 60).toString().padStart(2, '0')}
                            </div>

                            <p className="mt-4 text-metadata text-app-danger">
                                Do not restart the app. The timer will reset if you do.
                            </p>
                        </motion.div>
                    ) : (
                        <>


                            {step === "setup" && (
                                <motion.form
                                    key="setup"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleSetupSubmit}
                                    className="space-y-4"
                                >
                                    {googleAccount?.connected ? (
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between rounded-control border border-app-border bg-app-surface-sunken/40 p-3">
                                                <div className="flex items-center gap-2 text-ui text-app-text">
                                                    <GoogleGlyph />
                                                    <span className="truncate">{googleAccount.account_email}</span>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={async () => {
                                                        try {
                                                            const account = await invoke<GoogleAccountInfo>('cmd_google_sign_out');
                                                            setGoogleAccount(account);
                                                        } catch { /* non-critical */ }
                                                    }}
                                                    className="quiet-control flex h-7 w-7 items-center justify-center text-app-text-secondary hover:text-app-text"
                                                    title="Disconnect Google account"
                                                >
                                                    <LogOut className="h-3.5 w-3.5" />
                                                </button>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={handleContinueWithAuthenticator}
                                                disabled={loading}
                                                className="quiet-control auth-secondary-action w-full disabled:opacity-45"
                                            >
                                                <Key className="w-4 h-4" />
                                                Continue with Authenticator
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={handleContinueWithGoogle}
                                            disabled={loading}
                                            className="quiet-control auth-secondary-action w-full disabled:opacity-45"
                                        >
                                            <GoogleGlyph />
                                            Continue with Google
                                        </button>
                                    )}

                                    <div className="flex items-center gap-2 text-metadata text-app-text-tertiary">
                                        <div className="h-px flex-1 bg-app-border-subtle" />
                                        <span>or enter manually</span>
                                        <div className="h-px flex-1 bg-app-border-subtle" />
                                    </div>

                                    <div className="space-y-3">
                                        <div>
                                            <label className="auth-label">API ID</label>
                                            <div className="relative">
                                                <Key className="auth-input-icon" />
                                                <input
                                                    type="text"
                                                    value={apiId}
                                                    onChange={(e) => setApiId(e.target.value)}
                                                    placeholder="12345678"
                                                    className="auth-input font-mono"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="auth-label">API Hash</label>
                                            <div className="relative">
                                                <Key className="auth-input-icon" />
                                                <input
                                                    type="text"
                                                    value={apiHash}
                                                    onChange={(e) => setApiHash(e.target.value)}
                                                    placeholder="abcdef123456..."
                                                    className="auth-input font-mono"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <button
                                        type="submit"
                                        className="quiet-control auth-primary-action"
                                    >
                                        Configure <Settings className="w-4 h-4" />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => setShowHelp(true)}
                                        className="quiet-control auth-secondary-action w-full"
                                    >
                                        <HelpCircle className="w-3 h-3" />
                                        How do I get my API credentials?
                                    </button>

                                    {import.meta.env.DEV && (
                                        <button
                                            type="button"
                                            onClick={() => onLogin()}
                                            className="quiet-control auth-secondary-action w-full text-app-danger"
                                        >
                                            Dev Mode
                                        </button>
                                    )}
                                </motion.form>
                            )}


                            {step === "google-client-setup" && (
                                <motion.form
                                    key="google-client-setup"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleSaveGoogleClientAndContinue}
                                    className="space-y-4"
                                >
                                    <div className="flex items-center gap-2 text-ui text-app-text">
                                        <GoogleGlyph />
                                        <p className="text-ui text-app-text-secondary">
                                            One-time setup: enter the Google Cloud OAuth credentials for this app.
                                        </p>
                                    </div>
                                    <div className="space-y-3">
                                        <div>
                                            <label className="auth-label">Client ID</label>
                                            <div className="relative">
                                                <Key className="auth-input-icon" />
                                                <input
                                                    type="text"
                                                    value={googleClientId}
                                                    onChange={(e) => setGoogleClientId(e.target.value)}
                                                    placeholder="xxxxx.apps.googleusercontent.com"
                                                    className="auth-input font-mono"
                                                    autoFocus
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="auth-label">Client Secret</label>
                                            <div className="relative">
                                                <Lock className="auth-input-icon" />
                                                <input
                                                    type="password"
                                                    value={googleClientSecret}
                                                    onChange={(e) => setGoogleClientSecret(e.target.value)}
                                                    placeholder="GOCSPX-..."
                                                    autoComplete="off"
                                                    className="auth-input font-mono"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-3">
                                        <button
                                            type="submit"
                                            disabled={loading}
                                            className="quiet-control auth-primary-action disabled:opacity-45"
                                        >
                                            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Continue <ArrowRight className="h-4 w-4 rtl:rotate-180" /></>}
                                        </button>
                                        <button type="button" onClick={() => setStep("setup")} className="quiet-control auth-secondary-action w-full">
                                            <ChevronLeft className="h-3.5 w-3.5" /> Back
                                        </button>
                                    </div>
                                </motion.form>
                            )}

                            {step === "google-connecting" && (
                                <motion.div
                                    key="google-connecting"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    className="flex flex-col items-center gap-5 py-4"
                                >
                                    <div className="flex h-16 w-16 items-center justify-center rounded-container bg-app-surface-sunken/45">
                                        <Loader2 className="h-6 w-6 animate-spin text-app-accent" />
                                    </div>
                                    <div className="text-center">
                                        <p className="text-ui text-app-text">Waiting for Google sign-in in your browser…</p>
                                        <p className="mt-1 text-metadata text-app-text-tertiary">A browser window should have opened. Complete the sign-in there, then come back here.</p>
                                    </div>
                                    <button type="button" onClick={handleCancelGoogleOAuth} className="quiet-control auth-secondary-action w-full">
                                        Cancel
                                    </button>
                                </motion.div>
                            )}

                            {step === "phone" && (
                                <motion.div
                                    key="phone"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    className="space-y-5"
                                >
                                    {/* Phone / QR Toggle */}
                                    {!isMobile && (
                                        <div className="quiet-control flex overflow-hidden border border-app-border bg-app-surface-sunken/40 p-0.5">
                                            <button
                                                type="button"
                                                onClick={() => { setLoginMethod('phone'); setQrUrl(null); setQrPolling(false); setError(null); }}
                                                className={`quiet-control flex h-8 flex-1 items-center justify-center gap-2 text-metadata font-medium ${
                                                    loginMethod === 'phone'
                                                        ? 'bg-app-surface-raised text-app-text shadow-sm'
                                                        : 'text-app-text-secondary hover:text-app-text'
                                                }`}
                                            >
                                                <Phone className="w-4 h-4" /> Phone Number
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => { setLoginMethod('qr'); setError(null); handleQrLogin(); }}
                                                className={`quiet-control flex h-8 flex-1 items-center justify-center gap-2 text-metadata font-medium ${
                                                    loginMethod === 'qr'
                                                        ? 'bg-app-surface-raised text-app-text shadow-sm'
                                                        : 'text-app-text-secondary hover:text-app-text'
                                                }`}
                                            >
                                                <QrCode className="w-4 h-4" /> QR Code
                                            </button>
                                        </div>
                                    )}

                                    {loginMethod === 'phone' ? (
                                        <form onSubmit={handlePhoneSubmit} className="space-y-5">
                                            <div className="space-y-2">
                                                <label className="auth-label">Phone Number</label>
                                                <div className="relative">
                                                    <Phone className="auth-input-icon" />
                                                    <input
                                                        type="tel"
                                                        value={phone}
                                                        onChange={(e) => setPhone(e.target.value)}
                                                        placeholder="+1 234 567 8900"
                                                        className="auth-input tracking-wide"
                                                    />
                                                </div>
                                            </div>

                                            <div className="flex flex-col gap-3">
                                                <button
                                                    type="submit"
                                                    disabled={loading}
                                                    className="quiet-control auth-primary-action disabled:opacity-45"
                                                >
                                                    {loading ? "Connecting..." : <>Continue <ArrowRight className="h-4 w-4 rtl:rotate-180" /></>}
                                                </button>
                                                <button type="button" onClick={() => setStep("setup")} className="quiet-control auth-secondary-action w-full">
                                                    Back to Configuration
                                                </button>
                                            </div>
                                        </form>
                                    ) : (
                                        <div className="flex flex-col items-center gap-5">
                                            {loading && !qrUrl && (
                                                <div className="flex h-52 w-52 items-center justify-center rounded-container bg-app-surface-sunken/45">
                                                    <div className="h-7 w-7 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
                                                </div>
                                            )}
                                            {qrUrl && (
                                                <>
                                                    <div className="rounded-container bg-white p-3 shadow-[var(--shadow-raised)]">
                                                        <QRCodeSVG
                                                            value={qrUrl}
                                                            size={200}
                                                            level="M"
                                                            bgColor="#ffffff"
                                                            fgColor="#000000"
                                                        />
                                                    </div>
                                                    <div className="text-center space-y-1">
                                                        <p className="text-ui text-app-text">Scan with your Telegram app</p>
                                                        <p className="text-metadata text-app-text-tertiary">Settings &gt; Devices &gt; Link Desktop Device</p>
                                                    </div>
                                                    {qrPolling && (
                                                        <div className="flex items-center gap-2 text-metadata text-app-accent">
                                                            <div className="h-3 w-3 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
                                                            Waiting for scan...
                                                        </div>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={handleQrLogin}
                                                        className="quiet-control auth-secondary-action px-2"
                                                    >
                                                        Refresh QR Code
                                                    </button>
                                                </>
                                            )}
                                            <button type="button" onClick={() => { setStep("setup"); setQrPolling(false); }} className="quiet-control auth-secondary-action w-full">
                                                Back to Configuration
                                            </button>
                                        </div>
                                    )}
                                </motion.div>
                            )}


                            {step === "code" && (
                                <motion.form
                                    key="code"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleCodeSubmit}
                                    className="space-y-5"
                                >
                                    <div className="space-y-2">
                                        <label className="auth-label">Telegram Code</label>
                                        <div className="relative">
                                            <Key className="auth-input-icon" />
                                            <input
                                                type="text"
                                                value={code}
                                                onChange={(e) => setCode(e.target.value)}
                                                placeholder="1 2 3 4 5"
                                                className="auth-input pe-3 ps-10 text-center font-mono text-base tracking-[0.4em]"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3">
                                        <button
                                            type="submit"
                                            disabled={loading}
                                            className="quiet-control auth-primary-action disabled:opacity-45"
                                        >
                                            {loading ? "Verifying..." : "Sign In"}
                                        </button>
                                        <button type="button" onClick={() => setStep("phone")} className="quiet-control auth-secondary-action w-full">
                                            Change Phone Number
                                        </button>
                                    </div>
                                </motion.form>
                            )}


                            {step === "password" && (
                                <motion.form
                                    key="password"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handlePasswordSubmit}
                                    className="space-y-5"
                                >
                                    <div className="space-y-2">
                                        <div className="mb-4 rounded-control border border-app-accent/20 bg-app-selected p-3">
                                            <p className="text-center text-metadata text-app-accent">
                                                Your account has Two-Factor Authentication enabled.
                                                Please enter your cloud password to continue.
                                            </p>
                                        </div>
                                        <label className="auth-label">Cloud Password</label>
                                        <div className="relative">
                                            <Lock className="auth-input-icon" />
                                            <input
                                                type="password"
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                placeholder="Enter your password"
                                                className="auth-input"
                                                autoFocus
                                            />
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3">
                                        <button
                                            type="submit"
                                            disabled={loading || !password}
                                            className="quiet-control auth-primary-action disabled:opacity-45"
                                        >
                                            {loading ? "Verifying..." : "Unlock"}
                                        </button>
                                        <button type="button" onClick={() => { setStep("code"); setPassword(""); setError(null); }} className="quiet-control auth-secondary-action w-full">
                                            Back to Code Entry
                                        </button>
                                    </div>
                                </motion.form>
                            )}

                            {step === "authenticator-code" && (
                                <motion.form
                                    key="authenticator-code"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleVerifyAuthenticatorCode}
                                    className="space-y-5"
                                >
                                    <div className="space-y-2">
                                        <div className="mb-4 rounded-control border border-app-accent/20 bg-app-selected p-3">
                                            <p className="text-center text-metadata text-app-accent">
                                                This device already has your authenticator set up. Enter the current code to sign back in — no phone number needed.
                                            </p>
                                        </div>
                                        <label className="auth-label">Authenticator Code</label>
                                        <div className="relative">
                                            <Key className="auth-input-icon" />
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                value={totpCode}
                                                onChange={(e) => setTotpCode(e.target.value)}
                                                placeholder="123456"
                                                className="auth-input pe-3 ps-10 text-center font-mono text-base tracking-[0.4em]"
                                                autoFocus
                                            />
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3">
                                        <button
                                            type="submit"
                                            disabled={loading || totpCode.trim().length !== 6}
                                            className="quiet-control auth-primary-action disabled:opacity-45"
                                        >
                                            {loading ? "Verifying..." : "Continue"}
                                        </button>
                                        <button type="button" onClick={() => { setStep("setup"); setTotpCode(""); setError(null); }} className="quiet-control auth-secondary-action w-full">
                                            <ChevronLeft className="h-3.5 w-3.5" /> Back
                                        </button>
                                    </div>
                                </motion.form>
                            )}

                            {step === "authenticator-link" && (
                                <motion.form
                                    key="authenticator-link"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleLinkNewDevice}
                                    className="space-y-5"
                                >
                                    <div className="space-y-2">
                                        <div className="mb-4 rounded-control border border-app-accent/20 bg-app-selected p-3">
                                            <p className="text-center text-metadata text-app-accent">
                                                This account has an authenticator-protected session, but this is a new device. Paste the setup key you saved when you first set it up, and the current code from your authenticator app.
                                            </p>
                                        </div>
                                        <label className="auth-label">Setup Key</label>
                                        <div className="relative">
                                            <Key className="auth-input-icon" />
                                            <input
                                                type="text"
                                                value={totpSetupKey}
                                                onChange={(e) => setTotpSetupKey(e.target.value)}
                                                placeholder="Paste your saved setup key"
                                                className="auth-input font-mono"
                                                autoFocus
                                            />
                                        </div>
                                        <label className="auth-label">Authenticator Code</label>
                                        <div className="relative">
                                            <Key className="auth-input-icon" />
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                value={totpCode}
                                                onChange={(e) => setTotpCode(e.target.value)}
                                                placeholder="123456"
                                                className="auth-input pe-3 ps-10 text-center font-mono text-base tracking-[0.4em]"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3">
                                        <button
                                            type="submit"
                                            disabled={loading || !totpSetupKey.trim() || totpCode.trim().length !== 6}
                                            className="quiet-control auth-primary-action disabled:opacity-45"
                                        >
                                            {loading ? "Verifying..." : "Restore Session"}
                                        </button>
                                        <button type="button" onClick={() => { setStep("setup"); setTotpCode(""); setTotpSetupKey(""); setError(null); }} className="quiet-control auth-secondary-action w-full">
                                            <ChevronLeft className="h-3.5 w-3.5" /> Back
                                        </button>
                                    </div>
                                </motion.form>
                            )}
                        </>
                    )}
                </AnimatePresence>

                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-5 flex items-start gap-2 rounded-control border border-app-danger/20 bg-app-danger/10 p-3"
                    >
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 shrink-0" />
                        <p className="text-ui leading-snug text-app-danger">{error}</p>
                    </motion.div>
                )}

            </motion.div>


            <AnimatePresence>
                {showHelp && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm"
                        onClick={() => setShowHelp(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="quiet-raised max-h-[80vh] w-full max-w-lg overflow-y-auto p-5 sm:p-6"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-5 flex items-center justify-between">
                                <h2 className="text-app-title font-semibold text-app-text">Getting Started</h2>
                                <button onClick={() => setShowHelp(false)} className="quiet-control flex h-8 w-8 items-center justify-center text-app-text-secondary hover:text-app-text" aria-label="Close help">
                                    <X className="h-4 w-4" />
                                </button>
                            </div>

                            <div className="space-y-5 text-app-text">
                                <div className="rounded-control border border-app-accent/20 bg-app-selected p-3">
                                    <p className="text-ui leading-relaxed text-app-text-secondary">
                                        <strong className="text-app-accent">Telegram Drive</strong> uses your Telegram account as secure cloud storage. You'll need a Telegram account and API credentials to get started.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">1</span>
                                        Go to Telegram's Developer Portal
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        Visit <button type="button" onClick={(e) => { e.preventDefault(); open('https://my.telegram.org'); }} className="cursor-pointer text-app-accent underline hover:text-app-text">my.telegram.org</button> and log in with your phone number.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">2</span>
                                        Create a New Application
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        Click on <strong>"API development tools"</strong> and create a new application. Use any name and description you like.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">3</span>
                                        Copy Your Credentials
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        After creating the app, you'll see your <strong>API ID</strong> (a number) and <strong>API Hash</strong> (a string). Copy both and paste them into the fields on the previous screen.
                                    </p>
                                </div>

                                <div className="rounded-control border border-app-border bg-app-surface-sunken/35 p-3">
                                    <p className="text-metadata leading-relaxed text-app-text-secondary">
                                        <strong>🔒 Privacy:</strong> Your credentials are stored locally on your device and are never sent to any third-party servers. All data goes directly between you and Telegram.
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={(e) => { e.preventDefault(); open('https://my.telegram.org'); }}
                                    className="quiet-control auth-primary-action"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    Open my.telegram.org
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>


        </div>
    );
}
