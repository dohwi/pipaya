/// Windows toast whose click raises the window and tells the page which session to open.
/// The notification plugin shows toasts without any activation handler, so a click did nothing.
#[cfg(windows)]
#[tauri::command]
fn show_toast(app: tauri::AppHandle, title: String, body: Option<String>, session_id: Option<String>) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    use tauri_winrt_notification::Toast;
    // Same rule as tauri-plugin-notification: the real app id only for an installed build.
    let installed = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .map(|d| !(d.ends_with("target\\debug") || d.ends_with("target\\release")))
        .unwrap_or(false);
    let id = app.config().identifier.clone();
    let app_id = if installed { id.as_str() } else { Toast::POWERSHELL_APP_ID };
    let handle = app.clone();
    let mut toast = Toast::new(app_id).title(&title);
    if let Some(b) = body.as_deref() {
        toast = toast.text1(b);
    }
    toast
        .on_activated(move |_| {
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(sid) = session_id.clone().filter(|s| !s.is_empty()) {
                let _ = handle.emit("harness://open-session", sid);
            }
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
fn show_toast() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_harness_push::init())
        .plugin(tauri_plugin_deep_link::init());

    // Self-update is desktop only. Android installs go through the system package installer instead.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .invoke_handler(tauri::generate_handler![show_toast])
        .setup(|app| {
            // A relaunch after an update (or any start) should land in front, not behind whatever the user has open.
            #[cfg(desktop)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            #[cfg(not(desktop))]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
