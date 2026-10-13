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
