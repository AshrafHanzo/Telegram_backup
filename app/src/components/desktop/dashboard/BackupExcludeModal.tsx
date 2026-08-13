import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Folder, File, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface LocalDirEntry {
    name: string;
    is_dir: boolean;
}

interface BackupExcludeModalProps {
    /** Absolute local path of the backup source's root folder. */
    rootPath: string;
    /** Paths already excluded, relative to rootPath, '/'-separated. */
    initialExcluded: string[];
    onClose: () => void;
    onConfirm: (excludedPaths: string[]) => void;
}

interface NodeState {
    expanded: boolean;
    loading: boolean;
    children: LocalDirEntry[] | null;
}

// A single level of the tree is fetched lazily (cmd_list_local_dir_entries)
// only when expanded — a source folder can be huge, so walking the whole
// thing up front just to show a picker would be slow and wasteful.
function TreeNode({
    name, relativePath, absolutePath, isDir, depth, excluded, onToggleExclude, nodeStates, setNodeStates,
}: {
    name: string;
    relativePath: string;
    absolutePath: string;
    isDir: boolean;
    depth: number;
    excluded: Set<string>;
    onToggleExclude: (relativePath: string) => void;
    nodeStates: Map<string, NodeState>;
    setNodeStates: React.Dispatch<React.SetStateAction<Map<string, NodeState>>>;
}) {
    const isExcluded = excluded.has(relativePath);
    // A file/folder nested under an already-excluded ancestor folder is
    // implicitly excluded too (matches the backend's prefix-based check) —
    // shown as disabled + checked so it's clear toggling it individually
    // does nothing until the ancestor exclusion is removed.
    const isImplicitlyExcluded = !isExcluded && [...excluded].some(ex => relativePath.startsWith(`${ex}/`));
    const state = nodeStates.get(relativePath);

    const handleExpand = useCallback(async () => {
        if (!isDir) return;
        const current = nodeStates.get(relativePath);
        if (current?.expanded) {
            setNodeStates(prev => new Map(prev).set(relativePath, { ...current, expanded: false }));
            return;
        }
        setNodeStates(prev => new Map(prev).set(relativePath, { expanded: true, loading: true, children: current?.children ?? null }));
        if (!current?.children) {
            try {
                const children = await invoke<LocalDirEntry[]>('cmd_list_local_dir_entries', { path: absolutePath });
                setNodeStates(prev => new Map(prev).set(relativePath, { expanded: true, loading: false, children }));
            } catch {
                setNodeStates(prev => new Map(prev).set(relativePath, { expanded: true, loading: false, children: [] }));
            }
        } else {
            setNodeStates(prev => new Map(prev).set(relativePath, { expanded: true, loading: false, children: current.children }));
        }
    }, [isDir, relativePath, absolutePath, nodeStates, setNodeStates]);

    return (
        <div>
            <div
                className="quiet-control flex items-center gap-1.5 rounded px-1.5 py-1 text-sm"
                style={{ paddingInlineStart: `${depth * 18 + 6}px` }}
            >
                {isDir ? (
                    <button type="button" onClick={handleExpand} className="shrink-0 text-app-text-secondary hover:text-app-text">
                        {state?.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : state?.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </button>
                ) : (
                    <span className="w-3.5 shrink-0" />
                )}
                <input
                    type="checkbox"
                    checked={isExcluded || isImplicitlyExcluded}
                    disabled={isImplicitlyExcluded}
                    onChange={() => onToggleExclude(relativePath)}
                    className="shrink-0"
                />
                {isDir ? <Folder className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" /> : <File className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />}
                <span className={`truncate ${isExcluded || isImplicitlyExcluded ? 'text-app-text-tertiary line-through' : 'text-app-text'}`}>{name}</span>
            </div>
            {isDir && state?.expanded && state.children && (
                <div>
                    {state.children.map(child => (
                        <TreeNode
                            key={child.name}
                            name={child.name}
                            relativePath={relativePath ? `${relativePath}/${child.name}` : child.name}
                            absolutePath={`${absolutePath}/${child.name}`}
                            isDir={child.is_dir}
                            depth={depth + 1}
                            excluded={excluded}
                            onToggleExclude={onToggleExclude}
                            nodeStates={nodeStates}
                            setNodeStates={setNodeStates}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// Shown as an optional step after picking a local folder (and, for a new
// source, its Telegram destination) — lets specific subfolders/files be
// marked to skip entirely. Excluding a folder excludes everything nested
// under it too, not just its own direct contents (see backend's
// filter_entry in run_backup_source, which this mirrors).
export function BackupExcludeModal({ rootPath, initialExcluded, onClose, onConfirm }: BackupExcludeModalProps) {
    const { t } = useTranslation();
    const [excluded, setExcluded] = useState<Set<string>>(new Set(initialExcluded));
    const [rootEntries, setRootEntries] = useState<LocalDirEntry[] | null>(null);
    const [loadingRoot, setLoadingRoot] = useState(true);
    const [nodeStates, setNodeStates] = useState<Map<string, NodeState>>(new Map());

    useEffect(() => {
        (async () => {
            try {
                const entries = await invoke<LocalDirEntry[]>('cmd_list_local_dir_entries', { path: rootPath });
                setRootEntries(entries);
            } catch {
                setRootEntries([]);
            } finally {
                setLoadingRoot(false);
            }
        })();
    }, [rootPath]);

    const handleToggleExclude = useCallback((relativePath: string) => {
        setExcluded(prev => {
            const next = new Set(prev);
            if (next.has(relativePath)) {
                next.delete(relativePath);
            } else {
                // Toggling a folder "on" makes any exclusions nested under
                // it redundant — drop them so the list doesn't quietly grow
                // stale entries the UI already implies via the ancestor.
                for (const existing of [...next]) {
                    if (existing.startsWith(`${relativePath}/`)) next.delete(existing);
                }
                next.add(relativePath);
            }
            return next;
        });
    }, []);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onClick={onClose}>
            <div className="quiet-raised flex h-[min(560px,80vh)] w-[min(480px,calc(100vw-2rem))] flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-telegram-border flex justify-between items-center">
                    <div>
                        <h3 className="text-telegram-text font-medium">{t('settings.backup_exclude_title')}</h3>
                        <p className="mt-0.5 text-xs text-telegram-subtext">{t('settings.backup_exclude_desc')}</p>
                    </div>
                    <button onClick={onClose} className="shrink-0 text-telegram-subtext hover:text-telegram-text"><Plus className="w-5 h-5 rotate-45" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {loadingRoot ? (
                        <div className="flex items-center justify-center py-8 text-app-text-secondary"><Loader2 className="h-5 w-5 animate-spin" /></div>
                    ) : rootEntries && rootEntries.length > 0 ? (
                        rootEntries.map(entry => (
                            <TreeNode
                                key={entry.name}
                                name={entry.name}
                                relativePath={entry.name}
                                absolutePath={`${rootPath}/${entry.name}`}
                                isDir={entry.is_dir}
                                depth={0}
                                excluded={excluded}
                                onToggleExclude={handleToggleExclude}
                                nodeStates={nodeStates}
                                setNodeStates={setNodeStates}
                            />
                        ))
                    ) : (
                        <p className="p-4 text-center text-sm text-app-text-secondary">{t('settings.backup_exclude_empty')}</p>
                    )}
                </div>
                <div className="p-3 border-t border-telegram-border flex items-center justify-between gap-2">
                    <span className="text-xs text-telegram-subtext">
                        {excluded.size > 0 ? t('settings.backup_exclude_count', { count: excluded.size }) : t('settings.backup_exclude_none')}
                    </span>
                    <div className="flex gap-2">
                        <button onClick={onClose} className="quiet-control rounded-lg px-3 py-1.5 text-xs font-medium text-telegram-subtext hover:bg-telegram-hover hover:text-telegram-text">
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={() => onConfirm([...excluded])}
                            className="rounded-lg bg-telegram-primary/10 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/20"
                        >
                            {t('settings.backup_exclude_confirm')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
