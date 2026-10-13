//! The exchange between a client (jarvis-hook, Hermes) and the island: one JSON
//! line from the client, and — only when it asked to wait — one JSON line back.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::time::Duration;

pub const VERSION: u32 = 1;

/// Longest request line the server reads.
pub const MAX_LINE: usize = 1 << 20;
/// Longest reply line a client reads.
pub const MAX_REPLY: usize = 64 * 1024;

/// A client gets this long to reach the server. Beyond it the agent carries on without us.
pub const CONNECT_BUDGET: Duration = Duration::from_millis(300);
/// Whole run of an event nobody waits for: connect and write, no more.
pub const FIRE_BUDGET: Duration = Duration::from_secs(2);
/// How long the hook waits for a human on a permission request. Claude Code's
/// own hook timeout (written to settings.json) is longer, so we always exit first.
pub const HOOK_DECISION_BUDGET: Duration = Duration::from_secs(110);
/// The server answers slightly before the hook gives up, so a late click is not lost silently.
pub const SERVER_DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// The island must confirm the card is on screen within this, or the request is
/// declined at once (the terminal prompt then appears as if the island were absent).
pub const ACK_TIMEOUT: Duration = Duration::from_millis(800);
/// A client must send its request line within this.
pub const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds for a client-chosen wait (Hermes plan approval).
pub const MIN_WAIT: Duration = Duration::from_secs(1);
pub const MAX_WAIT: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Request {
    pub v: u32,
    #[serde(default)]
    pub token: String,
    /// `claude` for Claude Code hooks, `hermes` for the orchestrator.
    pub source: String,
    pub event: String,
    /// Keep the connection open and wait for a decision.
    #[serde(default)]
    pub wait: bool,
    /// Requested wait for a decision (ignored for Claude Code permission requests).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub payload: Value,
}

impl Request {
    /// How long the server holds a waiting request open.
    pub fn decision_timeout(&self) -> Duration {
        if self.source == "claude" {
            return SERVER_DECISION_TIMEOUT;
        }
        self.timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(SERVER_DECISION_TIMEOUT)
            .clamp(MIN_WAIT, MAX_WAIT)
    }
}

/// What the island answers. `decision: None` means "no decision": the client
/// falls back to whatever it would do without the island.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Reply {
    #[serde(default)]
    pub decision: Option<String>,
    /// AskUserQuestion: question text → chosen label(s).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<Map<String, Value>>,
    /// Free text: a deny reason, or Hermes plan feedback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

impl Reply {
    pub fn none() -> Self {
        Self::default()
    }
}

/// Fields never forwarded: large and never shown.
const DROPPED: &[&str] = &["transcript_path", "tool_response", "tool_output"];
const MAX_STRING: usize = 4 * 1024;
/// A turn's final words are shown in full on the "finished" notice.
const MAX_ANSWER: usize = 32 * 1024;
const MAX_DEPTH: usize = 12;

/// Make a hook payload small enough for one line: drop bulky fields, cut long strings.
pub fn trim_payload(payload: Value) -> Value {
    match payload {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(k, _)| !DROPPED.contains(&k.as_str()))
                .map(|(k, v)| {
                    let v = if k == "last_assistant_message" { cut_value(v, MAX_ANSWER, 0) } else { cut_value(v, MAX_STRING, 0) };
                    (k, v)
                })
                .collect(),
        ),
        other => cut_value(other, MAX_STRING, 0),
    }
}

fn cut_value(v: Value, max: usize, depth: usize) -> Value {
    if depth > MAX_DEPTH {
        return Value::Null;
    }
    match v {
        Value::String(s) => Value::String(cut(s, max)),
        Value::Array(items) => Value::Array(items.into_iter().take(200).map(|i| cut_value(i, max, depth + 1)).collect()),
        Value::Object(map) => Value::Object(map.into_iter().take(200).map(|(k, i)| (k, cut_value(i, max, depth + 1))).collect()),
        other => other,
    }
}

fn cut(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Constant-time comparison for the token.
pub fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trim_drops_bulky_fields_and_cuts_strings() {
        let big = "x".repeat(10_000);
        let out = trim_payload(json!({
            "transcript_path": "/a/b.jsonl",
            "tool_response": { "stdout": big },
            "tool_input": { "command": big },
            "last_assistant_message": big,
        }));
        assert!(out.get("transcript_path").is_none());
        assert!(out.get("tool_response").is_none());
        assert_eq!(out["tool_input"]["command"].as_str().unwrap().chars().count(), MAX_STRING + 1);
        assert_eq!(out["last_assistant_message"].as_str().unwrap().len(), 10_000);
    }

    #[test]
    fn cut_respects_char_boundaries() {
        let s = "é".repeat(3000); // 2 bytes each
        let out = cut(s, 4097);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn decision_timeout_is_fixed_for_claude_and_clamped_for_others() {
        let mut r = Request { v: 1, token: String::new(), source: "claude".into(), event: "PermissionRequest".into(), wait: true, timeout_ms: Some(1), payload: Value::Null };
        assert_eq!(r.decision_timeout(), SERVER_DECISION_TIMEOUT);
        r.source = "hermes".into();
        assert_eq!(r.decision_timeout(), MIN_WAIT);
        r.timeout_ms = Some(u64::MAX / 2);
        assert_eq!(r.decision_timeout(), MAX_WAIT);
        r.timeout_ms = None;
        assert_eq!(r.decision_timeout(), SERVER_DECISION_TIMEOUT);
    }

    #[test]
    fn token_compare() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("abc", "ab"));
        assert!(!token_matches("", ""));
    }

    #[test]
    fn reply_round_trip_omits_empty_fields() {
        assert_eq!(serde_json::to_string(&Reply::none()).unwrap(), r#"{"decision":null}"#);
        let r: Reply = serde_json::from_str(r#"{"decision":"allow"}"#).unwrap();
        assert_eq!(r.decision.as_deref(), Some("allow"));
    }
}
