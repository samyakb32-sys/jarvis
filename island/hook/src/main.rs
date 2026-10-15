//! jarvis-hook — what Claude Code runs on each hook event.
//!
//! Reads the hook JSON on stdin and hands it to Jarvis Island. The one rule:
//! **never hold the agent up.**
//! * Island not running (no token, no endpoint) → exit 0 at once, printing nothing.
//! * Every step runs on a worker thread under a deadline kept by the main thread,
//!   so a server that accepts and then stalls cannot wedge the session.
//! * Only `PermissionRequest` waits for an answer. No answer → print nothing,
//!   and Claude Code decides as if the island were not installed.
//!
//! Usage: `jarvis-hook [<EventName>]` (the event is also read from the JSON).

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use jarvis_island_protocol::{paths, reply, wire};
use serde_json::Value;

/// Stdin comes from the agent: never hold more than this.
const MAX_STDIN: u64 = 16 * 1024 * 1024;
/// An agent that never closes stdin must not keep us (and so itself) waiting.
const STDIN_BUDGET: Duration = Duration::from_secs(3);

fn main() {
    let arg_event = std::env::args().nth(1).unwrap_or_default();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut input = Vec::new();
        let _ = std::io::stdin().take(MAX_STDIN).read_to_end(&mut input);
        let _ = tx.send(input);
    });
    let Ok(input) = rx.recv_timeout(STDIN_BUDGET) else { std::process::exit(0) };
    let Ok(payload) = serde_json::from_slice::<Value>(&input) else { return };

    let event = if arg_event.is_empty() {
        payload.get("hook_event_name").and_then(Value::as_str).unwrap_or_default().to_string()
    } else {
        arg_event
    };
    if event.is_empty() {
        return;
    }
    let Some(token) = paths::read_token() else { return };

    let wait = event == "PermissionRequest";
    let request = wire::Request {
        v: wire::VERSION,
        token,
        source: "claude".into(),
        event: event.clone(),
        wait,
        timeout_ms: None,
        payload: wire::trim_payload(payload.clone()),
    };
    let budget = if wait { wire::HOOK_DECISION_BUDGET } else { wire::FIRE_BUDGET };

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(exchange(&paths::endpoint(), &request));
    });
    let answer = rx.recv_timeout(budget).ok().flatten();

    if let Some(line) = reply::claude_output(&event, answer.as_ref(), &payload) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
    // Leave at once, abandoning a worker that is still blocked.
    std::process::exit(0);
}

/// Connect, send the request, and read the reply when one is expected.
fn exchange(endpoint: &str, request: &wire::Request) -> Option<wire::Reply> {
    let mut conn = connect(endpoint)?;
    let mut line = serde_json::to_vec(request).ok()?;
    line.push(b'\n');
    conn.write_all(&line).ok()?;
    conn.flush().ok()?;
    if !request.wait {
        return None;
    }
    let mut reader = BufReader::new(conn.take(wire::MAX_REPLY as u64));
    let mut text = String::new();
    reader.read_line(&mut text).ok()?;
    serde_json::from_str(text.trim()).ok()
}

#[cfg(windows)]
fn connect(endpoint: &str) -> Option<std::fs::File> {
    // ERROR_PIPE_BUSY: every instance is taken for a moment; retry within the budget.
    const ERROR_PIPE_BUSY: i32 = 231;
    let start = Instant::now();
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(endpoint) {
            Ok(file) => return Some(file),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && start.elapsed() < wire::CONNECT_BUDGET => {
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => return None,
        }
    }
}

#[cfg(unix)]
fn connect(endpoint: &str) -> Option<std::os::unix::net::UnixStream> {
    let start = Instant::now();
    loop {
        match std::os::unix::net::UnixStream::connect(endpoint) {
            Ok(stream) => return Some(stream),
            // A listener with a full backlog: retry within the budget.
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && start.elapsed() < wire::CONNECT_BUDGET => {
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => return None,
        }
    }
}
