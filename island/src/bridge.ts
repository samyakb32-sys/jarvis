// Thin wrapper over the app's Tauri commands and events. Outside Tauri (plain
// `npm run dev` in a browser) every call is a no-op, so the UI can be worked on alone.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Card {
  id: string;
  source: string; // "claude" | "hermes"
  event: string;
  wait: boolean;
  /** Whatever the agent or Hermes sent; read it defensively (see model.ts). */
  payload: any;
}

export interface Reply {
  decision: string | null;
  answers?: Record<string, string>;
  feedback?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Prefs {
  placement?: { docked: boolean; x: number; y: number };
  sound?: boolean;
  animation?: "lite" | "live" | "still";
}

export interface ScreenInfo {
  monitor: Rect;
  work: Rect;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookExists: boolean;
}

export interface Preview {
  diff: string;
  changed: boolean;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IN_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[island] ${cmd} failed`, err);
    return null;
  }
}

/** Like `call`, but the error text reaches the caller (shown in Settings). */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IN_TAURI) throw new Error("Not running inside the app.");
  return invoke<T>(cmd, args);
}

export const Bridge = {
  ack: (id: string) => call<boolean>("card_ack", { id }),
  decide: (id: string, reply: Reply) => call<boolean>("card_decide", { id, reply }),
  /** Move and size the window (logical px on the screen); `poll` watches the pointer for click-through. */
  setGeometry: (rect: Rect, poll: boolean) => call<void>("set_geometry", { rect, poll }),
  /** The parts of the window that take clicks; everywhere else they pass through. */
  setHitRects: (rects: Rect[]) => call<void>("set_hit_rects", { rects }),
  screenInfo: () => call<ScreenInfo>("screen_info"),
  prefsGet: () => call<Prefs>("prefs_get"),
  prefsSet: (prefs: Prefs) => call<void>("prefs_set", { prefs }),
  setKeyboard: (take: boolean) => call<void>("set_keyboard", { take }),
  selftest: () => call<string | null>("selftest"),
  quit: () => call<void>("quit"),
  hooksStatus: () => callOrThrow<HookStatus>("hooks_status"),
  hooksPreview: (install: boolean) => callOrThrow<Preview>("hooks_preview", { install }),
  hooksApply: (install: boolean) => callOrThrow<string | null>("hooks_apply", { install }),
};

export async function on<T>(event: string, fn: (payload: T) => void): Promise<UnlistenFn> {
  if (!IN_TAURI) return () => {};
  return listen<T>(event, (e) => fn(e.payload));
}
