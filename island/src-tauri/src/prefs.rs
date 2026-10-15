// What the user chose in the island (where it lives, sounds, robot animation),
// kept in `%LOCALAPPDATA%\jarvis-island\prefs.json`. The page owns the shape;
// Rust only reads and writes it atomically and refuses anything unreasonable.

use jarvis_island_protocol::paths;
use serde_json::Value;

const MAX_BYTES: usize = 4096;

fn path() -> std::path::PathBuf {
    paths::data_dir().join("prefs.json")
}

/// The saved preferences, or an empty object when there are none (or the file is damaged).
pub fn get() -> Value {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()))
}

/// Save `prefs` (a JSON object) next to its final name and rename over it, so a crash never leaves half a file.
pub fn set(prefs: &Value) -> Result<(), String> {
    if !prefs.is_object() {
        return Err("preferences must be an object".into());
    }
    let text = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    if text.len() > MAX_BYTES {
        return Err("preferences are too large".into());
    }
    let target = path();
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_and_refusals() {
        let dir = std::env::temp_dir().join(format!("jarvis-prefs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var(paths::DIR_ENV, &dir);

        assert_eq!(get(), json!({}), "no file yet");
        set(&json!({ "sound": true, "placement": { "docked": false, "x": 10, "y": 20 } })).unwrap();
        assert_eq!(get()["placement"]["x"], 10);

        assert!(set(&json!([1, 2])).is_err());
        assert!(set(&json!({ "x": "a".repeat(MAX_BYTES) })).is_err());

        std::fs::write(dir.join("prefs.json"), "{ broken").unwrap();
        assert_eq!(get(), json!({}), "a damaged file reads as empty");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
