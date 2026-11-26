//! Desktop native file clipboard: stages bytes into the app cache directory under a sanitized
//! filename and places the resulting file path onto the OS clipboard (`CF_HDROP` on Windows,
//! `NSPasteboard` file URL on macOS, `text/uri-list` / `x-special/gnome-copied-files` on Linux).

use crate::file_clipboard_core::{
    percent_decode_utf8, prune_cache, write_staged_file, CACHE_MAX_AGE, MAX_CACHE_BYTES,
    MAX_CACHE_ENTRIES, MAX_FILE_BYTES,
};
use clipboard_rs::{Clipboard, ClipboardContext};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Manager;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Holds a lazily initialized `ClipboardContext` so Linux X11 keeps serving selection requests
/// for the lifetime of the app instead of dropping ownership immediately after the command returns,
/// plus a single-flight gate so concurrent IPC calls cannot stack memory or race cache pruning.
#[derive(Default)]
pub struct State {
    ctx: Mutex<Option<ClipboardContext>>,
    busy: AtomicBool,
}

struct BusyGuard(Arc<State>);

impl BusyGuard {
    fn try_acquire(state: Arc<State>) -> Result<Self, String> {
        if state.busy.swap(true, Ordering::AcqRel) {
            return Err("clipboard copy already in progress".into());
        }
        Ok(Self(state))
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("clipboard-files"))
}

fn clipboard_arg(path: &Path) -> String {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::file_clipboard_core::to_file_uri(path)
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        path.to_string_lossy().into_owned()
    }
}

fn put_file_on_clipboard(state: &State, path: &Path) -> Result<(), String> {
    let mut guard = lock(&state.ctx);
    if guard.is_none() {
        let created = ClipboardContext::new().map_err(|e| e.to_string())?;
        *guard = Some(created);
    }
    let ctx = guard.as_ref().ok_or_else(|| "clipboard unavailable".to_string())?;
    ctx.set_files(vec![clipboard_arg(path)])
        .map_err(|e| e.to_string())
}

/// Removes expired or over-budget staged files in the background on app startup.
pub fn sweep_cache(app: &tauri::AppHandle) {
    let Ok(root) = cache_root(app) else {
        return;
    };
    std::thread::spawn(move || {
        prune_cache(&root, None, MAX_CACHE_ENTRIES, MAX_CACHE_BYTES, CACHE_MAX_AGE);
    });
}

/// Receives raw file bytes via Tauri v2 binary IPC (`InvokeBody::Raw`) and an optional
/// percent-encoded `x-file-name` header, writes the file to an isolated staging directory,
/// and puts that file onto the native OS clipboard.
#[tauri::command]
pub async fn copy_file_to_clipboard(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<State>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(raw) = request.body() else {
        return Err("expected a raw binary body".into());
    };
    if raw.len() > MAX_FILE_BYTES {
        return Err(format!("file exceeds {} byte limit", MAX_FILE_BYTES));
    }
    let filename = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode_utf8)
        .unwrap_or_default();

    let st = state.inner().clone();
    let guard = BusyGuard::try_acquire(st.clone())?;
    let bytes = raw.to_vec();
    let root = cache_root(&app)?;
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let staged = write_staged_file(&root, &filename, &bytes)?;

        #[cfg(target_os = "macos")]
        let clip_res = {
            // AppKit's NSPasteboard is safest when accessed on the main thread.
            let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
            let st_main = st.clone();
            let path_main = staged.clone();
            app_handle
                .run_on_main_thread(move || {
                    let _ = tx.send(put_file_on_clipboard(&st_main, &path_main));
                })
                .map_err(|e| e.to_string())?;
            rx.recv().map_err(|e| e.to_string())?
        };

        #[cfg(not(target_os = "macos"))]
        let clip_res = {
            let _ = &app_handle;
            put_file_on_clipboard(&st, &staged)
        };

        if let Err(err) = clip_res {
            if let Some(dir) = staged.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
            return Err(err);
        }

        prune_cache(
            &root,
            staged.parent(),
            MAX_CACHE_ENTRIES,
            MAX_CACHE_BYTES,
            CACHE_MAX_AGE,
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
