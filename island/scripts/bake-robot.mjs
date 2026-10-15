// Bakes the Lite-mode robot: runs the real robot-heads renderer once, in
// headless Chromium, and records each state as a horizontal sprite sheet
// (WebP) plus a still frame. The app then only plays images (a CSS steps()
// animation the compositor runs), so a weak laptop pays ~nothing per frame.
//
//   node scripts/bake-robot.mjs            # writes public/robot/*
//   CHROMIUM=/path/to/chrome node scripts/bake-robot.mjs
//
// Output is committed; re-run only when the look or the vendored renderer changes.

import { build } from "esbuild";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "robot");

/** Box size (CSS px) the sheets are drawn for, and the pixel density they are drawn at. */
const BOX = 48;
const DPR = 2;
/** 12 fps for 4 s: smooth enough for a 44 px ball, small enough to stay tiny. */
const FPS = 12;
const FRAMES = 48;
/** Let each state settle in before recording. */
const PREROLL_S = 2;

const STATES = ["idle", "thinking", "listening", "working", "happy", "error", "sleeping"];

const entry = `
import { Robot, LOOK } from "./src/mascot/robot.ts";
window.bake = ({ box, dpr, fps, frames, preroll, states }) => {
  const sheets = {};
  let meta = null;
  for (const state of states) {
    const c = document.createElement("canvas");
    const r = new Robot(c, box, state, LOOK, dpr, 0.37);
    if (!meta) meta = { cssWidth: r.cssWidth, cssHeight: r.cssHeight, padSide: r.frame.padSide, padTop: r.frame.padTop, width: c.width, height: c.height };
    for (let t = 0; t < preroll; t += 1 / fps) r.update(1 / fps);
    const sheet = document.createElement("canvas");
    sheet.width = c.width * frames;
    sheet.height = c.height;
    const sctx = sheet.getContext("2d");
    for (let i = 0; i < frames; i++) {
      r.update(1 / fps);
      r.draw(true);
      sctx.drawImage(c, i * c.width, 0);
    }
    r.draw(false);
    sheets[state] = { sheet: sheet.toDataURL("image/webp", 0.86), still: c.toDataURL("image/webp", 0.92) };
  }
  return { meta, sheets };
};
`;

const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
});

const executablePath =
  process.env.CHROMIUM ||
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ content: bundle.outputFiles[0].text });
const result = await page.evaluate(
  (o) => window.bake(o),
  { box: BOX, dpr: DPR, fps: FPS, frames: FRAMES, preroll: PREROLL_S, states: STATES },
);
await browser.close();

mkdirSync(out, { recursive: true });
const decode = (url) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
let total = 0;
for (const [state, { sheet, still }] of Object.entries(result.sheets)) {
  const a = decode(sheet);
  const b = decode(still);
  writeFileSync(path.join(out, `${state}.webp`), a);
  writeFileSync(path.join(out, `${state}-still.webp`), b);
  total += a.length + b.length;
  console.log(`${state}: sheet ${(a.length / 1024).toFixed(1)} KB, still ${(b.length / 1024).toFixed(1)} KB`);
}
const manifest = { box: BOX, dpr: DPR, fps: FPS, frames: FRAMES, ...result.meta, states: STATES };
// The page imports the manifest from src/ (Vite does not import from public/).
writeFileSync(path.join(root, "src", "mascot", "robot.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`total ${(total / 1024).toFixed(1)} KB → ${path.relative(root, out)}`);
