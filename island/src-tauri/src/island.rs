// The island window: where it sits, how big it is, and when it lets clicks
// through.
//
// The page decides the geometry (place.ts: docked at the top edge, or a
// floating ball anywhere) and sends it here as a rectangle in logical screen
// pixels; this file only applies it and keeps the click-through right:
//
// * `poll == false` (hidden, or while dragging): the window is not
//   click-through, so the page sees the pointer arrive. Nothing polls.
// * `poll == true` (peek / open): the window is click-through everywhere except
//   over the rectangles the page reports (the island, the ball, the pill). A
//   cursor poll at ~60 Hz decides and tells the page `pointer: bool`. The poll
//   thread sleeps on a condvar when not needed, so a hidden island costs nothing.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, LogicalPosition, LogicalSize, WebviewWindow};

const TICK: Duration = Duration::from_millis(16);

/// A rectangle in logical pixels. As a hit rectangle it is relative to the window's top-left corner.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
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

#[derive(Serialize)]
pub struct ScreenInfo {
    pub monitor: Rect,
    pub work: Rect,
}

#[derive(Default)]
struct PollState {
    active: bool,
    rects: Vec<Rect>,
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

    pub fn set_rects(&self, rects: Vec<Rect>) {
        let mut s = self.state.lock().unwrap();
        s.rects = rects;
        s.inside = None;
    }

    fn set_active(&self, active: bool) {
        let mut s = self.state.lock().unwrap();
        if s.active != active {
            s.active = active;
            s.inside = None;
            self.wake.notify_all();
        }
    }
}

/// Non-focusable, shown, and the poll thread started. The page sets the geometry once it has loaded.
pub fn start(win: &WebviewWindow, poll: &Arc<Poll>) -> tauri::Result<()> {
    // Appearing must never take the keyboard from the user's own window.
    win.set_focusable(false)?;
    win.show()?;

    let win = win.clone();
    let poll = poll.clone();
    std::thread::Builder::new().name("island-poll".into()).spawn(move || run_poll(win, poll))?;
    Ok(())
}

/// The primary display and its work area (without the taskbar), in logical pixels.
pub fn screen_info(win: &WebviewWindow) -> tauri::Result<Option<ScreenInfo>> {
    let Some(m) = win.primary_monitor()?.or(win.current_monitor()?) else { return Ok(None) };
    let k = m.scale_factor();
    let (p, s, w) = (m.position(), m.size(), m.work_area());
    let logical = |x: f64, y: f64, w: f64, h: f64| Rect { x: x / k, y: y / k, w: w / k, h: h / k };
    Ok(Some(ScreenInfo {
        monitor: logical(p.x as f64, p.y as f64, s.width as f64, s.height as f64),
        work: logical(w.position.x as f64, w.position.y as f64, w.size.width as f64, w.size.height as f64),
    }))
}

/// Move and size the window (logical screen pixels) and switch the click-through poll on or off.
pub fn set_geometry(win: &WebviewWindow, poll: &Poll, rect: Rect, polling: bool) -> tauri::Result<()> {
    win.set_size(LogicalSize::new(rect.w, rect.h))?;
    win.set_position(LogicalPosition::new(rect.x, rect.y))?;
    if !polling {
        poll.set_active(false);
        win.set_ignore_cursor_events(false)?;
    } else {
        poll.set_active(true);
    }
    Ok(())
}

fn run_poll(win: WebviewWindow, poll: Arc<Poll>) {
    loop {
        let rects = {
            let mut s = poll.state.lock().unwrap();
            while !s.active {
                s = poll.wake.wait(s).unwrap();
            }
            s.rects.clone()
        };

        let inside = !rects.is_empty() && pointer_in(&win, &rects).unwrap_or(false);

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

fn pointer_in(win: &WebviewWindow, rects: &[Rect]) -> tauri::Result<bool> {
    let cursor = win.cursor_position()?;
    let origin = win.outer_position()?;
    let scale = win.scale_factor()?;
    let x = (cursor.x - origin.x as f64) / scale;
    let y = (cursor.y - origin.y as f64) / scale;
    Ok(rects.iter().any(|r| r.contains(x, y)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_contains_is_half_open() {
        let r = Rect { x: 10.0, y: 10.0, w: 20.0, h: 20.0 };
        assert!(r.contains(10.0, 10.0));
        assert!(r.contains(29.9, 29.9));
        assert!(!r.contains(30.0, 20.0));
        assert!(!r.contains(9.9, 20.0));
    }
}
