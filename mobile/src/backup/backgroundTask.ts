import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { runBackup } from "./backup";

export const BACKUP_TASK_NAME = "telegram-drive-daily-backup";

// Must run at module load time in the global scope (not inside a component)
// so the OS can invoke it in a headless JS context with no UI mounted.
TaskManager.defineTask(BACKUP_TASK_NAME, async () => {
  try {
    await runBackup();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// Best-effort only: the OS decides the actual timing (and may skip runs
// under battery optimization), so this is not a guaranteed daily-at-12:00
// schedule the way the desktop app's backup is.
export async function registerDailyBackup(): Promise<void> {
  await BackgroundTask.registerTaskAsync(BACKUP_TASK_NAME, { minimumInterval: 60 * 24 });
}

export async function unregisterDailyBackup(): Promise<void> {
  await BackgroundTask.unregisterTaskAsync(BACKUP_TASK_NAME);
}

export async function isDailyBackupRegistered(): Promise<boolean> {
  return TaskManager.isTaskRegisteredAsync(BACKUP_TASK_NAME);
}
