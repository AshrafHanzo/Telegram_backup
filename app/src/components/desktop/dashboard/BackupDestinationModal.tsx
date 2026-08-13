import { Plus, FolderPlus, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TelegramFolder } from '../../../types';

interface BackupDestinationModalProps {
    folders: TelegramFolder[];
    onClose: () => void;
    onSelect: (channelId: number | null) => void;
}

// Same pattern as MoveToFolderModal, but for picking where a new backup
// source should upload to: an existing folder, or a brand new dedicated one
// (channelId = null tells the backend to auto-create a "[TD-Backup]" channel).
export function BackupDestinationModal({ folders, onClose, onSelect }: BackupDestinationModalProps) {
    const { t } = useTranslation();

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onClick={onClose}>
            <div className="quiet-raised flex max-h-[80vh] w-80 flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-telegram-border flex justify-between items-center">
                    <h3 className="text-telegram-text font-medium">{t('settings.backup_pick_destination_title')}</h3>
                    <button onClick={onClose} className="text-telegram-subtext hover:text-telegram-text"><Plus className="w-5 h-5 rotate-45" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    <button
                        onClick={() => onSelect(null)}
                        className="quiet-control flex w-full items-center gap-3 px-3 py-3 text-start text-sm text-app-text"
                    >
                        <div className="w-8 h-8 rounded bg-telegram-primary/20 flex items-center justify-center text-telegram-primary">
                            <FolderPlus className="w-4 h-4" />
                        </div>
                        <span className="font-medium">{t('settings.backup_create_new_destination')}</span>
                    </button>

                    {folders.map(f => (
                        <button
                            key={f.id}
                            onClick={() => onSelect(f.id)}
                            className="quiet-control flex w-full items-center gap-3 px-3 py-3 text-start text-sm text-app-text"
                        >
                            <div className="w-8 h-8 rounded bg-telegram-hover flex items-center justify-center text-telegram-text">
                                <Folder className="w-4 h-4" />
                            </div>
                            <span className="font-medium truncate">{f.name}</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
