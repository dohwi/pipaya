//! Pure filesystem/filename helpers for the desktop file clipboard, kept free of Tauri/OS
//! clipboard crates so they compile and unit-test on headless Linux without GTK/WebKit libs.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Hard ceiling for a single file copied into the local staging cache (256 MiB).
pub const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;

/// Cache eviction policy: keep the most recent entries within both count and total byte budgets.
pub const MAX_CACHE_ENTRIES: usize = 20;
pub const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
pub const CACHE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

const MAX_FILENAME_CHARS: usize = 120;

static NEXT_SEQ: AtomicU64 = AtomicU64::new(1);

/// Decodes a percent-encoded UTF-8 header value (like JS `encodeURIComponent`).
/// Invalid escapes are copied literally; invalid UTF-8 falls back via lossy conversion.
pub fn percent_decode_utf8(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn is_windows_reserved_stem(stem: &str) -> bool {
    let trimmed = stem.trim_end_matches([' ', '.']);
    let upper = trimmed.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON"
            | "CONIN$"
            | "CONOUT$"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM\u{00B9}"
            | "COM\u{00B2}"
            | "COM\u{00B3}"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT\u{00B9}"
            | "LPT\u{00B2}"
            | "LPT\u{00B3}"
    )
}

fn is_unsafe_filename_char(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '<' | '>'
                | ':'
                | '"'
                | '/'
                | '\\'
                | '|'
                | '?'
                | '*'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// Turns an untrusted file name (or path) into a safe single path component for Windows, macOS,
/// and Linux while preserving readable Unicode names and extensions whenever possible.
pub fn sanitize_filename(raw: &str) -> String {
    // Strip any directory components first so `../../foo.mp4` or `C:\a\b.mp4` becomes `foo.mp4`.
    let base = raw
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("");

    let mut clean = String::with_capacity(base.len());
    for ch in base.chars() {
        if is_unsafe_filename_char(ch) {
            clean.push('_');
        } else {
            clean.push(ch);
        }
    }

    // Windows strips trailing spaces and dots silently; trim both ends of spaces and trailing dots.
    let trimmed = clean.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '.' || c == '_') && trimmed.contains('.') {
        return "file".to_string();
    }

    // Prevent hidden-only or traversal-like names such as "." or ".." even after replacement.
    let mut name = if trimmed == "." || trimmed == ".." {
        "file".to_string()
    } else {
        trimmed.to_string()
    };

    // Guard Windows reserved device names (e.g. `CON`, `NUL.mp4`, `com1.txt`).
    let stem_for_check = name.split('.').next().unwrap_or("");
    if is_windows_reserved_stem(stem_for_check) {
        name = format!("_{name}");
    }

    truncate_preserving_ext(&name, MAX_FILENAME_CHARS)
}

fn truncate_preserving_ext(name: &str, max_chars: usize) -> String {
    if name.chars().count() <= max_chars {
        return name.to_string();
    }
    // Preserve a short extension (<= 16 chars including the dot) when truncating long names.
    if let Some(dot_byte) = name.rfind('.') {
        let ext = &name[dot_byte..];
        let ext_chars = ext.chars().count();
        if dot_byte > 0 && ext_chars > 1 && ext_chars <= 16 && ext_chars < max_chars {
            let keep = max_chars - ext_chars;
            let prefix: String = name[..dot_byte].chars().take(keep).collect();
            let prefix = prefix.trim_end_matches(['.', ' ']);
            if !prefix.is_empty() {
                return format!("{prefix}{ext}");
            }
        }
    }
    let truncated: String = name.chars().take(max_chars).collect();
    let trimmed = truncated.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Encodes an absolute Unix path into a percent-encoded `file://` URI for Linux `text/uri-list`.
/// Uses raw OS bytes on Unix so non-UTF-8 home paths are preserved without lossy U+FFFD replacement.
#[cfg_attr(not(any(test, all(unix, not(target_os = "macos")))), allow(dead_code))]
pub fn to_file_uri(path: &Path) -> String {
    #[cfg(unix)]
    let raw_bytes: &[u8] = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes()
    };
    #[cfg(not(unix))]
    let lossy = path.to_string_lossy();
    #[cfg(not(unix))]
    let raw_bytes: &[u8] = lossy.as_bytes();

    let mut out = String::from("file://");
    for b in raw_bytes {
        let safe = matches!(
            *b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/'
        );
        if safe {
            out.push(*b as char);
        } else {
            out.push('%');
            out.push(hex_upper(b >> 4));
            out.push(hex_upper(b & 0x0f));
        }
    }
    out
}

#[cfg_attr(not(any(test, all(unix, not(target_os = "macos")))), allow(dead_code))]
fn hex_upper(nibble: u8) -> char {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    HEX[nibble as usize] as char
}

/// Writes `bytes` into a freshly created subdirectory of `cache_root` so the staged file keeps its
/// readable filename without colliding with concurrent or earlier copies.
pub fn write_staged_file(cache_root: &Path, raw_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("file exceeds {} byte limit", MAX_FILE_BYTES));
    }
    fs::create_dir_all(cache_root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(cache_root, fs::Permissions::from_mode(0o700));
    }

    let safe_name = sanitize_filename(raw_name);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pid = std::process::id();

    // Retry a few times in case of an improbable directory collision.
    let mut slot_dir = None;
    for _ in 0..8 {
        let seq = NEXT_SEQ.fetch_add(1, Ordering::Relaxed);
        let candidate = cache_root.join(format!("{now_ms}-{pid}-{seq}"));
        match fs::create_dir(&candidate) {
            Ok(()) => {
                slot_dir = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let dir = slot_dir.ok_or_else(|| "could not create staging directory".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }

    let dest = dir.join(&safe_name);
    let write_res = (|| -> Result<(), std::io::Error> {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&dest)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(fs::Permissions::from_mode(0o600));
        }
        f.write_all(bytes)?;
        f.flush()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_dir_all(&dir);
        return Err(e.to_string());
    }

    Ok(dest)
}

struct CacheEntry {
    path: PathBuf,
    modified: SystemTime,
    bytes: u64,
}

fn entry_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if meta.is_dir() {
        let Ok(rd) = fs::read_dir(path) else {
            return 0;
        };
        return rd
            .flatten()
            .map(|e| e.metadata().map(|m| if m.is_file() { m.len() } else { 0 }).unwrap_or(0))
            .sum();
    }
    0
}

/// Removes expired or over-budget entries in `cache_root`, never deleting `keep` (the directory
/// holding the file that was just placed on the clipboard).
pub fn prune_cache(
    cache_root: &Path,
    keep: Option<&Path>,
    max_entries: usize,
    max_bytes: u64,
    max_age: Duration,
) {
    let Ok(read_dir) = fs::read_dir(cache_root) else {
        return;
    };
    let now = SystemTime::now();
    let mut entries = Vec::new();
    for item in read_dir.flatten() {
        let path = item.path();
        if keep.is_some_and(|k| k == path) {
            continue;
        }
        let raw_modified = item
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH);
        // Clamp future timestamps to `now` so a skewed-clock entry cannot evade eviction forever.
        let modified = if raw_modified > now { now } else { raw_modified };
        let expired = now
            .duration_since(modified)
            .is_ok_and(|age| age > max_age);
        if expired {
            remove_entry(&path);
            continue;
        }
        entries.push(CacheEntry {
            bytes: entry_size(&path),
            path,
            modified,
        });
    }

    // Newest first so oldest entries are evicted first.
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));

    let keep_bytes = keep.map(entry_size).unwrap_or(0);
    let mut kept_count = usize::from(keep.is_some());
    let mut kept_bytes = keep_bytes;

    for entry in entries {
        let fits_count = kept_count < max_entries;
        let fits_bytes = kept_bytes.saturating_add(entry.bytes) <= max_bytes;
        if fits_count && fits_bytes {
            kept_count += 1;
            kept_bytes = kept_bytes.saturating_add(entry.bytes);
        } else {
            remove_entry(&entry.path);
        }
    }
}

fn remove_entry(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(tag: &str) -> PathBuf {
        let seq = NEXT_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "pipaya-file-clipboard-test-{}-{}-{tag}",
            std::process::id(),
            seq
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn percent_decode_handles_korean_spaces_and_bad_escapes() {
        assert_eq!(percent_decode_utf8("demo%20clip.mp4"), "demo clip.mp4");
        assert_eq!(
            percent_decode_utf8("%EC%98%81%EC%83%81%201.mp4"),
            "영상 1.mp4"
        );
        assert_eq!(percent_decode_utf8("100%ZZ.mp4"), "100%ZZ.mp4");
        assert_eq!(percent_decode_utf8("trailing%2"), "trailing%2");
        assert_eq!(percent_decode_utf8(""), "");
    }

    #[test]
    fn sanitize_filename_strips_paths_controls_and_reserved_names() {
        assert_eq!(sanitize_filename("out/demo.mp4"), "demo.mp4");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename(r"C:\Users\me\clip.mp4"), "clip.mp4");
        assert_eq!(sanitize_filename(".."), "file");
        assert_eq!(sanitize_filename("."), "file");
        assert_eq!(sanitize_filename("   "), "file");
        assert_eq!(sanitize_filename(""), "file");
        assert_eq!(sanitize_filename("a<b>c:d\"e|f?g*h.mp4"), "a_b_c_d_e_f_g_h.mp4");
        assert_eq!(sanitize_filename("bad\0name\n.mp4"), "bad_name_.mp4");
        assert_eq!(sanitize_filename("trailing. . ."), "trailing");
        assert_eq!(sanitize_filename("CON.mp4"), "_CON.mp4");
        assert_eq!(sanitize_filename("CON .txt"), "_CON .txt");
        assert_eq!(sanitize_filename("nul  .x"), "_nul  .x");
        assert_eq!(sanitize_filename("CONIN$.mp4"), "_CONIN$.mp4");
        assert_eq!(sanitize_filename("com\u{00B9}.txt"), "_com\u{00B9}.txt");
        assert_eq!(sanitize_filename("nul"), "_nul");
        assert_eq!(sanitize_filename("lpt9.tar.gz"), "_lpt9.tar.gz");
        assert_eq!(sanitize_filename("photo\u{202E}gpj.exe"), "photo_gpj.exe");
        assert_eq!(sanitize_filename("최종 영상 (1).mp4"), "최종 영상 (1).mp4");
    }

    #[test]
    fn sanitize_filename_truncates_long_names_keeping_extension() {
        let long = format!("{}.mp4", "가".repeat(150));
        let out = sanitize_filename(&long);
        assert!(out.ends_with(".mp4"));
        assert!(out.chars().count() <= MAX_FILENAME_CHARS);
    }

    #[test]
    fn to_file_uri_encodes_spaces_unicode_and_specials() {
        let p = Path::new("/tmp/my clip #1/영상%.mp4");
        assert_eq!(
            to_file_uri(p),
            "file:///tmp/my%20clip%20%231/%EC%98%81%EC%83%81%25.mp4"
        );
    }

    #[test]
    fn write_staged_file_isolates_duplicate_names_and_enforces_limit() {
        let root = temp_test_dir("stage");
        let p1 = write_staged_file(&root, "out/demo.mp4", b"first").unwrap();
        let p2 = write_staged_file(&root, "out/demo.mp4", b"second").unwrap();
        assert_ne!(p1, p2);
        assert_eq!(p1.file_name().unwrap(), "demo.mp4");
        assert_eq!(p2.file_name().unwrap(), "demo.mp4");
        assert_eq!(fs::read(&p1).unwrap(), b"first");
        assert_eq!(fs::read(&p2).unwrap(), b"second");
        // Empty 0-byte file is allowed.
        let empty = write_staged_file(&root, "empty.bin", b"").unwrap();
        assert_eq!(fs::read(&empty).unwrap(), b"");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_cache_respects_keep_count_and_byte_budget() {
        let root = temp_test_dir("prune");
        let p1 = write_staged_file(&root, "a.mp4", &[1u8; 100]).unwrap();
        std::thread::sleep(Duration::from_millis(15));
        let p2 = write_staged_file(&root, "b.mp4", &[2u8; 100]).unwrap();
        std::thread::sleep(Duration::from_millis(15));
        let p3 = write_staged_file(&root, "c.mp4", &[3u8; 100]).unwrap();

        let keep_dir = p3.parent().unwrap();
        prune_cache(&root, Some(keep_dir), 2, 1000, Duration::from_secs(3600));
        assert!(!p1.exists(), "oldest entry should be evicted by count");
        assert!(p2.exists(), "second newest should remain");
        assert!(p3.exists(), "kept entry should remain");

        // Now enforce a tight byte budget (150 bytes): keep_dir (100B) stays, p2 (100B) evicted.
        prune_cache(&root, Some(keep_dir), 10, 150, Duration::from_secs(3600));
        assert!(!p2.exists(), "entry exceeding byte budget should be evicted");
        assert!(p3.exists(), "kept entry must never be evicted");

        let _ = fs::remove_dir_all(&root);
    }
}
