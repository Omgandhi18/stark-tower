//! Notify-only update check. Signed auto-INSTALL needs release infrastructure
//! (signing key + a publish pipeline) that doesn't exist yet, so this only tells
//! the user a newer GitHub release exists. It embodies the discipline the roadmap
//! called out: never swallow an update error — every step and failure is written
//! to `<app data>/updater.log` and surfaced to the UI (never silent).

use tauri::{Emitter, Manager};

const REPO: &str = "Omgandhi18/stark-tower";

/// Compare two `vX.Y.Z` (or `X.Y.Z`) versions; true if `latest` > `current`.
/// Non-numeric / unparseable versions compare as not-newer (fail safe).
pub fn is_newer(current: &str, latest: &str) -> bool {
    fn parse(v: &str) -> Option<(u64, u64, u64)> {
        let v = v.trim().trim_start_matches('v');
        let mut it = v.split('.');
        let a = it.next()?.parse().ok()?;
        let b = it.next().unwrap_or("0").parse().ok()?;
        let c = it
            .next()
            .unwrap_or("0")
            .split(|ch: char| !ch.is_ascii_digit())
            .next()
            .unwrap_or("0")
            .parse()
            .ok()?;
        Some((a, b, c))
    }
    match (parse(current), parse(latest)) {
        (Some(cur), Some(lat)) => lat > cur,
        _ => false,
    }
}

fn log_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("updater.log")
}

fn breadcrumb(app: &tauri::AppHandle, line: &str) {
    eprintln!("[update] {line}");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(app))
    {
        let _ = writeln!(f, "{line}");
    }
}

fn emit(app: &tauri::AppHandle, available: bool, latest: Option<&str>, error: Option<&str>) {
    let _ = app.emit(
        "update://status",
        serde_json::json!({
            "available": available,
            "latest": latest,
            "current": env!("CARGO_PKG_VERSION"),
            "error": error,
        }),
    );
}

/// Check GitHub for a newer release (best-effort, via `curl`). Fail-loud: any
/// error is logged to updater.log and emitted, never swallowed.
pub fn check(app: &tauri::AppHandle) {
    let current = env!("CARGO_PKG_VERSION");
    breadcrumb(app, &format!("checking for updates (current v{current})"));
    let out = std::process::Command::new("curl")
        .args([
            "-sSL",
            "-H",
            "Accept: application/vnd.github+json",
            &format!("https://api.github.com/repos/{REPO}/releases/latest"),
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let body = String::from_utf8_lossy(&o.stdout);
            let tag = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("tag_name").and_then(|t| t.as_str()).map(String::from));
            match tag {
                Some(latest) => {
                    let available = is_newer(current, &latest);
                    breadcrumb(app, &format!("latest release {latest} — available={available}"));
                    emit(app, available, Some(&latest), None);
                }
                None => {
                    // No releases yet (404 body) or unexpected shape — not an error
                    // the user needs, but log it.
                    breadcrumb(app, "no published release found");
                    emit(app, false, None, None);
                }
            }
        }
        Ok(o) => {
            let msg = format!("update check: curl exited {:?}", o.status.code());
            breadcrumb(app, &msg);
            emit(app, false, None, Some(&msg));
        }
        Err(e) => {
            let msg = format!("update check failed to run curl: {e}");
            breadcrumb(app, &msg);
            emit(app, false, None, Some(&msg));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn semver_comparison() {
        assert!(is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("v0.1.0", "v0.1.1"));
        assert!(is_newer("1.0.0", "2.0.0"));
        assert!(!is_newer("0.2.0", "0.1.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(is_newer("0.1.0", "v0.1.1-beta")); // trailing tag ignored on patch
        assert!(!is_newer("0.1.0", "garbage")); // unparseable = not newer
    }
}
