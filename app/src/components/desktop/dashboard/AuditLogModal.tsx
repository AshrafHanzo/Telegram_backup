import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Trash2, Loader2, RefreshCw, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatBytes } from '../../../utils';
import { EmptyState } from './EmptyState';

interface AuditLogRow {
    id: string;
    event_type: string;
    detail: string;
    file_name: string | null;
    bytes: number | null;
    source_id: string | null;
    created_at: number;
}

interface AuditLogModalProps {
    onClose: () => void;
}

// Itemized history reachable from the notification bell — separate from
// notifications themselves, which are short-lived; this is the permanent
// per-file record ("what uploaded, what time") that notifications summarize.
export function AuditLogModal({ onClose }: AuditLogModalProps) {
    const { t } = useTranslation();
    const [logs, setLogs] = useState<AuditLogRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const fetchLogs = useCallback(async () => {
        try {
            const rows = await invoke<AuditLogRow[]>('cmd_list_audit_logs');
            setLogs(rows);
            return rows;
        } catch (error) {
            toast.error(t('notifications.audit_log_load_failed', { error }));
            return [];
        } finally {
            setLoading(false);
        }
    }, [t]);

    // The local table is the only copy of a permanent record — if it's
    // empty (fresh install, lost device), best-effort pull back whatever
    // snapshot is sitting in Saved Messages before concluding there's
    // really nothing to show.
    useEffect(() => {
        (async () => {
            const rows = await fetchLogs();
            if (rows.length === 0) {
                try {
                    const restored = await invoke<number>('cmd_restore_audit_log_from_telegram');
                    if (restored > 0) await fetchLogs();
                } catch {
                    // Not connected, or nothing synced yet — fine, leave it empty.
                }
            }
        })();
    }, [fetchLogs]);

    const handleSyncNow = useCallback(async () => {
        setSyncing(true);
        try {
            await invoke('cmd_sync_audit_log_to_telegram');
            toast.success(t('notifications.audit_log_synced'));
        } catch (error) {
            toast.error(t('notifications.audit_log_sync_failed', { error }));
        } finally {
            setSyncing(false);
        }
    }, [t]);

    const allSelected = logs.length > 0 && selected.size === logs.length;
    const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(logs.map(l => l.id)));
    const toggleOne = (id: string) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const handleDeleteOne = useCallback(async (id: string) => {
        setLogs(prev => prev.filter(l => l.id !== id));
        setSelected(prev => { const next = new Set(prev); next.delete(id); return next; });
        try {
            await invoke('cmd_delete_audit_log', { id });
        } catch {
            fetchLogs();
        }
    }, [fetchLogs]);

    const handleDeleteSelected = useCallback(async () => {
        const ids = [...selected];
        setLogs(prev => prev.filter(l => !selected.has(l.id)));
        setSelected(new Set());
        try {
            await Promise.all(ids.map(id => invoke('cmd_delete_audit_log', { id })));
        } catch {
            fetchLogs();
        }
    }, [selected, fetchLogs]);

    const handleDeleteAll = useCallback(async () => {
        setLogs([]);
        setSelected(new Set());
        try {
            await invoke('cmd_delete_all_audit_logs');
        } catch {
            fetchLogs();
        }
    }, [fetchLogs]);

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onClick={onClose}>
            <div className="quiet-raised flex h-[min(600px,80vh)] w-[min(560px,calc(100vw-2rem))] flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between border-b border-telegram-border p-4">
                    <h3 className="text-telegram-text font-medium">{t('notifications.audit_log_title')}</h3>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={handleSyncNow}
                            disabled={syncing}
                            title={t('notifications.audit_log_sync_now')}
                            className="rounded-md p-1.5 text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text disabled:opacity-50"
                        >
                            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </button>
                        <button onClick={onClose} className="text-telegram-subtext hover:text-telegram-text"><Plus className="w-5 h-5 rotate-45" /></button>
                    </div>
                </div>
                <p className="border-b border-telegram-border px-4 py-2 text-[11px] text-telegram-subtext">
                    {t('notifications.audit_log_sync_desc')}
                </p>

                {logs.length > 0 && (
                    <div className="flex items-center justify-between border-b border-telegram-border px-4 py-2">
                        <label className="flex items-center gap-2 text-xs text-telegram-subtext">
                            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                            {t('notifications.select_all')}
                        </label>
                        <div className="flex gap-3">
                            {selected.size > 0 && (
                                <button onClick={handleDeleteSelected} className="text-xs font-medium text-red-400 hover:text-red-300">
                                    {t('notifications.delete_selected', { count: selected.size })}
                                </button>
                            )}
                            <button onClick={handleDeleteAll} className="text-xs font-medium text-telegram-subtext hover:text-red-400">
                                {t('notifications.clear_all')}
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto p-2">
                    {loading ? (
                        <div className="flex items-center justify-center py-8 text-app-text-secondary"><Loader2 className="h-5 w-5 animate-spin" /></div>
                    ) : logs.length === 0 ? (
                        <EmptyState
                            icon={<History className="h-6 w-6" strokeWidth={1.6} />}
                            title={t('notifications.audit_log_empty')}
                            description="Backups, uploads, and remote jobs will show up here once something happens."
                            tone="accent"
                        />
                    ) : (
                        <div className="space-y-1">
                            {logs.map(entry => (
                                <div key={entry.id} className="flex items-center gap-2.5 rounded-lg bg-telegram-hover/50 p-2.5">
                                    <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleOne(entry.id)} className="shrink-0" />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm text-telegram-text">{entry.detail}</p>
                                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-telegram-subtext">
                                            <span>{new Date(entry.created_at * 1000).toLocaleString()}</span>
                                            {entry.bytes != null && <span>· {formatBytes(entry.bytes)}</span>}
                                        </p>
                                    </div>
                                    <button onClick={() => handleDeleteOne(entry.id)} className="shrink-0 rounded-md p-1.5 text-telegram-subtext transition hover:bg-telegram-hover hover:text-red-400">
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
