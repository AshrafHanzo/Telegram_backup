import { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { X, RotateCcw, Download, Upload, Trash2, HardDrive, Globe, Key, Copy, Check, RefreshCw, FolderArchive, Shield, Zap, Activity, Gauge, Wifi, ChevronDown, Link, Sparkles, Info, Clipboard, Monitor, Loader2, Languages, Play, Palette, Plus, Tag, Moon, Sun, Cloud, FolderPlus, FolderOpen, Link2, Eye, EyeOff, KeyRound, LogOut, Lock, Mail, Ban } from 'lucide-react';
import { GoogleGlyph } from '../../shared/GoogleGlyph';
import { useGoogleOAuthPolling, GoogleAccountInfo } from '../../../hooks/useGoogleOAuthPolling';
import { AppLockSetupFlow } from '../../shared/AppLockSetupFlow';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import { load as loadStore } from '@tauri-apps/plugin-store';
import { listen } from '@tauri-apps/api/event';
import { pickWithFallback } from '../../../utils';
import { toast } from 'sonner';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useSettings } from '../../../context/SettingsContext';
import { useConfirm } from '../../../context/ConfirmContext';
import { useTranslation } from 'react-i18next';
import { EncryptionSettingsSection } from '../../shared/EncryptionSettingsSection';
import { LANGUAGES } from '../../../i18n/languages';
import { ShareInfo, CacheEntry, DetailedCacheInfo, TelegramFolder, FolderShareInfo, BandwidthStats } from '../../../types';
import { TempLinkGeneratorModal } from './TempLinkGeneratorModal';
import { BackupDestinationModal } from './BackupDestinationModal';
import { BackupExcludeModal } from './BackupExcludeModal';
import { version as appVersion } from '../../../../package.json';
import { useTheme } from '../../../context/ThemeContext';
import { CustomTheme, ThemeColorPalette, generateThemeId } from '../../../theme/themeEngine';
import { getDefaultPalette } from '../../../theme/presets';
import { clearImageMemoryCaches } from '../../../services/imagePreviewCache';
import { pullAndApplyGoogleDriveSync } from '../../../services/googleDriveSync';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    folders?: TelegramFolder[];
}

interface ApiSettings {
    enabled: boolean;
    port: number;
    key_set: boolean;
    running: boolean;
}

interface WebDavSettings {
    supported: boolean;
    enabled: boolean;
    port: number;
    write_enabled: boolean;
    token_set: boolean;
    running: boolean;
    last_error: string | null;
}

interface WebDavTokenResponse {
    token: string;
    url: string;
}

interface BackupSourceFolder {
    id: string;
    local_path: string;
    display_name: string;
    channel_id: number | null;
    enabled: boolean;
    last_run_at: number | null;
    last_run_status: string | null;
    last_error: string | null;
    excluded_paths: string[];
}

interface BackupSettings {
    enabled: boolean;
    schedule_hour: number;
    schedule_minute: number;
    sources: BackupSourceFolder[];
    last_scheduled_run_at: number | null;
    last_scheduled_run_status: string | null;
}

interface BackupStatus {
    running: boolean;
    current_source_id: string | null;
    current_files_done: number;
    current_files_total: number;
    next_scheduled_run_at: number | null;
    settings: BackupSettings;
}

interface BackupRunSummary {
    sources_processed: number;
    files_uploaded: number;
    files_skipped: number;
    files_failed: number;
    errors: string[];
}

interface RestoreRunSummary {
    restored: number;
    skipped: number;
    failed: number;
    errors: string[];
}

type SettingsTab = 'general' | 'webdav' | 'backup' | 'google' | 'app-lock' | 'themes' | 'proxy' | 'vpn' | 'encryption' | 'sharing' | 'about';

export function SettingsModal({ isOpen, onClose, folders = [] }: SettingsModalProps) {
    const { settings, updateSetting, resetSettings } = useSettings();
    const { confirm } = useConfirm();
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [clearing, setClearing] = useState(false);

    // Transcode cache state
    const [transcodeCache, setTranscodeCache] = useState<DetailedCacheInfo | null>(null);
    const [cacheLoading, setCacheLoading] = useState(false);
    const [clearingVariant, setClearingVariant] = useState<string | null>(null); // file_key:quality being cleared
    const [activeTab, setActiveTab] = useState<SettingsTab>('general');
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [vpnDetected, setVpnDetected] = useState<boolean | null>(null);
    const [proxyStatus, setProxyStatus] = useState<{ reachable: boolean; latency_ms: number } | null>(null);
    const [isTestingProxy, setIsTestingProxy] = useState(false);

    // Update check state
    const [updateChecking, setUpdateChecking] = useState(false);
    const [updateAvailable, setUpdateAvailable] = useState<Update | null>(null);
    const [updateVersion, setUpdateVersion] = useState<string | null>(null);
    const [updateDownloading, setUpdateDownloading] = useState(false);
    const [updateProgress, setUpdateProgress] = useState(0);

    // Reconnect state
    const [reconnecting, setReconnecting] = useState(false);

    // Diagnostics state
    const [diagLoading, setDiagLoading] = useState(false);

    // Telegram API credentials (api_id / api_hash) — required for every
    // cloud feature (streaming, backup, sharing) to reach Telegram at all.
    // Persisted in the same `config.json` store AuthWizard writes to at
    // first login, so this section can view/update them afterwards too.
    const [telegramApiId, setTelegramApiId] = useState('');
    const [telegramApiHash, setTelegramApiHash] = useState('');
    const [showApiHash, setShowApiHash] = useState(false);
    const [savingTelegramCreds, setSavingTelegramCreds] = useState(false);
    const [telegramCredsDirty, setTelegramCredsDirty] = useState(false);

    useEffect(() => {
        if (!isOpen || activeTab !== 'general') return;
        (async () => {
            try {
                const store = await loadStore('config.json');
                const storedApiId = await store.get<string>('api_id');
                const storedApiHash = await store.get<string>('api_hash');
                setTelegramApiId(storedApiId ?? '');
                setTelegramApiHash(storedApiHash ?? '');
                setTelegramCredsDirty(false);
            } catch {
                // Store not readable yet — leave fields blank rather than error.
            }
        })();
    }, [isOpen, activeTab]);

    const handleSaveTelegramCredentials = useCallback(async () => {
        const trimmedId = telegramApiId.trim();
        const trimmedHash = telegramApiHash.trim();
        if (!trimmedId || !trimmedHash) {
            toast.error(t('settings.telegram_creds_required'));
            return;
        }
        if (/\s/.test(trimmedId) || /\s/.test(trimmedHash) || !/^\d+$/.test(trimmedId)) {
            toast.error(t('settings.telegram_creds_invalid'));
            return;
        }
        setSavingTelegramCreds(true);
        try {
            const store = await loadStore('config.json');
            await store.set('api_id', trimmedId);
            await store.set('api_hash', trimmedHash);
            await store.save();
            await invoke('cmd_connect', { apiId: parseInt(trimmedId, 10) });
            setTelegramCredsDirty(false);
            toast.success(t('settings.telegram_creds_saved'));
        } catch (error) {
            toast.error(t('settings.telegram_creds_save_failed', { error }));
        } finally {
            setSavingTelegramCreds(false);
        }
    }, [telegramApiId, telegramApiHash, t]);

    // --- Google Account (Drive-synced api_id/api_hash) ---
    const [googleAccount, setGoogleAccount] = useState<GoogleAccountInfo | null>(null);
    const [googleClientIdInput, setGoogleClientIdInput] = useState('');
    const [googleClientSecretInput, setGoogleClientSecretInput] = useState('');
    const [savingGoogleClient, setSavingGoogleClient] = useState(false);
    const [editingGoogleClient, setEditingGoogleClient] = useState(false);

    const fetchGoogleAccount = useCallback(async () => {
        try {
            const account = await invoke<GoogleAccountInfo>('cmd_get_google_account');
            setGoogleAccount(account);
            // Pre-fill with whatever's already saved instead of leaving a
            // blank "one-time setup" form — single-user local app, so
            // showing the current values back is a usability win, not a leak.
            setGoogleClientIdInput(account.client_id ?? '');
            setGoogleClientSecretInput(account.client_secret ?? '');

            // Already signed into Google — refresh api_id/api_hash (and, as
            // a side effect of the backend command, the App Lock cache)
            // from Drive every time this tab is opened or a connect just
            // succeeded, mirroring mobile's `GoogleAccountScreen.refresh()`.
            // Best-effort: a failed pull just means locally-cached
            // credentials/app-lock state stay as they were.
            if (account.connected) {
                pullAndApplyGoogleDriveSync().catch(() => {});
            }
        } catch {
            // Google sign-in is optional; leave previous state as-is.
        }
    }, []);

    useEffect(() => {
        if (isOpen && activeTab === 'google') {
            fetchGoogleAccount();
        }
    }, [isOpen, activeTab, fetchGoogleAccount]);

    const handleGoogleConnected = useCallback(() => {
        fetchGoogleAccount();
    }, [fetchGoogleAccount]);

    const googleOauth = useGoogleOAuthPolling(handleGoogleConnected);

    // --- Authenticator (TOTP) setup — see commands/totp.rs for the actual
    // encryption/sync this enables. Only meaningful once Google is
    // connected, since that's what carries the encrypted session to Drive.
    const [totpEnabled, setTotpEnabled] = useState(false);
    const [totpSetupData, setTotpSetupData] = useState<{ base32Secret: string; qrSvg: string } | null>(null);
    const [totpConfirmCode, setTotpConfirmCode] = useState('');
    const [totpBusy, setTotpBusy] = useState(false);

    const fetchTotpStatus = useCallback(async () => {
        try {
            const status = await invoke<{ enabled: boolean }>('cmd_totp_status');
            setTotpEnabled(status.enabled);
        } catch {
            // Non-critical — leave previous state as-is.
        }
    }, []);

    useEffect(() => {
        if (isOpen && activeTab === 'google') {
            fetchTotpStatus();
        }
    }, [isOpen, activeTab, fetchTotpStatus]);

    const handleStartTotpSetup = useCallback(async () => {
        setTotpBusy(true);
        try {
            const setup = await invoke<{ base32_secret: string; otpauth_uri: string; qr_svg: string }>('cmd_totp_setup_start');
            setTotpSetupData({ base32Secret: setup.base32_secret, qrSvg: setup.qr_svg });
        } catch (error) {
            toast.error(t('settings.totp_setup_start_failed', { error }));
        } finally {
            setTotpBusy(false);
        }
    }, [t]);

    const handleConfirmTotpSetup = useCallback(async () => {
        setTotpBusy(true);
        try {
            await invoke('cmd_totp_setup_confirm', { code: totpConfirmCode.trim() });
            setTotpSetupData(null);
            setTotpConfirmCode('');
            await fetchTotpStatus();
            toast.success(t('settings.totp_setup_success'));
        } catch (error) {
            toast.error(t('settings.totp_setup_confirm_failed', { error }));
        } finally {
            setTotpBusy(false);
        }
    }, [totpConfirmCode, fetchTotpStatus, t]);

    const handleDisableTotp = useCallback(async () => {
        const ok = await confirm({
            title: t('settings.totp_disable_title'),
            message: t('settings.totp_disable_desc'),
            confirmText: t('settings.totp_disable_confirm'),
            variant: 'danger',
        });
        if (!ok) return;
        setTotpBusy(true);
        try {
            await invoke('cmd_totp_disable');
            await fetchTotpStatus();
            toast.success(t('settings.totp_disabled'));
        } catch (error) {
            toast.error(t('settings.totp_disable_failed', { error }));
        } finally {
            setTotpBusy(false);
        }
    }, [fetchTotpStatus, t]);

    useEffect(() => {
        if (googleOauth.error) {
            toast.error(t('settings.google_connect_failed', { error: googleOauth.error }));
        }
    }, [googleOauth.error, t]);

    const handleSaveGoogleClient = useCallback(async () => {
        if (!googleClientIdInput.trim() || !googleClientSecretInput.trim()) {
            toast.error(t('settings.google_client_required'));
            return;
        }
        setSavingGoogleClient(true);
        try {
            const account = await invoke<GoogleAccountInfo>('cmd_set_google_oauth_client', {
                clientId: googleClientIdInput.trim(),
                clientSecret: googleClientSecretInput.trim(),
            });
            setGoogleAccount(account);
            setGoogleClientIdInput(account.client_id ?? '');
            setGoogleClientSecretInput(account.client_secret ?? '');
            setEditingGoogleClient(false);
            toast.success(t('settings.google_client_saved'));
        } catch (error) {
            toast.error(t('settings.google_client_save_failed', { error }));
        } finally {
            setSavingGoogleClient(false);
        }
    }, [googleClientIdInput, googleClientSecretInput, t]);

    const handleGoogleSignOut = useCallback(async () => {
        try {
            const account = await invoke<GoogleAccountInfo>('cmd_google_sign_out');
            setGoogleAccount(account);
            toast.success(t('settings.google_disconnected'));
        } catch (error) {
            toast.error(t('settings.google_disconnect_failed', { error }));
        }
    }, [t]);

    // --- App Lock + SMTP sender ---
    const [appLockStatus, setAppLockStatus] = useState<{ enabled: boolean; email: string | null } | null>(null);
    const [showAppLockSetup, setShowAppLockSetup] = useState(false);
    const [smtpSettings, setSmtpSettings] = useState<{ gmail_address: string | null; configured: boolean } | null>(null);
    const [smtpGmailInput, setSmtpGmailInput] = useState('');
    const [smtpAppPasswordInput, setSmtpAppPasswordInput] = useState('');
    const [savingSmtp, setSavingSmtp] = useState(false);

    const fetchAppLockStatus = useCallback(async () => {
        try {
            const status = await invoke<{ enabled: boolean; email: string | null }>('cmd_get_app_lock_status');
            setAppLockStatus(status);
        } catch {
            // non-critical
        }
    }, []);

    const fetchSmtpSettings = useCallback(async () => {
        try {
            const result = await invoke<{ gmail_address: string | null; configured: boolean }>('cmd_get_smtp_settings');
            setSmtpSettings(result);
        } catch {
            // non-critical
        }
    }, []);

    useEffect(() => {
        if (isOpen && activeTab === 'app-lock') {
            fetchAppLockStatus();
            fetchSmtpSettings();
        }
    }, [isOpen, activeTab, fetchAppLockStatus, fetchSmtpSettings]);

    const handleSaveSmtp = useCallback(async () => {
        if (!smtpGmailInput.trim() || !smtpAppPasswordInput.trim()) {
            toast.error(t('settings.smtp_required'));
            return;
        }
        setSavingSmtp(true);
        try {
            const result = await invoke<{ gmail_address: string | null; configured: boolean }>('cmd_update_smtp_settings', {
                gmailAddress: smtpGmailInput.trim(),
                appPassword: smtpAppPasswordInput.trim(),
            });
            setSmtpSettings(result);
            setSmtpAppPasswordInput('');
            toast.success(t('settings.smtp_saved'));
        } catch (error) {
            toast.error(t('settings.smtp_save_failed', { error }));
        } finally {
            setSavingSmtp(false);
        }
    }, [smtpGmailInput, smtpAppPasswordInput, t]);

    const handleToggleAppLock = useCallback(async (enabled: boolean) => {
        try {
            const status = await invoke<{ enabled: boolean; email: string | null }>('cmd_set_app_lock_enabled', { enabled });
            setAppLockStatus(status);
        } catch (error) {
            toast.error(t('settings.app_lock_toggle_failed', { error }));
        }
    }, [t]);

    const handleCheckForUpdates = useCallback(async () => {
        setUpdateChecking(true);
        try {
            const updateInfo = await check();
            if (updateInfo) {
                setUpdateAvailable(updateInfo);
                setUpdateVersion(updateInfo.version);
                toast.success(t('settings.update_available_toast', { version: updateInfo.version }));
            } else {
                setUpdateAvailable(null);
                setUpdateVersion(null);
                toast.success(t('settings.latest_version_toast'));
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('dev') || msg.includes('no current version')) {
                toast.info(t('settings.update_prod_only_toast'));
            } else {
                toast.error(t('settings.update_check_failed_toast', { error: msg }));
            }
        } finally {
            setUpdateChecking(false);
        }
    }, [t]);

    const handleInstallUpdate = useCallback(async () => {
        if (!updateAvailable) return;
        setUpdateDownloading(true);
        setUpdateProgress(0);
        let downloaded = 0;
        let contentLength = 0;
        try {
            await updateAvailable.downloadAndInstall((event) => {
                if (event.event === 'Started') {
                    const data = event.data as { contentLength?: number };
                    contentLength = data.contentLength || 0;
                } else if (event.event === 'Progress') {
                    const data = event.data as { chunkLength?: number };
                    downloaded += data.chunkLength || 0;
                    if (contentLength > 0) {
                        setUpdateProgress(Math.min(Math.round((downloaded / contentLength) * 100), 100));
                    }
                }
            });
            await relaunch();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(t('settings.update_failed_toast', { error: msg }));
            setUpdateDownloading(false);
        }
    }, [updateAvailable, t]);

    // Sharing settings state
    const [shares, setShares] = useState<ShareInfo[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [globalDomain, setGlobalDomain] = useState('');

    const fetchShares = useCallback(async () => {
        setRefreshing(true);
        try {
            const [fileShares, folderList] = await Promise.all([
                invoke<ShareInfo[]>('cmd_list_shares'),
                invoke<FolderShareInfo[]>('cmd_list_folder_shares').catch(() => []),
            ]);
            setShares(fileShares);
            setFolderShares(folderList);
        } catch (e) {
            toast.error(t('settings.load_shares_failed', { error: e }));
        } finally {
            setRefreshing(false);
        }
    }, [t]);

    useEffect(() => {
        if (isOpen && activeTab === 'sharing') {
            fetchShares();
        }
    }, [isOpen, activeTab, fetchShares]);

    // Always-on relay (bot + Cloudflare Worker) configuration
    const [relayStatus, setRelayStatus] = useState<{ bot_configured: boolean; bot_username: string | null; worker_configured: boolean } | null>(null);
    const [botTokenInput, setBotTokenInput] = useState('');
    const [savingBotToken, setSavingBotToken] = useState(false);
    const [workerUrlInput, setWorkerUrlInput] = useState('');
    const [adminSecretInput, setAdminSecretInput] = useState('');
    const [savingWorkerConfig, setSavingWorkerConfig] = useState(false);

    const fetchRelayStatus = useCallback(async () => {
        try {
            const status = await invoke<{ bot_configured: boolean; bot_username: string | null; worker_configured: boolean }>('cmd_get_relay_status');
            setRelayStatus(status);
        } catch {
            // Non-critical — always-on links are opt-in.
        }
    }, []);

    useEffect(() => {
        if (isOpen && activeTab === 'sharing') {
            fetchRelayStatus();
        }
    }, [isOpen, activeTab, fetchRelayStatus]);

    const handleSaveBotToken = useCallback(async () => {
        if (!botTokenInput.trim()) return;
        setSavingBotToken(true);
        try {
            const status = await invoke<typeof relayStatus>('cmd_set_relay_bot_token', { botToken: botTokenInput.trim() });
            setRelayStatus(status);
            setBotTokenInput('');
            toast.success(t('settings.relay_bot_saved'));
        } catch (error) {
            toast.error(t('settings.relay_bot_save_failed', { error }));
        } finally {
            setSavingBotToken(false);
        }
    }, [botTokenInput, t]);

    const handleSaveWorkerConfig = useCallback(async () => {
        if (!workerUrlInput.trim() || !adminSecretInput.trim()) return;
        setSavingWorkerConfig(true);
        try {
            const status = await invoke<typeof relayStatus>('cmd_set_relay_worker_config', {
                workerUrl: workerUrlInput.trim(),
                adminSecret: adminSecretInput.trim(),
            });
            setRelayStatus(status);
            toast.success(t('settings.relay_worker_saved'));
        } catch (error) {
            toast.error(t('settings.relay_worker_save_failed', { error }));
        } finally {
            setSavingWorkerConfig(false);
        }
    }, [workerUrlInput, adminSecretInput, t]);

    // Temp Link Generator (folder-scoped, permissioned shares)
    const [folderShares, setFolderShares] = useState<FolderShareInfo[]>([]);
    const [showTempLinkGenerator, setShowTempLinkGenerator] = useState(false);
    const [copiedFolderShareId, setCopiedFolderShareId] = useState<string | null>(null);

    const handleCopyFolderShare = (id: string) => {
        const share = folderShares.find(s => s.id === id);
        if (!share) return;
        let link = share.link;
        if (globalDomain.trim()) {
            try {
                const url = new URL(share.link);
                link = `${url.protocol}//${globalDomain.trim()}${url.pathname}`;
            } catch { /* keep default link */ }
        }
        navigator.clipboard.writeText(link).then(() => {
            setCopiedFolderShareId(id);
            setTimeout(() => setCopiedFolderShareId(null), 2000);
        });
    };

    const handleRevokeFolderShare = async (id: string) => {
        const ok = await confirm({
            title: t('settings.revoke_link_title'),
            message: t('settings.revoke_link_desc'),
            confirmText: t('settings.revoke'),
            variant: 'danger',
        });
        if (!ok) return;
        try {
            await invoke('cmd_revoke_folder_share', { id });
            toast.success(t('settings.link_revoked'));
            fetchShares();
        } catch (e) {
            toast.error(t('settings.link_revoke_failed', { error: e }));
        }
    };

    const handleRevokeShare = async (id: string) => {
        const ok = await confirm({
            title: t('settings.revoke_link_title'),
            message: t('settings.revoke_link_desc'),
            confirmText: t('settings.revoke'),
            variant: 'danger',
        });
        if (!ok) return;

        try {
            await invoke('cmd_revoke_share', { id });
            toast.success(t('settings.link_revoked'));
            fetchShares();
        } catch (e) {
            toast.error(t('settings.link_revoke_failed', { error: e }));
        }
    };

    const handleCopyShare = (id: string) => {
        const share = shares.find(s => s.id === id);
        if (!share) return;
        
        let link = `http://127.0.0.1:14201/d/${share.id}`;
        if (globalDomain.trim()) {
            link = `http://${globalDomain.trim()}/d/${share.id}`;
        }
        
        navigator.clipboard.writeText(link);
        setCopiedId(share.id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    // API settings state
    const [apiSettings, setApiSettings] = useState<ApiSettings>({ enabled: false, port: 8550, key_set: false, running: false });
    const [apiPort, setApiPort] = useState('8550');
    const [apiLoading, setApiLoading] = useState(false);
    const [generatedKey, setGeneratedKey] = useState<string | null>(null);
    const [keyCopied, setKeyCopied] = useState(false);

    // WebDAV settings state
    const [webDavSettings, setWebDavSettings] = useState<WebDavSettings>({
        supported: true,
        enabled: false,
        port: 8551,
        write_enabled: false,
        token_set: false,
        running: false,
        last_error: null,
    });
    const [webDavPort, setWebDavPort] = useState('8551');
    const [webDavLoading, setWebDavLoading] = useState(false);
    const [webDavGenerating, setWebDavGenerating] = useState(false);
    const [generatedWebDavUrl, setGeneratedWebDavUrl] = useState<string | null>(null);
    const [webDavUrlCopied, setWebDavUrlCopied] = useState(false);

    const fetchApiSettings = useCallback(async () => {
        try {
            const result = await invoke<ApiSettings>('cmd_get_api_settings');
            setApiSettings(result);
            setApiPort(result.port.toString());
        } catch {
            // API settings not available
        }
    }, []);

    const fetchWebDavSettings = useCallback(async (syncPort = true) => {
        try {
            const result = await invoke<WebDavSettings>('cmd_get_webdav_settings');
            setWebDavSettings(result);
            if (syncPort) setWebDavPort(result.port.toString());
        } catch {
            setWebDavSettings(previous => ({ ...previous, supported: false }));
        }
    }, []);

    // Load API settings when modal opens
    useEffect(() => {
        if (isOpen) {
            fetchApiSettings();
            fetchWebDavSettings();
            setGeneratedKey(null);
            setKeyCopied(false);
            setGeneratedWebDavUrl(null);
            setWebDavUrlCopied(false);
        }
    }, [isOpen, fetchApiSettings, fetchWebDavSettings]);

    // Fetch transcode cache info
    const fetchTranscodeCache = useCallback(async () => {
        setCacheLoading(true);
        try {
            const info = await invoke<DetailedCacheInfo>('cmd_get_detailed_transcode_cache');
            setTranscodeCache(info);
        } catch {
            setTranscodeCache(null);
        } finally {
            setCacheLoading(false);
        }
    }, []);

    // Load transcode cache when on general tab
    useEffect(() => {
        if (isOpen && activeTab === 'general') {
            fetchTranscodeCache();
        }
    }, [isOpen, activeTab, fetchTranscodeCache]);

    // Poll API status while modal is open and API is enabled
    useEffect(() => {
        if (!isOpen || !apiSettings.enabled) return;
        const interval = setInterval(fetchApiSettings, 3000);
        return () => clearInterval(interval);
    }, [isOpen, apiSettings.enabled, fetchApiSettings]);

    // Poll WebDAV runtime state while its tab is visible.
    useEffect(() => {
        if (!isOpen || activeTab !== 'webdav') return;
        const interval = setInterval(() => void fetchWebDavSettings(false), 3000);
        return () => clearInterval(interval);
    }, [isOpen, activeTab, fetchWebDavSettings]);

    // --- Backup feature state ---
    const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
    const [backupHour, setBackupHour] = useState('12');
    const [backupMinute, setBackupMinute] = useState('00');
    const [backupBusy, setBackupBusy] = useState(false);
    const [addingBackupFolder, setAddingBackupFolder] = useState(false);
    const [pendingBackupLocalPath, setPendingBackupLocalPath] = useState<string | null>(null);
    const [restoreTargetId, setRestoreTargetId] = useState<string | null>(null);
    const [restorePath, setRestorePath] = useState('');
    const [restoring, setRestoring] = useState(false);

    const fetchBackupStatus = useCallback(async () => {
        try {
            const result = await invoke<BackupStatus>('cmd_get_backup_status');
            setBackupStatus(result);
            setBackupHour(String(result.settings.schedule_hour).padStart(2, '0'));
            setBackupMinute(String(result.settings.schedule_minute).padStart(2, '0'));
        } catch {
            // Backend not ready yet — leave previous state as-is.
        }
    }, []);

    useEffect(() => {
        if (isOpen && activeTab === 'backup') {
            fetchBackupStatus();
        }
    }, [isOpen, activeTab, fetchBackupStatus]);

    // Launch-at-startup + "keep running when closed" — without this,
    // scheduled backups only ever fired while the app happened to be open.
    const [autostartEnabled, setAutostartEnabled] = useState(false);
    const [autostartBusy, setAutostartBusy] = useState(false);

    const fetchAutostartStatus = useCallback(async () => {
        try {
            const enabled = await invoke<boolean>('cmd_get_autostart_enabled');
            setAutostartEnabled(enabled);
        } catch {
            // Non-critical — leave previous state as-is.
        }
    }, []);

    useEffect(() => {
        if (isOpen && activeTab === 'backup') {
            fetchAutostartStatus();
        }
    }, [isOpen, activeTab, fetchAutostartStatus]);

    const handleToggleAutostart = useCallback(async () => {
        setAutostartBusy(true);
        try {
            await invoke('cmd_set_autostart_enabled', { enabled: !autostartEnabled });
            await fetchAutostartStatus();
        } catch (error) {
            toast.error(t('settings.autostart_toggle_failed', { error }));
        } finally {
            setAutostartBusy(false);
        }
    }, [autostartEnabled, fetchAutostartStatus, t]);

    // Poll backup status while its tab is open — faster while a run is active
    // so the progress line feels live even if the event listener below misses
    // a tick (e.g. the tab was reopened mid-run).
    useEffect(() => {
        if (!isOpen || activeTab !== 'backup') return;
        const interval = setInterval(fetchBackupStatus, backupStatus?.running ? 1000 : 5000);
        return () => clearInterval(interval);
    }, [isOpen, activeTab, fetchBackupStatus, backupStatus?.running]);

    // Live progress while a backup/restore run is in flight.
    useEffect(() => {
        if (!isOpen || activeTab !== 'backup') return;
        let unlistenFn: (() => void) | undefined;
        listen('backup-progress', () => { void fetchBackupStatus(); }).then(fn => { unlistenFn = fn; });
        return () => { unlistenFn?.(); };
    }, [isOpen, activeTab, fetchBackupStatus]);

    const handleAddBackupFolder = useCallback(async () => {
        try {
            const dirPath = await pickWithFallback(
                () => openFolderDialog({ directory: true, multiple: false, title: t('settings.backup_pick_folder_title') }),
                () => { /* no-op retry: user can just click Add Folder again */ },
                { errorTitle: 'Folder picker failed' },
            );
            if (!dirPath || typeof dirPath !== 'string') return;
            // Ask which Telegram folder to back up into before actually
            // registering the source — see handleDestinationChosen.
            setPendingBackupLocalPath(dirPath);
        } catch (error) {
            toast.error(t('settings.backup_folder_add_failed', { error }));
        }
    }, [t]);

    // Destination picked → exclude-picker step next, before the source is
    // actually registered (see handleConfirmBackupDestination).
    const [pendingBackupChannelId, setPendingBackupChannelId] = useState<number | null>(null);
    const [showBackupExcludeStep, setShowBackupExcludeStep] = useState(false);
    const handleDestinationChosen = useCallback((channelId: number | null) => {
        setPendingBackupChannelId(channelId);
        setShowBackupExcludeStep(true);
    }, []);

    const handleConfirmBackupDestination = useCallback(async (excludedPaths: string[]) => {
        const localPath = pendingBackupLocalPath;
        const channelId = pendingBackupChannelId;
        setPendingBackupLocalPath(null);
        setPendingBackupChannelId(null);
        setShowBackupExcludeStep(false);
        if (!localPath) return;
        setAddingBackupFolder(true);
        try {
            const updated = await invoke<BackupSettings>('cmd_add_backup_source', { localPath, channelId, excludedPaths });
            setBackupStatus(previous => previous ? { ...previous, settings: updated } : previous);
            toast.success(t('settings.backup_folder_added'));
        } catch (error) {
            toast.error(t('settings.backup_folder_add_failed', { error }));
        } finally {
            setAddingBackupFolder(false);
        }
    }, [pendingBackupLocalPath, pendingBackupChannelId, t]);

    const handleCancelBackupAdd = useCallback(() => {
        setPendingBackupLocalPath(null);
        setPendingBackupChannelId(null);
        setShowBackupExcludeStep(false);
    }, []);

    // Editing exclusions for a source that's already been added.
    const [editingExclusionsFor, setEditingExclusionsFor] = useState<BackupSourceFolder | null>(null);
    const handleSaveExclusions = useCallback(async (excludedPaths: string[]) => {
        if (!editingExclusionsFor) return;
        try {
            const updated = await invoke<BackupSettings>('cmd_set_backup_exclusions', {
                sourceId: editingExclusionsFor.id,
                excludedPaths,
            });
            setBackupStatus(previous => previous ? { ...previous, settings: updated } : previous);
            toast.success(t('settings.backup_exclude_saved'));
        } catch (error) {
            toast.error(t('settings.backup_exclude_save_failed', { error }));
        } finally {
            setEditingExclusionsFor(null);
        }
    }, [editingExclusionsFor, t]);

    const handleRemoveBackupFolder = useCallback(async (sourceId: string, displayName: string) => {
        const ok = await confirm({
            title: t('settings.backup_remove_title'),
            message: t('settings.backup_remove_desc', { name: displayName }),
            confirmText: t('settings.backup_remove_confirm'),
            variant: 'danger',
        });
        if (!ok) return;
        try {
            const updated = await invoke<BackupSettings>('cmd_remove_backup_source', { sourceId });
            setBackupStatus(previous => previous ? { ...previous, settings: updated } : previous);
        } catch (error) {
            toast.error(t('settings.backup_remove_failed', { error }));
        }
    }, [t, confirm]);

    const handleToggleBackupFolder = useCallback(async (sourceId: string, enabled: boolean) => {
        try {
            const updated = await invoke<BackupSettings>('cmd_set_backup_source_enabled', { sourceId, enabled });
            setBackupStatus(previous => previous ? { ...previous, settings: updated } : previous);
        } catch (error) {
            toast.error(t('settings.backup_toggle_failed', { error }));
        }
    }, [t]);

    const applyBackupSchedule = useCallback(async (enabled: boolean, hour: string, minute: string) => {
        const parsedHour = Math.min(23, Math.max(0, parseInt(hour, 10) || 0));
        const parsedMinute = Math.min(59, Math.max(0, parseInt(minute, 10) || 0));
        try {
            const updated = await invoke<BackupSettings>('cmd_update_backup_schedule', {
                enabled,
                scheduleHour: parsedHour,
                scheduleMinute: parsedMinute,
            });
            setBackupStatus(previous => previous ? { ...previous, settings: updated } : previous);
        } catch (error) {
            toast.error(t('settings.backup_schedule_failed', { error }));
        }
    }, [t]);

    const handleBackupScheduleToggle = useCallback(() => {
        if (!backupStatus) return;
        void applyBackupSchedule(!backupStatus.settings.enabled, backupHour, backupMinute);
    }, [backupStatus, backupHour, backupMinute, applyBackupSchedule]);

    const handleBackupTimeApply = useCallback(() => {
        if (!backupStatus) return;
        void applyBackupSchedule(backupStatus.settings.enabled, backupHour, backupMinute);
    }, [backupStatus, backupHour, backupMinute, applyBackupSchedule]);

    const handleBackupNow = useCallback(async () => {
        setBackupBusy(true);
        try {
            const summary = await invoke<BackupRunSummary>('cmd_backup_now');
            if (summary.files_failed > 0) {
                toast.warning(t('settings.backup_now_partial', { uploaded: summary.files_uploaded, failed: summary.files_failed }));
            } else {
                toast.success(t('settings.backup_now_success', { uploaded: summary.files_uploaded, skipped: summary.files_skipped }));
            }
        } catch (error) {
            toast.error(t('settings.backup_now_failed', { error }));
        } finally {
            setBackupBusy(false);
            fetchBackupStatus();
            // A backup run uploads/removes files directly on the backend,
            // bypassing the normal upload queue entirely — so whichever
            // folder(s) are currently open in the file browser never hear
            // about it. Force every open folder view to refetch instead of
            // showing stale contents until the user navigates away and back.
            queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'files' });
        }
    }, [t, fetchBackupStatus, queryClient]);

    // "Backup All" (OneDrive-style): protects Desktop/Documents/Pictures.
    // Only calculates + raises an approval notification here — actually
    // adding the folders and uploading happens on approve, handled by
    // cmd_respond_to_notification → backup::run_backup_all_approved.
    const [backupAllBusy, setBackupAllBusy] = useState(false);
    const handleBackupAll = useCallback(async () => {
        setBackupAllBusy(true);
        try {
            await invoke('cmd_calculate_backup_all');
            toast.success(t('settings.backup_all_calculated'));
        } catch (error) {
            toast.error(t('settings.backup_all_failed', { error }));
        } finally {
            setBackupAllBusy(false);
        }
    }, [t]);

    const handleCancelBackup = useCallback(async () => {
        try {
            await invoke('cmd_cancel_backup');
            toast.info(t('settings.backup_cancelling'));
        } catch (error) {
            toast.error(t('settings.backup_cancel_failed', { error }));
        }
    }, [t]);

    const handlePickRestoreFolder = useCallback(async () => {
        const dirPath = await pickWithFallback(
            () => openFolderDialog({ directory: true, multiple: false, title: t('settings.backup_restore_pick_title') }),
            () => { /* no-op retry */ },
            { errorTitle: 'Folder picker failed' },
        );
        if (dirPath && typeof dirPath === 'string') {
            setRestorePath(dirPath);
        }
    }, [t]);

    const handleRestore = useCallback(async () => {
        if (!restoreTargetId || !restorePath.trim()) return;
        const source = backupStatus?.settings.sources.find(s => s.id === restoreTargetId);
        const ok = await confirm({
            title: t('settings.backup_restore_confirm_title'),
            message: t('settings.backup_restore_confirm_desc', { name: source?.display_name ?? '', path: restorePath }),
            confirmText: t('settings.backup_restore_confirm_action'),
        });
        if (!ok) return;

        setRestoring(true);
        try {
            const summary = await invoke<RestoreRunSummary>('cmd_restore_backup', {
                sourceId: restoreTargetId,
                restorePath: restorePath.trim(),
            });
            if (summary.failed > 0) {
                toast.warning(t('settings.backup_restore_partial', { restored: summary.restored, failed: summary.failed }));
            } else {
                toast.success(t('settings.backup_restore_success', { restored: summary.restored, skipped: summary.skipped }));
            }
            setRestoreTargetId(null);
            setRestorePath('');
        } catch (error) {
            toast.error(t('settings.backup_restore_failed', { error }));
        } finally {
            setRestoring(false);
            fetchBackupStatus();
        }
    }, [restoreTargetId, restorePath, backupStatus, t, confirm]);

    // Sync proxy settings to backend whenever they change
    useEffect(() => {
        const applyProxy = async () => {
            try {
                await invoke('cmd_apply_proxy_settings', {
                    enabled: settings.proxyEnabled,
                    proxyType: settings.proxyType,
                    host: settings.proxyHost,
                    port: settings.proxyPort,
                    username: settings.proxyUsername,
                    password: settings.proxyPassword,
                });
            } catch {
                // best-effort sync
            }
        };
        applyProxy();
    }, [
        settings.proxyEnabled, settings.proxyType, settings.proxyHost,
        settings.proxyPort, settings.proxyUsername, settings.proxyPassword,
    ]);

    // Sync VPN optimizer settings to backend whenever they change
    useEffect(() => {
        const applyVpn = async () => {
            try {
                await invoke('cmd_apply_vpn_settings', {
                    enabled: settings.vpnMode,
                    timeoutMultiplier: settings.timeoutMultiplier,
                    retryAttempts: settings.retryAttempts,
                    retryBaseBackoffMs: Math.round(settings.retryBaseBackoffSec * 1000),
                    retryMaxBackoffMs: Math.round(settings.retryMaxBackoffSec * 1000),
                    adaptivePolling: settings.adaptivePolling,
                    pollingMinSec: settings.pollingMinSec,
                    pollingMaxSec: settings.pollingMaxSec,
                    preferredDc: settings.preferredDC,
                    dcFallbackAttempts: settings.dcFallbackAttempts,
                    floodWaitRespect: settings.floodWaitRespect,
                    peerCacheSize: settings.peerCacheSize,
                    bandwidthLimitUpKbs: settings.bandwidthLimitUpKBs,
                    bandwidthLimitDownKbs: settings.bandwidthLimitDownKBs,
                    chunkSizeKb: settings.chunkSizeKb,
                    keepAliveIntervalSec: settings.keepAliveIntervalSec,
                    autoDetectVpn: settings.autoDetectVpn,
                    archiveMaxBytes: settings.archiveMaxBytes * 1024 * 1024,
                });
            } catch {
                // best-effort sync
            }
        };
        applyVpn();
    }, [
        settings.vpnMode, settings.timeoutMultiplier, settings.retryAttempts,
        settings.retryBaseBackoffSec, settings.retryMaxBackoffSec, settings.adaptivePolling,
        settings.pollingMinSec, settings.pollingMaxSec, settings.preferredDC,
        settings.dcFallbackAttempts, settings.floodWaitRespect, settings.peerCacheSize,
        settings.bandwidthLimitUpKBs, settings.bandwidthLimitDownKBs, settings.chunkSizeKb,
        settings.keepAliveIntervalSec, settings.autoDetectVpn, settings.archiveMaxBytes,
    ]);

    // Poll latency when VPN tab is active
    useEffect(() => {
        if (!isOpen || activeTab !== 'vpn') return;
        const check = async () => {
            try {
                const ms = await invoke<number>('cmd_check_latency');
                setLatencyMs(ms);
            } catch { setLatencyMs(null); }
        };
        check();
        const interval = setInterval(check, 5000);
        return () => clearInterval(interval);
    }, [isOpen, activeTab]);

    // Poll proxy status when Proxy tab is active
    useEffect(() => {
        if (!isOpen || activeTab !== 'proxy') return;
        const checkProxy = async () => {
            if (!settings.proxyEnabled || !settings.proxyLiveStateEnabled) {
                setProxyStatus(null);
                return;
            }
            try {
                const status = await invoke<{ reachable: boolean; latency_ms: number }>('cmd_get_proxy_status');
                setProxyStatus(status);
            } catch {
                setProxyStatus({ reachable: false, latency_ms: -1 });
            }
        };
        checkProxy();
        const interval = setInterval(checkProxy, 5000);
        return () => clearInterval(interval);
    }, [isOpen, activeTab, settings.proxyEnabled, settings.proxyLiveStateEnabled]);

    // Detect VPN interfaces when VPN tab opens
    useEffect(() => {
        if (!isOpen || activeTab !== 'vpn') return;
        const detect = async () => {
            try {
                const found = await invoke<boolean>('cmd_detect_vpn');
                setVpnDetected(found);
            } catch { setVpnDetected(null); }
        };
        detect();
    }, [isOpen, activeTab]);

    // Daily storage/transfer cap — separate from the KB/s throttle above:
    // this limits total GB moved per day, not instantaneous speed.
    const [bandwidthStats, setBandwidthStats] = useState<BandwidthStats | null>(null);
    const [capUnlimited, setCapUnlimited] = useState(false);
    const [capGb, setCapGb] = useState('250');
    const [savingCap, setSavingCap] = useState(false);

    const fetchBandwidthStats = useCallback(async () => {
        try {
            const stats = await invoke<BandwidthStats>('cmd_get_bandwidth');
            setBandwidthStats(stats);
            const isUnlimited = stats.limit >= Number.MAX_SAFE_INTEGER;
            setCapUnlimited(isUnlimited);
            if (!isUnlimited) {
                setCapGb((stats.limit / (1024 * 1024 * 1024)).toFixed(0));
            }
        } catch {
            // Non-critical — the cap still enforces server-side either way.
        }
    }, []);

    useEffect(() => {
        if (!isOpen || activeTab !== 'vpn') return;
        fetchBandwidthStats();
    }, [isOpen, activeTab, fetchBandwidthStats]);

    const handleSaveBandwidthCap = useCallback(async () => {
        setSavingCap(true);
        try {
            const gb = capUnlimited ? null : Math.max(1, parseFloat(capGb) || 1);
            const stats = await invoke<BandwidthStats>('cmd_set_bandwidth_limit', { gigabytes: gb });
            setBandwidthStats(stats);
            // The sidebar's "Used Today" widget polls this same query — push
            // the fresh value into its cache immediately instead of waiting
            // for the next 5s poll to pick it up.
            queryClient.setQueryData(['bandwidth'], stats);
            toast.success(t('settings.storage_cap_saved'));
        } catch (error) {
            toast.error(t('settings.storage_cap_save_failed', { error }));
        } finally {
            setSavingCap(false);
        }
    }, [capUnlimited, capGb, t, queryClient]);

    const handleApiToggle = async () => {
        setApiLoading(true);
        try {
            const port = parseInt(apiPort, 10);
            if (isNaN(port) || port < 1024 || port > 65535) {
                toast.error(t('settings.port_range_error'));
                setApiLoading(false);
                return;
            }
            const result = await invoke<ApiSettings>('cmd_update_api_settings', {
                enabled: !apiSettings.enabled,
                port,
            });
            setApiSettings(result);
            toast.success(result.enabled ? t('settings.api_server_started') : t('settings.api_server_stopped'));
        } catch (e) {
            toast.error(t('settings.api_update_failed', { error: e }));
        } finally {
            setApiLoading(false);
        }
    };

    const handlePortApply = async () => {
        const port = parseInt(apiPort, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
            toast.error(t('settings.port_range_error'));
            return;
        }
        if (port === apiSettings.port) return;
        setApiLoading(true);
        try {
            const result = await invoke<ApiSettings>('cmd_update_api_settings', {
                enabled: apiSettings.enabled,
                port,
            });
            setApiSettings(result);
            toast.success(t('settings.api_port_updated', { port }));
        } catch (e) {
            toast.error(t('settings.api_port_update_failed', { error: e }));
        } finally {
            setApiLoading(false);
        }
    };

    const handleGenerateKey = async () => {
        const ok = await confirm({
            title: t('settings.generate_api_key_title'),
            message: apiSettings.key_set
                ? t('settings.regenerate_api_key_desc')
                : t('settings.generate_api_key_desc'),
            confirmText: apiSettings.key_set ? t('settings.regenerate') : t('settings.generate'),
            variant: apiSettings.key_set ? 'danger' : 'info',
        });
        if (!ok) return;
        try {
            const key = await invoke<string>('cmd_regenerate_api_key');
            setGeneratedKey(key);
            setKeyCopied(false);
            setApiSettings(prev => ({ ...prev, key_set: true }));
            toast.success(t('settings.api_key_generated'));
        } catch (e) {
            toast.error(t('settings.api_key_generate_failed', { error: e }));
        }
    };

    const handleCopyKey = async () => {
        if (!generatedKey) return;
        try {
            await navigator.clipboard.writeText(generatedKey);
            setKeyCopied(true);
            setTimeout(() => setKeyCopied(false), 2000);
        } catch {
            toast.error(t('settings.copy_clipboard_failed'));
        }
    };

    const parseWebDavPort = () => {
        const port = Number.parseInt(webDavPort, 10);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            toast.error(t('settings.port_range_error'));
            return null;
        }
        return port;
    };

    const generateWebDavLink = async (askBeforeReplacing = true) => {
        if (askBeforeReplacing && webDavSettings.token_set) {
            const ok = await confirm({
                title: t('settings.webdav_regenerate_title'),
                message: t('settings.webdav_regenerate_desc'),
                confirmText: t('settings.regenerate'),
                variant: 'danger',
            });
            if (!ok) return null;
        }
        setWebDavGenerating(true);
        try {
            const result = await invoke<WebDavTokenResponse>('cmd_regenerate_webdav_token');
            setGeneratedWebDavUrl(result.url);
            setWebDavUrlCopied(false);
            setWebDavSettings(previous => ({ ...previous, token_set: true }));
            toast.success(t('settings.webdav_link_generated'));
            return result;
        } catch (error) {
            toast.error(t('settings.webdav_generate_failed', { error }));
            return null;
        } finally {
            setWebDavGenerating(false);
        }
    };

    const handleWebDavToggle = async () => {
        const port = parseWebDavPort();
        if (port === null || !webDavSettings.supported) return;
        setWebDavLoading(true);
        try {
            if (!webDavSettings.enabled && !webDavSettings.token_set) {
                const generated = await generateWebDavLink(false);
                if (!generated) return;
            }
            const result = await invoke<WebDavSettings>('cmd_update_webdav_settings', {
                enabled: !webDavSettings.enabled,
                port,
                writeEnabled: webDavSettings.write_enabled,
            });
            setWebDavSettings(result);
            toast.success(result.enabled ? t('settings.webdav_started') : t('settings.webdav_stopped_toast'));
        } catch (error) {
            toast.error(t('settings.webdav_update_failed', { error }));
        } finally {
            setWebDavLoading(false);
        }
    };

    const handleWebDavPortApply = async () => {
        const port = parseWebDavPort();
        if (port === null || port === webDavSettings.port || !webDavSettings.supported) return;
        setWebDavLoading(true);
        try {
            const result = await invoke<WebDavSettings>('cmd_update_webdav_settings', {
                enabled: webDavSettings.enabled,
                port,
                writeEnabled: webDavSettings.write_enabled,
            });
            setWebDavSettings(result);
            setGeneratedWebDavUrl(previous => {
                if (!previous) return previous;
                try {
                    const updated = new URL(previous);
                    updated.port = port.toString();
                    return updated.toString();
                } catch {
                    return previous;
                }
            });
            toast.success(t('settings.webdav_port_updated', { port }));
        } catch (error) {
            setWebDavPort(webDavSettings.port.toString());
            toast.error(t('settings.webdav_update_failed', { error }));
        } finally {
            setWebDavLoading(false);
        }
    };

    const handleWebDavWriteToggle = async () => {
        if (!webDavSettings.supported) return;
        const port = parseWebDavPort();
        if (port === null) return;
        const nextWriteEnabled = !webDavSettings.write_enabled;
        if (nextWriteEnabled) {
            const ok = await confirm({
                title: t('settings.webdav_enable_changes_title'),
                message: t('settings.webdav_enable_changes_confirm'),
                confirmText: t('common.confirm'),
                variant: 'danger',
            });
            if (!ok) return;
        }
        setWebDavLoading(true);
        try {
            const result = await invoke<WebDavSettings>('cmd_update_webdav_settings', {
                enabled: webDavSettings.enabled,
                port,
                writeEnabled: nextWriteEnabled,
            });
            setWebDavSettings(result);
        } catch (error) {
            toast.error(t('settings.webdav_update_failed', { error }));
        } finally {
            setWebDavLoading(false);
        }
    };

    const handleCopyWebDavUrl = async () => {
        if (!generatedWebDavUrl) return;
        try {
            await navigator.clipboard.writeText(generatedWebDavUrl);
            setWebDavUrlCopied(true);
            setTimeout(() => setWebDavUrlCopied(false), 2000);
        } catch {
            toast.error(t('settings.copy_clipboard_failed'));
        }
    };

    return (
        <>
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-app-overlay p-6 backdrop-blur-sm"
                    onClick={onClose}
                >
                    <motion.div
                        layout
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                        className="quiet-raised flex h-[min(760px,calc(100vh-3rem))] w-[min(920px,calc(100vw-3rem))] flex-col overflow-hidden"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex min-h-16 items-center justify-between border-b border-app-border-subtle px-6 py-4">
                            <div>
                                <h2 className="text-base font-semibold text-app-text">{t('settings.title')}</h2>
                                <p className="mt-0.5 text-xs text-app-text-tertiary">{t(`settings.tab_${activeTab}`)}</p>
                            </div>
                            <button
                                onClick={onClose}
                                className="quiet-control p-2 text-app-text-secondary hover:text-app-text"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="flex min-h-0 flex-1">
                        {/* Settings navigation */}
                        <aside className="w-48 shrink-0 border-e border-app-border-subtle bg-app-sidebar p-3">
                            {([['general', Globe], ['themes', Palette], ['proxy', Shield], ['vpn', Zap], ['webdav', HardDrive], ['backup', Cloud], ['google', GoogleGlyph], ['app-lock', Lock], ['encryption', Shield], ['sharing', Link], ['about', Info]] as const).map(([key, Icon]) => (
                                <button
                                    key={key}
                                    onClick={() => setActiveTab(key as SettingsTab)}
                                    className={`quiet-control mb-1 flex w-full items-center gap-2.5 px-3 py-2.5 text-start text-sm font-medium ${
                                        activeTab === key
                                            ? 'bg-app-selected text-app-text'
                                            : 'text-app-text-secondary hover:text-app-text'
                                    }`}
                                >
                                    <Icon className={`h-4 w-4 ${activeTab === key ? 'text-app-accent' : ''}`} />
                                    {t(`settings.tab_${key}`)}
                                </button>
                            ))}
                        </aside>

                        {/* Body */}
                        <div className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-7 py-6">
                            <AnimatePresence mode="wait" initial={false}>

                                {activeTab === 'general' && (
                                    <motion.div
                                        key="general"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-6 w-full"
                                    >

                            {/* Telegram API Credentials */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <KeyRound className="w-3.5 h-3.5" />
                                    {t('settings.telegram_creds_title')}
                                </h3>

                                <div className="space-y-2.5 p-3 rounded-lg bg-telegram-hover/50">
                                    <p className="text-xs text-telegram-subtext leading-relaxed">
                                        {t('settings.telegram_creds_desc')}
                                    </p>

                                    <div className="space-y-1">
                                        <label className="text-xs font-medium text-telegram-text">{t('settings.telegram_api_id')}</label>
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            value={telegramApiId}
                                            onChange={e => { setTelegramApiId(e.target.value); setTelegramCredsDirty(true); }}
                                            placeholder="12345678"
                                            className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-sm text-telegram-text font-mono focus:outline-none focus:border-telegram-primary/50 transition"
                                        />
                                    </div>

                                    <div className="space-y-1">
                                        <label className="text-xs font-medium text-telegram-text">{t('settings.telegram_api_hash')}</label>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type={showApiHash ? 'text' : 'password'}
                                                value={telegramApiHash}
                                                onChange={e => { setTelegramApiHash(e.target.value); setTelegramCredsDirty(true); }}
                                                placeholder="0123456789abcdef0123456789abcdef"
                                                autoComplete="off"
                                                className="min-w-0 flex-1 bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-sm text-telegram-text font-mono focus:outline-none focus:border-telegram-primary/50 transition"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowApiHash(v => !v)}
                                                className="shrink-0 p-1.5 rounded-md text-telegram-subtext hover:text-telegram-text hover:bg-telegram-hover transition"
                                                title={showApiHash ? t('settings.telegram_hide_hash') : t('settings.telegram_show_hash')}
                                            >
                                                {showApiHash ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                            </button>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between pt-1">
                                        <button
                                            onClick={() => open('https://my.telegram.org/apps')}
                                            className="text-xs text-telegram-primary hover:underline"
                                        >
                                            {t('settings.telegram_get_credentials')}
                                        </button>
                                        <button
                                            onClick={handleSaveTelegramCredentials}
                                            disabled={savingTelegramCreds || !telegramCredsDirty}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition disabled:opacity-50"
                                        >
                                            {savingTelegramCreds ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                            {t('settings.telegram_creds_save')}
                                        </button>
                                    </div>
                                </div>
                            </section>

                            {/* Transfers Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Upload className="w-3.5 h-3.5" />
                                    {t('settings.transfers')}
                                </h3>

                                {/* Max Concurrent Uploads */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Upload className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.concurrent_uploads')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.max_uploads_desc')}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => updateSetting('maxConcurrentUploads', Math.max(1, settings.maxConcurrentUploads - 1))}
                                            className="w-7 h-7 flex items-center justify-center rounded-md bg-telegram-bg text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition text-sm font-medium"
                                        >
                                            -
                                        </button>
                                        <span className="text-sm text-telegram-text font-medium w-5 text-center">
                                            {settings.maxConcurrentUploads}
                                        </span>
                                        <button
                                            onClick={() => updateSetting('maxConcurrentUploads', Math.min(10, settings.maxConcurrentUploads + 1))}
                                            className="w-7 h-7 flex items-center justify-center rounded-md bg-telegram-bg text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition text-sm font-medium"
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>

                                {/* Max Concurrent Downloads */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Download className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.concurrent_downloads')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.max_downloads_desc')}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => updateSetting('maxConcurrentDownloads', Math.max(1, settings.maxConcurrentDownloads - 1))}
                                            className="w-7 h-7 flex items-center justify-center rounded-md bg-telegram-bg text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition text-sm font-medium"
                                        >
                                            -
                                        </button>
                                        <span className="text-sm text-telegram-text font-medium w-5 text-center">
                                            {settings.maxConcurrentDownloads}
                                        </span>
                                        <button
                                            onClick={() => updateSetting('maxConcurrentDownloads', Math.min(10, settings.maxConcurrentDownloads + 1))}
                                            className="w-7 h-7 flex items-center justify-center rounded-md bg-telegram-bg text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition text-sm font-medium"
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>

                                {/* Zip Folders */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <FolderArchive className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.zip_before_upload')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.zip_folders_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('zipFolders', !settings.zipFolders)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.zipFolders ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.zipFolders ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Hide Folder Groups */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Tag className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('common.hide_groups')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('common.hide_groups_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('hideGroups', !settings.hideGroups)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.hideGroups ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.hideGroups ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Performance Mode */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Zap className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.performance_mode')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.performance_mode_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('performanceMode', !settings.performanceMode)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.performanceMode ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.performanceMode ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Linux Rendering Fix */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Monitor className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.linux_rendering_fix')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.linux_rendering_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => {
                                            updateSetting('linuxRenderingFix', !settings.linuxRenderingFix);
                                            toast.info(t('settings.restart_app_toast'), { duration: 5000 });
                                        }}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.linuxRenderingFix ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.linuxRenderingFix ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                            </section>

                            {/* Language & Region Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Languages className="w-3.5 h-3.5" />
                                    {t('settings.language_region')}
                                </h3>

                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Globe className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.app_language')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.choose_language')}</p>
                                        </div>
                                    </div>
                                    <div className="relative">
                                        <select
                                            value={settings.language}
                                            onChange={e => updateSetting('language', e.target.value as any)}
                                            className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                        >
                                            {LANGUAGES.map(lang => (
                                                <option key={lang.code} value={lang.code}>
                                                    {lang.nativeLabel}
                                                </option>
                                            ))}
                                        </select>
                                        <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    </div>
                                </div>
                            </section>

                            {/* REST API Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Globe className="w-3.5 h-3.5" />
                                    {t('settings.rest_api')}
                                </h3>

                                {/* Enable Toggle */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full ${apiSettings.running ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' : 'bg-gray-500'}`} />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.enable_api_server')}</p>
                                            <p className="text-xs text-telegram-subtext">
                                                {apiSettings.running ? t('settings.api_running', { port: apiSettings.port }) : t('settings.api_stopped')}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={handleApiToggle}
                                        disabled={apiLoading}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${apiSettings.enabled ? 'bg-telegram-primary' : 'bg-telegram-border'} disabled:opacity-50`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${apiSettings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Port */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.port')}</p>
                                        <p className="text-xs text-telegram-subtext">1024 - 65535</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="number"
                                            min="1024"
                                            max="65535"
                                            value={apiPort}
                                            onChange={e => setApiPort(e.target.value)}
                                            onBlur={handlePortApply}
                                            onKeyDown={e => { if (e.key === 'Enter') handlePortApply(); }}
                                            className="w-20 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-center focus:outline-none focus:border-telegram-primary/50 transition"
                                        />
                                    </div>
                                </div>

                                {/* API Key */}
                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2.5">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Key className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.api_key')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {apiSettings.key_set ? t('settings.api_key_configured') : t('settings.api_key_unset')}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={handleGenerateKey}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition"
                                        >
                                            <RefreshCw className="w-3 h-3" />
                                            {apiSettings.key_set ? t('settings.regenerate') : t('settings.generate')}
                                        </button>
                                    </div>

                                    {/* One-time key reveal */}
                                    {generatedKey && (
                                        <div className="mt-2 p-2.5 bg-telegram-bg rounded-lg border border-yellow-500/20">
                                            <p className="text-[10px] text-yellow-400/80 uppercase tracking-wider font-semibold mb-1.5">
                                                {t('settings.api_copy_alert')}
                                            </p>
                                            <div className="flex items-center gap-2">
                                                <code className="flex-1 text-xs text-telegram-text font-mono bg-telegram-hover rounded px-2 py-1.5 overflow-x-auto select-all">
                                                    {generatedKey}
                                                </code>
                                                <button
                                                    onClick={handleCopyKey}
                                                    className="p-1.5 rounded-md hover:bg-telegram-hover text-telegram-subtext hover:text-telegram-text transition flex-shrink-0"
                                                    title="Copy to clipboard"
                                                >
                                                    {keyCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </section>

                            {/* Storage Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <HardDrive className="w-3.5 h-3.5" />
                                    {t('settings.storage')}
                                </h3>

                                {/* Transcode Cache Size */}
                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <HardDrive className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.transcode_cache_limit')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.transcode_cache_desc')}</p>
                                            </div>
                                        </div>
                                        <span className="text-sm text-telegram-primary font-mono font-medium">{settings.transcodeCacheMaxGb} GB</span>
                                    </div>
                                    <input type="range" min="1" max="50" step="1" value={settings.transcodeCacheMaxGb}
                                        onChange={e => {
                                            const gb = parseInt(e.target.value);
                                            updateSetting('transcodeCacheMaxGb', gb);
                                            invoke('cmd_set_transcode_cache_limit', { maxGb: gb }).catch(() => {});
                                        }}
                                        className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                </div>

                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <Trash2 className="w-4 h-4 text-telegram-subtext" />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.clear_local_cache')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.clear_local_cache_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        disabled={clearing}
                                        onClick={async () => {
                                            const ok = await confirm({
                                                title: t('settings.clear_cache_title'),
                                                message: t('settings.clear_cache_desc'),
                                                confirmText: t('settings.clear'),
                                                variant: 'danger',
                                            });
                                            if (!ok) return;
                                            setClearing(true);
                                            try {
                                                await invoke('cmd_clean_cache');
                                                clearImageMemoryCaches();
                                                toast.success(t('settings.cache_cleared'));
                                            } catch {
                                                toast.error(t('settings.cache_clear_failed'));
                                            } finally {
                                                setClearing(false);
                                            }
                                        }}
                                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {clearing ? t('settings.clearing') : t('settings.clear')}
                                    </button>
                                </div>

                                {/* Transcode Cache */}
                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <HardDrive className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.transcode_cache')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {transcodeCache
                                                        ? `${(transcodeCache.total_bytes / 1048576).toFixed(1)} MB / ${(transcodeCache.max_bytes / 1073741824).toFixed(1)} GB`
                                                        : t('common.loading')}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                onClick={fetchTranscodeCache}
                                                disabled={cacheLoading}
                                                className="p-1.5 rounded-md hover:bg-telegram-hover text-telegram-subtext hover:text-telegram-text transition"
                                                title={t('settings.refresh_links')}
                                            >
                                                <RefreshCw className={`w-3 h-3 ${cacheLoading ? 'animate-spin' : ''}`} />
                                            </button>
                                            <button
                                                disabled={!transcodeCache || transcodeCache.entries.length === 0}
                                                onClick={async () => {
                                                    const ok = await confirm({
                                                        title: t('settings.clear_transcode_title'),
                                                        message: t('settings.clear_transcode_message'),
                                                        confirmText: t('settings.clear_all'),
                                                        variant: 'danger',
                                                    });
                                                    if (!ok) return;
                                                    setClearingVariant('__all__');
                                                    try {
                                                        const msg = await invoke<string>('cmd_clear_transcode_cache', {});
                                                        toast.success(msg);
                                                        fetchTranscodeCache();
                                                    } catch (e) {
                                                        toast.error(t('settings.failed_prefix', { error: e }));
                                                    } finally {
                                                        setClearingVariant(null);
                                                    }
                                                }}
                                                className="px-2.5 py-1 rounded-md text-[10px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {clearingVariant === '__all__' ? t('settings.clearing') : t('settings.clear_all')}
                                            </button>
                                        </div>
                                    </div>

                                    {/* Cache entries list */}
                                    {transcodeCache && transcodeCache.entries.length > 0 ? (
                                        <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1 custom-scrollbar">
                                            {/* Group HLS variants by file_key (exclude originals, which are cleared via per-file Clear or Clear All) */}
                                            {(() => {
                                                const grouped: Record<string, CacheEntry[]> = {};
                                                for (const e of transcodeCache.entries) {
                                                    // Skip original entries — they're cleared via per-file or Clear All only
                                                    if (e.quality === 'original') continue;
                                                    if (!grouped[e.file_key]) grouped[e.file_key] = [];
                                                    grouped[e.file_key].push(e);
                                                }
                                                return Object.entries(grouped).map(([fileKey, entries]) => (
                                                    <div key={fileKey} className="p-2 rounded bg-telegram-bg/50 border border-telegram-border/30">
                                                        <div className="flex items-center justify-between mb-1">
                                                            <span className="text-[10px] font-mono text-telegram-subtext truncate max-w-[180px]" title={fileKey}>
                                                                {fileKey}
                                                            </span>
                                                            <button
                                                                disabled={clearingVariant !== null}
                                                                onClick={async () => {
                                                                    setClearingVariant(fileKey);
                                                                    try {
                                                                        const msg = await invoke<string>('cmd_clear_transcode_cache', { fileKey });
                                                                        toast.success(msg);
                                                                        fetchTranscodeCache();
                                                                    } catch (e) {
                                                                        toast.error(t('settings.failed_prefix', { error: e }));
                                                                    } finally {
                                                                        setClearingVariant(null);
                                                                    }
                                                                }}
                                                                className="text-[9px] text-red-400/60 hover:text-red-400 transition px-1 py-0.5 rounded hover:bg-red-500/10 disabled:opacity-30"
                                                                title={t('settings.clear_variants_for', { key: fileKey })}
                                                            >
                                                                {clearingVariant === fileKey ? '...' : t('settings.clear')}
                                                            </button>
                                                        </div>
                                                        <div className="flex flex-wrap gap-1">
                                                            {entries.map(e => (
                                                                <button
                                                                    key={`${e.file_key}:${e.quality}`}
                                                                    disabled={clearingVariant !== null}
                                                                    onClick={async () => {
                                                                        const variantKey = `${e.file_key}:${e.quality}`;
                                                                        setClearingVariant(variantKey);
                                                                        try {
                                                                            const msg = await invoke<string>('cmd_clear_transcode_cache', { fileKey: e.file_key, quality: e.quality });
                                                                            toast.success(msg);
                                                                            fetchTranscodeCache();
                                                                        } catch (err) {
                                                                            toast.error(t('settings.failed_prefix', { error: err }));
                                                                        } finally {
                                                                            setClearingVariant(null);
                                                                        }
                                                                    }}
                                                                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
                                                                        e.playlist_exists
                                                                            ? 'bg-emerald-500/10 text-emerald-400 hover:bg-red-500/10 hover:text-red-400 border border-emerald-500/20'
                                                                            : 'bg-amber-500/10 text-amber-400/60 border border-amber-500/20'
                                                                    } disabled:opacity-30`}
                                                                    title={`${e.quality} — ${(e.size_bytes / 1048576).toFixed(2)} MB${e.playlist_exists ? ' (ready)' : ' (partial)'}`}
                                                                >
                                     {e.quality === 'original' ? t('settings.original') : e.quality}
                                                                    <span className="text-[8px] opacity-60">{e.playlist_exists ? '✓' : '~'}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ));
                                            })()}
                                        </div>
                                    ) : transcodeCache && transcodeCache.entries.length === 0 ? (
                                        <p className="text-[11px] text-telegram-subtext/50 text-center py-2">{t('settings.no_transcoded_cached')}</p>
                                    ) : (
                                        <div className="flex items-center justify-center py-2">
                                            <RefreshCw className="w-3 h-3 text-telegram-subtext animate-spin" />
                                        </div>
                                    )}
                                </div>
                            </section>

                            {/* Updates Section */}
                            <section className="space-y-3">
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Sparkles className="w-3.5 h-3.5" />
                                    {t('settings.updates')}
                                </h3>

                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Download className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.check_for_updates')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {updateVersion ? t('settings.update_available', { version: updateVersion }) : t('settings.check_updates_desc')}
                                                </p>
                                            </div>
                                        </div>
                                        {updateAvailable && !updateDownloading ? (
                                            <button
                                                onClick={handleInstallUpdate}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary text-white hover:bg-telegram-primary/90 transition"
                                            >
                                                <Download className="w-3 h-3" />
                                                {t('settings.update_restart')}
                                            </button>
                                        ) : updateDownloading ? (
                                            <div className="flex items-center gap-2">
                                                <RefreshCw className="w-3.5 h-3.5 text-telegram-primary animate-spin" />
                                                <span className="text-xs text-telegram-primary font-mono">{updateProgress}%</span>
                                            </div>
                                        ) : (
                                            <button
                                                onClick={handleCheckForUpdates}
                                                disabled={updateChecking}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition disabled:opacity-50"
                                            >
                                                <RefreshCw className={`w-3 h-3 ${updateChecking ? 'animate-spin' : ''}`} />
                                                {updateChecking ? t('settings.checking') : t('settings.check_now')}
                                            </button>
                                        )}
                                    </div>
                                    {updateDownloading && (
                                        <div className="w-full h-1.5 bg-telegram-border rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-telegram-primary rounded-full transition-all duration-300"
                                                style={{ width: `${updateProgress}%` }}
                                            />
                                        </div>
                                    )}
                                </div>
                            </section>

                                    </motion.div>
                                )}

                                {activeTab === 'proxy' && (
                                    <motion.section
                                        key="proxy"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-3 w-full"
                                    >
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Shield className="w-3.5 h-3.5" />
                                    {t('settings.proxy_config')}
                                </h3>

                                {/* Enable Proxy */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2.5 h-2.5 rounded-full ${
                                            !settings.proxyEnabled || !settings.proxyLiveStateEnabled
                                                ? 'bg-gray-500' 
                                                : !proxyStatus 
                                                    ? 'bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.5)]' 
                                                    : proxyStatus.reachable 
                                                        ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' 
                                                        : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                                        }`} />
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm text-telegram-text font-medium">{t('common.enable_proxy')}</p>
                                                {settings.proxyEnabled && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-telegram-subtext font-mono">
                                                        {!settings.proxyLiveStateEnabled
                                                            ? t('settings.proxy_status_off') || 'Off'
                                                            : !proxyStatus 
                                                                ? t('settings.proxy_status_checking') || 'Checking…' 
                                                                : proxyStatus.reachable 
                                                                    ? `${t('settings.proxy_status_connected') || 'Connected'} (${proxyStatus.latency_ms}ms)` 
                                                                    : t('settings.proxy_status_unreachable') || 'Unreachable'}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-telegram-subtext">{t('settings.enable_proxy_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('proxyEnabled', !settings.proxyEnabled)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.proxyEnabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.proxyEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Live Connection Monitoring */}
                                {settings.proxyEnabled && (
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.live_state') || 'Live Connection Monitoring'}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.live_state_desc') || 'Periodically check connectivity and display latency'}</p>
                                        </div>
                                        <button
                                            onClick={() => updateSetting('proxyLiveStateEnabled', !settings.proxyLiveStateEnabled)}
                                            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.proxyLiveStateEnabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.proxyLiveStateEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                )}

                                {/* Proxy Type */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.proxy_type')}</p>
                                        <p className="text-xs text-telegram-subtext">
                                            {settings.proxyType === 'socks5' 
                                                ? t('settings.socks5_desc') 
                                                : t('settings.http_bridge_desc') || 'HTTP/HTTPS proxy tunneling via local SOCKS5 bridge.'}
                                        </p>
                                    </div>
                                    <div className="relative">
                                        <select
                                            value={settings.proxyType}
                                            onChange={e => updateSetting('proxyType', e.target.value as 'socks5' | 'http' | 'https')}
                                            className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                        >
                                            <option value="socks5">SOCKS5</option>
                                            <option value="http">HTTP</option>
                                            <option value="https">HTTPS</option>
                                        </select>
                                        <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    </div>
                                </div>

                                {/* Host */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.host')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.host_desc')}</p>
                                    </div>
                                    <input
                                        type="text"
                                        placeholder="e.g. 127.0.0.1"
                                        value={settings.proxyHost}
                                        onChange={e => updateSetting('proxyHost', e.target.value)}
                                        className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                    />
                                </div>

                                {/* Port */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.port')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.port_desc')}</p>
                                    </div>
                                    <input
                                        type="number"
                                        min="1"
                                        max="65535"
                                        value={settings.proxyPort}
                                        onChange={e => updateSetting('proxyPort', Math.max(1, Math.min(65535, parseInt(e.target.value) || 1080)))}
                                        className="w-20 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-center focus:outline-none focus:border-telegram-primary/50 transition"
                                    />
                                </div>

                                {/* SOCKS5/HTTP auth fields */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.username')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.optional')}</p>
                                    </div>
                                    <input
                                        type="text"
                                        placeholder={t('settings.optional')}
                                        value={settings.proxyUsername}
                                        onChange={e => updateSetting('proxyUsername', e.target.value)}
                                        className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                    />
                                </div>
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('common.password')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.optional')}</p>
                                    </div>
                                    <input
                                        type="password"
                                        placeholder={t('settings.optional')}
                                        value={settings.proxyPassword}
                                        onChange={e => updateSetting('proxyPassword', e.target.value)}
                                        className="w-40 bg-telegram-bg border border-telegram-border rounded-md px-2 py-1 text-sm text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                                    />
                                </div>

                                {/* Info note */}
                                <div className="p-3 rounded-lg bg-yellow-500/5 border border-yellow-500/10 space-y-3">
                                    <p className="text-[11px] text-yellow-400/70 leading-relaxed">
                                        {t('settings.proxy_reconnect_note')}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={async () => {
                                                setReconnecting(true);
                                                try {
                                                    const ok = await invoke<boolean>('cmd_reconnect_with_network_settings');
                                                    if (ok) {
                                                        toast.success(t('settings.reconnect_success_toast'));
                                                    } else {
                                                        toast.error(t('settings.reconnect_failed_toast'));
                                                    }
                                                } catch (e) {
                                                    toast.error(t('settings.reconnect_failed_err_toast', { error: e }));
                                                } finally {
                                                    setReconnecting(false);
                                                }
                                            }}
                                            disabled={reconnecting}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary/10 text-telegram-primary hover:bg-telegram-primary/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {reconnecting ? (
                                                <>
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                    {t('settings.reconnecting')}
                                                </>
                                            ) : (
                                                <>
                                                    <RefreshCw className="w-3 h-3" />
                                                    {t('settings.reconnect_now')}
                                                </>
                                            )}
                                        </button>
                                        <button
                                            onClick={async () => {
                                                setIsTestingProxy(true);
                                                try {
                                                    const success = await invoke<boolean>('cmd_test_proxy_traffic');
                                                    if (success) {
                                                        toast.success(t('settings.proxy_test_success') || 'Proxy connection working!');
                                                    } else {
                                                        toast.error(t('settings.proxy_test_failed') || 'Proxy traffic test failed.');
                                                    }
                                                } catch (e) {
                                                    toast.error(`Error testing proxy: ${e}`);
                                                } finally {
                                                    setIsTestingProxy(false);
                                                }
                                            }}
                                            disabled={isTestingProxy || reconnecting || !settings.proxyEnabled}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 text-telegram-text hover:bg-white/10 transition disabled:opacity-30 disabled:cursor-not-allowed"
                                        >
                                            {isTestingProxy ? (
                                                <>
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                    {t('settings.proxy_testing') || 'Testing…'}
                                                </>
                                            ) : (
                                                <>
                                                    <Play className="w-3.5 h-3.5" />
                                                    {t('settings.test_connection') || 'Test Connection'}
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </motion.section>
                        )}

                        {activeTab === 'vpn' && (
                                    <motion.section
                                        key="vpn"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-3 w-full"
                                    >
                                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                    <Zap className="w-3.5 h-3.5" />
                                    {t('settings.vpn_optimizer')}
                                    {latencyMs !== null && (
                                        <span className={`ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                                            latencyMs < 0 ? 'bg-red-500/10 text-red-400' :
                                            latencyMs < 100 ? 'bg-green-500/10 text-green-400' :
                                            latencyMs < 300 ? 'bg-yellow-500/10 text-yellow-400' :
                                            'bg-red-500/10 text-red-400'
                                        }`}>
                                            <Activity className="w-3 h-3 inline mr-0.5" />
                                            {latencyMs < 0 ? 'Offline' : `${latencyMs}ms`}
                                        </span>
                                    )}
                                </h3>

                                {/* Master Toggle */}
                                <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full ${settings.vpnMode ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-gray-500'}`} />
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.vpn_mode')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.vpn_mode_desc')}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => updateSetting('vpnMode', !settings.vpnMode)}
                                        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.vpnMode ? 'bg-emerald-500' : 'bg-telegram-border'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.vpnMode ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>

                                {/* Daily storage cap — total GB moved per day, separate from the
                                    KB/s throttle below (which limits instantaneous speed, not volume) */}
                                <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2.5">
                                    <div>
                                        <p className="text-sm text-telegram-text font-medium">{t('settings.storage_cap')}</p>
                                        <p className="text-xs text-telegram-subtext">{t('settings.storage_cap_desc')}</p>
                                    </div>
                                    {bandwidthStats && (
                                        <p className="text-xs text-telegram-subtext">
                                            {t('settings.storage_cap_used', {
                                                used: ((bandwidthStats.up_bytes + bandwidthStats.down_bytes) / (1024 * 1024 * 1024)).toFixed(2),
                                            })}
                                        </p>
                                    )}
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs text-telegram-subtext">{t('settings.storage_cap_unlimited')}</p>
                                        <button
                                            onClick={() => setCapUnlimited(!capUnlimited)}
                                            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${capUnlimited ? 'bg-emerald-500' : 'bg-telegram-border'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${capUnlimited ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                    {!capUnlimited && (
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number"
                                                min="1"
                                                step="1"
                                                value={capGb}
                                                onChange={e => setCapGb(e.target.value)}
                                                className="w-24 rounded-md border border-telegram-border bg-telegram-bg px-2 py-1.5 text-sm text-telegram-text outline-none transition focus:border-telegram-primary/50"
                                            />
                                            <span className="text-xs text-telegram-subtext">{t('settings.storage_cap_gb_per_day')}</span>
                                        </div>
                                    )}
                                    <button
                                        onClick={handleSaveBandwidthCap}
                                        disabled={savingCap}
                                        className="flex items-center gap-1.5 rounded-lg bg-telegram-primary/10 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/20 disabled:opacity-50"
                                    >
                                        {savingCap ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                        {t('settings.storage_cap_save')}
                                    </button>
                                </div>

                                {settings.vpnMode && (<>
                                    {/* Timeout Multiplier */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.timeout_multiplier')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.timeout_multiplier_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.timeoutMultiplier}×</span>
                                        </div>
                                        <input type="range" min="1" max="5" step="1" value={settings.timeoutMultiplier}
                                            onChange={e => updateSetting('timeoutMultiplier', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Retry Attempts */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.retry_attempts')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.retry_attempts_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.retryAttempts}</span>
                                        </div>
                                        <input type="range" min="0" max="5" step="1" value={settings.retryAttempts}
                                            onChange={e => updateSetting('retryAttempts', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Backoff Settings */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <p className="text-sm text-telegram-text font-medium">{t('settings.retry_backoff')}</p>
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">{t('settings.base_delay')}</p>
                                            <span className="text-xs text-telegram-primary font-mono">{settings.retryBaseBackoffSec}s</span>
                                        </div>
                                        <input type="range" min="0.5" max="5" step="0.5" value={settings.retryBaseBackoffSec}
                                            onChange={e => updateSetting('retryBaseBackoffSec', parseFloat(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">{t('settings.max_delay')}</p>
                                            <span className="text-xs text-telegram-primary font-mono">{settings.retryMaxBackoffSec}s</span>
                                        </div>
                                        <input type="range" min="8" max="60" step="2" value={settings.retryMaxBackoffSec}
                                            onChange={e => updateSetting('retryMaxBackoffSec', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Adaptive Polling */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.adaptive_polling')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.adaptive_polling_desc')}</p>
                                            </div>
                                            <button
                                                onClick={() => updateSetting('adaptivePolling', !settings.adaptivePolling)}
                                                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.adaptivePolling ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                            >
                                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.adaptivePolling ? 'translate-x-5' : 'translate-x-0'}`} />
                                            </button>
                                        </div>
                                        {settings.adaptivePolling && (<>
                                            <div className="flex items-center justify-between">
                                                <p className="text-xs text-telegram-subtext">{t('settings.min_interval')}</p>
                                                <span className="text-xs text-telegram-primary font-mono">{settings.pollingMinSec}s</span>
                                            </div>
                                            <input type="range" min="10" max="30" step="5" value={settings.pollingMinSec}
                                                onChange={e => updateSetting('pollingMinSec', parseInt(e.target.value))}
                                                className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                            <div className="flex items-center justify-between">
                                                <p className="text-xs text-telegram-subtext">{t('settings.max_interval')}</p>
                                                <span className="text-xs text-telegram-primary font-mono">{settings.pollingMaxSec}s</span>
                                            </div>
                                            <input type="range" min="45" max="120" step="15" value={settings.pollingMaxSec}
                                                onChange={e => updateSetting('pollingMaxSec', parseInt(e.target.value))}
                                                className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                        </>)}
                                    </div>

                                    {/* Preferred DC */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.preferred_dc')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.preferred_dc_desc')}</p>
                                        </div>
                                        <div className="relative">
                                            <select
                                                value={settings.preferredDC}
                                                onChange={e => updateSetting('preferredDC', e.target.value as typeof settings.preferredDC)}
                                                className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                            >
                                                <option value="auto">{t('settings.auto')}</option>
                                                <option value="dc1">DC 1</option>
                                                <option value="dc2">DC 2</option>
                                                <option value="dc3">DC 3</option>
                                                <option value="dc4">DC 4</option>
                                                <option value="dc5">DC 5</option>
                                            </select>
                                            <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                        </div>
                                    </div>

                                    {/* DC Fallback Attempts */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.dc_fallback_attempts')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.dc_fallback_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.dcFallbackAttempts}</span>
                                        </div>
                                        <input type="range" min="1" max="4" step="1" value={settings.dcFallbackAttempts}
                                            onChange={e => updateSetting('dcFallbackAttempts', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Flood Wait */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.respect_flood')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.respect_flood_desc')}</p>
                                        </div>
                                        <button
                                            onClick={() => updateSetting('floodWaitRespect', !settings.floodWaitRespect)}
                                            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.floodWaitRespect ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.floodWaitRespect ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>

                                    {/* Peer Cache Size */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.peer_cache_size')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.peer_cache_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">{settings.peerCacheSize}</span>
                                        </div>
                                        <input type="range" min="100" max="2000" step="100" value={settings.peerCacheSize}
                                            onChange={e => updateSetting('peerCacheSize', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Bandwidth Throttle */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <p className="text-sm text-telegram-text font-medium flex items-center gap-1.5">
                                            <Gauge className="w-3.5 h-3.5 text-telegram-subtext" />
                                            {t('settings.bandwidth_throttle')}
                                        </p>
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">{t('settings.upload_limit')}</p>
                                            <span className="text-xs text-telegram-primary font-mono">
                                                {settings.bandwidthLimitUpKBs === 0 ? t('settings.unlimited') : `${settings.bandwidthLimitUpKBs} KB/s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="5120" step="128" value={settings.bandwidthLimitUpKBs}
                                            onChange={e => updateSetting('bandwidthLimitUpKBs', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-telegram-subtext">{t('settings.download_limit')}</p>
                                            <span className="text-xs text-telegram-primary font-mono">
                                                {settings.bandwidthLimitDownKBs === 0 ? t('settings.unlimited') : `${settings.bandwidthLimitDownKBs} KB/s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="5120" step="128" value={settings.bandwidthLimitDownKBs}
                                            onChange={e => updateSetting('bandwidthLimitDownKBs', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Chunk Size */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div>
                                            <p className="text-sm text-telegram-text font-medium">{t('settings.transfer_chunk_size')}</p>
                                            <p className="text-xs text-telegram-subtext">{t('settings.chunk_size_desc')}</p>
                                        </div>
                                        <div className="relative">
                                            <select
                                                value={settings.chunkSizeKb}
                                                onChange={e => updateSetting('chunkSizeKb', parseInt(e.target.value))}
                                                className="appearance-none bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                                            >
                                                <option value={128}>128 KB</option>
                                                <option value={256}>256 KB</option>
                                                <option value={512}>512 KB</option>
                                            </select>
                                            <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                        </div>
                                    </div>

                                    {/* Keep-Alive */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.keep_alive')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.keep_alive_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">
                                                {settings.keepAliveIntervalSec === 0 ? t('settings.off') : `${settings.keepAliveIntervalSec}s`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="120" step="15" value={settings.keepAliveIntervalSec}
                                            onChange={e => updateSetting('keepAliveIntervalSec', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Archive Size Limit */}
                                    <div className="p-3 rounded-lg bg-telegram-hover/50 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.bulk_archive_limit')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.bulk_archive_desc')}</p>
                                            </div>
                                            <span className="text-sm text-telegram-primary font-mono font-medium">
                                                {settings.archiveMaxBytes === 0 ? t('settings.unlimited') : `${settings.archiveMaxBytes} MiB`}
                                            </span>
                                        </div>
                                        <input type="range" min="0" max="2048" step="64" value={settings.archiveMaxBytes}
                                            onChange={e => updateSetting('archiveMaxBytes', parseInt(e.target.value))}
                                            className="w-full h-1.5 rounded-full appearance-none bg-telegram-border accent-telegram-primary cursor-pointer" />
                                    </div>

                                    {/* Auto-Detect VPN */}
                                    <div className="flex items-center justify-between p-3 rounded-lg bg-telegram-hover/50">
                                        <div className="flex items-center gap-2">
                                            <Wifi className="w-4 h-4 text-telegram-subtext" />
                                            <div>
                                                <p className="text-sm text-telegram-text font-medium">{t('settings.auto_detect_vpn')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {vpnDetected === true ? t('settings.vpn_detected') : vpnDetected === false ? t('settings.no_vpn_detected') : t('settings.checking')}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => updateSetting('autoDetectVpn', !settings.autoDetectVpn)}
                                            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.autoDetectVpn ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.autoDetectVpn ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                </>)}
                                    </motion.section>
                                )}

                                {activeTab === 'webdav' && (
                                    <motion.section
                                        key="webdav"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-4 w-full"
                                    >
                                        <div className="flex items-start gap-3 rounded-lg border border-telegram-primary/20 bg-telegram-primary/5 p-3">
                                            <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-telegram-primary" />
                                            <div>
                                                <h3 className="text-sm font-semibold text-telegram-text">{t('settings.webdav_title')}</h3>
                                                <p className="mt-1 text-xs leading-relaxed text-telegram-subtext">{t('settings.webdav_description')}</p>
                                                <p className="mt-1 text-[11px] text-telegram-primary">{t('settings.webdav_local_only')}</p>
                                            </div>
                                        </div>

                                        {!webDavSettings.supported ? (
                                            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-300">
                                                {t('settings.webdav_mobile_unavailable')}
                                            </div>
                                        ) : (
                                            <>
                                                <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
                                                    <div className="flex items-center gap-2">
                                                        <div className={`h-2.5 w-2.5 rounded-full ${
                                                            webDavSettings.running
                                                                ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]'
                                                                : webDavSettings.enabled
                                                                    ? 'animate-pulse bg-amber-400'
                                                                    : 'bg-gray-500'
                                                        }`} />
                                                        <div>
                                                            <p className="text-sm font-medium text-telegram-text">{t('settings.enable_webdav')}</p>
                                                            <p className="text-xs text-telegram-subtext">
                                                                {webDavSettings.running
                                                                    ? t('settings.webdav_running', { port: webDavSettings.port })
                                                                    : t('settings.webdav_stopped')}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <button
                                                        onClick={handleWebDavToggle}
                                                        disabled={webDavLoading || webDavGenerating}
                                                        aria-label={t('settings.enable_webdav')}
                                                        className={`relative h-6 w-11 rounded-full transition-colors duration-200 ${webDavSettings.enabled ? 'bg-telegram-primary' : 'bg-telegram-border'} disabled:opacity-50`}
                                                    >
                                                        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${webDavSettings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                                    </button>
                                                </div>

                                                <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
                                                    <div>
                                                        <p className="text-sm font-medium text-telegram-text">{t('common.port')}</p>
                                                        <p className="text-xs text-telegram-subtext">{t('settings.webdav_port_desc')}</p>
                                                    </div>
                                                    <input
                                                        type="number"
                                                        inputMode="numeric"
                                                        min="1024"
                                                        max="65535"
                                                        value={webDavPort}
                                                        onChange={event => setWebDavPort(event.target.value)}
                                                        onBlur={handleWebDavPortApply}
                                                        onKeyDown={event => {
                                                            if (event.key === 'Enter') {
                                                                event.currentTarget.blur();
                                                            }
                                                        }}
                                                        disabled={webDavLoading || webDavGenerating}
                                                        aria-label={t('common.port')}
                                                        className="w-24 rounded-md border border-telegram-border bg-telegram-bg px-2 py-1.5 text-center font-mono text-sm text-telegram-text outline-none transition focus:border-telegram-primary/50 disabled:opacity-50"
                                                    />
                                                </div>

                                                <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
                                                    <div className="max-w-[75%]">
                                                        <p className="text-sm font-medium text-telegram-text">{t('settings.webdav_allow_changes')}</p>
                                                        <p className="text-xs text-telegram-subtext">{t('settings.webdav_allow_changes_desc')}</p>
                                                    </div>
                                                    <button
                                                        onClick={handleWebDavWriteToggle}
                                                        disabled={webDavLoading || webDavGenerating}
                                                        aria-label={t('settings.webdav_allow_changes')}
                                                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${webDavSettings.write_enabled ? 'bg-telegram-primary' : 'bg-telegram-border'} disabled:opacity-50`}
                                                    >
                                                        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${webDavSettings.write_enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                                    </button>
                                                </div>

                                                <div className="space-y-3 rounded-lg bg-telegram-hover/50 p-3">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <div className="flex min-w-0 items-center gap-2">
                                                            <Key className="h-4 w-4 shrink-0 text-telegram-subtext" />
                                                            <div className="min-w-0">
                                                                <p className="text-sm font-medium text-telegram-text">{t('settings.webdav_connection_link')}</p>
                                                                <p className="text-xs text-telegram-subtext">
                                                                    {webDavSettings.token_set
                                                                        ? t('settings.webdav_link_configured')
                                                                        : t('settings.webdav_link_unset')}
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <button
                                                            onClick={() => void generateWebDavLink(true)}
                                                            disabled={webDavLoading || webDavGenerating}
                                                            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-telegram-primary/10 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/20 disabled:opacity-50"
                                                        >
                                                            <RefreshCw className={`h-3 w-3 ${webDavGenerating ? 'animate-spin' : ''}`} />
                                                            {webDavSettings.token_set ? t('settings.regenerate') : t('settings.generate')}
                                                        </button>
                                                    </div>

                                                    {generatedWebDavUrl && (
                                                        <div className="rounded-lg border border-yellow-500/20 bg-telegram-bg p-2.5">
                                                            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-yellow-400/80">
                                                                {t('settings.webdav_copy_alert')}
                                                            </p>
                                                            <div className="flex items-center gap-2">
                                                                <code className="min-w-0 flex-1 select-all overflow-x-auto rounded bg-telegram-hover px-2 py-1.5 font-mono text-xs text-telegram-text">
                                                                    {generatedWebDavUrl}
                                                                </code>
                                                                <button
                                                                    onClick={handleCopyWebDavUrl}
                                                                    className="shrink-0 rounded-md p-1.5 text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text"
                                                                    title={t('settings.webdav_connection_link')}
                                                                >
                                                                    {webDavUrlCopied
                                                                        ? <Check className="h-4 w-4 text-green-400" />
                                                                        : <Copy className="h-4 w-4" />}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>

                                                <div className="flex items-center gap-2 text-[11px] text-telegram-subtext">
                                                    {(webDavLoading || webDavGenerating) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                                    <span>{webDavSettings.write_enabled ? t('settings.webdav_changes_enabled') : t('settings.webdav_read_only')}</span>
                                                </div>

                                                {webDavSettings.last_error && (
                                                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                                                        <p className="text-xs font-medium text-red-300">{t('settings.webdav_last_error')}</p>
                                                        <p className="mt-1 break-words font-mono text-[11px] text-red-300/80">{webDavSettings.last_error}</p>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </motion.section>
                                )}

                                {activeTab === 'encryption' && (
                                    <motion.section
                                        key="encryption"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                    >
                                        <EncryptionSettingsSection />
                                    </motion.section>
                                )}

                                {activeTab === 'sharing' && (
                                    <motion.section
                                        key="sharing"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-4 w-full"
                                    >
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                                <Link className="w-3.5 h-3.5 text-telegram-primary" />
                                                {t('settings.shared_links', { count: shares.length })}
                                            </h3>
                                            <div className="flex items-center gap-1">
                                                <button
                                                    onClick={() => setShowTempLinkGenerator(true)}
                                                    className="flex items-center gap-1 rounded-md bg-telegram-primary/10 px-2 py-1 text-[11px] font-medium text-telegram-primary hover:bg-telegram-primary/20 transition"
                                                >
                                                    <Plus className="w-3 h-3" />
                                                    {t('temp_link.new_button')}
                                                </button>
                                                <button
                                                    onClick={fetchShares}
                                                    className="text-telegram-subtext hover:text-telegram-text p-1 rounded hover:bg-telegram-hover transition"
                                                    title={t('settings.refresh_links')}
                                                >
                                                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                                                </button>
                                            </div>
                                        </div>

                                        <div className="bg-telegram-hover/30 border border-telegram-border/50 rounded-lg p-3 space-y-2">
                                            <div className="text-[11px] font-semibold text-telegram-text flex items-center gap-1">🌐 {t('settings.ip_override')}</div>
                                            <input
                                                type="text"
                                                placeholder="e.g. 100.115.22.45 or my-pc:14201"
                                                value={globalDomain}
                                                onChange={(e) => setGlobalDomain(e.target.value)}
                                                className="w-full bg-telegram-surface border border-telegram-border rounded-md px-2.5 py-1.5 text-xs text-telegram-text focus:outline-none focus:border-telegram-primary/50 placeholder:text-telegram-subtext/40"
                                            />
                                            <p className="text-[10px] text-telegram-subtext">
                                                {t('settings.ip_override_desc')}
                                            </p>
                                        </div>

                                        <div className="bg-telegram-hover/30 border border-telegram-border/50 rounded-lg p-3 space-y-3">
                                            <div className="text-[11px] font-semibold text-telegram-text flex items-center gap-1">
                                                🤖 {t('settings.relay_title')}
                                            </div>
                                            <p className="text-[10px] text-telegram-subtext">{t('settings.relay_desc')}</p>

                                            <div className="space-y-1.5">
                                                <div className="flex items-center gap-2 text-[11px]">
                                                    {relayStatus?.bot_configured ? (
                                                        <span className="text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> @{relayStatus.bot_username}</span>
                                                    ) : (
                                                        <span className="text-telegram-subtext">{t('settings.relay_bot_not_set')}</span>
                                                    )}
                                                </div>
                                                <div className="flex gap-1.5">
                                                    <input
                                                        type="text"
                                                        placeholder={t('settings.relay_bot_token_placeholder')}
                                                        value={botTokenInput}
                                                        onChange={e => setBotTokenInput(e.target.value)}
                                                        className="flex-1 bg-telegram-surface border border-telegram-border rounded-md px-2.5 py-1.5 text-xs text-telegram-text font-mono focus:outline-none focus:border-telegram-primary/50"
                                                    />
                                                    <button
                                                        onClick={handleSaveBotToken}
                                                        disabled={savingBotToken || !botTokenInput.trim()}
                                                        className="rounded-md bg-telegram-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-telegram-primary hover:bg-telegram-primary/20 disabled:opacity-50 shrink-0"
                                                    >
                                                        {savingBotToken ? <Loader2 className="w-3 h-3 animate-spin" /> : t('settings.relay_save')}
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="space-y-1.5">
                                                <div className="text-[11px]">
                                                    {relayStatus?.worker_configured ? (
                                                        <span className="text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> {t('settings.relay_worker_configured')}</span>
                                                    ) : (
                                                        <span className="text-telegram-subtext">{t('settings.relay_worker_not_set')}</span>
                                                    )}
                                                </div>
                                                <input
                                                    type="text"
                                                    placeholder={t('settings.relay_worker_url_placeholder')}
                                                    value={workerUrlInput}
                                                    onChange={e => setWorkerUrlInput(e.target.value)}
                                                    className="w-full bg-telegram-surface border border-telegram-border rounded-md px-2.5 py-1.5 text-xs text-telegram-text font-mono focus:outline-none focus:border-telegram-primary/50"
                                                />
                                                <input
                                                    type="text"
                                                    placeholder={t('settings.relay_admin_secret_placeholder')}
                                                    value={adminSecretInput}
                                                    onChange={e => setAdminSecretInput(e.target.value)}
                                                    className="w-full bg-telegram-surface border border-telegram-border rounded-md px-2.5 py-1.5 text-xs text-telegram-text font-mono focus:outline-none focus:border-telegram-primary/50"
                                                />
                                                <button
                                                    onClick={handleSaveWorkerConfig}
                                                    disabled={savingWorkerConfig || !workerUrlInput.trim() || !adminSecretInput.trim()}
                                                    className="w-full rounded-md bg-telegram-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-telegram-primary hover:bg-telegram-primary/20 disabled:opacity-50"
                                                >
                                                    {savingWorkerConfig ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : t('settings.relay_save')}
                                                </button>
                                            </div>
                                            <p className="text-[10px] text-telegram-subtext leading-relaxed">
                                                {t('settings.relay_setup_help')}
                                            </p>
                                        </div>

                                        {shares.length === 0 ? (
                                            <div className="py-8 text-center space-y-2">
                                                <Link className="w-8 h-8 text-telegram-subtext/40 mx-auto" />
                                                <p className="text-sm font-medium text-telegram-text">{t('settings.no_active_links')}</p>
                                                <p className="text-xs text-telegram-subtext">{t('settings.no_active_links_desc')}</p>
                                            </div>
                                        ) : (
                                            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                                                {shares.map((share) => {
                                                    const isExpired = share.expires_at ? (share.expires_at < Math.floor(Date.now() / 1000)) : false;
                                                    return (
                                                        <div key={share.id} className="p-3 rounded-lg bg-telegram-hover/40 border border-telegram-border/50 flex flex-col gap-2 relative">
                                                              <div className="flex justify-between items-start gap-4">
                                                                <div className="min-w-0 flex-1">
                                                                    <div className="text-xs font-semibold text-telegram-text truncate" title={share.file_name}>
                                                                        {share.file_name}
                                                                    </div>
                                                                    <div className="flex gap-2 items-center mt-1 flex-wrap text-[10px]">
                                                                        <span className="text-telegram-subtext">
                                                                            {new Date(share.created_at * 1000).toLocaleDateString()}
                                                                        </span>
                                                                        <span className="w-1 h-1 rounded-full bg-telegram-border" />
                                                                        {share.has_password ? (
                                                                            <span className="text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-0.5 font-medium">
                                                                                <Key className="w-2.5 h-2.5" /> {t('settings.protected')}
                                                                            </span>
                                                                        ) : (
                                                                            <span className="text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded font-medium">{t('settings.public')}</span>
                                                                        )}
                                                                        {share.always_on && (
                                                                            <>
                                                                                <span className="w-1 h-1 rounded-full bg-telegram-border" />
                                                                                <span className="text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded font-medium">
                                                                                    {t('settings.always_on_badge')}
                                                                                </span>
                                                                            </>
                                                                        )}
                                                                        <span className="w-1 h-1 rounded-full bg-telegram-border" />
                                                                        {share.expires_at ? (
                                                                            isExpired ? (
                                                                                <span className="text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded font-medium">{t('settings.expired')}</span>
                                                                            ) : (
                                                                                <span className="text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded font-medium">
                                                                                    {t('settings.expires_at', { date: new Date(share.expires_at * 1000).toLocaleDateString() })}
                                                                                </span>
                                                                            )
                                                                        ) : (
                                                                            <span className="text-teal-400 bg-teal-500/10 px-1.5 py-0.5 rounded font-medium">{t('settings.never_expires')}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                
                                                                <div className="flex gap-1">
                                                                    <button
                                                                        onClick={() => handleCopyShare(share.id)}
                                                                        className={`p-1.5 rounded bg-telegram-surface border border-telegram-border text-telegram-text hover:bg-telegram-hover transition ${
                                                                            copiedId === share.id ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : ''
                                                                        }`}
                                                                        title={t('settings.copy_share_link')}
                                                                    >
                                                                        {copiedId === share.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleRevokeShare(share.id)}
                                                                        className="p-1.5 rounded bg-telegram-surface border border-telegram-border text-red-400 hover:bg-red-500/10 hover:border-red-500/30 transition"
                                                                        title={t('settings.revoke_link')}
                                                                    >
                                                                        <Trash2 className="w-3.5 h-3.5" />
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        {/* Temp Links: permissioned, folder-scoped shares */}
                                        <div className="flex items-center justify-between pt-2">
                                            <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                                                <Link2 className="w-3.5 h-3.5 text-telegram-primary" />
                                                {t('temp_link.active_links', { count: folderShares.length })}
                                            </h3>
                                        </div>
                                        {folderShares.length === 0 ? (
                                            <p className="py-3 text-center text-xs text-telegram-subtext">{t('temp_link.no_active_links')}</p>
                                        ) : (
                                            <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1 custom-scrollbar">
                                                {folderShares.map(share => {
                                                    const isExpired = share.expires_at ? (share.expires_at < Math.floor(Date.now() / 1000)) : false;
                                                    const chips: Array<[boolean, string]> = [
                                                        [share.can_upload, t('temp_link.perm_upload')],
                                                        [share.can_download, t('temp_link.perm_download')],
                                                        [share.can_update, t('temp_link.perm_update')],
                                                        [share.can_delete, t('temp_link.perm_delete')],
                                                    ];
                                                    return (
                                                        <div key={share.id} className="p-3 rounded-lg bg-telegram-hover/40 border border-telegram-border/50 flex flex-col gap-2">
                                                            <div className="flex justify-between items-start gap-4">
                                                                <div className="min-w-0 flex-1">
                                                                    <div className="text-xs font-semibold text-telegram-text truncate" title={share.folder_name}>
                                                                        {share.folder_name}
                                                                    </div>
                                                                    <div className="flex gap-1 items-center mt-1.5 flex-wrap text-[10px]">
                                                                        {chips.filter(([on]) => on).map(([, label]) => (
                                                                            <span key={label} className="text-telegram-primary bg-telegram-primary/10 px-1.5 py-0.5 rounded font-medium">{label}</span>
                                                                        ))}
                                                                        {share.has_password && (
                                                                            <span className="text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-0.5 font-medium">
                                                                                <Key className="w-2.5 h-2.5" /> {t('settings.protected')}
                                                                            </span>
                                                                        )}
                                                                        {share.username && (
                                                                            <span className="text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded font-medium" title={share.username}>
                                                                                {t('temp_link.username_badge')}
                                                                            </span>
                                                                        )}
                                                                        {isExpired && (
                                                                            <span className="text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded font-medium">{t('settings.expired')}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <div className="flex gap-1">
                                                                    <button
                                                                        onClick={() => handleCopyFolderShare(share.id)}
                                                                        className={`p-1.5 rounded bg-telegram-surface border border-telegram-border text-telegram-text hover:bg-telegram-hover transition ${
                                                                            copiedFolderShareId === share.id ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : ''
                                                                        }`}
                                                                        title={t('settings.copy_share_link')}
                                                                    >
                                                                        {copiedFolderShareId === share.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleRevokeFolderShare(share.id)}
                                                                        className="p-1.5 rounded bg-telegram-surface border border-telegram-border text-red-400 hover:bg-red-500/10 hover:border-red-500/30 transition"
                                                                        title={t('settings.revoke_link')}
                                                                    >
                                                                        <Trash2 className="w-3.5 h-3.5" />
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </motion.section>
                                )}
                                {activeTab === 'backup' && backupStatus && (
                                    <motion.section
                                        key="backup"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-4 w-full"
                                    >
                                        <div className="flex items-start gap-3 rounded-lg border border-telegram-primary/20 bg-telegram-primary/5 p-3">
                                            <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-telegram-primary" />
                                            <div>
                                                <h3 className="text-sm font-semibold text-telegram-text">{t('settings.backup_title')}</h3>
                                                <p className="mt-1 text-xs leading-relaxed text-telegram-subtext">{t('settings.backup_description')}</p>
                                            </div>
                                        </div>

                                        {/* Schedule */}
                                        <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
                                            <div>
                                                <p className="text-sm font-medium text-telegram-text">{t('settings.backup_schedule_enable')}</p>
                                                <p className="text-xs text-telegram-subtext">
                                                    {backupStatus.settings.enabled && backupStatus.next_scheduled_run_at
                                                        ? t('settings.backup_next_run', { time: new Date(backupStatus.next_scheduled_run_at * 1000).toLocaleString() })
                                                        : t('settings.backup_schedule_disabled')}
                                                </p>
                                            </div>
                                            <button
                                                onClick={handleBackupScheduleToggle}
                                                aria-label={t('settings.backup_schedule_enable')}
                                                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${backupStatus.settings.enabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                            >
                                                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${backupStatus.settings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                            </button>
                                        </div>

                                        <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
                                            <div>
                                                <p className="text-sm font-medium text-telegram-text">{t('settings.autostart_title')}</p>
                                                <p className="text-xs text-telegram-subtext leading-relaxed">{t('settings.autostart_desc')}</p>
                                            </div>
                                            <button
                                                onClick={handleToggleAutostart}
                                                disabled={autostartBusy}
                                                aria-label={t('settings.autostart_title')}
                                                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 ${autostartEnabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                            >
                                                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${autostartEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                            </button>
                                        </div>

                                        <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
                                            <p className="text-sm font-medium text-telegram-text">{t('settings.backup_schedule_time')}</p>
                                            <div className="flex items-center gap-1 font-mono text-sm text-telegram-text">
                                                <input
                                                    type="number" inputMode="numeric" min="0" max="23"
                                                    value={backupHour}
                                                    onChange={e => setBackupHour(e.target.value)}
                                                    onBlur={handleBackupTimeApply}
                                                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                                    className="w-12 rounded-md border border-telegram-border bg-telegram-bg px-1 py-1.5 text-center outline-none transition focus:border-telegram-primary/50"
                                                />
                                                <span>:</span>
                                                <input
                                                    type="number" inputMode="numeric" min="0" max="59"
                                                    value={backupMinute}
                                                    onChange={e => setBackupMinute(e.target.value)}
                                                    onBlur={handleBackupTimeApply}
                                                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                                    className="w-12 rounded-md border border-telegram-border bg-telegram-bg px-1 py-1.5 text-center outline-none transition focus:border-telegram-primary/50"
                                                />
                                            </div>
                                        </div>

                                        {/* Protected folders */}
                                        <div className="space-y-2 rounded-lg bg-telegram-hover/50 p-3">
                                            <div className="flex items-center justify-between">
                                                <p className="text-sm font-medium text-telegram-text">{t('settings.backup_protected_folders')}</p>
                                                <button
                                                    onClick={handleAddBackupFolder}
                                                    disabled={addingBackupFolder}
                                                    className="flex items-center gap-1.5 rounded-lg bg-telegram-primary/10 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/20 disabled:opacity-50"
                                                >
                                                    <FolderPlus className="h-3.5 w-3.5" />
                                                    {t('settings.backup_add_folder')}
                                                </button>
                                            </div>

                                            {backupStatus.settings.sources.length === 0 ? (
                                                <p className="py-2 text-center text-xs text-telegram-subtext">{t('settings.backup_no_folders')}</p>
                                            ) : (
                                                <div className="space-y-1.5">
                                                    {backupStatus.settings.sources.map(source => (
                                                        <div key={source.id} className="flex items-center justify-between gap-2 rounded-lg bg-telegram-bg p-2.5">
                                                            <div className="min-w-0 flex-1">
                                                                <p className="truncate text-sm text-telegram-text">{source.display_name}</p>
                                                                <p className="truncate font-mono text-[11px] text-telegram-subtext">{source.local_path}</p>
                                                                {backupStatus.running && backupStatus.current_source_id === source.id ? (
                                                                    <p className="mt-0.5 text-[11px] text-telegram-primary">
                                                                        {t('settings.backup_in_progress', { done: backupStatus.current_files_done, total: backupStatus.current_files_total })}
                                                                    </p>
                                                                ) : source.last_run_status === 'failed' ? (
                                                                    <p className="mt-0.5 text-[11px] text-red-400">{source.last_error ?? t('settings.backup_status_failed')}</p>
                                                                ) : source.last_run_at ? (
                                                                    <p className="mt-0.5 text-[11px] text-telegram-subtext">
                                                                        {t('settings.backup_last_run', { time: new Date(source.last_run_at * 1000).toLocaleString() })}
                                                                    </p>
                                                                ) : (
                                                                    <p className="mt-0.5 text-[11px] text-telegram-subtext">{t('settings.backup_never_run')}</p>
                                                                )}
                                                            </div>
                                                            <button
                                                                onClick={() => setEditingExclusionsFor(source)}
                                                                className={`shrink-0 rounded-md p-1.5 transition hover:bg-telegram-hover ${source.excluded_paths.length > 0 ? 'text-telegram-primary' : 'text-telegram-subtext hover:text-telegram-text'}`}
                                                                title={source.excluded_paths.length > 0 ? t('settings.backup_exclude_count', { count: source.excluded_paths.length }) : t('settings.backup_exclude_title')}
                                                            >
                                                                <Ban className="h-3.5 w-3.5" />
                                                            </button>
                                                            <button
                                                                onClick={() => handleToggleBackupFolder(source.id, !source.enabled)}
                                                                aria-label={t('settings.backup_folder_enabled')}
                                                                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${source.enabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                                                            >
                                                                <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${source.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                                                            </button>
                                                            <button
                                                                onClick={() => handleRemoveBackupFolder(source.id, source.display_name)}
                                                                className="shrink-0 rounded-md p-1.5 text-telegram-subtext transition hover:bg-telegram-hover hover:text-red-400"
                                                                title={t('settings.backup_remove_confirm')}
                                                            >
                                                                <Trash2 className="h-3.5 w-3.5" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Backup All (OneDrive-style) */}
                                        <button
                                            onClick={handleBackupAll}
                                            disabled={backupAllBusy}
                                            className="flex w-full items-center justify-center gap-2 rounded-lg border border-telegram-border px-3 py-2.5 text-sm font-medium text-telegram-text transition hover:bg-telegram-hover disabled:opacity-50"
                                        >
                                            {backupAllBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
                                            {t('settings.backup_all_button')}
                                        </button>
                                        <p className="-mt-2 text-[11px] text-telegram-subtext">{t('settings.backup_all_desc')}</p>

                                        {/* Backup Now */}
                                        <button
                                            onClick={handleBackupNow}
                                            disabled={backupBusy || backupStatus.running || backupStatus.settings.sources.length === 0}
                                            className="flex w-full items-center justify-center gap-2 rounded-lg bg-telegram-primary px-3 py-2.5 text-sm font-medium text-white transition hover:bg-telegram-primary/90 disabled:opacity-50"
                                        >
                                            {(backupBusy || backupStatus.running) ? (
                                                <>
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    {t('settings.backup_running')}
                                                </>
                                            ) : (
                                                <>
                                                    <Upload className="h-4 w-4" />
                                                    {t('settings.backup_now')}
                                                </>
                                            )}
                                        </button>
                                        {backupStatus.running && (
                                            <button
                                                onClick={handleCancelBackup}
                                                className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-400 transition hover:bg-red-500/10"
                                            >
                                                {t('settings.backup_stop')}
                                            </button>
                                        )}

                                        {/* Restore */}
                                        <div className="space-y-2 rounded-lg bg-telegram-hover/50 p-3">
                                            <p className="text-sm font-medium text-telegram-text">{t('settings.backup_restore_title')}</p>
                                            <select
                                                value={restoreTargetId ?? ''}
                                                onChange={e => setRestoreTargetId(e.target.value || null)}
                                                className="w-full rounded-md border border-telegram-border bg-telegram-bg px-2 py-1.5 text-sm text-telegram-text outline-none transition focus:border-telegram-primary/50"
                                            >
                                                <option value="">{t('settings.backup_restore_select')}</option>
                                                {backupStatus.settings.sources.filter(s => s.channel_id !== null).map(source => (
                                                    <option key={source.id} value={source.id}>{source.display_name}</option>
                                                ))}
                                            </select>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="text"
                                                    value={restorePath}
                                                    onChange={e => setRestorePath(e.target.value)}
                                                    placeholder={t('settings.backup_restore_path_placeholder')}
                                                    className="min-w-0 flex-1 rounded-md border border-telegram-border bg-telegram-bg px-2 py-1.5 text-sm text-telegram-text outline-none transition focus:border-telegram-primary/50"
                                                />
                                                <button
                                                    onClick={handlePickRestoreFolder}
                                                    className="shrink-0 rounded-md border border-telegram-border p-1.5 text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text"
                                                    title={t('settings.backup_restore_browse')}
                                                >
                                                    <FolderOpen className="h-4 w-4" />
                                                </button>
                                            </div>
                                            <button
                                                onClick={handleRestore}
                                                disabled={restoring || backupStatus.running || !restoreTargetId || !restorePath.trim()}
                                                className="flex w-full items-center justify-center gap-2 rounded-lg border border-telegram-primary/30 px-3 py-2 text-sm font-medium text-telegram-primary transition hover:bg-telegram-primary/10 disabled:opacity-50"
                                            >
                                                {restoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                                {t('settings.backup_restore_action')}
                                            </button>
                                        </div>
                                    </motion.section>
                                )}
                                {activeTab === 'google' && (
                                    <motion.section
                                        key="google"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-4 w-full"
                                    >
                                        <div className="flex items-start gap-3 rounded-lg border border-telegram-primary/20 bg-telegram-primary/5 p-3">
                                            <GoogleGlyph className="mt-0.5 h-4 w-4 shrink-0" />
                                            <div>
                                                <h3 className="text-sm font-semibold text-telegram-text">{t('settings.google_title')}</h3>
                                                <p className="mt-1 text-xs leading-relaxed text-telegram-subtext">{t('settings.google_description')}</p>
                                            </div>
                                        </div>

                                        {googleAccount?.connected ? (
                                            <>
                                            <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <GoogleGlyph />
                                                    <span className="text-sm text-telegram-text truncate">{googleAccount.account_email}</span>
                                                </div>
                                                <button
                                                    onClick={handleGoogleSignOut}
                                                    className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/10"
                                                >
                                                    <LogOut className="h-3.5 w-3.5" />
                                                    {t('settings.google_disconnect')}
                                                </button>
                                            </div>

                                            <div className="space-y-2.5 rounded-lg border border-telegram-border/50 bg-telegram-hover/30 p-3">
                                                <div className="flex items-start gap-2">
                                                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-telegram-primary" />
                                                    <div>
                                                        <h4 className="text-sm font-semibold text-telegram-text">{t('settings.totp_title')}</h4>
                                                        <p className="mt-0.5 text-xs leading-relaxed text-telegram-subtext">{t('settings.totp_desc')}</p>
                                                    </div>
                                                </div>

                                                {totpSetupData ? (
                                                    <div className="space-y-3 rounded-lg bg-telegram-bg p-3">
                                                        <p className="text-xs text-telegram-subtext leading-relaxed">{t('settings.totp_scan_instructions')}</p>
                                                        <div
                                                            className="mx-auto w-fit rounded-lg bg-white p-2"
                                                            dangerouslySetInnerHTML={{ __html: totpSetupData.qrSvg }}
                                                        />
                                                        <div className="space-y-1">
                                                            <label className="text-xs font-medium text-telegram-text">{t('settings.totp_setup_key_label')}</label>
                                                            <div className="flex items-center gap-2">
                                                                <input
                                                                    type="text"
                                                                    readOnly
                                                                    value={totpSetupData.base32Secret}
                                                                    className="flex-1 bg-telegram-hover/50 border border-telegram-border rounded-md px-3 py-1.5 text-xs text-telegram-text font-mono select-all"
                                                                />
                                                                <button
                                                                    onClick={() => { navigator.clipboard.writeText(totpSetupData.base32Secret); toast.success(t('common.copied')); }}
                                                                    className="shrink-0 rounded-lg p-1.5 text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text"
                                                                    title={t('common.copy')}
                                                                >
                                                                    <Copy className="h-3.5 w-3.5" />
                                                                </button>
                                                            </div>
                                                            <p className="text-xs text-amber-400 leading-relaxed">{t('settings.totp_setup_key_warning')}</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <label className="text-xs font-medium text-telegram-text">{t('settings.totp_confirm_code_label')}</label>
                                                            <input
                                                                type="text"
                                                                inputMode="numeric"
                                                                value={totpConfirmCode}
                                                                onChange={e => setTotpConfirmCode(e.target.value)}
                                                                placeholder="123456"
                                                                className="w-full bg-telegram-hover/50 border border-telegram-border rounded-md px-3 py-1.5 text-sm text-telegram-text font-mono text-center tracking-[0.3em] focus:outline-none focus:border-telegram-primary/50"
                                                            />
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={handleConfirmTotpSetup}
                                                                disabled={totpBusy || totpConfirmCode.trim().length !== 6}
                                                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-telegram-primary/10 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/20 disabled:opacity-50"
                                                            >
                                                                {totpBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                                                {t('settings.totp_confirm_button')}
                                                            </button>
                                                            <button
                                                                onClick={() => { setTotpSetupData(null); setTotpConfirmCode(''); }}
                                                                className="rounded-lg px-3 py-1.5 text-xs font-medium text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text"
                                                            >
                                                                {t('common.cancel')}
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : totpEnabled ? (
                                                    <div className="flex items-center justify-between rounded-lg bg-telegram-bg p-2.5">
                                                        <div className="flex items-center gap-2 min-w-0">
                                                            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                                                            <span className="text-sm text-telegram-text">{t('settings.totp_enabled')}</span>
                                                        </div>
                                                        <button
                                                            onClick={handleDisableTotp}
                                                            disabled={totpBusy}
                                                            className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                                                        >
                                                            {t('settings.totp_disable_button')}
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={handleStartTotpSetup}
                                                        disabled={totpBusy}
                                                        className="w-full flex items-center justify-center gap-2 rounded-lg border border-telegram-border px-3 py-2.5 text-sm font-medium text-telegram-text transition hover:bg-telegram-hover disabled:opacity-50"
                                                    >
                                                        {totpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                                                        {t('settings.totp_setup_button')}
                                                    </button>
                                                )}
                                            </div>
                                            </>
                                        ) : (
                                            <>
                                                {googleAccount?.client_configured && !editingGoogleClient ? (
                                                    <div className="flex items-center justify-between rounded-lg bg-telegram-hover/50 p-3">
                                                        <div className="flex items-center gap-2 min-w-0">
                                                            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                                                            <span className="text-sm text-telegram-text">{t('settings.google_client_configured')}</span>
                                                        </div>
                                                        <button
                                                            onClick={() => setEditingGoogleClient(true)}
                                                            className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text"
                                                        >
                                                            {t('settings.google_client_change')}
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="space-y-2.5 rounded-lg bg-telegram-hover/50 p-3">
                                                        <p className="text-xs text-telegram-subtext leading-relaxed">{t('settings.google_client_desc')}</p>
                                                        <div className="space-y-1">
                                                            <label className="text-xs font-medium text-telegram-text">{t('settings.google_client_id')}</label>
                                                            <input
                                                                type="text"
                                                                value={googleClientIdInput}
                                                                onChange={e => setGoogleClientIdInput(e.target.value)}
                                                                placeholder="xxxxx.apps.googleusercontent.com"
                                                                className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-sm text-telegram-text font-mono focus:outline-none focus:border-telegram-primary/50 transition"
                                                            />
                                                        </div>
                                                        <div className="space-y-1">
                                                            <label className="text-xs font-medium text-telegram-text">{t('settings.google_client_secret')}</label>
                                                            <input
                                                                type="text"
                                                                value={googleClientSecretInput}
                                                                onChange={e => setGoogleClientSecretInput(e.target.value)}
                                                                placeholder="GOCSPX-..."
                                                                autoComplete="off"
                                                                className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-sm text-telegram-text font-mono focus:outline-none focus:border-telegram-primary/50 transition"
                                                            />
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={handleSaveGoogleClient}
                                                                disabled={savingGoogleClient}
                                                                className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-telegram-primary/10 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/20 disabled:opacity-50"
                                                            >
                                                                {savingGoogleClient ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                                                {t('settings.google_client_save')}
                                                            </button>
                                                            {googleAccount?.client_configured && (
                                                                <button
                                                                    onClick={() => {
                                                                        setEditingGoogleClient(false);
                                                                        setGoogleClientIdInput(googleAccount?.client_id ?? '');
                                                                        setGoogleClientSecretInput(googleAccount?.client_secret ?? '');
                                                                    }}
                                                                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text"
                                                                >
                                                                    {t('common.cancel')}
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}

                                                <button
                                                    onClick={async () => { if (await googleOauth.start()) { /* polling started */ } }}
                                                    disabled={!googleAccount?.client_configured || googleOauth.polling}
                                                    className="w-full flex items-center justify-center gap-2 rounded-lg border border-telegram-border px-3 py-2.5 text-sm font-medium text-telegram-text transition hover:bg-telegram-hover disabled:opacity-50"
                                                >
                                                    {googleOauth.polling ? (
                                                        <>
                                                            <Loader2 className="h-4 w-4 animate-spin" />
                                                            {t('settings.google_connecting')}
                                                        </>
                                                    ) : (
                                                        <>
                                                            <GoogleGlyph />
                                                            {t('settings.google_connect')}
                                                        </>
                                                    )}
                                                </button>
                                                {googleOauth.polling && (
                                                    <button
                                                        onClick={() => googleOauth.cancel()}
                                                        className="w-full text-xs text-telegram-subtext hover:text-telegram-text transition"
                                                    >
                                                        {t('common.cancel')}
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </motion.section>
                                )}
                                {activeTab === 'app-lock' && (
                                    <motion.section
                                        key="app-lock"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-4 w-full"
                                    >
                                        <div className="flex items-start gap-3 rounded-lg border border-telegram-primary/20 bg-telegram-primary/5 p-3">
                                            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-telegram-primary" />
                                            <div>
                                                <h3 className="text-sm font-semibold text-telegram-text">{t('settings.app_lock_title')}</h3>
                                                <p className="mt-1 text-xs leading-relaxed text-telegram-subtext">{t('settings.app_lock_description')}</p>
                                            </div>
                                        </div>

                                        {/* Email sender (SMTP) — required before app lock can send codes */}
                                        <div className="space-y-2.5 rounded-lg bg-telegram-hover/50 p-3">
                                            <div className="flex items-center gap-2 text-sm font-medium text-telegram-text">
                                                <Mail className="h-4 w-4 text-telegram-subtext" />
                                                {t('settings.smtp_title')}
                                            </div>
                                            <p className="text-xs text-telegram-subtext leading-relaxed">{t('settings.smtp_desc')}</p>
                                            {smtpSettings?.configured && (
                                                <p className="text-xs text-emerald-400">{t('settings.smtp_configured_as', { email: smtpSettings.gmail_address })}</p>
                                            )}
                                            <div className="space-y-1">
                                                <label className="text-xs font-medium text-telegram-text">{t('settings.smtp_gmail_address')}</label>
                                                <input
                                                    type="email"
                                                    value={smtpGmailInput}
                                                    onChange={e => setSmtpGmailInput(e.target.value)}
                                                    placeholder="you@gmail.com"
                                                    className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition"
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <label className="text-xs font-medium text-telegram-text">{t('settings.smtp_app_password')}</label>
                                                <input
                                                    type="password"
                                                    value={smtpAppPasswordInput}
                                                    onChange={e => setSmtpAppPasswordInput(e.target.value)}
                                                    placeholder="xxxx xxxx xxxx xxxx"
                                                    autoComplete="off"
                                                    className="w-full bg-telegram-bg border border-telegram-border rounded-md px-3 py-1.5 text-sm text-telegram-text font-mono focus:outline-none focus:border-telegram-primary/50 transition"
                                                />
                                            </div>
                                            <button
                                                onClick={handleSaveSmtp}
                                                disabled={savingSmtp}
                                                className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-telegram-primary/10 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/20 disabled:opacity-50"
                                            >
                                                {savingSmtp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                                {t('settings.smtp_save')}
                                            </button>
                                        </div>

                                        {/* App lock itself */}
                                        {appLockStatus?.enabled && !showAppLockSetup ? (
                                            <div className="space-y-2.5 rounded-lg bg-telegram-hover/50 p-3">
                                                <div className="flex items-center justify-between">
                                                    <div>
                                                        <p className="text-sm font-medium text-telegram-text">{t('settings.app_lock_enabled')}</p>
                                                        <p className="text-xs text-telegram-subtext">{appLockStatus.email}</p>
                                                    </div>
                                                    <button
                                                        onClick={() => handleToggleAppLock(false)}
                                                        className="relative h-6 w-11 shrink-0 rounded-full bg-telegram-primary transition-colors duration-200"
                                                        aria-label={t('settings.app_lock_enabled')}
                                                    >
                                                        <span className="absolute left-0.5 top-0.5 h-5 w-5 translate-x-5 rounded-full bg-white shadow transition-transform duration-200" />
                                                    </button>
                                                </div>
                                                <button
                                                    onClick={() => setShowAppLockSetup(true)}
                                                    className="w-full rounded-lg border border-telegram-border px-3 py-1.5 text-xs font-medium text-telegram-text transition hover:bg-telegram-hover"
                                                >
                                                    {t('settings.app_lock_change_password')}
                                                </button>
                                            </div>
                                        ) : !showAppLockSetup ? (
                                            <div className="space-y-2 rounded-lg bg-telegram-hover/50 p-3">
                                                {appLockStatus && !appLockStatus.enabled && appLockStatus.email && (
                                                    <div className="flex items-center justify-between">
                                                        <p className="text-xs text-telegram-subtext">{t('settings.app_lock_disabled_desc')}</p>
                                                        <button
                                                            onClick={() => handleToggleAppLock(true)}
                                                            className="relative h-6 w-11 shrink-0 rounded-full bg-telegram-border transition-colors duration-200"
                                                            aria-label={t('settings.app_lock_enabled')}
                                                        >
                                                            <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200" />
                                                        </button>
                                                    </div>
                                                )}
                                                <button
                                                    onClick={() => setShowAppLockSetup(true)}
                                                    disabled={!smtpSettings?.configured}
                                                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-telegram-primary/10 px-3 py-2 text-sm font-medium text-telegram-primary transition hover:bg-telegram-primary/20 disabled:opacity-50"
                                                >
                                                    <Lock className="h-4 w-4" />
                                                    {t('settings.app_lock_set_up')}
                                                </button>
                                                {!smtpSettings?.configured && (
                                                    <p className="text-[11px] text-telegram-subtext">{t('settings.app_lock_needs_smtp')}</p>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="rounded-lg bg-telegram-hover/50 p-3">
                                                <AppLockSetupFlow
                                                    mode={appLockStatus?.enabled ? 'reset' : 'setup'}
                                                    initialEmail={appLockStatus?.email ?? ''}
                                                    onComplete={() => { setShowAppLockSetup(false); fetchAppLockStatus(); toast.success(t('settings.app_lock_saved')); }}
                                                    onCancel={() => setShowAppLockSetup(false)}
                                                />
                                            </div>
                                        )}
                                    </motion.section>
                                )}
                                {activeTab === 'themes' && (
                                    <ThemesTab />
                                )}
                                {activeTab === 'about' && (
                                    <motion.section
                                        key="about"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                                        className="space-y-4 w-full"
                                    >
                                        <div className="flex flex-col items-center py-6 space-y-5">
                                            {/* Logo */}
                                            <img src="/logo.svg" className="w-16 h-16 drop-shadow-lg" alt="Telegram Drive Logo" />
                                            
                                            {/* App Name & Version */}
                                            <div className="text-center">
                                                <h3 className="text-base font-bold text-telegram-text">Telegram Drive</h3>
                                                <p className="text-xs text-telegram-subtext mt-0.5">v{appVersion}</p>
                                            </div>

                                            {/* Divider */}
                                            <div className="w-12 h-px bg-telegram-border" />

                                            {/* Diagnostics */}
                                            <button
                                                onClick={async () => {
                                                    setDiagLoading(true);
                                                    try {
                                                        const info = await invoke<string>('cmd_get_system_diagnostics');
                                                        await navigator.clipboard.writeText(info);
                                                        toast.success(t('settings.diagnostics_copied'));
                                                    } catch (e) {
                                                        toast.error(t('settings.diagnostics_copy_failed', { error: e }));
                                                    } finally {
                                                        setDiagLoading(false);
                                                    }
                                                }}
                                                disabled={diagLoading}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-telegram-hover border border-telegram-border text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border/30 transition disabled:opacity-50"
                                            >
                                                {diagLoading ? (
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                ) : (
                                                    <Clipboard className="w-3 h-3" />
                                                )}
                                                {t('settings.copy_diagnostics')}
                                            </button>

                                            {/* Creator Info */}
                                            <div className="text-center space-y-3">
                                                <div>
                                                    <p className="text-sm font-semibold text-telegram-text">Cameron Amer</p>
                                                </div>

                                                {/* Website Link */}
                                                <button
                                                    onClick={(e) => { e.preventDefault(); open('https://www.cameronamer.com'); }}
                                                    className="flex items-center justify-center gap-1.5 text-xs text-telegram-primary hover:text-telegram-primary/80 transition-colors cursor-pointer"
                                                >
                                                    <Globe className="w-3.5 h-3.5" />
                                                    www.cameronamer.com
                                                </button>

                                                {/* GitHub Link */}
                                                <button
                                                    onClick={(e) => { e.preventDefault(); open('https://github.com/caamer20/telegram-drive'); }}
                                                    className="flex items-center justify-center gap-1.5 text-xs text-telegram-primary hover:text-telegram-primary/80 transition-colors cursor-pointer"
                                                >
                                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                                                    </svg>
                                                    github.com/caamer20/telegram-drive
                                                </button>
                                            </div>

                                            {/* Tagline */}
                                            <p className="text-[11px] text-telegram-subtext/60 leading-relaxed max-w-[280px] text-center">
                                                {t('settings.tagline')}
                                            </p>
                                        </div>
                                    </motion.section>
                                )}
                            </AnimatePresence>
                        </div>
                        </div>

                        {/* Footer */}
                        <div className="flex items-center justify-between border-t border-app-border-subtle px-6 py-3">
                            <button
                                onClick={resetSettings}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-telegram-subtext hover:text-red-400 hover:bg-red-500/10 transition font-medium"
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                                {t('settings.reset_defaults')}
                            </button>
                            <button
                                onClick={onClose}
                                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-telegram-primary text-white hover:bg-telegram-primary/90 transition"
                            >
                                {t('settings.done')}
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
        {showTempLinkGenerator && (
            <TempLinkGeneratorModal
                folders={folders}
                onClose={() => { setShowTempLinkGenerator(false); fetchShares(); }}
                onFolderCreated={() => { /* folder list refresh is owned by DesktopDashboard's query */ }}
            />
        )}
        {pendingBackupLocalPath && !showBackupExcludeStep && (
            <BackupDestinationModal
                folders={folders}
                onClose={handleCancelBackupAdd}
                onSelect={handleDestinationChosen}
            />
        )}
        {pendingBackupLocalPath && showBackupExcludeStep && (
            <BackupExcludeModal
                rootPath={pendingBackupLocalPath}
                initialExcluded={[]}
                onClose={handleCancelBackupAdd}
                onConfirm={handleConfirmBackupDestination}
            />
        )}
        {editingExclusionsFor && (
            <BackupExcludeModal
                rootPath={editingExclusionsFor.local_path}
                initialExcluded={editingExclusionsFor.excluded_paths}
                onClose={() => setEditingExclusionsFor(null)}
                onConfirm={handleSaveExclusions}
            />
        )}
        </>
    );
}

// ── Themes Tab ──────────────────────────────────────────────────────
// Inline component (follows the pattern of the other tabs in this file).

const PALETTE_KEYS: { key: keyof ThemeColorPalette; labelKey: string; defaultLabel: string }[] = [
    { key: 'bg', labelKey: 'settings.color_bg', defaultLabel: 'Canvas' },
    { key: 'surface', labelKey: 'settings.color_surface', defaultLabel: 'Surface' },
    { key: 'primary', labelKey: 'settings.color_primary', defaultLabel: 'Accent' },
    { key: 'secondary', labelKey: 'settings.color_secondary', defaultLabel: 'Information' },
    { key: 'text', labelKey: 'settings.color_text', defaultLabel: 'Text' },
    { key: 'subtext', labelKey: 'settings.color_subtext', defaultLabel: 'Secondary text' },
    { key: 'border', labelKey: 'settings.color_border', defaultLabel: 'Border' },
    { key: 'hover', labelKey: 'settings.color_hover', defaultLabel: 'Hover' },
];

function ThemesTab() {
    const { t } = useTranslation();
    const {
        customThemes,
        themePreference,
        setThemePreference,
        activeCustomThemeId,
        setActiveCustomTheme,
        addCustomTheme,
        deleteCustomTheme,
        updateCustomTheme,
    } = useTheme();
    const { confirm } = useConfirm();

    const [editingId, setEditingId] = useState<string | null>(null);

    const builtinThemes = customThemes.filter(t => t.isBuiltin);
    const userThemes = customThemes.filter(t => !t.isBuiltin);
    const editingTheme = editingId ? customThemes.find(t => t.id === editingId) : null;

    const handleCreateTheme = () => {
        const id = generateThemeId();
        const newTheme: CustomTheme = {
            id,
            name: 'My Theme',
            isDark: true,
            palette: getDefaultPalette(true),
        };
        addCustomTheme(newTheme);
        setEditingId(id);
        setActiveCustomTheme(id);
    };

    const handleSelectTheme = (theme: CustomTheme) => {
        if (activeCustomThemeId === theme.id) {
            // Deselect → reset to default
            setActiveCustomTheme(null);
            setEditingId(null);
        } else {
            setActiveCustomTheme(theme.id);
            if (!theme.isBuiltin) {
                setEditingId(theme.id);
            } else {
                setEditingId(null);
            }
        }
    };

    const handleDeleteTheme = async (id: string) => {
        const ok = await confirm({
            title: t('settings.delete_theme'),
            message: t('settings.delete_theme_confirm'),
            confirmText: t('common.delete'),
            variant: 'danger',
        });
        if (!ok) return;
        deleteCustomTheme(id);
        if (editingId === id) setEditingId(null);
    };

    const handlePaletteChange = (key: keyof ThemeColorPalette, value: string) => {
        if (!editingTheme || editingTheme.isBuiltin) return;
        const newPalette = { ...editingTheme.palette, [key]: value };
        updateCustomTheme(editingTheme.id, { palette: newPalette });
    };

    const handleBaseToggle = (isDark: boolean) => {
        if (!editingTheme || editingTheme.isBuiltin) return;
        updateCustomTheme(editingTheme.id, { isDark });
    };

    const handleNameChange = (name: string) => {
        if (!editingTheme || editingTheme.isBuiltin) return;
        updateCustomTheme(editingTheme.id, { name });
    };

    return (
        <motion.section
            key="themes"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
            className="w-full space-y-6"
        >
            <div className="space-y-2">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-app-text-secondary">
                    <Monitor className="h-3.5 w-3.5" />
                    {t('common.theme')}
                </h3>
                <div className="grid grid-cols-4 gap-2 rounded-container border border-app-border-subtle bg-app-surface-sunken/30 p-2">
                    {([
                        ['default', Sparkles, t('common.default', { defaultValue: 'Default' })],
                        ['system', Monitor, 'System'],
                        ['light', Sun, t('common.light_mode')],
                        ['dark', Moon, t('common.dark_mode')],
                    ] as const).map(([preference, Icon, label]) => (
                        <button
                            key={preference}
                            onClick={() => setThemePreference(preference)}
                            className={`quiet-control flex items-center justify-center gap-2 border px-3 py-2 text-xs font-medium ${
                                !activeCustomThemeId && themePreference === preference
                                    ? 'border-app-accent/40 bg-app-selected text-app-accent'
                                    : 'border-transparent text-app-text-secondary hover:text-app-text'
                            }`}
                        >
                            <Icon className="h-3.5 w-3.5" />
                            {label}
                        </button>
                    ))}
                </div>
                <p className="text-xs leading-relaxed text-app-text-tertiary">
                    Default restores the Quiet Utility theme. System follows your device, while presets and custom themes override these standard modes.
                </p>
            </div>

            {/* Presets */}
            <div className="space-y-2">
                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                    <Palette className="w-3.5 h-3.5" />
                    {t('settings.presets')}
                </h3>
                <div className="grid grid-cols-4 gap-3">
                    {builtinThemes.map(theme => (
                        <button
                            key={theme.id}
                            onClick={() => handleSelectTheme(theme)}
                            className={`relative rounded-container border p-1.5 transition-colors ${
                                activeCustomThemeId === theme.id
                                    ? 'border-app-accent bg-app-selected'
                                    : 'border-app-border-subtle hover:border-app-border-strong'
                            }`}
                            title={theme.name}
                        >
                            {/* Color preview swatch */}
                            <div className="flex h-12 overflow-hidden rounded-control">
                                <div className="flex-1" style={{ background: theme.palette.bg }} />
                                <div className="flex-1" style={{ background: theme.palette.surface }} />
                                <div className="flex-1" style={{ background: theme.palette.primary }} />
                            </div>
                            <p className="mt-1.5 truncate text-center text-[10px] text-app-text-secondary">
                                {theme.name}
                            </p>
                            {activeCustomThemeId === theme.id && (
                                <div className="absolute -end-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-app-accent">
                                    <Check className="h-2.5 w-2.5 text-app-accent-contrast" />
                                </div>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            {/* Custom Themes */}
            <div className="space-y-2">
                <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5" />
                    {t('settings.custom_themes')}
                </h3>

                {userThemes.length > 0 && (
                    <div className="grid grid-cols-4 gap-3">
                        {userThemes.map(theme => (
                            <button
                                key={theme.id}
                                onClick={() => handleSelectTheme(theme)}
                                className={`relative rounded-container border p-1.5 transition-colors ${
                                    activeCustomThemeId === theme.id
                                        ? 'border-app-accent bg-app-selected'
                                        : 'border-app-border-subtle hover:border-app-border-strong'
                                }`}
                                title={theme.name}
                            >
                                <div className="flex h-12 overflow-hidden rounded-control">
                                    <div className="flex-1" style={{ background: theme.palette.bg }} />
                                    <div className="flex-1" style={{ background: theme.palette.surface }} />
                                    <div className="flex-1" style={{ background: theme.palette.primary }} />
                                </div>
                                <p className="mt-1.5 truncate text-center text-[10px] text-app-text-secondary">
                                    {theme.name}
                                </p>
                                {activeCustomThemeId === theme.id && (
                                    <div className="absolute -end-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-app-accent">
                                        <Check className="h-2.5 w-2.5 text-app-accent-contrast" />
                                    </div>
                                )}
                            </button>
                        ))}
                    </div>
                )}

                <button
                    onClick={handleCreateTheme}
                    className="quiet-control flex w-full items-center justify-center gap-2 border border-dashed border-app-border px-3 py-2.5 text-xs text-app-text-secondary hover:border-app-accent/50 hover:text-app-accent"
                >
                    <Plus className="w-3.5 h-3.5" />
                    {t('settings.create_theme')}
                </button>
            </div>

            {/* Editor (shown when a custom theme is selected) */}
            {editingTheme && !editingTheme.isBuiltin && (
                <div className="quiet-surface space-y-4 p-4">
                    <h3 className="text-xs font-semibold text-telegram-subtext uppercase tracking-wider">
                        {t('settings.edit_theme')}
                    </h3>

                    {/* Theme Name */}
                    <div className="flex items-center gap-2">
                        <label className="text-xs text-telegram-subtext w-16 shrink-0">{t('settings.theme_name')}</label>
                        <input
                            type="text"
                            value={editingTheme.name}
                            onChange={e => handleNameChange(e.target.value)}
                            className="flex-1 px-2 py-1.5 rounded-md text-xs bg-telegram-surface border border-telegram-border text-telegram-text focus:border-telegram-primary outline-none transition"
                            maxLength={32}
                        />
                    </div>

                    {/* Base Mode Toggle */}
                    <div className="flex items-center gap-2">
                        <label className="text-xs text-telegram-subtext w-16 shrink-0">{t('settings.base_mode')}</label>
                        <div className="flex gap-1">
                            <button
                                onClick={() => handleBaseToggle(true)}
                                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                                    editingTheme.isDark
                                        ? 'bg-telegram-primary text-white'
                                        : 'bg-telegram-hover text-telegram-subtext hover:text-telegram-text'
                                }`}
                            >
                                Dark
                            </button>
                            <button
                                onClick={() => handleBaseToggle(false)}
                                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                                    !editingTheme.isDark
                                        ? 'bg-telegram-primary text-white'
                                        : 'bg-telegram-hover text-telegram-subtext hover:text-telegram-text'
                                }`}
                            >
                                Light
                            </button>
                        </div>
                    </div>

                    {/* Color Pickers */}
                    <div className="space-y-2">
                        {PALETTE_KEYS.map(({ key, labelKey, defaultLabel }) => (
                            <div key={key} className="flex items-center gap-2">
                                <label className="w-24 shrink-0 text-xs text-telegram-subtext">{t(labelKey, { defaultValue: defaultLabel })}</label>
                                <div className="flex items-center gap-1.5 flex-1">
                                    <input
                                        type="color"
                                        value={editingTheme.palette[key].startsWith('rgba') ? '#888888' : editingTheme.palette[key]}
                                        onChange={e => handlePaletteChange(key, e.target.value)}
                                        className="w-7 h-7 rounded-md border border-telegram-border cursor-pointer p-0.5 bg-transparent"
                                    />
                                    <input
                                        type="text"
                                        value={editingTheme.palette[key]}
                                        onChange={e => handlePaletteChange(key, e.target.value)}
                                        className="flex-1 px-2 py-1 rounded-md text-xs bg-telegram-surface border border-telegram-border text-telegram-text focus:border-telegram-primary outline-none transition font-mono"
                                        maxLength={30}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Delete Button */}
                    <button
                        onClick={() => handleDeleteTheme(editingTheme.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10 transition"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        {t('settings.delete_theme')}
                    </button>
                </div>
            )}

            {/* Reset to Default */}
            {activeCustomThemeId && (
                <button
                    onClick={() => {
                        setThemePreference('default');
                        setEditingId(null);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-telegram-subtext hover:text-telegram-text bg-telegram-hover/50 hover:bg-telegram-hover transition"
                >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {t('settings.reset_default')}
                </button>
            )}
        </motion.section>
    );
}
