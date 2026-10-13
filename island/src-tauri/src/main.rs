// Jarvis Island — the app host.
//
// One transparent, topmost, non-focusable window hung from the top centre of the
// primary display. Hidden, it is a 240×8 strip the pointer can find; shown, it
// grows to the panel size and becomes click-through everywhere except over the
// island itself (the page reports that rectangle; a cursor poll that only runs
// while the panel is up decides). The relay server (jarvis-island-protocol)
// feeds it cards from jarvis-hook and Hermes.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hooks;
mod island;

use std::sync::Arc;

use jarvis_island_protocol::paths;
use jarvis_island_protocol::server::{self, Answer, Card, Hub, Ui};
use jarvis_island_protocol::wire::Reply;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

pub const WINDOW: &str = "island";

struct AppState {
    hub: Arc<Hub>,
    poll: Arc<island::Poll>,
}

/// The island side of the relay: cards become events for the page.
struct PageUi(AppHandle);

impl Ui for PageUi {
    fn show(&self, card: Card) {
        let _ = self.0.emit_to(WINDOW, "card", card);
    }
    fn dismiss(&self, id: &str) {
        let _ = self.0.emit_to(WINDOW, "dismiss", id);
    }
}

#[tauri::command]
fn card_ack(state: State<'_, AppState>, id: String) -> bool {
    state.hub.answer(&id, Answer::Ack)
}

#[tauri::command]
fn card_decide(state: State<'_, AppState>, id: String, reply: Reply) -> bool {
    state.hub.answer(&id, Answer::Decide(reply))
}

#[tauri::command]
async fn set_mode(app: AppHandle, state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let win = app.get_webview_window(WINDOW).ok_or("no island window")?;
    island::set_mode(&win, &state.poll, &mode).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_hit_rect(state: State<'_, AppState>, rect: Option<island::Rect>) {
    state.poll.set_rect(rect);
}

/// Let the island take the keyboard (a text field was clicked), or give it back.
#[tauri::command]
async fn set_keyboard(app: AppHandle, take: bool) -> Result<(), String> {
    let win = app.get_webview_window(WINDOW).ok_or("no island window")?;
    win.set_focusable(take).map_err(|e| e.to_string())?;
    if take {
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// CI only: `JARVIS_ISLAND_SELFTEST=allow|deny` makes the page answer cards by itself.
#[tauri::command]
fn selftest() -> Option<String> {
    std::env::var("JARVIS_ISLAND_SELFTEST").ok().filter(|v| matches!(v.as_str(), "allow" | "deny"))
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// A fresh random token, written where clients (jarvis-hook, Hermes) read it.
fn write_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = paths::data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    std::fs::write(paths::token_path(), &token).map_err(|e| e.to_string())?;
    Ok(token)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let token = write_token()?;
            let hub = Hub::new(token);
            let poll = island::Poll::new();
            app.manage(AppState { hub: hub.clone(), poll: poll.clone() });

            let win = app.get_webview_window(WINDOW).ok_or("no island window")?;
            island::start(&win, &poll)?;

            let handle = app.handle().clone();
            let ui: Arc<dyn Ui> = Arc::new(PageUi(handle.clone()));
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::serve(hub, ui, paths::endpoint()).await {
                    eprintln!("jarvis-island: relay stopped: {e}");
                    let _ = handle.emit_to(WINDOW, "relay-error", e.to_string());
                }
            });

            let hooks_item = MenuItem::with_id(app, "hooks", "Claude Code hooks…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Jarvis Island", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&hooks_item, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("main").tooltip("Jarvis Island").menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "hooks" => {
                    let _ = app.emit_to(WINDOW, "open-settings", ());
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            card_ack,
            card_decide,
            set_mode,
            set_hit_rect,
            set_keyboard,
            selftest,
            quit,
            hooks::hooks_status,
            hooks::hooks_preview,
            hooks::hooks_apply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jarvis Island");
}
