//! The relay the island app runs: accepts one request per connection, shows it,
//! and — for requests that wait — writes the island's decision back.
//!
//! Guarantees towards the agent (it must never be stuck behind us):
//! * a client must send its line within [`REQUEST_READ_TIMEOUT`];
//! * a waiting request is declined unless the island confirms, within
//!   [`ACK_TIMEOUT`], that the card is actually on screen;
//! * after the decision timeout the request gets "no decision";
//! * a client that hangs up takes its card off the island.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::wire::{self, Reply, Request, ACK_TIMEOUT, MAX_LINE, REQUEST_READ_TIMEOUT};

/// What the island shows.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Card {
    pub id: String,
    pub source: String,
    pub event: String,
    /// A human is expected to answer it.
    pub wait: bool,
    pub payload: Value,
}

/// The island side. Implemented by the app (Tauri events) and by tests.
pub trait Ui: Send + Sync + 'static {
    fn show(&self, card: Card);
    /// The card is no longer answerable (decided, timed out, or the client left).
    fn dismiss(&self, id: &str);
}

/// What the island can say about a waiting card.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// The card is on screen and can be acted on.
    Ack,
    /// A human decided.
    Decide(Reply),
    /// Nobody can act on it (paused, closed).
    Decline,
}

/// Cards waiting for an answer, and the token clients must present.
pub struct Hub {
    token: String,
    pending: Mutex<HashMap<String, mpsc::UnboundedSender<Answer>>>,
    next: AtomicU64,
}

impl Hub {
    pub fn new(token: impl Into<String>) -> Arc<Self> {
        Arc::new(Self { token: token.into(), pending: Mutex::default(), next: AtomicU64::new(1) })
    }

    /// Route an answer to the waiting request. `false` if it is no longer waiting.
    pub fn answer(&self, id: &str, answer: Answer) -> bool {
        let pending = self.pending.lock().unwrap();
        pending.get(id).is_some_and(|tx| tx.send(answer).is_ok())
    }

    /// Ids of cards currently waiting.
    pub fn waiting(&self) -> Vec<String> {
        self.pending.lock().unwrap().keys().cloned().collect()
    }

    fn register(&self) -> (String, mpsc::UnboundedReceiver<Answer>) {
        let id = format!("c{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::unbounded_channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    fn forget(&self, id: &str) {
        self.pending.lock().unwrap().remove(id);
    }
}

/// Serve one connection.
pub async fn handle<S>(hub: Arc<Hub>, ui: Arc<dyn Ui>, stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);

    let mut line = Vec::new();
    let got = timeout(REQUEST_READ_TIMEOUT, (&mut reader).take(MAX_LINE as u64).read_until(b'\n', &mut line)).await;
    if !matches!(got, Ok(Ok(n)) if n > 0) {
        return;
    }
    let Ok(req) = serde_json::from_slice::<Request>(&line) else { return };
    if req.v != wire::VERSION || !wire::token_matches(&hub.token, &req.token) {
        if req.wait {
            let _ = write_reply(&mut write, &Reply::none()).await;
        }
        return;
    }

    if !req.wait {
        let id = format!("e{}", hub.next.fetch_add(1, Ordering::Relaxed));
        ui.show(Card { id, source: req.source, event: req.event, wait: false, payload: req.payload });
        return;
    }

    let limit = req.decision_timeout();
    let (id, mut rx) = hub.register();
    ui.show(Card { id: id.clone(), source: req.source, event: req.event, wait: true, payload: req.payload });

    let reply = decide(&mut rx, &mut reader, limit).await;
    hub.forget(&id);
    ui.dismiss(&id);
    if let Some(reply) = reply {
        let _ = write_reply(&mut write, &reply).await;
    }
}

/// `Some(reply)` to write back, `None` when the client is already gone.
async fn decide<R: AsyncRead + Unpin>(
    rx: &mut mpsc::UnboundedReceiver<Answer>,
    reader: &mut R,
    limit: std::time::Duration,
) -> Option<Reply> {
    // 1. The island must confirm the card is visible.
    match timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Answer::Ack)) => {}
        Ok(Some(Answer::Decide(reply))) => return Some(reply),
        _ => return Some(Reply::none()),
    }
    // 2. Wait for a human, the deadline, or the client hanging up.
    let mut probe = [0u8; 1];
    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            answer = rx.recv() => match answer {
                Some(Answer::Decide(reply)) => return Some(reply),
                Some(Answer::Ack) => continue,
                Some(Answer::Decline) | None => return Some(Reply::none()),
            },
            _ = &mut deadline => return Some(Reply::none()),
            // A client never sends more after its request: any read result means it left.
            _ = reader.read(&mut probe) => return None,
        }
    }
}

async fn write_reply<W: AsyncWrite + Unpin>(write: &mut W, reply: &Reply) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(reply).unwrap_or_else(|_| b"{\"decision\":null}".to_vec());
    line.push(b'\n');
    write.write_all(&line).await?;
    write.flush().await
}

/// Listen on `endpoint` forever (named pipe on Windows, Unix socket elsewhere).
/// Fails at once if another instance already owns the endpoint.
pub async fn serve(hub: Arc<Hub>, ui: Arc<dyn Ui>, endpoint: String) -> std::io::Result<()> {
    platform::serve(hub, ui, endpoint).await
}

#[cfg(windows)]
mod platform {
    use super::*;
    use tokio::net::windows::named_pipe::ServerOptions;

    pub async fn serve(hub: Arc<Hub>, ui: Arc<dyn Ui>, endpoint: String) -> std::io::Result<()> {
        // first_pipe_instance: refuse to share a name someone else created first.
        let mut server = ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&endpoint)?;
        loop {
            server.connect().await?;
            let next = ServerOptions::new().reject_remote_clients(true).create(&endpoint)?;
            let conn = std::mem::replace(&mut server, next);
            tokio::spawn(handle(hub.clone(), ui.clone(), conn));
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    pub async fn serve(hub: Arc<Hub>, ui: Arc<dyn Ui>, endpoint: String) -> std::io::Result<()> {
        let path = std::path::Path::new(&endpoint);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // A socket file left by a crashed instance; a live one would still accept.
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "another island is already running"));
        }
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        loop {
            let (conn, _) = listener.accept().await?;
            tokio::spawn(handle(hub.clone(), ui.clone(), conn));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::duplex;

    #[derive(Default)]
    struct Recorder {
        shown: Mutex<Vec<Card>>,
        dismissed: Mutex<Vec<String>>,
    }
    impl Ui for Recorder {
        fn show(&self, card: Card) {
            self.shown.lock().unwrap().push(card);
        }
        fn dismiss(&self, id: &str) {
            self.dismissed.lock().unwrap().push(id.into());
        }
    }

    fn line(token: &str, wait: bool) -> Vec<u8> {
        let req = Request { v: 1, token: token.into(), source: "claude".into(), event: "PermissionRequest".into(), wait, timeout_ms: None, payload: serde_json::json!({"tool_name":"Bash"}) };
        let mut l = serde_json::to_vec(&req).unwrap();
        l.push(b'\n');
        l
    }

    async fn read_reply<R: AsyncRead + Unpin>(r: &mut R) -> String {
        let mut s = String::new();
        BufReader::new(r).read_line(&mut s).await.unwrap();
        s
    }

    #[tokio::test]
    async fn ack_then_decision_is_written_back() {
        let hub = Hub::new("t0k");
        let ui = Arc::new(Recorder::default());
        let (mut client, server) = duplex(4096);
        let task = tokio::spawn(handle(hub.clone(), ui.clone(), server));
        client.write_all(&line("t0k", true)).await.unwrap();
        // Wait for the card, then answer like the island would.
        let id = loop {
            if let Some(c) = ui.shown.lock().unwrap().first() { break c.id.clone(); }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(hub.answer(&id, Answer::Ack));
        assert!(hub.answer(&id, Answer::Decide(Reply { decision: Some("allow".into()), ..Reply::default() })));
        assert_eq!(read_reply(&mut client).await, "{\"decision\":\"allow\"}\n");
        task.await.unwrap();
        assert_eq!(ui.dismissed.lock().unwrap().as_slice(), std::slice::from_ref(&id));
        assert!(!hub.answer(&id, Answer::Ack), "forgotten after the decision");
    }

    #[tokio::test(start_paused = true)]
    async fn no_ack_means_no_decision_quickly() {
        let hub = Hub::new("t0k");
        let ui = Arc::new(Recorder::default());
        let (mut client, server) = duplex(4096);
        let task = tokio::spawn(handle(hub, ui, server));
        client.write_all(&line("t0k", true)).await.unwrap();
        assert_eq!(read_reply(&mut client).await, "{\"decision\":null}\n");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn bad_token_shows_nothing() {
        let hub = Hub::new("t0k");
        let ui = Arc::new(Recorder::default());
        let (mut client, server) = duplex(4096);
        let task = tokio::spawn(handle(hub, ui.clone(), server));
        client.write_all(&line("nope", true)).await.unwrap();
        assert_eq!(read_reply(&mut client).await, "{\"decision\":null}\n");
        task.await.unwrap();
        assert!(ui.shown.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn fire_and_forget_is_shown_and_closed() {
        let hub = Hub::new("t0k");
        let ui = Arc::new(Recorder::default());
        let (mut client, server) = duplex(4096);
        let task = tokio::spawn(handle(hub.clone(), ui.clone(), server));
        client.write_all(&line("t0k", false)).await.unwrap();
        task.await.unwrap();
        let shown = ui.shown.lock().unwrap();
        assert_eq!(shown.len(), 1);
        assert!(!shown[0].wait);
        assert!(hub.waiting().is_empty());
    }

    #[tokio::test]
    async fn client_hanging_up_dismisses_the_card() {
        let hub = Hub::new("t0k");
        let ui = Arc::new(Recorder::default());
        let (mut client, server) = duplex(4096);
        let task = tokio::spawn(handle(hub.clone(), ui.clone(), server));
        client.write_all(&line("t0k", true)).await.unwrap();
        let id = loop {
            if let Some(c) = ui.shown.lock().unwrap().first() { break c.id.clone(); }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        hub.answer(&id, Answer::Ack);
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(client);
        task.await.unwrap();
        assert_eq!(ui.dismissed.lock().unwrap().as_slice(), [id]);
        assert!(hub.waiting().is_empty());
    }
}
