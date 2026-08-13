import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import { Lock, ArrowRight, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { AppLockSetupFlow } from './AppLockSetupFlow';

interface AppLockStatus {
    enabled: boolean;
    email: string | null;
}

interface AppLockScreenProps {
    onUnlock: () => void;
}

/**
 * The app-lock gate: shown after Google/Telegram login has already
 * succeeded on this device (see App.tsx's "app-lock" authStatus), sitting in
 * front of the dashboard the same way the login flow does. Unlocking checks
 * the password against a locally-cached hash — this screen works fully offline.
 */
export function AppLockScreen({ onUnlock }: AppLockScreenProps) {
    const [status, setStatus] = useState<AppLockStatus | null>(null);
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showForgot, setShowForgot] = useState(false);
    // Distinguishes "still checking status" / "checked, failed" from a
    // successful status fetch (`status !== null`).
    const [statusLoading, setStatusLoading] = useState(true);
    const [statusError, setStatusError] = useState<string | null>(null);

    const fetchStatus = async () => {
        setStatusLoading(true);
        setStatusError(null);
        try {
            // `cmd_get_app_lock_status` (see app_lock.rs) always resolves —
            // "not configured" is represented by a successful response with
            // `enabled: false`, it is never thrown. This screen is also only
            // ever mounted after App.tsx has already confirmed the lock is
            // enabled, so a thrown error here is a genuine failure (e.g. a
            // transient IPC hiccup), not "lock isn't configured" — it must
            // NOT be treated the same as a legitimate unlock.
            const result = await invoke<AppLockStatus>('cmd_get_app_lock_status');
            setStatus(result);
        } catch (err) {
            setStatusError(err instanceof Error ? err.message : String(err));
        } finally {
            setStatusLoading(false);
        }
    };

    useEffect(() => {
        fetchStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleUnlock = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const ok = await invoke<boolean>('cmd_verify_app_lock_password', { password });
            if (ok) {
                onUnlock();
            } else {
                setError('Incorrect password.');
                setPassword('');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-gradient relative flex h-full w-full items-center justify-center overflow-y-auto p-4 pt-[calc(1rem+env(safe-area-inset-top,24px))] text-app-text sm:p-6">
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="auth-glass my-auto w-full max-w-[24rem] rounded-overlay p-5 sm:p-6"
            >
                <div className="mb-6 text-center">
                    <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-container bg-app-surface-sunken/45">
                        <Lock className="h-5 w-5 text-app-accent" />
                    </div>
                    <h1 className="text-app-title font-semibold tracking-[-0.01em] text-app-text">Locked</h1>
                    {status?.email && (
                        <p className="mt-1 text-metadata text-app-text-secondary">{status.email}</p>
                    )}
                </div>

                {statusLoading ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-app-text-secondary">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-ui">Checking app lock status…</span>
                    </div>
                ) : statusError ? (
                    <div className="space-y-4">
                        <div className="flex items-start gap-2 rounded-control border border-app-danger/20 bg-app-danger/10 p-3">
                            <AlertTriangle className="h-4 w-4 shrink-0 text-app-danger mt-0.5" />
                            <p className="text-ui leading-snug text-app-danger">
                                Couldn&apos;t verify the app lock status: {statusError}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={fetchStatus}
                            className="quiet-control auth-primary-action w-full"
                        >
                            <RefreshCw className="h-4 w-4" /> Retry
                        </button>
                    </div>
                ) : (
                <AnimatePresence mode="wait">
                    {!showForgot ? (
                        <motion.form
                            key="unlock"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onSubmit={handleUnlock}
                            className="space-y-4"
                        >
                            <div className="relative">
                                <Lock className="auth-input-icon" />
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="Password"
                                    className="auth-input"
                                    autoFocus
                                />
                            </div>
                            <button type="submit" disabled={loading || !password} className="quiet-control auth-primary-action disabled:opacity-45">
                                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Unlock <ArrowRight className="h-4 w-4 rtl:rotate-180" /></>}
                            </button>
                            <button
                                type="button"
                                onClick={() => { setShowForgot(true); setError(null); }}
                                className="quiet-control auth-secondary-action w-full"
                            >
                                Forgot password?
                            </button>

                            {error && (
                                <motion.div
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="flex items-start gap-2 rounded-control border border-app-danger/20 bg-app-danger/10 p-3"
                                >
                                    <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 shrink-0" />
                                    <p className="text-ui leading-snug text-app-danger">{error}</p>
                                </motion.div>
                            )}
                        </motion.form>
                    ) : (
                        <motion.div key="forgot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            <AppLockSetupFlow
                                initialEmail={status?.email ?? ''}
                                mode="reset"
                                onComplete={() => { setShowForgot(false); setPassword(''); }}
                                onCancel={() => setShowForgot(false)}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
                )}
            </motion.div>
        </div>
    );
}
