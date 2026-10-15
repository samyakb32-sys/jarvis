// Drives the vendored robot-heads renderer without React: the same steps as
// upstream's RobotHead.tsx `paint()`, as a small class. Used live (Settings ›
// "Live 3D") and by scripts/bake-robot.mjs to bake the Lite sprite sheets.

import { parseColor } from "../vendor/robot-heads/color";
import { getShape } from "../vendor/robot-heads/tv/geometry";
import { linear } from "../vendor/robot-heads/tv/light";
import { frameFor, RobotRenderer, type Frame, type Palette } from "../vendor/robot-heads/tv/render";
import { RobotSim, restPose } from "../vendor/robot-heads/tv/sim";
import type { RobotHeadShape, RobotHeadState } from "../vendor/robot-heads/types";

export type { RobotHeadShape, RobotHeadState };

export interface Look {
  shape: RobotHeadShape;
  /** Shell, trim (ears, antenna collar) and LED colours, as #rrggbb. */
  color: string;
  trim: string;
  screen: string;
  antenna: boolean;
}

/** The Jarvis Island look: a dark ball with periwinkle trim and cool white LEDs. */
export const LOOK: Look = { shape: "circle", color: "#1f2438", trim: "#8ea2ff", screen: "#e8f2ff", antenna: true };

function palette(look: Look): Palette {
  const shell = parseColor(look.color) ?? [31, 36, 56];
  const metal = parseColor(look.trim) ?? [142, 162, 255];
  const led = parseColor(look.screen) ?? [232, 242, 255];
  return {
    shell: { albedo: linear(shell), f0: 0.05, metal: 0.15, spec: 0.55, shininess: 70, rim: 0.9 },
    trim: { albedo: linear(metal), f0: 0.2, metal: 0.65, spec: 0.8, shininess: 45, rim: 0.7 },
    led,
  };
}

/** Where the robot sits for a `box`-px element: the canvas reaches past the box by the pads. */
export function frameOf(box: number, look: Look = LOOK): Frame {
  return frameFor(getShape(look.shape), look.antenna, box);
}

export class Robot {
  readonly frame: Frame;
  private sim: RobotSim;
  private renderer = new RobotRenderer();
  private pal: Palette;
  private state: RobotHeadState;

  constructor(
    private canvas: HTMLCanvasElement,
    box: number,
    state: RobotHeadState = "idle",
    private look: Look = LOOK,
    private dpr = Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1),
    seed = 0.37,
  ) {
    this.frame = frameOf(box, look);
    this.pal = palette(look);
    this.state = state;
    this.sim = new RobotSim(seed, state);
    const f = this.frame;
    canvas.width = Math.round((f.box + 2 * f.padSide) * this.dpr);
    canvas.height = Math.round((f.box + f.padTop + f.padBottom) * this.dpr);
  }

  /** CSS size of the canvas (box plus pads). */
  get cssWidth() {
    return this.frame.box + 2 * this.frame.padSide;
  }
  get cssHeight() {
    return this.frame.box + this.frame.padTop + this.frame.padBottom;
  }

  setState(state: RobotHeadState) {
    this.state = state;
    this.sim.setState(state);
  }

  /** Eyes and head follow a point given relative to the resting head's centre (CSS px), or nothing. */
  setPointer(p: { x: number; y: number } | null) {
    this.sim.pointer = p;
  }

  /** A hop and a spin, as on a click. */
  poke() {
    this.sim.poke();
  }

  /** Advance the motion by `dt` seconds. */
  update(dt: number) {
    this.sim.update(dt);
  }

  /** Draw the current pose, or the still rest pose of the state. */
  draw(animated = true) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const shape = getShape(this.look.shape);
    this.renderer.draw(ctx, this.frame, this.dpr, animated ? this.sim.pose : restPose(this.state), animated ? this.sim : null, this.state, shape, this.pal, {
      floorShadow: false,
      antenna: this.look.antenna,
    });
  }
}
