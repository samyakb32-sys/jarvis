//! The real jarvis-hook binary against the real relay server, over a real named
//! pipe (Windows) or Unix socket. Each test uses its own endpoint and data dir.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use jarvis_island_protocol::server::{self, Answer, Card, Hub, Ui};
use jarvis_island_protocol::wire::Reply;
use serde_json::{json, Value};

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Env {
    dir: std::path::PathBuf,
    endpoint: String,
}

fn env() -> Env {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("jarvis-island-e2e-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let endpoint = if cfg!(windows) {
        format!(r"\\.\pipe\jarvis-island-e2e-{}-{n}", std::process::id())
    } else {
        dir.join("island.sock").to_string_lossy().into_owned()
    };
    Env { dir, endpoint }
}

/// What the fake island does with each waiting card.
#[derive(Clone)]
enum Script {
    Answer(Reply),
    /// Never confirm the card (a paused or broken island).
    Ignore,
}

struct FakeIsland {
    hub: OnceLock<Arc<Hub>>,
    script: Script,
    shown: Mutex<Vec<Card>>,
}

impl Ui for FakeIsland {
    fn show(&self, card: Card) {
        self.shown.lock().unwrap().push(card.clone());
        if !card.wait {
            return;
        }
        if let Script::Answer(reply) = self.script.clone() {
            let hub = self.hub.get().unwrap().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(30));
                hub.answer(&card.id, Answer::Ack);
                std::thread::sleep(Duration::from_millis(30));
                hub.answer(&card.id, Answer::Decide(reply));
            });
        }
    }
    fn dismiss(&self, _id: &str) {}
}

fn start_island(env: &Env, token: &str, script: Script) -> Arc<FakeIsland> {
    std::fs::write(env.dir.join("token"), token).unwrap();
    let hub = Hub::new(token);
    let island = Arc::new(FakeIsland { hub: OnceLock::new(), script, shown: Mutex::default() });
    island.hub.set(hub.clone()).ok().unwrap();
    let ui: Arc<dyn Ui> = island.clone();
    let endpoint = env.endpoint.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(server::serve(hub, ui, endpoint)).unwrap();
    });
    // Wait until the endpoint accepts.
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if endpoint_ready(&env.endpoint) {
            return island;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("island did not start");
}

#[cfg(unix)]
fn endpoint_ready(endpoint: &str) -> bool {
    std::path::Path::new(endpoint).exists()
}

#[cfg(windows)]
fn endpoint_ready(_endpoint: &str) -> bool {
    // Probing a pipe by opening it would consume an instance; the server creates
    // it synchronously at start, so a short pause is enough.
    std::thread::sleep(Duration::from_millis(200));
    true
}

/// Run the hook with `payload` on stdin; return (stdout, elapsed).
fn run_hook(env: &Env, event: &str, payload: &Value) -> (String, Duration) {
    let start = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_jarvis-hook"))
        .arg(event)
        .env("JARVIS_ISLAND_DIR", &env.dir)
        .env("JARVIS_ISLAND_PIPE", &env.endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "the hook must always exit 0");
    (String::from_utf8(out.stdout).unwrap().trim().to_string(), start.elapsed())
}

fn bash_request() -> Value {
    json!({
        "session_id": "s1", "cwd": "/demo/sample-app", "hook_event_name": "PermissionRequest",
        "tool_name": "Bash", "tool_input": { "command": "npm run build" },
        "permission_suggestions": [{ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm run build" }], "behavior": "allow", "destination": "localSettings" }],
        "transcript_path": "/home/x/.claude/projects/p/t.jsonl"
    })
}

fn decision(stdout: &str) -> Value {
    let v: Value = serde_json::from_str(stdout).unwrap_or_else(|e| panic!("not JSON: {stdout:?} ({e})"));
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
    v["hookSpecificOutput"]["decision"].clone()
}

fn reply(word: &str) -> Reply {
    Reply { decision: Some(word.into()), ..Reply::default() }
}

#[test]
fn allow_from_the_island_reaches_claude_code() {
    let env = env();
    let island = start_island(&env, "secret-1", Script::Answer(reply("allow")));
    let (out, _) = run_hook(&env, "PermissionRequest", &bash_request());
    assert_eq!(decision(&out), json!({ "behavior": "allow" }));
    let shown = island.shown.lock().unwrap();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].payload["tool_input"]["command"], "npm run build");
    assert!(shown[0].payload.get("transcript_path").is_none(), "bulky fields are not forwarded");
}

#[test]
fn deny_from_the_island_reaches_claude_code() {
    let env = env();
    start_island(&env, "secret-2", Script::Answer(reply("deny")));
    let (out, _) = run_hook(&env, "PermissionRequest", &bash_request());
    assert_eq!(decision(&out)["behavior"], "deny");
}

#[test]
fn always_returns_the_suggested_rule() {
    let env = env();
    start_island(&env, "secret-3", Script::Answer(reply("always")));
    let (out, _) = run_hook(&env, "PermissionRequest", &bash_request());
    assert_eq!(decision(&out)["updatedPermissions"][0]["rules"][0]["ruleContent"], "npm run build");
}

#[test]
fn an_island_that_never_confirms_costs_under_two_seconds() {
    let env = env();
    start_island(&env, "secret-4", Script::Ignore);
    let (out, took) = run_hook(&env, "PermissionRequest", &bash_request());
    assert_eq!(out, "");
    assert!(took < Duration::from_secs(2), "took {took:?}");
}

#[test]
fn no_island_exits_at_once_with_no_opinion() {
    let env = env();
    // Token present (the app ran before) but nothing listening.
    std::fs::write(env.dir.join("token"), "stale").unwrap();
    let (out, took) = run_hook(&env, "PermissionRequest", &bash_request());
    assert_eq!(out, "");
    assert!(took < Duration::from_secs(1), "took {took:?}");
    // No token at all.
    std::fs::remove_file(env.dir.join("token")).unwrap();
    let (out, took) = run_hook(&env, "PermissionRequest", &bash_request());
    assert_eq!(out, "");
    assert!(took < Duration::from_secs(1), "took {took:?}");
}

#[test]
fn other_events_are_forwarded_without_waiting() {
    let env = env();
    let island = start_island(&env, "secret-5", Script::Answer(reply("allow")));
    let stop = json!({ "session_id": "s1", "cwd": "/demo", "hook_event_name": "Stop", "last_assistant_message": "Done." });
    let (out, took) = run_hook(&env, "Stop", &stop);
    assert_eq!(out, "", "nothing is printed for events other than PermissionRequest");
    assert!(took < Duration::from_secs(2), "took {took:?}");
    // The server may still be reading when the hook exits.
    let start = Instant::now();
    while island.shown.lock().unwrap().is_empty() && start.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let shown = island.shown.lock().unwrap();
    assert_eq!(shown[0].event, "Stop");
    assert!(!shown[0].wait);
}

#[test]
fn a_wrong_token_raises_no_card() {
    let env = env();
    let island = start_island(&env, "secret-6", Script::Answer(reply("allow")));
    std::fs::write(env.dir.join("token"), "forged").unwrap();
    let (out, _) = run_hook(&env, "PermissionRequest", &bash_request());
    assert_eq!(out, "");
    assert!(island.shown.lock().unwrap().is_empty());
}

#[test]
fn garbage_on_stdin_is_ignored() {
    let env = env();
    start_island(&env, "secret-7", Script::Answer(reply("allow")));
    let mut child = Command::new(env!("CARGO_BIN_EXE_jarvis-hook"))
        .env("JARVIS_ISLAND_DIR", &env.dir)
        .env("JARVIS_ISLAND_PIPE", &env.endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"not json").unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn an_agent_that_never_closes_stdin_does_not_hang_us() {
    let env = env();
    let mut child = Command::new(env!("CARGO_BIN_EXE_jarvis-hook"))
        .arg("PermissionRequest")
        .env("JARVIS_ISLAND_DIR", &env.dir)
        .env("JARVIS_ISLAND_PIPE", &env.endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // Keep stdin open (held in `_stdin`) without writing anything.
    let _stdin = child.stdin.take().unwrap();
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(6), "the hook is still waiting on stdin");
        std::thread::sleep(Duration::from_millis(50));
    }
}
