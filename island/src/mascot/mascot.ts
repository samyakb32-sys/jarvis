// The robot on the island, in one of three modes:
//
// * lite (default): plays the pre-baked sprite sheet of the state with a CSS
//   steps() animation. The compositor runs it; no script runs per frame.
// * live: the real robot-heads renderer, capped at 20 fps, with the eyes
//   following the pointer and a hop on a click. For a stronger PC.
// * still: one still image per state. No animation at all.
//
// Nothing runs while the element is not in the document or the page is hidden.

import manifest from "./robot.json";
import { Robot } from "./robot.ts";
import type { RobotMood } from "../model.ts";

export type AnimationMode = "lite" | "live" | "still";

const LIVE_FPS = 20;
/** The sprite loop's period, shared by every robot so a re-inserted one does not jump. */
const PERIOD_S = manifest.frames / manifest.fps;

const asset = (name: string) => `robot/${name}.webp`;

export class Mascot {
  readonly el: HTMLElement;
  private art: HTMLElement;
  private mood: RobotMood = "idle";
  private mode: AnimationMode;
  private robot: Robot | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private timer = 0;
  private last = 0;
  private onMove = (e: PointerEvent) => this.track(e);

  constructor(private size: number, mode: AnimationMode) {
    this.mode = mode;
    this.el = document.createElement("span");
    this.el.className = "mascot";
    this.el.style.width = this.el.style.height = `${size}px`;
    this.el.setAttribute("role", "img");
    this.art = document.createElement("span");
    this.art.className = "mascot-art";
    this.el.append(this.art);
    this.el.addEventListener("click", () => this.robot?.poke());
    this.apply();
  }

  setMood(mood: RobotMood) {
    if (mood === this.mood) return;
    this.mood = mood;
    this.el.setAttribute("aria-label", `Jarvis, ${mood}`);
    if (this.robot) this.robot.setState(mood);
    else this.paintSprite();
  }

  setMode(mode: AnimationMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.apply();
  }

  /** Call after the element was (re)inserted: keeps the sprite loop in phase with the clock. */
  attached() {
    if (this.mode === "lite") this.art.style.animationDelay = `${-((performance.now() / 1000) % PERIOD_S)}s`;
    if (this.robot && !this.timer) this.schedule();
  }

  destroy() {
    this.stopLive();
  }

  // -------------------------------------------------------------------------

  private get scale() {
    return this.size / manifest.box;
  }

  private apply() {
    this.stopLive();
    this.art.replaceChildren();
    this.art.removeAttribute("style");
    const k = this.scale;
    // the art reaches past the box: room for the antenna, hops and glow
    Object.assign(this.art.style, {
      left: `${-manifest.padSide * k}px`,
      top: `${-manifest.padTop * k}px`,
      width: `${manifest.cssWidth * k}px`,
      height: `${manifest.cssHeight * k}px`,
    });
    if (this.mode === "live" && !matchMedia("(prefers-reduced-motion: reduce)").matches) this.startLive();
    else this.paintSprite();
  }

  private paintSprite() {
    const k = this.scale;
    const still = this.mode === "still" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.art.classList.toggle("playing", !still);
    this.art.style.backgroundImage = `url(${asset(still ? `${this.mood}-still` : this.mood)})`;
    this.art.style.backgroundSize = still
      ? "100% 100%"
      : `${manifest.cssWidth * k * manifest.frames}px ${manifest.cssHeight * k}px`;
    this.art.style.setProperty("--run", `${-manifest.cssWidth * k * manifest.frames}px`);
    this.art.style.setProperty("--frames", String(manifest.frames));
    this.art.style.setProperty("--period", `${PERIOD_S}s`);
    this.attached();
  }

  private startLive() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "mascot-live";
    this.robot = new Robot(this.canvas, this.size, this.mood);
    this.canvas.style.width = `${this.robot.cssWidth}px`;
    this.canvas.style.height = `${this.robot.cssHeight}px`;
    Object.assign(this.art.style, { left: `${-this.robot.frame.padSide}px`, top: `${-this.robot.frame.padTop}px` });
    this.art.append(this.canvas);
    this.robot.draw(false);
    document.addEventListener("pointermove", this.onMove, { passive: true });
    this.schedule();
  }

  private schedule() {
    this.last = performance.now();
    this.timer = window.setTimeout(this.tick, 1000 / LIVE_FPS);
  }

  private stopLive() {
    window.clearTimeout(this.timer);
    this.timer = 0;
    document.removeEventListener("pointermove", this.onMove);
    this.robot = null;
    this.canvas = null;
  }

  /** One frame at most every 1/20 s; the loop ends while the robot is off screen (attached() restarts it). */
  private tick = () => {
    this.timer = 0;
    if (!this.robot || !this.el.isConnected) return;
    const now = performance.now();
    if (!document.hidden) {
      this.robot.update(Math.min(0.1, (now - this.last) / 1000));
      this.robot.draw(true);
    }
    this.schedule();
  };

  private track(e: PointerEvent) {
    if (!this.robot || !this.el.isConnected) return;
    const r = this.el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    this.robot.setPointer(Math.hypot(dx, dy) < 700 ? { x: dx, y: dy } : null);
  }
}
