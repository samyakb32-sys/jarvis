// Unit tests for the island's pure logic. Node runs the TypeScript directly
// (type stripping, Node >= 22.18).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answersFrom,
  applyHermes,
  applyHook,
  basename,
  hermesBusy,
  onLeave,
  pick,
  questionsOf,
  toolLine,
} from "../src/model.ts";

const hook = (event, payload) => ({ id: "e", source: "claude", event, wait: false, payload });

test("leaving folds, then hides, unless something holds the island", () => {
  const free = { waiting: false, settings: false, typing: false };
  assert.equal(onLeave("open", free, false), "peek");
  assert.equal(onLeave("peek", free, false), "hidden");
  assert.equal(onLeave("peek", free, true), null, "kept out while Hermes runs or a notice shows");
  assert.equal(onLeave("open", { ...free, waiting: true }, false), null, "a waiting card pins it");
  assert.equal(onLeave("open", { ...free, settings: true }, false), null);
  assert.equal(onLeave("open", { ...free, typing: true }, false), null);
});

test("hook events build the session list", () => {
  const s = new Map();
  applyHook(s, hook("SessionStart", { session_id: "a", cwd: "C:\\work\\shop" }), 1);
  assert.equal(s.get("a").project, "shop");
  applyHook(s, hook("PreToolUse", { session_id: "a", tool_name: "Bash", tool_input: { command: "npm test" } }), 2);
  assert.equal(s.get("a").state, "working");
  assert.equal(s.get("a").detail, "Bash · npm test");
  const n = applyHook(s, hook("Stop", { session_id: "a", last_assistant_message: "All tests pass." }), 3);
  assert.equal(n, "shop: finished");
  assert.equal(s.get("a").state, "done");
  applyHook(s, hook("SessionEnd", { session_id: "a" }), 4);
  assert.equal(s.size, 0);
  assert.equal(applyHook(s, { ...hook("PermissionRequest", {}), wait: true }, 5), null, "waiting cards are not session events");
});

test("tool lines and basenames", () => {
  assert.equal(toolLine("Edit", { file_path: "src/a.ts" }), "Edit · src/a.ts");
  assert.equal(toolLine("Task", {}), "Task");
  assert.equal(toolLine(undefined, null), "Tool");
  assert.equal(basename("/home/me/proj/"), "proj");
  assert.equal(basename(""), "session");
});

const askCard = {
  id: "c1",
  source: "claude",
  event: "PermissionRequest",
  wait: true,
  payload: {
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [
        { question: "Which DB?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] },
        { question: "Extras?", header: "Extras", multiSelect: true, options: [{ label: "Auth" }, { label: "Tests" }] },
      ],
    },
  },
};

test("question cards collect one answer per question", () => {
  const qs = questionsOf(askCard);
  assert.equal(qs.length, 2);
  const picks = new Map();
  assert.equal(answersFrom(qs, picks), null);
  pick(picks, qs[0], "Postgres");
  pick(picks, qs[0], "SQLite");
  pick(picks, qs[1], "Tests");
  pick(picks, qs[1], "Auth");
  assert.deepEqual(answersFrom(qs, picks), { "Which DB?": "SQLite", "Extras?": "Auth, Tests" }, "labels keep the offered order");
  pick(picks, qs[1], "Auth");
  pick(picks, qs[1], "Tests");
  assert.equal(answersFrom(qs, picks), null, "a multi-select with nothing picked is unanswered");
  assert.equal(questionsOf({ ...askCard, payload: { tool_name: "Bash" } }), null);
});

test("Hermes events drive the stage strip", () => {
  const ev = (event, payload) => ({ id: "h", source: "hermes", event, wait: false, payload });
  let { run, notice } = applyHermes(null, ev("start", { project: "recipes" }));
  assert.equal(notice, "Hermes: recipes");
  assert.equal(hermesBusy(run), false);
  ({ run, notice } = applyHermes(run, ev("stage", { stage: "frontend", status: "running" })));
  assert.equal(run.stages.frontend, "running");
  assert.equal(notice, "Frontend started");
  assert.equal(hermesBusy(run), true);
  ({ run } = applyHermes(run, ev("stage", { stage: "frontend", status: "done" })));
  ({ run, notice } = applyHermes(run, ev("done", { url: "https://recipes.vercel.app" })));
  assert.equal(run.url, "https://recipes.vercel.app");
  assert.equal(run.finished, true);
  assert.equal(hermesBusy(run), false);
  ({ run } = applyHermes(run, ev("done", { url: "javascript:alert(1)" })));
  assert.equal(run.url, "https://recipes.vercel.app", "only http(s) links are kept");
});

// ---------------------------------------------------------------------------
// The robot's mood

import { FLASH_MS, SLEEP_AFTER_MS, mascotMood } from "../src/model.ts";

const mood = (o = {}) =>
  mascotMood({ waiting: 0, sessions: [], hermes: null, flash: null, lastActivity: 1000, now: 1000, ...o });

test("the robot shows the most urgent thing", () => {
  const working = [{ id: "a", project: "p", state: "working", detail: "", updated: 0 }];
  const busyHermes = { project: "p", stages: { plan: "done", frontend: "running" }, url: null, finished: false };
  assert.equal(mood(), "idle");
  assert.equal(mood({ sessions: working }), "working");
  assert.equal(mood({ hermes: busyHermes }), "thinking");
  assert.equal(mood({ sessions: working, hermes: busyHermes }), "thinking", "Hermes outranks a session");
  const flash = { mood: "happy", until: 1000 + FLASH_MS };
  assert.equal(mood({ flash, hermes: busyHermes }), "happy", "a reaction outranks work");
  assert.equal(mood({ flash: { ...flash, until: 999 } }), "idle", "an ended reaction is ignored");
  assert.equal(mood({ waiting: 1, flash, sessions: working }), "listening", "a waiting card outranks everything");
  assert.equal(mood({ now: 1000 + SLEEP_AFTER_MS + 1 }), "sleeping");
  assert.equal(mood({ now: 1000 + SLEEP_AFTER_MS + 1, sessions: working }), "working", "work keeps it awake");
});

// ---------------------------------------------------------------------------
// Placement

import { BALL, DOCKED, ORB, PANEL, PILL_W, SNAP, clampBall, layout, revalidate, settle as settlePlacement } from "../src/place.ts";

const screen = { monitor: { x: 0, y: 0, w: 1920, h: 1080 }, work: { x: 0, y: 0, w: 1920, h: 1040 } };

test("a ball dropped near the top edge docks, anywhere else it floats", () => {
  assert.deepEqual(settlePlacement(900, 10, screen), DOCKED);
  assert.deepEqual(settlePlacement(900, SNAP + BALL / 2, screen), DOCKED);
  const p = settlePlacement(900, 400, screen);
  assert.deepEqual(p, { docked: false, x: 900, y: 400 });
  // Dropped off the bottom and right edges: pulled back so the whole ball is visible.
  const q = settlePlacement(5000, 5000, screen);
  assert.equal(q.docked, false);
  assert.equal(q.x, 1920 - (ORB.w - ORB.cx));
  assert.equal(q.y, 1040 - (ORB.h - ORB.cy));
});

test("a saved placement is made valid for today's screen", () => {
  assert.deepEqual(revalidate(null, screen), DOCKED);
  assert.deepEqual(revalidate({ docked: true, x: 1, y: 1 }, screen), DOCKED);
  assert.deepEqual(revalidate({ docked: false, x: NaN, y: 3 }, screen), DOCKED);
  const small = { monitor: { x: 0, y: 0, w: 800, h: 600 }, work: { x: 0, y: 0, w: 800, h: 560 } };
  const p = revalidate({ docked: false, x: 1800, y: 900 }, small);
  assert.ok(p.x <= 800 && p.y <= 560, "pulled back inside the smaller screen");
});

test("layout: docked hangs from the top centre, the ball opens its panel where there is room", () => {
  const strip = layout("hidden", DOCKED, screen).win;
  assert.equal(strip.y, 0);
  assert.equal(strip.x, (1920 - strip.w) / 2);
  assert.equal(layout("open", DOCKED, screen).win.w, PANEL.w);

  const high = { docked: false, x: 960, y: 300 };
  const down = layout("open", high, screen);
  assert.equal(down.dir, "down");
  assert.ok(down.win.x >= 0 && down.win.x + down.win.w <= 1920);
  assert.equal(down.win.x + down.ball.x, 960, "the ball stays where it was");
  assert.equal(down.win.y + down.ball.y, 300);

  const low = layout("open", { docked: false, x: 960, y: 1000 }, screen);
  assert.equal(low.dir, "up", "no room below: the panel opens above");
  assert.ok(low.win.y >= 0 && low.win.y + low.win.h <= 1040);
  assert.equal(low.win.y + low.ball.y, clampBall(960, 1000, screen).y);

  const edge = layout("peek", { docked: false, x: 1900, y: 300 }, screen);
  assert.equal(edge.side, "left", "no room on the right: the pill goes left of the ball");
  assert.ok(edge.win.x >= 0 && edge.win.x + edge.win.w <= 1920);
  assert.equal(layout("peek", { docked: false, x: 200, y: 300 }, screen).side, "right");
  assert.equal(layout("peek", { docked: false, x: 200, y: 300 }, screen).win.w, ORB.w + PILL_W);
});

// ---------------------------------------------------------------------------
// Sounds stay off unless asked for

test("sounds are defined for every event and nothing plays at import", async () => {
  globalThis.AudioContext = class {
    constructor() { globalThis.__audio = true; }
  };
  const { play } = await import("../src/sound.ts");
  assert.equal(globalThis.__audio, undefined, "importing the module creates no audio context");
  play("ask"); // an unusable context must never throw
  play("done");
  play("deny");
});
