fn main() {
    tauri_plugin::Builder::new(&["register", "pending_tap", "set_system_bars", "device_name", "download_apk", "update_progress", "install_apk"])
        .android_path("android")
        .build();
}
