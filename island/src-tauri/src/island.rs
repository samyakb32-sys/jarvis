// The island window: where it sits, how big it is, and when it lets clicks
// through.
//
// * `strip` (hidden): 240×8 logical at the top centre. Not click-through, so the
//   page sees the pointer arrive. Nothing polls.
// * `panel` (peek/open): 680×440 logical. Click-through except over the island
//   rectangle the page reports; a cursor poll at ~60 Hz decides and tells the
//   page `pointer: bool`. The poll thread sleeps on a condvar while in strip mode,
//   so a hidden island costs nothing.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{Emitter, PhysicalPosition, PhysicalSize, WebviewWindow};

const STRIP: (f64, f64) = (240.0, 8.0);
const PANEL: (f64, f64) = (680.0, 440.0);
const TICK: Duration = Duration::from_millis(16);

/// A rectangle in logical pixels, relative to the window's top-left corner.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

#[derive(Default)]
struct PollState {
    active: bool,
    rect: Option<Rect>,
    /// Last state applied to the window; `None` forces the next tick to apply.
    inside: Option<bool>,
}

#[derive(Default)]
pub struct Poll {
    state: Mutex<PollState>,
    wake: Condvar,
}

impl Poll {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set_rect(&self, rect: Option<Rect>) {
        self.state.lock().unwrap().rect = rect;
    }

    fn set_active(&self, active: bool) {
        let mut s = self.state.lock().unwrap();
        s.active = active;
        s.inside = None;
        self.wake.notify_all();
    }
}

/// Place the window as the strip, make it non-focusable, start the poll thread, show it.
pub fn start(win: &WebviewWindow, poll: &Arc<Poll>) -> tauri::Result<()> {
    // Appearing must never take the keyboard from the user's own window.
    win.set_focusable(false)?;
    place(win, STRIP)?;
    win.show()?;

    let win = win.clone();
    let poll = poll.clone();
    std::thread::Builder::new().name("island-poll".into()).spawn(move || run_poll(win, poll))?;
    Ok(())
}

pub fn set_mode(win: &WebviewWindow, poll: &Poll, mode: &str) -> tauri::Result<()> {
    match mode {
        "panel" => {
            place(win, PANEL)?;
            poll.set_active(true);
        }
        _ => {
            poll.set_active(false);
            win.set_ignore_cursor_events(false)?;
            place(win, STRIP)?;
        }
    }
    Ok(())
}

/// Size the window (logical) and hang it from the top centre of the primary display.
fn place(win: &WebviewWindow, (w, h): (f64, f64)) -> tauri::Result<()> {
    let monitor = win.primary_monitor()?.or(win.current_monitor()?);
    let Some(monitor) = monitor else {
        return win.set_size(tauri::LogicalSize::new(w, h));
    };
    let scale = monitor.scale_factor();
    let (pw, ph) = ((w * scale).round() as u32, (h * scale).round() as u32);
    let origin = monitor.position();
    let width = monitor.size().width as i32;
    win.set_size(PhysicalSize::new(pw, ph))?;
    win.set_position(PhysicalPosition::new(origin.x + (width - pw as i32) / 2, origin.y))?;
    Ok(())
}

fn run_poll(win: WebviewWindow, poll: Arc<Poll>) {
    loop {
        let rect = {
            let mut s = poll.state.lock().unwrap();
            while !s.active {
                s = poll.wake.wait(s).unwrap();
            }
            s.rect
        };

        let inside = rect.is_some_and(|r| pointer_in(&win, &r).unwrap_or(false));

        let apply = {
            let mut s = poll.state.lock().unwrap();
            if s.active && s.inside != Some(inside) {
                s.inside = Some(inside);
                true
            } else {
                false
            }
        };
        if apply {
            let _ = win.set_ignore_cursor_events(!inside);
            let _ = win.emit_to(crate::WINDOW, "pointer", inside);
        }
        std::thread::sleep(TICK);
    }
}

fn pointer_in(win: &WebviewWindow, rect: &Rect) -> tauri::Result<bool> {
    let cursor = win.cursor_position()?;
    let origin = win.outer_position()?;
    let scale = win.scale_factor()?;
    let x = (cursor.x - origin.x as f64) / scale;
    let y = (cursor.y - origin.y as f64) / scale;
    Ok(rect.contains(x, y))
}
