import { AnimatePresence, motion } from 'framer-motion';
import { Shield, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type ExpiryType = 'never' | '1h' | '1d' | '7d' | 'custom';

interface SharePasswordAndExpiryFieldsProps {
    password: string;
    setPassword: (value: string) => void;
    requirePassword: boolean;
    setRequirePassword: (value: boolean) => void;
    expiryType: ExpiryType;
    setExpiryType: (value: ExpiryType) => void;
    customHours: string;
    setCustomHours: (value: string) => void;
}

/**
 * Password-protection toggle + expiry picker shared by the single-file
 * ShareDialog and the folder-scoped Temp Link Generator, so both produce
 * identical controls instead of two copies that could drift.
 */
export function SharePasswordAndExpiryFields({
    password, setPassword, requirePassword, setRequirePassword,
    expiryType, setExpiryType, customHours, setCustomHours,
}: SharePasswordAndExpiryFieldsProps) {
    const { t } = useTranslation();

    return (
        <>
            <div className="space-y-2">
                <div className="flex items-center justify-between py-1">
                    <span className="text-sm font-medium text-telegram-text flex items-center gap-2 select-none">
                        <Shield className="w-4 h-4 text-emerald-400" />
                        {t('share.password_protection')}
                    </span>
                    <button
                        type="button"
                        onClick={() => setRequirePassword(!requirePassword)}
                        className={`relative w-10 h-5.5 rounded-full transition-colors duration-200 shrink-0 ${
                            requirePassword ? 'bg-telegram-primary' : 'bg-telegram-border'
                        }`}
                    >
                        <span
                            className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform duration-200 ${
                                requirePassword ? 'translate-x-4.5' : 'translate-x-0'
                            }`}
                        />
                    </button>
                </div>

                <AnimatePresence>
                    {requirePassword && (
                        <motion.div
                            initial={{ height: 0, opacity: 0, marginTop: 0 }}
                            animate={{ height: 'auto', opacity: 1, marginTop: 8 }}
                            exit={{ height: 0, opacity: 0, marginTop: 0 }}
                            transition={{ duration: 0.2, ease: 'easeInOut' }}
                            className="overflow-hidden"
                        >
                            <input
                                type="password"
                                placeholder={t('share.enter_password')}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="new-password"
                                className="w-full bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary placeholder:text-telegram-subtext/60"
                                autoFocus
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <div className="space-y-2">
                <span className="text-sm font-medium text-telegram-text flex items-center gap-2">
                    <Clock className="w-4 h-4 text-amber-400" />
                    {t('share.expiration')}
                </span>
                <div className="grid grid-cols-3 gap-2">
                    {(['1h', '1d', '7d'] as const).map((type) => (
                        <button
                            key={type}
                            type="button"
                            onClick={() => setExpiryType(type)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                                expiryType === type
                                    ? 'bg-telegram-primary border-telegram-primary text-white'
                                    : 'bg-telegram-surface border-telegram-border text-telegram-text hover:bg-telegram-hover'
                            }`}
                        >
                            {type === '1h' ? t('share.one_hour') : type === '1d' ? t('share.one_day') : t('share.seven_days')}
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={() => setExpiryType('never')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            expiryType === 'never'
                                ? 'bg-telegram-primary border-telegram-primary text-white'
                                : 'bg-telegram-surface border-telegram-border text-telegram-text hover:bg-telegram-hover'
                        }`}
                    >
                        {t('share.never')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setExpiryType('custom')}
                        className={`col-span-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            expiryType === 'custom'
                                ? 'bg-telegram-primary border-telegram-primary text-white'
                                : 'bg-telegram-surface border-telegram-border text-telegram-text hover:bg-telegram-hover'
                        }`}
                    >
                        {t('share.custom_hours')}
                    </button>
                </div>

                {expiryType === 'custom' && (
                    <div className="flex gap-2 items-center mt-2 animate-in slide-in-from-top-1 duration-100">
                        <input
                            type="number"
                            min="1"
                            value={customHours}
                            onChange={(e) => setCustomHours(e.target.value)}
                            className="w-24 bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary"
                        />
                        <span className="text-xs text-telegram-subtext">{t('share.hours_from_now')}</span>
                    </div>
                )}
            </div>
        </>
    );
}

/** Shared helper: resolves the UI's expiry selection into hours (or null = never). */
export function resolveExpiryHours(expiryType: ExpiryType, customHours: string): number | null {
    if (expiryType === '1h') return 1;
    if (expiryType === '1d') return 24;
    if (expiryType === '7d') return 168;
    if (expiryType === 'custom') {
        const parsed = parseInt(customHours, 10);
        if (isNaN(parsed) || parsed <= 0) {
            throw new Error('Please enter a valid number of hours');
        }
        return parsed;
    }
    return null;
}
