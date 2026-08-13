import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, KeyRound, Lock, ArrowRight, Loader2, ChevronLeft } from 'lucide-react';

interface AppLockSetupFlowProps {
    initialEmail?: string;
    mode?: 'setup' | 'reset';
    onComplete: () => void;
    onCancel?: () => void;
}

type SubStep = 'email' | 'otp';

/**
 * Shared email-OTP-then-set-password flow, used both by the post-login
 * AppLockScreen's "forgot password" path and by Settings' App Lock tab —
 * so both produce the exact same flow instead of two copies.
 */
export function AppLockSetupFlow({ initialEmail = '', mode = 'setup', onComplete, onCancel }: AppLockSetupFlowProps) {
    const [subStep, setSubStep] = useState<SubStep>('email');
    const [email, setEmail] = useState(initialEmail);
    const [otp, setOtp] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSendOtp = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email.trim() || !email.includes('@')) {
            setError('Enter a valid email address.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await invoke('cmd_send_app_lock_otp', { email: email.trim() });
            setSubStep('otp');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    const handleVerifyAndSet = async (e: React.FormEvent) => {
        e.preventDefault();
        if (newPassword.length < 6) {
            setError('Choose a password with at least 6 characters.');
            return;
        }
        if (newPassword !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await invoke('cmd_verify_otp_and_set_app_lock', {
                email: email.trim(),
                otp: otp.trim(),
                newPassword,
            });
            onComplete();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-4">
            <AnimatePresence mode="wait">
                {subStep === 'email' ? (
                    <motion.form
                        key="email"
                        initial={{ x: 12, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: -12, opacity: 0 }}
                        onSubmit={handleSendOtp}
                        className="space-y-3"
                    >
                        <p className="text-ui text-app-text-secondary">
                            {mode === 'reset'
                                ? "Enter the email your app lock is set to. We'll send a code to verify it's you."
                                : "Enter an email to protect the app with. We'll send a code to verify it."}
                        </p>
                        <div className="relative">
                            <Mail className="auth-input-icon" />
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="you@example.com"
                                className="auth-input"
                                // Resetting must go to the email the lock is already set to —
                                // letting it be edited here would just invite typing in an
                                // address you control instead of the real one.
                                readOnly={mode === 'reset'}
                                disabled={mode === 'reset'}
                                autoFocus
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <button type="submit" disabled={loading} className="quiet-control auth-primary-action disabled:opacity-45">
                                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Send Code <ArrowRight className="h-4 w-4 rtl:rotate-180" /></>}
                            </button>
                            {onCancel && (
                                <button type="button" onClick={onCancel} className="quiet-control auth-secondary-action w-full">
                                    <ChevronLeft className="h-3.5 w-3.5" /> Cancel
                                </button>
                            )}
                        </div>
                    </motion.form>
                ) : (
                    <motion.form
                        key="otp"
                        initial={{ x: 12, opacity: 0 }}
                        animate={{ x: 0, opacity: 1 }}
                        exit={{ x: -12, opacity: 0 }}
                        onSubmit={handleVerifyAndSet}
                        className="space-y-3"
                    >
                        <p className="text-ui text-app-text-secondary">
                            We sent a 6-digit code to <strong>{email}</strong>. Enter it below along with your new password.
                        </p>
                        <div className="relative">
                            <KeyRound className="auth-input-icon" />
                            <input
                                type="text"
                                inputMode="numeric"
                                value={otp}
                                onChange={(e) => setOtp(e.target.value)}
                                placeholder="123456"
                                className="auth-input text-center font-mono tracking-[0.4em]"
                                autoFocus
                            />
                        </div>
                        <div className="relative">
                            <Lock className="auth-input-icon" />
                            <input
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                placeholder="New password"
                                autoComplete="new-password"
                                className="auth-input"
                            />
                        </div>
                        <div className="relative">
                            <Lock className="auth-input-icon" />
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                placeholder="Confirm password"
                                autoComplete="new-password"
                                className="auth-input"
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <button type="submit" disabled={loading} className="quiet-control auth-primary-action disabled:opacity-45">
                                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify & Set Password'}
                            </button>
                            {mode !== 'reset' && (
                                <button type="button" onClick={() => { setSubStep('email'); setError(null); }} className="quiet-control auth-secondary-action w-full">
                                    <ChevronLeft className="h-3.5 w-3.5" /> Use a different email
                                </button>
                            )}
                        </div>
                    </motion.form>
                )}
            </AnimatePresence>

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
        </div>
    );
}
