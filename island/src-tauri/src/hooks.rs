// Installing our hooks into Claude Code's user settings
// (`%USERPROFILE%\.claude\settings.json`).
//
// Never written without the user seeing the diff first and clicking: the page
// calls `hooks_preview`, shows the diff, and only `hooks_apply` writes — after a
// timestamped backup of the previous file.

use std::path::PathBuf;

use jarvis_island_protocol::settings;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    installed: bool,
    settings_path: String,
    hook_path: String,
    hook_exists: bool,
}

#[derive(Serialize)]
pub struct Preview {
    diff: String,
    changed: bool,
}

fn settings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("cannot find the home folder")?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

/// The relay shipped next to the app: the installer puts it in the resource
/// folder; a dev build has it beside the app's own exe.
fn hook_path(app: &AppHandle) -> PathBuf {
    let name = if cfg!(windows) { "jarvis-hook.exe" } else { "jarvis-hook" };
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(name);
        if p.exists() {
            return p;
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

fn read_current() -> Result<(PathBuf, Option<String>), String> {
    let path = settings_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    Ok((path, text))
}

/// The command written to settings.json. Forward slashes work both when Claude
/// Code spawns it directly (exec form) and when an older version hands it to Git Bash.
fn hook_command(app: &AppHandle) -> String {
    hook_path(app).to_string_lossy().replace('\\', "/")
}

fn proposed(app: &AppHandle, install: bool) -> Result<(PathBuf, Option<String>, String), String> {
    let (path, text) = read_current()?;
    let current = settings::parse(text.as_deref())?;
    let next = if install {
        settings::install(&current, &hook_command(app))?
    } else {
        settings::uninstall(&current)?
    };
    Ok((path, text, settings::render(&next)))
}

#[tauri::command]
pub fn hooks_status(app: AppHandle) -> Result<HookStatus, String> {
    let (path, text) = read_current()?;
    let hook = hook_path(&app);
    let installed = settings::parse(text.as_deref()).is_ok_and(|v| settings::is_installed(&v, &hook_command(&app)));
    Ok(HookStatus {
        installed,
        settings_path: path.display().to_string(),
        hook_exists: hook.exists(),
        hook_path: hook.display().to_string(),
    })
}

#[tauri::command]
pub fn hooks_preview(app: AppHandle, install: bool) -> Result<Preview, String> {
    let (_, before, after) = proposed(&app, install)?;
    let before = before.unwrap_or_default();
    let changed = settings::parse(Some(&before)).ok() != settings::parse(Some(&after)).ok();
    Ok(Preview { diff: settings::diff(&before, &after), changed })
}

/// Back up the current file, then write the proposed one. Returns the backup path, if any.
#[tauri::command]
pub fn hooks_apply(app: AppHandle, install: bool) -> Result<Option<String>, String> {
    let (path, before, after) = proposed(&app, install)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let backup = match before {
        Some(old) => {
            let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let backup = path.with_file_name(format!("settings.json.jarvis-backup-{secs}"));
            std::fs::write(&backup, old).map_err(|e| format!("backup failed, nothing written: {e}"))?;
            Some(backup.display().to_string())
        }
        None => None,
    };
    // Write beside the target, then rename over it, so a crash never leaves half a file.
    let tmp = path.with_file_name("settings.json.jarvis-tmp");
    std::fs::write(&tmp, after).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(backup)
}
