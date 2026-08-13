import { useEffect, useState } from 'react';
import { Plus, Link2, Copy, Check, AlertCircle, Share2, HardDrive, Folder, Upload, Download, Pencil, Trash2, ChevronRight, ChevronLeft, Loader2, User as UserIcon } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { TelegramFolder, FolderShareInfo } from '../../../types';
import { nativeShareOrCopy } from '../../../utils';
import { SharePasswordAndExpiryFields, resolveExpiryHours, ExpiryType } from './SharePasswordAndExpiryFields';

interface TempLinkGeneratorModalProps {
    folders: TelegramFolder[];
    onClose: () => void;
    onFolderCreated?: () => void;
    /** Pre-fills the folder step, e.g. when opened from a folder's context menu. */
    initialFolderId?: number | null;
    initialFolderName?: string;
}

type Step = 'folder' | 'permissions' | 'security' | 'result';

export function TempLinkGeneratorModal({ folders, onClose, onFolderCreated, initialFolderId, initialFolderName }: TempLinkGeneratorModalProps) {
    const { t } = useTranslation();
    const [step, setStep] = useState<Step>(initialFolderId !== undefined ? 'permissions' : 'folder');

    // Folder step
    const [folderMode, setFolderMode] = useState<'existing' | 'new'>('existing');
    const [selectedFolderId, setSelectedFolderId] = useState<number | null>(initialFolderId ?? null);
    const [selectedFolderName, setSelectedFolderName] = useState(initialFolderName ?? '');
    const [newFolderName, setNewFolderName] = useState('');
    const [creatingFolder, setCreatingFolder] = useState(false);

    // Permissions step
    const [canUpload, setCanUpload] = useState(false);
    const [canDownload, setCanDownload] = useState(true);
    const [canUpdate, setCanUpdate] = useState(false);
    const [canDelete, setCanDelete] = useState(false);

    // Security step (shared with ShareDialog)
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [requirePassword, setRequirePassword] = useState(false);
    const [expiryType, setExpiryType] = useState<ExpiryType>('7d');
    const [customHours, setCustomHours] = useState('24');

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [shareInfo, setShareInfo] = useState<FolderShareInfo | null>(null);
    const [copied, setCopied] = useState(false);
    const [customDomain, setCustomDomain] = useState('');
    const [tunnelPublic, setTunnelPublic] = useState<boolean | null>(null);

    // The backend auto-starts a free Cloudflare tunnel on launch so links
    // work from any device, not just this machine — it can take a few
    // seconds to come up, so poll briefly while showing the result step.
    useEffect(() => {
        if (step !== 'result') return;
        let cancelled = false;
        const poll = async () => {
            try {
                const status = await invoke<{ public: boolean }>('cmd_get_share_tunnel_status');
                if (!cancelled) setTunnelPublic(status.public);
            } catch {
                if (!cancelled) setTunnelPublic(false);
            }
        };
        poll();
        const interval = setInterval(poll, 3000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [step]);

    const hasAnyPermission = canUpload || canDownload || canUpdate || canDelete;

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;
        setCreatingFolder(true);
        setError(null);
        try {
            const folder = await invoke<TelegramFolder>('cmd_create_folder', { name: newFolderName.trim() });
            setSelectedFolderId(folder.id);
            setSelectedFolderName(folder.name);
            onFolderCreated?.();
            setStep('permissions');
        } catch (err) {
            setError(String(err));
        } finally {
            setCreatingFolder(false);
        }
    };

    const handleSelectExisting = (id: number | null, name: string) => {
        setSelectedFolderId(id);
        setSelectedFolderName(name);
        setStep('permissions');
    };

    const handleGenerate = async () => {
        setLoading(true);
        setError(null);
        try {
            const expiryHours = resolveExpiryHours(expiryType, customHours);
            const pwdParam = requirePassword && password.trim() ? password : null;

            const usernameParam = requirePassword && username.trim() ? username.trim() : null;
            const result = await invoke<FolderShareInfo>('cmd_create_folder_share', {
                folderId: selectedFolderId,
                folderName: selectedFolderName || t('common.saved_messages'),
                canUpload, canDownload, canUpdate, canDelete,
                username: usernameParam,
                password: pwdParam,
                expiryHours,
            });
            setShareInfo(result);
            setStep('result');
        } catch (err) {
            setError(String(err));
        } finally {
            setLoading(false);
        }
    };

    const getDisplayLink = () => {
        if (!shareInfo) return '';
        if (customDomain.trim()) {
            try {
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
            navigator.clipboard.writeText(link).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }).catch(() => toastCopyFailed());
        }
    };

    const toastCopyFailed = () => setError(t('temp_link.copy_failed'));

    const handleNativeShare = () => {
        if (!shareInfo) return;
        nativeShareOrCopy(shareInfo.folder_name, '', getDisplayLink(), () => {
            navigator.clipboard.writeText(getDisplayLink());
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const permissionWarning = () => {
        const granted: string[] = [];
        if (canUpload) granted.push(t('temp_link.perm_upload').toLowerCase());
        if (canDownload) granted.push(t('temp_link.perm_download').toLowerCase());
        if (canUpdate) granted.push(t('temp_link.perm_update').toLowerCase());
        if (canDelete) granted.push(t('temp_link.perm_delete').toLowerCase());
        if (granted.length === 0) return t('temp_link.no_permissions_warning');
        return t('temp_link.permission_warning', { permissions: granted.join(', '), folder: selectedFolderName || t('common.saved_messages') });
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onClick={onClose}>
            <div className="quiet-raised flex w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between border-b border-app-border-subtle p-4">
                    <h3 className="text-telegram-text font-medium flex items-center gap-2">
                        {step !== 'folder' && step !== 'result' && (
                            <button
                                onClick={() => setStep(step === 'security' ? 'permissions' : 'folder')}
                                className="text-telegram-subtext hover:text-telegram-text -ml-1"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                        )}
                        <Link2 className="w-5 h-5 text-telegram-primary" />
                        {t('temp_link.title')}
                    </h3>
                    <button onClick={onClose} className="text-telegram-subtext hover:text-telegram-text">
                        <Plus className="w-5 h-5 rotate-45" />
                    </button>
                </div>

                <div className="p-5 flex-1 overflow-y-auto space-y-4 max-h-[75vh]">
                    {step === 'folder' && (
                        <div className="space-y-3">
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setFolderMode('existing')}
                                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${folderMode === 'existing' ? 'bg-telegram-primary border-telegram-primary text-white' : 'bg-telegram-surface border-telegram-border text-telegram-text hover:bg-telegram-hover'}`}
                                >
                                    {t('temp_link.choose_existing')}
                                </button>
                                <button
                                    onClick={() => setFolderMode('new')}
                                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${folderMode === 'new' ? 'bg-telegram-primary border-telegram-primary text-white' : 'bg-telegram-surface border-telegram-border text-telegram-text hover:bg-telegram-hover'}`}
                                >
                                    {t('temp_link.create_new')}
                                </button>
                            </div>

                            {folderMode === 'existing' ? (
                                <div className="max-h-64 space-y-1 overflow-y-auto">
                                    <button
                                        onClick={() => handleSelectExisting(null, t('common.saved_messages'))}
                                        className="quiet-control flex w-full items-center gap-3 px-3 py-3 text-start text-sm text-app-text"
                                    >
                                        <div className="w-8 h-8 rounded bg-telegram-primary/20 flex items-center justify-center text-telegram-primary">
                                            <HardDrive className="w-4 h-4" />
                                        </div>
                                        <span className="font-medium">{t('common.saved_messages')}</span>
                                    </button>
                                    {folders.map(folder => (
                                        <button
                                            key={folder.id}
                                            onClick={() => handleSelectExisting(folder.id, folder.name)}
                                            className="quiet-control flex w-full items-center gap-3 px-3 py-3 text-start text-sm text-app-text"
                                        >
                                            <div className="w-8 h-8 rounded bg-telegram-hover flex items-center justify-center text-telegram-text">
                                                <Folder className="w-4 h-4" />
                                            </div>
                                            <span className="font-medium truncate">{folder.name}</span>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <input
                                        type="text"
                                        value={newFolderName}
                                        onChange={e => setNewFolderName(e.target.value)}
                                        placeholder={t('temp_link.new_folder_placeholder')}
                                        className="w-full bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary"
                                        autoFocus
                                    />
                                    <button
                                        onClick={handleCreateFolder}
                                        disabled={creatingFolder || !newFolderName.trim()}
                                        className="w-full bg-telegram-primary hover:bg-telegram-primary-hover text-white text-sm font-medium py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                                    >
                                        {creatingFolder ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                                        {t('temp_link.create_and_continue')}
                                    </button>
                                </div>
                            )}

                            {error && (
                                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg p-3 flex gap-2 items-start">
                                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>{error}</span>
                                </div>
                            )}
                        </div>
                    )}

                    {step === 'permissions' && (
                        <div className="space-y-3">
                            <div className="quiet-surface p-3">
                                <div className="text-xs text-telegram-subtext uppercase font-semibold tracking-wider mb-1">{t('temp_link.folder_label')}</div>
                                <div className="text-sm font-medium text-telegram-text truncate">{selectedFolderName || t('common.saved_messages')}</div>
                            </div>

                            {([
                                ['upload', Upload, canUpload, setCanUpload, t('temp_link.perm_upload'), t('temp_link.perm_upload_desc')],
                                ['download', Download, canDownload, setCanDownload, t('temp_link.perm_download'), t('temp_link.perm_download_desc')],
                                ['update', Pencil, canUpdate, setCanUpdate, t('temp_link.perm_update'), t('temp_link.perm_update_desc')],
                                ['delete', Trash2, canDelete, setCanDelete, t('temp_link.perm_delete'), t('temp_link.perm_delete_desc')],
                            ] as const).map(([key, Icon, checked, setChecked, label, desc]) => (
                                <div key={key} className="flex items-center justify-between py-1">
                                    <span className="text-sm font-medium text-telegram-text flex items-center gap-2 select-none">
                                        <Icon className="w-4 h-4 text-telegram-primary" />
                                        <span>
                                            {label}
                                            <span className="block text-xs font-normal text-telegram-subtext">{desc}</span>
                                        </span>
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => (setChecked as (v: boolean) => void)(!checked)}
                                        className={`relative w-10 h-5.5 rounded-full transition-colors duration-200 shrink-0 ${checked ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-4.5' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                            ))}

                            <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs rounded-lg p-3 flex gap-2 items-start">
                                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                <span>{permissionWarning()}</span>
                            </div>

                            <button
                                onClick={() => setStep('security')}
                                disabled={!hasAnyPermission}
                                className="w-full bg-telegram-primary hover:bg-telegram-primary-hover text-white text-sm font-medium py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {t('common.next')}
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                    )}

                    {step === 'security' && (
                        <div className="space-y-4">
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

                            {requirePassword && (
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-telegram-text flex items-center gap-2">
                                        <UserIcon className="w-4 h-4 text-telegram-primary" />
                                        {t('temp_link.username_label')}
                                    </label>
                                    <input
                                        type="text"
                                        placeholder={t('temp_link.username_placeholder')}
                                        value={username}
                                        onChange={(e) => setUsername(e.target.value)}
                                        autoComplete="off"
                                        className="w-full bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary placeholder:text-telegram-subtext/60"
                                    />
                                    <p className="text-[11px] text-telegram-subtext">{t('temp_link.username_desc')}</p>
                                </div>
                            )}

                            {(canUpload || canUpdate || canDelete) && !requirePassword && (
                                <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs rounded-lg p-3 flex gap-2 items-start">
                                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>{t('temp_link.no_password_warning')}</span>
                                </div>
                            )}

                            {error && (
                                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg p-3 flex gap-2 items-start">
                                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>{error}</span>
                                </div>
                            )}

                            <button
                                onClick={handleGenerate}
                                disabled={loading}
                                className="w-full bg-telegram-primary hover:bg-telegram-primary-hover text-white text-sm font-medium py-2.5 rounded-lg shadow-lg hover:shadow-telegram-primary/20 transition-all flex items-center justify-center gap-2"
                            >
                                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('temp_link.generate_link')}
                            </button>
                        </div>
                    )}

                    {step === 'result' && shareInfo && (
                        <div className="space-y-4 animate-in fade-in duration-200">
                            <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-lg p-3 flex gap-2 items-center">
                                <Check className="w-4 h-4 shrink-0" />
                                <span>{t('temp_link.link_created')}</span>
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-telegram-subtext">{t('temp_link.link_label')}</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={getDisplayLink()}
                                        className="flex-1 bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text focus:outline-none select-all"
                                    />
                                    <button
                                        onClick={handleCopy}
                                        className={`px-3 py-2 rounded-lg border flex items-center justify-center transition-all ${copied ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-telegram-hover border-telegram-border text-telegram-text hover:bg-white/10'}`}
                                    >
                                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>
                                {!customDomain.trim() && (
                                    tunnelPublic === null ? (
                                        <p className="text-[11px] text-telegram-subtext">{t('temp_link.tunnel_checking')}</p>
                                    ) : tunnelPublic ? (
                                        <p className="text-[11px] text-emerald-400">{t('temp_link.tunnel_public')}</p>
                                    ) : (
                                        <p className="text-[11px] text-amber-400">{t('temp_link.tunnel_local_only')}</p>
                                    )
                                )}
                            </div>

                            {shareInfo.username && (
                                <div className="space-y-1.5">
                                    <label className="text-xs font-semibold text-telegram-subtext">{t('temp_link.username_label')}</label>
                                    <input
                                        type="text"
                                        readOnly
                                        value={shareInfo.username}
                                        className="w-full bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text focus:outline-none select-all"
                                    />
                                    <p className="text-[11px] text-telegram-subtext">{t('temp_link.username_share_reminder')}</p>
                                </div>
                            )}

                            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                                <button
                                    onClick={handleNativeShare}
                                    className="w-full bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary text-sm font-medium py-2.5 rounded-lg border border-telegram-primary/30 transition-all flex items-center justify-center gap-2"
                                >
                                    <Share2 className="w-4 h-4" />
                                    {t('share.share_via')}
                                </button>
                            )}

                            <div className="bg-telegram-hover/30 border border-telegram-border/50 rounded-lg p-3 space-y-2">
                                <div className="text-xs font-semibold text-telegram-text flex items-center gap-1.5">
                                    <span>🌐</span> {t('share.share_externally')}
                                </div>
                                <p className="text-xs text-telegram-subtext leading-relaxed">{t('share.tailscale_help')}</p>
                                <input
                                    type="text"
                                    placeholder="e.g. 100.115.22.45 or tailscale-pc:14201"
                                    value={customDomain}
                                    onChange={(e) => setCustomDomain(e.target.value)}
                                    className="w-full bg-telegram-surface/50 border border-telegram-border rounded-lg px-3 py-1.5 text-xs text-telegram-text focus:outline-none focus:border-telegram-primary placeholder:text-telegram-subtext/40"
                                />
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
