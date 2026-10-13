//! Adding and removing our hooks in Claude Code's `settings.json`.
//!
//! Rules: never touch another tool's hooks, refuse (rather than "fix") a file
//! whose `hooks` is not shaped as Claude Code documents, and let the app show
//! a diff before anything is written ([`diff`]).
//!
//! Hooks are written in exec form (`command` = the exe, `args` = the event), so
//! no shell is involved: it works the same whether Claude Code would have used
//! Git Bash or PowerShell, and paths with spaces need no quoting.

use serde_json::{json, Map, Value};

use crate::HOOK_MARKER;

/// (event, timeout in seconds, async). Only PermissionRequest waits for a human;
/// everything else runs in the background and can never slow a session down.
pub const EVENTS: &[(&str, u64, bool)] = &[
    ("PermissionRequest", 120, false),
    ("SessionStart", 10, true),
    ("SessionEnd", 10, true),
    ("UserPromptSubmit", 10, true),
    ("PreToolUse", 10, true),
    ("PostToolUse", 10, true),
    ("Notification", 10, true),
    ("Stop", 10, true),
];

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| hooks.iter().any(|h| h.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(HOOK_MARKER))))
}

fn unexpected(what: &str) -> String {
    format!("settings.json: {what} is not shaped as Claude Code documents; left untouched.")
}

type Object = Map<String, Value>;

/// The file's top-level object and its `hooks` object (both empty when absent).
fn root_and_hooks(existing: &Value) -> Result<(Object, Object), String> {
    let root = match existing {
        Value::Null => Map::new(),
        Value::Object(map) => map.clone(),
        _ => return Err(unexpected("the file")),
    };
    let hooks = match root.get("hooks") {
        None => Map::new(),
        Some(Value::Object(h)) => h.clone(),
        Some(_) => return Err(unexpected("\"hooks\"")),
    };
    Ok((root, hooks))
}

/// `existing` with our hooks pointing at `hook_exe` (replacing any older entries of ours).
pub fn install(existing: &Value, hook_exe: &str) -> Result<Value, String> {
    let (mut root, mut hooks) = root_and_hooks(existing)?;
    for (event, timeout, background) in EVENTS {
        let mut list = match hooks.get(*event) {
            None => Vec::new(),
            Some(Value::Array(list)) => list.clone(),
            Some(_) => return Err(unexpected(&format!("\"hooks\".\"{event}\""))),
        };
        list.retain(|e| !entry_is_ours(e));
        let mut hook = json!({ "type": "command", "command": hook_exe, "args": [event], "timeout": timeout });
        if *background {
            hook["async"] = Value::Bool(true);
        }
        list.push(json!({ "hooks": [hook] }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    Ok(Value::Object(root))
}

/// `existing` with every entry of ours removed and nothing else changed
/// (an event left empty, and `hooks` left empty, are removed too).
pub fn uninstall(existing: &Value) -> Result<Value, String> {
    let (mut root, hooks) = root_and_hooks(existing)?;
    if !root.contains_key("hooks") {
        return Ok(Value::Object(root));
    }
    let mut out = Map::new();
    for (event, value) in hooks {
        match value {
            Value::Array(list) => {
                let kept: Vec<Value> = list.into_iter().filter(|e| !entry_is_ours(e)).collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            other => {
                out.insert(event, other);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Ok(Value::Object(root))
}

/// Our PermissionRequest hook is present and points at `hook_exe`.
pub fn is_installed(existing: &Value, hook_exe: &str) -> bool {
    existing
        .get("hooks")
        .and_then(|h| h.get("PermissionRequest"))
        .and_then(Value::as_array)
        .is_some_and(|list| {
            list.iter().filter(|e| entry_is_ours(e)).any(|e| {
                e["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h| h.get("command").and_then(Value::as_str) == Some(hook_exe)))
            })
        })
}

/// Parse a settings file's text. An empty or missing file is an empty object.
pub fn parse(text: Option<&str>) -> Result<Value, String> {
    match text.map(str::trim) {
        None | Some("") => Ok(Value::Object(Map::new())),
        Some(t) => serde_json::from_str(t).map_err(|e| format!("settings.json is not valid JSON ({e}); left untouched.")),
    }
}

/// Pretty JSON with a trailing newline, as written to disk.
pub fn render(value: &Value) -> String {
    let mut s = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into());
    s.push('\n');
    s
}

/// A unified-style line diff (`-` removed, `+` added, two spaces unchanged).
/// Settings files are small; a plain LCS table is enough.
pub fn diff(old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let (mut i, mut j, mut out) = (0, 0, String::new());
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            out.push_str("  ");
            out.push_str(a[i]);
            i += 1;
            j += 1;
        } else if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            out.push_str("+ ");
            out.push_str(b[j]);
            j += 1;
        } else {
            out.push_str("- ");
            out.push_str(a[i]);
            i += 1;
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\Jo Doe\AppData\Local\Jarvis Island\jarvis-hook.exe";

    #[test]
    fn install_adds_every_event_and_keeps_other_hooks() {
        let existing = json!({
            "model": "opus",
            "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "guard.sh" }] }] }
        });
        let out = install(&existing, EXE).unwrap();
        assert_eq!(out["model"], "opus");
        for (event, timeout, background) in EVENTS {
            let list = out["hooks"][event].as_array().unwrap();
            let ours = list.last().unwrap();
            assert_eq!(ours["hooks"][0]["command"], EXE);
            assert_eq!(ours["hooks"][0]["args"], json!([event]));
            assert_eq!(ours["hooks"][0]["timeout"], *timeout);
            assert_eq!(ours["hooks"][0].get("async").is_some(), *background);
        }
        assert_eq!(out["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "guard.sh");
        assert!(is_installed(&out, EXE));
        assert!(!is_installed(&out, "C:/elsewhere/jarvis-hook.exe"));
    }

    #[test]
    fn install_twice_does_not_duplicate() {
        let once = install(&Value::Null, EXE).unwrap();
        let twice = install(&once, EXE).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn uninstall_restores_the_original() {
        let original = json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "notify.sh" }] }] }, "x": 1 });
        let back = uninstall(&install(&original, EXE).unwrap()).unwrap();
        assert_eq!(back, original);
        assert_eq!(uninstall(&install(&json!({}), EXE).unwrap()).unwrap(), json!({}));
    }

    #[test]
    fn refuses_unexpected_shapes() {
        assert!(install(&json!({ "hooks": [] }), EXE).is_err());
        assert!(install(&json!({ "hooks": { "Stop": {} } }), EXE).is_err());
        assert!(install(&json!([1]), EXE).is_err());
        assert!(parse(Some("{ not json")).is_err());
        assert_eq!(parse(None).unwrap(), json!({}));
        assert_eq!(parse(Some("  ")).unwrap(), json!({}));
    }

    #[test]
    fn diff_marks_changes() {
        let d = diff("a\nb\nc\n", "a\nc\nd\n");
        assert_eq!(d, "  a\n- b\n  c\n+ d\n");
    }
}
