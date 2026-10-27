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
                let _ = handle.emit("pipaya://open-session", sid);
            }
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
fn show_toast() {}

/// The server bundled with the desktop app (sidecar), loopback-only unless the settings (or `PIPAYA_APP_HOST`) say otherwise.
#[cfg(desktop)]
mod local_server {
    use std::io::Read;
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};
    use tauri::Manager;

    /// Locks even after a panic elsewhere poisoned the mutex: what it guards (a child handle, an address) is still valid,
    /// and stopping the server on exit must not fail because of an earlier panic.
    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[derive(Default)]
    pub struct State {
        child: Mutex<Option<Child>>,
        info: Mutex<Option<Info>>,
    }

    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Info {
        base_url: String,
        token: String,
    }

    /// Where the bundled server listens, chosen in the settings screen (`server-bind.json` in the app data dir).
    #[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct Bind {
        /// Empty means loopback only.
        host: String,
        /// 0 means "8788 if free, else any".
        port: u16,
    }

    fn bind_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.join("server-bind.json"))
    }

    /// Write the setting file, or remove it when `text` is None (back to the default).
    fn write_bind(file: &std::path::Path, text: Option<&str>) -> Result<(), String> {
        match text {
            Some(t) => std::fs::write(file, t).map_err(|e| e.to_string()),
            None => match std::fs::remove_file(file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            },
        }
    }

    fn read_bind(app: &tauri::AppHandle) -> Bind {
        bind_file(app)
            .ok()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// Address the bundled server binds to: the saved setting, else `PIPAYA_APP_HOST`, else loopback.
    fn bind_host(saved: &Bind) -> String {
        let pick = |h: &str| Some(h.trim().to_string()).filter(|h| !h.is_empty());
        pick(&saved.host)
            .or_else(|| std::env::var("PIPAYA_APP_HOST").ok().and_then(|h| pick(&h)))
            .unwrap_or_else(|| "127.0.0.1".into())
    }

    /// Address the app itself uses to reach the server (a wildcard bind is reached via loopback).
    fn connect_host(bind: &str) -> String {
        match bind.parse::<std::net::IpAddr>() {
            Ok(ip) if ip.is_unspecified() => "127.0.0.1".into(),
            _ => bind.to_string(),
        }
    }

    fn pick_port(host: &str, saved: &Bind) -> u16 {
        // An explicit port (setting, else `PIPAYA_APP_PORT`) is tried first; otherwise prefer a
        // stable port so the saved address keeps working across launches.
        let forced = Some(saved.port)
            .filter(|p| *p != 0)
            .or_else(|| std::env::var("PIPAYA_APP_PORT").ok().and_then(|p| p.trim().parse::<u16>().ok()));
        let mut candidates = Vec::new();
        candidates.extend(forced);
        candidates.extend([8788u16, 0]);
        for p in candidates {
            if let Ok(l) = TcpListener::bind((host, p)) {
                if let Ok(a) = l.local_addr() {
                    return a.port();
                }
            }
        }
        8788
    }

    pub fn stop(state: &State) {
        if let Some(mut c) = lock(&state.child).take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        *lock(&state.info) = None;
    }

    fn start(app: &tauri::AppHandle, state: &State) -> Result<Info, String> {
        if let Some(i) = lock(&state.info).clone() {
            return Ok(i);
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let name = if cfg!(windows) { "pipaya-server.exe" } else { "pipaya-server" };
        let bin = exe.parent().ok_or("no exe dir")?.join(name);
        if !bin.exists() {
            return Err(format!("bundled server not found: {}", bin.display()));
        }
        let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("server");
        std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let workspace = app.path().home_dir().map_err(|e| e.to_string())?;
        let saved = read_bind(app);
        let host = bind_host(&saved);
        let reach = connect_host(&host);
        let port = pick_port(&host, &saved);
        let mut cmd = Command::new(&bin);
        cmd.env("PIPAYA_HOST", &host)
            .env("PIPAYA_PORT", port.to_string())
            .env("PIPAYA_DATA_DIR", &data)
            .env("PIPAYA_WORKSPACE", &workspace)
            .env_remove("PIPAYA_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Ok(res) = app.path().resource_dir() {
            let skills = res.join("builtin-skills");
            if skills.exists() {
                cmd.env("PIPAYA_BUILTIN_SKILLS", skills);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        *lock(&state.child) = Some(child);

        let addr: SocketAddr = format!("{reach}:{port}")
            .parse()
            .unwrap_or_else(|_| ([127, 0, 0, 1], port).into());
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
                break;
            }
            if let Some(c) = lock(&state.child).as_mut() {
                if let Ok(Some(status)) = c.try_wait() {
                    return Err(format!("server exited early: {status}"));
                }
            }
            if Instant::now() > deadline {
                stop(state);
                return Err("server did not start in time".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut token = String::new();
        std::fs::File::open(data.join("token"))
            .and_then(|mut f| f.read_to_string(&mut token))
            .map_err(|e| e.to_string())?;
        let info = Info { base_url: format!("http://{reach}:{port}"), token: token.trim().to_string() };
        *lock(&state.info) = Some(info.clone());
        Ok(info)
    }

    #[tauri::command]
    pub fn local_server_bind(app: tauri::AppHandle) -> Bind {
        read_bind(&app)
    }

    /// Save where the bundled server listens and restart it there. Reverts the file if it cannot start.
    #[tauri::command]
    pub async fn set_local_server_bind(
        app: tauri::AppHandle,
        state: tauri::State<'_, Arc<State>>,
        host: String,
        port: u16,
    ) -> Result<Info, String> {
        let host = host.trim().to_string();
        if !host.is_empty() && host.parse::<std::net::IpAddr>().is_err() {
            return Err(format!("invalid address: {host}"));
        }
        let file = bind_file(&app)?;
        let previous = std::fs::read_to_string(&file).ok();
        let next = serde_json::to_string(&Bind { host, port }).map_err(|e| e.to_string())?;
        write_bind(&file, Some(&next))?;
        let st = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            stop(&st);
            match start(&app, &st) {
                Ok(i) => Ok(i),
                Err(e) => {
                    // Put the old setting back and bring the server up where it was.
                    let _ = write_bind(&file, previous.as_deref());
                    stop(&st);
                    let _ = start(&app, &st);
                    Err(e)
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn local_server(app: tauri::AppHandle, state: tauri::State<'_, Arc<State>>) -> Result<Info, String> {
        let st = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || start(&app, &st))
            .await
            .map_err(|e| e.to_string())?
    }
}

#[cfg(not(desktop))]
mod local_server {
    #[tauri::command]
    pub fn local_server_bind() {}

    #[tauri::command]
    pub async fn set_local_server_bind(_host: String, _port: u16) -> Result<(), String> {
        Err("not available on this platform".into())
    }

    #[tauri::command]
    pub async fn local_server() -> Result<(), String> {
        Err("not available on this platform".into())
    }
}

/// The app has its own shortcuts, so WebView2's browser ones (find, print, reload, zoom, devtools …) must not fire.
#[cfg(windows)]
fn disable_browser_shortcuts(app: &tauri::App) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(|webview| unsafe {
            if let Ok(core) = webview.controller().CoreWebView2() {
                if let Ok(settings) = core.Settings() {
                    if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
                    }
                    // No native right-click menu (Print, Save as, Inspect …); the page shows its own where needed.
                    let _ = settings.SetAreDefaultContextMenusEnabled(false);
                }
            }
        });
    }
}

/// The updater unpacks every downloaded installer into `<temp>/pipaya-<version>-updater-*` and never removes it, so each
/// update leaves the whole installer behind. Sweep the old ones at start. Anything younger than an hour is kept: it may
/// be the installer that is still running and about to relaunch the app.
#[cfg(desktop)]
fn sweep_updater_temp() {
    std::thread::spawn(|| {
        let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
        let hour = std::time::Duration::from_secs(3600);
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("pipaya-") && name.contains("-updater-")) {
                continue;
            }
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > hour);
            if old && entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_pipaya_push::init())
        .plugin(tauri_plugin_deep_link::init());

    // Self-update is desktop only. Android installs go through the system package installer instead.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // QR scanning for "connect to a server" is phone only.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .invoke_handler(tauri::generate_handler![
            show_toast,
            local_server::local_server,
            local_server::local_server_bind,
            local_server::set_local_server_bind
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::Manager;
                app.manage(std::sync::Arc::new(local_server::State::default()));
            }
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
            #[cfg(desktop)]
            sweep_updater_temp();
            #[cfg(windows)]
            disable_browser_shortcuts(app);
            #[cfg(not(desktop))]
            let _ = app;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = _event {
                use tauri::Manager;
                if let Some(st) = _app.try_state::<std::sync::Arc<local_server::State>>() {
                    local_server::stop(&st);
                }
            }
        });
}
