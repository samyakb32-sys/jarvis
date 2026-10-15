//! Shared by the Jarvis Island app, the `jarvis-hook` relay and (by mirroring the
//! same rules in JavaScript) Hermes.
//!
//! * [`paths`] — where the app listens and keeps its token.
//! * [`wire`] — the one-line JSON request/reply exchanged over that endpoint.
//! * [`reply`] — turning the island's answer into Claude Code's hook output.
//! * [`settings`] — adding/removing our hooks in `~/.claude/settings.json`.
//! * [`server`] (feature `server`) — the async relay the app runs.

pub mod paths;
pub mod reply;
pub mod settings;
pub mod wire;

#[cfg(feature = "server")]
pub mod server;

/// Shown to the agent when a request is denied from the island.
pub const APP_NAME: &str = "Jarvis Island";
/// Every hook entry we write contains this, which is how we find our own entries again.
pub const HOOK_MARKER: &str = "jarvis-hook";
