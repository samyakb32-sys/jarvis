// Where the island's window goes: hung from the top edge (docked), or as a
// floating ball anywhere on the screen. Pure geometry, in logical px on the
// screen; unit-tested by tests/model.test.mjs. Rust only applies the result.

import type { Mode } from "./model.ts";

export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Screen {
  /** The whole display. */
  monitor: Area;
  /** The display minus the taskbar. */
  work: Area;
}

/** Docked, or a floating ball whose centre is at (x, y). */
export interface Placement {
  docked: boolean;
  x: number;
  y: number;
}

export const DOCKED: Placement = { docked: true, x: 0, y: 0 };

/** Sizes, logical px. */
export const STRIP = { w: 240, h: 8 };
export const PANEL = { w: 680, h: 440 };
/** The floating ball and the room its antenna, hops and glow need around it. */
export const BALL = 44;
export const ORB = { w: 64, h: 84, cx: 32, cy: 52 };
/** The one-line status pill shown beside the ball. */
export const PILL_W = 300;
/** A ball dropped this close to the top edge docks. */
export const SNAP = 28;

export interface Layout {
  /** The window, on the screen. */
  win: Area;
  /** Centre of the ball inside the window; null when docked. */
  ball: { x: number; y: number } | null;
  /** Which side of the ball the pill goes (peek). */
  side: "right" | "left";
  /** Whether the panel opens below or above the ball (open). */
  dir: "down" | "up";
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** A ball centre kept inside the work area with room for its whole window. */
export function clampBall(x: number, y: number, s: Screen): { x: number; y: number } {
  const w = s.work;
  return {
    x: clamp(x, w.x + ORB.cx, w.x + w.w - (ORB.w - ORB.cx)),
    y: clamp(y, w.y + ORB.cy, w.y + w.h - (ORB.h - ORB.cy)),
  };
}

/** Where a ball released at (x, y) ends up: docked near the top edge, else floating there. */
export function settle(x: number, y: number, s: Screen): Placement {
  if (y - s.monitor.y <= SNAP + BALL / 2) return DOCKED;
  const c = clampBall(x, y, s);
  return { docked: false, x: Math.round(c.x), y: Math.round(c.y) };
}

/** A saved placement made valid for the display of today (resolution or monitor may have changed). */
export function revalidate(p: Placement | null | undefined, s: Screen): Placement {
  if (!p || p.docked || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return DOCKED;
  const c = clampBall(p.x, p.y, s);
  return { docked: false, x: Math.round(c.x), y: Math.round(c.y) };
}

export function layout(mode: Mode, p: Placement, s: Screen): Layout {
  const m = s.monitor;
  const w = s.work;
  if (p.docked) {
    const size = mode === "hidden" ? STRIP : PANEL;
    return { win: { x: Math.round(m.x + (m.w - size.w) / 2), y: m.y, w: size.w, h: size.h }, ball: null, side: "right", dir: "down" };
  }
  const c = clampBall(p.x, p.y, s);
  if (mode === "hidden") {
    return { win: { x: c.x - ORB.cx, y: c.y - ORB.cy, w: ORB.w, h: ORB.h }, ball: { x: ORB.cx, y: ORB.cy }, side: "right", dir: "down" };
  }
  if (mode === "peek") {
    const side = c.x + (ORB.w - ORB.cx) + PILL_W <= w.x + w.w ? "right" : "left";
    const width = ORB.w + PILL_W;
    const x = side === "right" ? c.x - ORB.cx : c.x - (width - (ORB.w - ORB.cx));
    return { win: { x, y: c.y - ORB.cy, w: width, h: ORB.h }, ball: { x: c.x - x, y: ORB.cy }, side, dir: "down" };
  }
  // open: the panel below the ball, or above it when there is no room below
  const height = ORB.h + PANEL.h;
  const dir = c.y + (ORB.h - ORB.cy) + PANEL.h <= w.y + w.h ? "down" : "up";
  const x = clamp(c.x - PANEL.w / 2, w.x, w.x + w.w - PANEL.w);
  const y = dir === "down" ? c.y - ORB.cy : c.y + (ORB.h - ORB.cy) - height;
  return { win: { x: Math.round(x), y: Math.round(y), w: PANEL.w, h: height }, ball: { x: c.x - Math.round(x), y: c.y - Math.round(y) }, side: "right", dir };
}
