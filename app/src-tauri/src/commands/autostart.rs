//! Launch-at-login toggle, exposed to Settings — pairs with the tray-icon
//! "keep running when closed" behavior set up in `lib.rs` so scheduled
//! backups actually fire even on a day the user never opens the app.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub async fn cmd_get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cmd_set_autostart_enabled(enabled: bool, app: AppHandle) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|error| error.to_string())
    } else {
        autolaunch.disable().map_err(|error| error.to_string())
    }
}
