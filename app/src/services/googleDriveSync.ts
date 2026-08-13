import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';

// Mirrors the backend's `commands::google_auth::DriveSyncPullResponse`
// (app/src-tauri/src/commands/google_auth.rs).
export interface DriveSyncPullResult {
    api_id: string | null;
    api_hash: string | null;
    has_app_lock: boolean;
    app_lock_email: string | null;
}

/**
 * Pulls the Google Drive-synced blob and applies whatever it carries to
 * local state, the same way `AuthWizard.tsx`'s `handleGoogleConnected` does
 * for a fresh sign-in:
 *  - `api_id`/`api_hash` are written into `config.json`, the same store
 *    every other Telegram-credentials read/write in the app already uses.
 *  - The App Lock cache (`app_lock.json`) does NOT need any handling here —
 *    it's refreshed as a side effect of the backend `cmd_google_drive_sync_pull`
 *    command itself (see `commands/app_lock.rs::cache_from_drive`, invoked
 *    from `commands/google_auth.rs::cmd_google_drive_sync_pull`), so simply
 *    calling this pulls that state current too.
 *
 * This is meant to be called best-effort — callers on the desktop's
 * "already connected" paths (Settings tab open/mount, app launch) should
 * swallow rejections themselves so a failed pull (offline, token expired,
 * etc.) never blocks the surrounding flow.
 */
export async function pullAndApplyGoogleDriveSync(): Promise<DriveSyncPullResult> {
    const pull = await invoke<DriveSyncPullResult>('cmd_google_drive_sync_pull');
    if (pull.api_id && pull.api_hash) {
        try {
            const store = await load('config.json');
            await store.set('api_id', pull.api_id);
            await store.set('api_hash', pull.api_hash);
            await store.save();
        } catch {
            // Config write failure is non-critical here — the pull itself
            // still succeeded and the app-lock side effect already ran.
        }
    }
    return pull;
}
