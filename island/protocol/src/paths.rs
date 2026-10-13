//! Where the island listens and where it keeps the token clients must present.
//!
//! Both can be overridden for tests and CI: `JARVIS_ISLAND_DIR` (data directory)
//! and `JARVIS_ISLAND_PIPE` (endpoint). Hermes (`src/island.js`) mirrors these
//! rules exactly; change both together.

use std::path::PathBuf;

pub const DIR_ENV: &str = "JARVIS_ISLAND_DIR";
pub const PIPE_ENV: &str = "JARVIS_ISLAND_PIPE";
const DIR_NAME: &str = "jarvis-island";

/// The current user's name, reduced to characters that are safe in a pipe or file name.
pub fn user_slug() -> String {
    slugify(&std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default())
}

fn slugify(raw: &str) -> String {
    let slug: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>()
        .to_ascii_lowercase();
    if slug.is_empty() { "user".into() } else { slug }
}

/// `%LOCALAPPDATA%\jarvis-island` on Windows; `$XDG_RUNTIME_DIR/jarvis-island`
/// (or `/tmp/jarvis-island-<user>`) elsewhere.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(DIR_ENV).filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local).join(DIR_NAME);
        }
    }
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(run).join(DIR_NAME);
    }
    std::env::temp_dir().join(format!("{DIR_NAME}-{}", user_slug()))
}

/// The endpoint: a named pipe on Windows, a Unix socket elsewhere.
pub fn endpoint() -> String {
    if let Ok(pipe) = std::env::var(PIPE_ENV) {
        if !pipe.is_empty() {
            return pipe;
        }
    }
    if cfg!(windows) {
        format!(r"\\.\pipe\{DIR_NAME}-{}", user_slug())
    } else {
        data_dir().join("island.sock").to_string_lossy().into_owned()
    }
}

pub fn token_path() -> PathBuf {
    data_dir().join("token")
}

/// The token the running app wrote at start. `None` means the app has never run
/// (or its directory was removed): nobody can answer, so clients give up at once.
pub fn read_token() -> Option<String> {
    let text = std::fs::read_to_string(token_path()).ok()?;
    let token = text.trim();
    (!token.is_empty()).then(|| token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_only_safe_characters() {
        assert_eq!(slugify("Jöhn Doe\\x"), "jhndoex");
        assert_eq!(slugify("ç"), "user");
    }
}
