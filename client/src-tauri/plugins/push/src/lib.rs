#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "android")]
struct Push<R: Runtime>(PluginHandle<R>);

// `#[cfg]` must not be placed on command parameters: the command macro does not strip them, so every
// non-Android target would fail to compile. The Android handle is looked up inside the function instead.
#[tauri::command]
async fn register<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return _app
        .state::<Push<R>>()
        .0
        .run_mobile_plugin_async("register", serde_json::json!({}))
        .await
        .map_err(|_| "Push registration unavailable".to_string());
    #[cfg(not(target_os = "android"))]
    Ok(serde_json::Value::Null)
}

#[tauri::command]
async fn pending_tap<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return _app
        .state::<Push<R>>()
        .0
        .run_mobile_plugin_async("pendingTap", serde_json::json!({}))
        .await
        .map_err(|_| "Push tap unavailable".to_string());
    #[cfg(not(target_os = "android"))]
    Ok(serde_json::Value::Null)
}

/// Paints the Android system bars to match the app's theme. `color` is "#rrggbb"; `dark` means a dark background,
/// so the clock and battery icons are drawn light. Other platforms have nothing to do.
#[tauri::command]
async fn set_system_bars<R: Runtime>(_app: tauri::AppHandle<R>, color: String, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return _app
        .state::<Push<R>>()
        .0
        .run_mobile_plugin_async::<serde_json::Value>("setSystemBars", serde_json::json!({ "color": color, "dark": dark }))
        .await
        .map(|_| ())
        .map_err(|_| "System bars unavailable".to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (color, dark);
        Ok(())
    }
}

/// The phone's own name (Android only). Other platforms have a hostname and do not call this.
#[tauri::command]
async fn device_name<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return _app
        .state::<Push<R>>()
        .0
        .run_mobile_plugin_async("deviceName", serde_json::json!({}))
        .await
        .map_err(|_| "Device name unavailable".to_string());
    #[cfg(not(target_os = "android"))]
    Ok(serde_json::Value::Null)
}

/// In-app update (Android). Desktop updates through the Tauri updater plugin and never calls these.
#[tauri::command]
async fn download_apk<R: Runtime>(_app: tauri::AppHandle<R>, url: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return _app
        .state::<Push<R>>()
        .0
        .run_mobile_plugin_async("downloadApk", serde_json::json!({ "url": url }))
        .await
        .map_err(|_| "Update unavailable".to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = url;
        Ok(serde_json::Value::Null)
    }
}

#[tauri::command]
async fn update_progress<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return _app
        .state::<Push<R>>()
        .0
        .run_mobile_plugin_async("updateProgress", serde_json::json!({}))
        .await
        .map_err(|_| "Update unavailable".to_string());
    #[cfg(not(target_os = "android"))]
    {
        
        Ok(serde_json::Value::Null)
    }
}

#[tauri::command]
async fn install_apk<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return _app
        .state::<Push<R>>()
        .0
        .run_mobile_plugin_async("installApk", serde_json::json!({}))
        .await
        .map_err(|_| "Update unavailable".to_string());
    #[cfg(not(target_os = "android"))]
    {
        
        Ok(serde_json::Value::Null)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pipaya-push")
        .invoke_handler(tauri::generate_handler![register, pending_tap, set_system_bars, device_name, download_apk, update_progress, install_apk])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _app.manage(Push(
                _api.register_android_plugin("pipaya.push", "PushPlugin")?,
            ));
            // iOS intentionally returns unsupported until the signed native APNs/FCM adapter is added.
            Ok(())
        })
        .build()
}
