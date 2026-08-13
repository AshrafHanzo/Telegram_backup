import { useState } from 'react';
import { Plus, Link, Copy, Check, AlertCircle, Share2 } from 'lucide-react';
import { TelegramFile, ShareInfo } from '../../../types';
import { invoke } from '@tauri-apps/api/core';
import { nativeShareOrCopy } from '../../../utils';
import { useTranslation } from 'react-i18next';
import { SharePasswordAndExpiryFields, resolveExpiryHours, ExpiryType } from './SharePasswordAndExpiryFields';

interface ShareDialogProps {
    file: TelegramFile;
    onClose: () => void;
}

export function ShareDialog({ file, onClose }: ShareDialogProps) {
    const { t } = useTranslation();
    const [password, setPassword] = useState('');
    const [requirePassword, setRequirePassword] = useState(false);
    const [expiryType, setExpiryType] = useState<ExpiryType>('1d');
    const [customHours, setCustomHours] = useState('24');
    
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
    const [copied, setCopied] = useState(false);
    const [customDomain, setCustomDomain] = useState('');
    const [alwaysOn, setAlwaysOn] = useState(false);
    const [usageLimit, setUsageLimit] = useState('');

    const handleGenerate = async () => {
        setLoading(true);
        setError(null);
        try {
            const expiryHours = resolveExpiryHours(expiryType, customHours);
            const pwdParam = requirePassword && password.trim() ? password : null;
            const usageLimitParam = usageLimit.trim() ? parseInt(usageLimit, 10) : null;

            // Always-on links need the file's real channel (the bot has to be
            // added there) — the local/tunnel path stays folder_id: null as
            // before, unchanged from existing behavior.
            const useAlwaysOn = alwaysOn && !!file.folder_id;
            const res = await invoke<ShareInfo>('cmd_create_share', {
                folderId: useAlwaysOn ? file.folder_id : null,
                messageId: file.id, // In Telegram Drive, file.id is the message id
                fileName: file.name,
                fileSize: file.size,
                password: pwdParam,
                expiryHours,
                alwaysOn: useAlwaysOn,
                usageLimit: usageLimitParam,
            });

            setShareInfo(res);
        } catch (err: any) {
            setError(err.toString());
        } finally {
            setLoading(false);
        }
    };

    const getDisplayLink = () => {
        if (!shareInfo) return '';
        if (customDomain.trim()) {
            try {
                // Replace the host part (localhost:14201) with the custom domain
                const url = new URL(shareInfo.link);
                return `${url.protocol}//${customDomain.trim()}${url.pathname}`;
            } catch {
                return shareInfo.link;
            }
        }
        return shareInfo.link;
    };

    const handleCopy = () => {
        const link = getDisplayLink();
        if (link) {
            navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    // Native Android/iOS share sheet via Web Share API
    const handleNativeShare = () => {
        if (!shareInfo) return;
        nativeShareOrCopy(file.name, file.sizeStr, getDisplayLink(), () => {
            navigator.clipboard.writeText(getDisplayLink());
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onClick={onClose}>
            <div className="quiet-raised flex w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between border-b border-app-border-subtle p-4">
                    <h3 className="text-telegram-text font-medium flex items-center gap-2">
                        <Link className="w-5 h-5 text-telegram-primary" />
                        {t('share.title')}
                    </h3>
                    <button onClick={onClose} className="text-telegram-subtext hover:text-telegram-text">
                        <Plus className="w-5 h-5 rotate-45" />
                    </button>
                </div>

                <div className="p-5 flex-1 overflow-y-auto space-y-4 max-h-[75vh]">
                    <div className="quiet-surface p-3">
                        <div className="text-xs text-telegram-subtext uppercase font-semibold tracking-wider mb-1">{t('share.sharing_file')}</div>
                        <div className="text-sm font-medium text-telegram-text truncate">{file.name}</div>
                        <div className="text-xs text-telegram-subtext mt-0.5">{file.sizeStr}</div>
                    </div>

                    {!shareInfo ? (
                        <>
                            <SharePasswordAndExpiryFields
                                password={password}
                                setPassword={setPassword}
                                requirePassword={requirePassword}
                                setRequirePassword={setRequirePassword}
                                expiryType={expiryType}
                                setExpiryType={setExpiryType}
                                customHours={customHours}
                                setCustomHours={setCustomHours}
                            />

                            <div className="quiet-surface p-3 space-y-2">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('share.always_on')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('share.always_on_desc')}</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setAlwaysOn(!alwaysOn)}
                                        disabled={!file.folder_id}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${alwaysOn ? 'bg-emerald-500' : 'bg-telegram-border'} disabled:opacity-40`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${alwaysOn ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                                {!file.folder_id && (
                                    <p className="text-xs text-amber-400">{t('share.always_on_needs_folder')}</p>
                                )}
                                {alwaysOn && file.folder_id && (
                                    <>
                                        <p className="text-xs text-telegram-subtext">{t('share.always_on_setup_note')}</p>
                                        <input
                                            type="number"
                                            min="1"
                                            placeholder={t('share.usage_limit_placeholder')}
                                            value={usageLimit}
                                            onChange={e => setUsageLimit(e.target.value)}
                                            className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50"
                                        />
                                    </>
                                )}
                            </div>

                            {error && (
                                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg p-3 flex gap-2 items-start">
                                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>{error}</span>
                                </div>
                            )}

                            <button
                                onClick={handleGenerate}
                                disabled={loading}
                                className="w-full bg-telegram-primary hover:bg-telegram-primary-hover text-white text-sm font-medium py-2.5 rounded-lg shadow-lg hover:shadow-telegram-primary/20 transition-all flex items-center justify-center gap-2 mt-4"
                            >
                                {loading ? (
                                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                ) : t('share.generate_link')}
                            </button>
                        </>
                    ) : (
                        <div className="space-y-4 animate-in fade-in duration-200">
                            <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-lg p-3 flex gap-2 items-center">
                                <Check className="w-4 h-4 shrink-0" />
                                <span>{shareInfo.always_on ? t('share.always_on_link_created') : t('share.link_created')}</span>
                            </div>
                            {shareInfo.always_on && shareInfo.usage_limit && (
                                <p className="text-xs text-telegram-subtext">
                                    {t('share.usage_count', { used: shareInfo.usage_count, limit: shareInfo.usage_limit })}
                                </p>
                            )}

                            {/* Shareable Link Display */}
                            <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-telegram-subtext">{t('files.share_link')}</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={getDisplayLink()}
                                        className="flex-1 bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text focus:outline-none select-all"
                                    />
                                    <button
                                        onClick={handleCopy}
                                        className={`px-3 py-2 rounded-lg border flex items-center justify-center transition-all ${
                                            copied 
                                                ? 'bg-emerald-500 border-emerald-500 text-white' 
                                                : 'bg-telegram-hover border-telegram-border text-telegram-text hover:bg-white/10'
                                        }`}
                                    >
                                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>

                            {/* Native Share Button (Android/iOS) */}
                            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                                <button
                                    onClick={handleNativeShare}
                                    className="w-full bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary text-sm font-medium py-2.5 rounded-lg border border-telegram-primary/30 transition-all flex items-center justify-center gap-2"
                                >
                                    <Share2 className="w-4 h-4" />
                                    {t('share.share_via')}
                                </button>
                            )}

                            {/* Tailscale / Network Share Customizer */}
                            <div className="bg-telegram-hover/30 border border-telegram-border/50 rounded-lg p-3 space-y-2">
                                <div className="text-xs font-semibold text-telegram-text flex items-center gap-1.5">
                                    <span>🌐</span> {t('share.share_externally')}
                                </div>
                                <p className="text-xs text-telegram-subtext leading-relaxed">
                                    {t('share.tailscale_help')}
                                </p>
                                <div className="flex gap-2 items-center">
                                    <input
                                        type="text"
                                        placeholder="e.g. 100.115.22.45 or tailscale-pc:14201"
                                        value={customDomain}
                                        onChange={(e) => setCustomDomain(e.target.value)}
                                        className="flex-1 bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-1.5 text-xs text-telegram-text focus:outline-none focus:border-telegram-primary placeholder:text-telegram-subtext/40"
                                    />
                                </div>
                            </div>

                            <button
                                onClick={onClose}
                                className="w-full bg-telegram-hover hover:bg-white/10 text-telegram-text text-sm font-medium py-2 rounded-lg transition-colors border border-telegram-border"
                            >
                                {t('share.done')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
