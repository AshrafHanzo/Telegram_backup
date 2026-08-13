import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check, X, ScrollText } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { IconButton, MenuPanel } from '../../ui';
import { AuditLogModal } from './AuditLogModal';
import { EmptyState } from './EmptyState';

interface NotificationRow {
    id: string;
    kind: string;
    title: string;
    message: string;
    created_at: number;
    read: boolean;
    requires_action: boolean;
    action_resolved: boolean;
    action_payload: string | null;
}

const POLL_MS = 10_000;

// The bell lives in TopBar, top-right, next to the other toolbar icons — see
// the note in SettingsModal about why this can't literally sit inside the
// native minimize/restore/close bar (that's OS-drawn chrome, not ours).
export function NotificationBell() {
    const { t } = useTranslation();
    const [notifications, setNotifications] = useState<NotificationRow[]>([]);
    const [open, setOpen] = useState(false);
    const [showAuditLog, setShowAuditLog] = useState(false);
    const [respondingTo, setRespondingTo] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const fetchNotifications = useCallback(async () => {
        try {
            const rows = await invoke<NotificationRow[]>('cmd_list_notifications');
            setNotifications(rows);
        } catch {
            // Non-critical — leave previous state as-is.
        }
    }, []);

    useEffect(() => {
        fetchNotifications();
        const interval = setInterval(fetchNotifications, POLL_MS);
        return () => clearInterval(interval);
    }, [fetchNotifications]);

    useEffect(() => {
        if (!open) return;
        const close = (event: MouseEvent) => {
            if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
        };
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [open]);

    const unreadCount = notifications.filter(n => !n.read).length;

    const handleOpen = useCallback(() => {
        setOpen(value => !value);
        if (!open && unreadCount > 0) {
            invoke('cmd_mark_all_notifications_read').then(fetchNotifications).catch(() => {});
        }
    }, [open, unreadCount, fetchNotifications]);

    const handleDelete = useCallback(async (id: string) => {
        setNotifications(prev => prev.filter(n => n.id !== id));
        try {
            await invoke('cmd_delete_notification', { id });
        } catch {
            fetchNotifications();
        }
    }, [fetchNotifications]);

    const handleClearAll = useCallback(async () => {
        setNotifications([]);
        try {
            await invoke('cmd_delete_all_notifications');
        } catch {
            fetchNotifications();
        }
    }, [fetchNotifications]);

    const handleRespond = useCallback(async (id: string, approved: boolean) => {
        setRespondingTo(id);
        try {
            await invoke('cmd_respond_to_notification', { id, approved });
            toast.success(approved ? t('notifications.approved') : t('notifications.denied'));
            await fetchNotifications();
        } catch (error) {
            toast.error(t('notifications.respond_failed', { error }));
        } finally {
            setRespondingTo(null);
        }
    }, [fetchNotifications, t]);

    return (
        <div className="relative" ref={panelRef}>
            <IconButton label={t('notifications.title')} onClick={handleOpen} aria-expanded={open} className="relative">
                <Bell className="h-3.5 w-3.5" />
                {unreadCount > 0 && (
                    <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-app-danger px-1 text-[10px] font-semibold leading-none text-white">
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </IconButton>
            {open && (
                <MenuPanel className="absolute end-0 top-9 z-50 w-80 max-h-[26rem] overflow-hidden flex flex-col p-0">
                    <div className="flex items-center justify-between border-b border-app-border-subtle px-3 py-2">
                        <span className="text-ui font-semibold text-app-text">{t('notifications.title')}</span>
                        {notifications.length > 0 && (
                            <button onClick={handleClearAll} className="text-metadata text-app-text-secondary hover:text-app-text">
                                {t('notifications.clear_all')}
                            </button>
                        )}
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {notifications.length === 0 ? (
                            <EmptyState
                                icon={<Bell className="h-5 w-5" strokeWidth={1.6} />}
                                title={t('notifications.empty')}
                                tone="accent"
                                compact
                            />
                        ) : (
                            notifications.map(n => (
                                <div key={n.id} className="border-b border-app-border-subtle p-3 last:border-0">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="text-ui font-medium text-app-text">{n.title}</p>
                                            <p className="mt-0.5 text-metadata text-app-text-secondary leading-relaxed">{n.message}</p>
                                            <p className="mt-1 text-badge text-app-text-tertiary">{new Date(n.created_at * 1000).toLocaleString()}</p>
                                        </div>
                                        <button onClick={() => handleDelete(n.id)} className="shrink-0 text-app-text-tertiary hover:text-app-danger" title={t('common.delete')}>
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                    {n.requires_action && !n.action_resolved && (
                                        <div className="mt-2 flex gap-2">
                                            <button
                                                onClick={() => handleRespond(n.id, true)}
                                                disabled={respondingTo === n.id}
                                                className="flex-1 rounded-md bg-app-accent/10 px-2 py-1 text-metadata font-medium text-app-accent transition hover:bg-app-accent/20 disabled:opacity-50"
                                            >
                                                <Check className="me-1 inline h-3 w-3" />{t('notifications.approve')}
                                            </button>
                                            <button
                                                onClick={() => handleRespond(n.id, false)}
                                                disabled={respondingTo === n.id}
                                                className="flex-1 rounded-md bg-app-danger/10 px-2 py-1 text-metadata font-medium text-app-danger transition hover:bg-app-danger/20 disabled:opacity-50"
                                            >
                                                <X className="me-1 inline h-3 w-3" />{t('notifications.deny')}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                    <button
                        onClick={() => { setShowAuditLog(true); setOpen(false); }}
                        className="flex items-center justify-center gap-1.5 border-t border-app-border-subtle py-2 text-metadata font-medium text-app-text-secondary hover:bg-app-hover hover:text-app-text"
                    >
                        <ScrollText className="h-3.5 w-3.5" />
                        {t('notifications.view_audit_log')}
                    </button>
                </MenuPanel>
            )}
            {showAuditLog && <AuditLogModal onClose={() => setShowAuditLog(false)} />}
        </div>
    );
}
