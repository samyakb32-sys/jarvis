// The island page: hidden → peek → open, cards that wait for a click, the
// Claude Code sessions and the Hermes run, the robot, and the settings.
//
// Two placements share every rule: docked (hung from the top edge, as a
// notch) and floating (the robot ball, anywhere on the screen). Drag the
// island off the top edge to make it a ball; drop the ball near the top edge
// to dock it again. The geometry is in place.ts; Rust only applies it.

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { Bridge, IN_TAURI, on, type Card, type HookStatus, type Prefs, type Rect, type Reply } from "./bridge.ts";
import { Mascot, type AnimationMode } from "./mascot/mascot.ts";
import {
  applyHermes,
  applyHook,
  answersFrom,
  basename,
  FLASH_MS,
  FOLD_DELAY,
  hasSuggestions,
  hermesBusy,
  HIDE_DELAY,
  HOVER_OPEN,
  mascotMood,
  NOTICE_MS,
  onLeave,
  pick,
  questionsOf,
  SLEEP_AFTER_MS,
  STAGES,
  toolLine,
  WAKE_DWELL,
  type HermesRun,
  type Mode,
  type Session,
} from "./model.ts";
import { BALL, DOCKED, layout, revalidate, settle as settlePlacement, type Placement, type Screen } from "./place.ts";
import { play, type Sound } from "./sound.ts";

// ---------------------------------------------------------------------------
// State

let mode: Mode = "hidden";
let view: "home" | "settings" = "home";
let pointerInside = false;
let typing = false;
const waiting: Card[] = [];
const sessions = new Map<string, Session>();
let hermes: HermesRun | null = null;
let notice: { text: string; until: number } | null = null;
let relayError: string | null = null;
let selftest: string | null = null;

let prefs: Required<Prefs> = { placement: DOCKED, sound: false, animation: "lite" };
let placement: Placement = DOCKED;
/** Outside the app (browser preview) a 1920×1080 screen is assumed. */
let screen: Screen = { monitor: { x: 0, y: 0, w: 1920, h: 1080 }, work: { x: 0, y: 0, w: 1920, h: 1040 } };

let flash: { mood: "happy" | "error"; until: number } | null = null;
let lastActivity = Date.now();

/** Picks on the question card on screen, by card id. */
const picks = new Map<string, Map<string, Set<string>>>();
/** Text typed in the plan-feedback box, by card id. */
const drafts = new Map<string, string>();

// Settings view
let hookStatus: HookStatus | null = null;
let preview: { install: boolean; diff: string; changed: boolean } | null = null;
let settingsMessage = "";

const root = document.getElementById("root")!;

// The robots: one per size, kept across renders so their animation stays in phase.
const bots = {
  strip: new Mascot(22, "lite"),
  head: new Mascot(26, "lite"),
  ball: new Mascot(BALL, "lite"),
};

// ---------------------------------------------------------------------------
// Small DOM helper

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function button(label: string, kind: string, onClick: () => void, title?: string): HTMLElement {
  return h("button", { type: "button", class: `btn ${kind}`, title, onclick: (e: Event) => { e.stopPropagation(); onClick(); } }, label);
}

// ---------------------------------------------------------------------------
// The robot's mood, sounds

let moodTimer: number | undefined;

function refreshMood() {
  const now = Date.now();
  const mood = mascotMood({ waiting: waiting.length, sessions: sessions.values(), hermes, flash, lastActivity, now });
  for (const bot of Object.values(bots)) bot.setMood(mood);
  // Look again when a reaction ends or the robot is due to fall asleep; nothing else ticks.
  window.clearTimeout(moodTimer);
  const next = Math.min(flash && flash.until > now ? flash.until - now : Infinity, lastActivity + SLEEP_AFTER_MS - now + 50);
  if (Number.isFinite(next) && next > 0) moodTimer = window.setTimeout(refreshMood, next);
}

function react(mood: "happy" | "error") {
  flash = { mood, until: Date.now() + FLASH_MS };
  refreshMood();
}

function activity() {
  lastActivity = Date.now();
  refreshMood();
}

function sound(s: Sound) {
  if (prefs.sound) play(s);
}

function setAnimation(a: AnimationMode) {
  for (const bot of Object.values(bots)) bot.setMode(a);
}

// ---------------------------------------------------------------------------
// Mode changes, geometry and timers

let timer: number | undefined;

function clearTimer() {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
}

function later(ms: number, fn: () => void) {
  clearTimer();
  timer = window.setTimeout(() => {
    timer = undefined;
    fn();
  }, ms);
}

function holds() {
  return { waiting: waiting.length > 0, settings: view === "settings", typing };
}

/** The small island stays out on its own while something is in progress. */
function keepPeek(): boolean {
  return hermesBusy(hermes) || (notice !== null && notice.until > Date.now());
}

/** Size and place the window for the current mode and placement. */
async function applyGeometry() {
  const l = layout(mode, placement, screen);
  root.dataset.place = placement.docked ? "docked" : "floating";
  await Bridge.setGeometry(l.win, mode !== "hidden");
}

async function go(next: Mode) {
  if (next === mode) return;
  const growing = mode === "hidden" || next === "open";
  mode = next;
  if (next === "hidden") {
    view = "home";
    preview = null;
  }
  // Grow the window before drawing into it; shrink it after.
  if (growing) await applyGeometry();
  render();
  if (!growing) await applyGeometry();
}

/** Decide what happens now that the pointer is (or is not) on the island. */
function settle() {
  clearTimer();
  if (dragging) return;
  if (pointerInside) {
    if (mode === "peek") later(HOVER_OPEN, () => go("open"));
    return;
  }
  const target = onLeave(mode, holds(), keepPeek());
  if (target === "peek") later(FOLD_DELAY, () => go("peek").then(settle));
  else if (target === "hidden") later(HIDE_DELAY, () => go("hidden"));
  else if (mode === "peek" && notice) {
    // Kept out by a notice: look again when it expires.
    later(Math.max(50, notice.until - Date.now()), settle);
  }
}

function showNotice(text: string) {
  notice = { text, until: Date.now() + NOTICE_MS };
  if (mode === "hidden") void go("peek").then(settle);
  else {
    render();
    settle();
  }
}

// ---------------------------------------------------------------------------
// Dragging: the island off the top edge becomes the ball; the ball near the top docks

let dragging = false;
let suppressClick = false;
let press: { id: number; sx: number; sy: number; dx: number; dy: number } | null = null;
let dragFrame = 0;
let dragAt = { x: 0, y: 0 };

/** A press on the ball or the island (not on a control) may become a drag. */
function onPress(e: PointerEvent) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, textarea, input, .opt")) return;
  // Offset of the pointer from the ball's centre, so the ball does not jump under it.
  const l = layout(mode, placement, screen);
  const offset = l.ball && !placement.docked ? { dx: l.win.x + l.ball.x - e.screenX, dy: l.win.y + l.ball.y - e.screenY } : { dx: 0, dy: 0 };
  press = { id: e.pointerId, sx: e.screenX, sy: e.screenY, ...offset };
  root.setPointerCapture(e.pointerId);
}

function onMove(e: PointerEvent) {
  if (!press || e.pointerId !== press.id) return;
  if (!dragging) {
    if (Math.hypot(e.screenX - press.sx, e.screenY - press.sy) < 6) return;
    dragging = true;
    clearTimer();
    root.classList.add("dragging");
    // Whatever it was, while it moves it is the ball.
    mode = "hidden";
    placement = { docked: false, x: e.screenX + press.dx, y: e.screenY + press.dy };
    render();
  }
  dragAt = { x: e.screenX + press.dx, y: e.screenY + press.dy };
  if (!dragFrame) {
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      placement = { docked: false, x: dragAt.x, y: dragAt.y };
      const l = layout("hidden", placement, screen);
      void Bridge.setGeometry(l.win, false);
    });
  }
}

function onRelease(e: PointerEvent) {
  if (!press || e.pointerId !== press.id) return;
  press = null;
  if (!dragging) return;
  dragging = false;
  suppressClick = true;
  window.setTimeout(() => (suppressClick = false), 0);
  root.classList.remove("dragging");
  placement = settlePlacement(dragAt.x, dragAt.y, screen);
  savePrefs({ placement });
  render();
  void applyGeometry();
  settle();
}

function dock() {
  placement = DOCKED;
  savePrefs({ placement });
  render();
  void applyGeometry();
}

// ---------------------------------------------------------------------------
// Cards

function receive(card: Card) {
  activity();
  if (card.wait) {
    waiting.push(card);
    refreshMood();
    sound("ask");
    clearTimer();
    void go("open").then(() => {
      render();
      // Confirm only once the card is really in the DOM.
      requestAnimationFrame(() => void Bridge.ack(card.id));
      if (selftest) window.setTimeout(() => answer(card, { decision: selftestDecision(card) }), 1500);
    });
    return;
  }
  if (card.source === "claude") {
    const n = applyHook(sessions, card, Date.now());
    if (card.event === "Stop") {
      react("happy");
      sound("done");
    }
    refreshMood();
    if (n) showNotice(n);
    else if (mode !== "hidden") render();
  } else if (card.source === "hermes") {
    const r = applyHermes(hermes, card);
    hermes = r.run;
    if (card.payload?.status === "failed") {
      react("error");
      sound("deny");
    } else if (card.payload?.status === "done" || card.event === "done") {
      react("happy");
      sound("done");
    }
    refreshMood();
    if (r.notice) showNotice(r.notice);
    else if (mode !== "hidden") render();
  }
}

function selftestDecision(card: Card): string {
  if (card.source === "hermes") return selftest === "deny" ? "revise" : "approve";
  return selftest ?? "deny";
}

function answer(card: Card, reply: Reply) {
  void Bridge.decide(card.id, reply);
  const d = reply.decision;
  if (d === "deny" || d === "revise") {
    react("error");
    sound("deny");
  } else if (d) react("happy");
  drop(card.id);
}

function drop(id: string) {
  const i = waiting.findIndex((c) => c.id === id);
  if (i >= 0) waiting.splice(i, 1);
  picks.delete(id);
  drafts.delete(id);
  if (typing && waiting.length === 0) releaseKeyboard();
  refreshMood();
  render();
  settle();
}

function releaseKeyboard() {
  typing = false;
  void Bridge.setKeyboard(false);
}

// ---------------------------------------------------------------------------
// Rendering

function render() {
  root.replaceChildren();
  root.dataset.mode = mode;
  root.dataset.place = placement.docked ? "docked" : "floating";
  if (placement.docked) renderDocked();
  else renderFloating();
  for (const bot of Object.values(bots)) if (bot.el.isConnected) bot.attached();
  requestAnimationFrame(reportHitRects);
}

function renderDocked() {
  if (mode === "hidden") {
    root.append(h("div", { class: "wake", onmouseenter: onWake }));
    return;
  }
  const island = h(
    "div",
    { class: `island ${mode}`, onclick: () => !suppressClick && mode === "peek" && go("open"), onpointerdown: onPress },
    mode === "peek" ? peekRow(bots.strip) : openBody(),
  );
  root.append(island);
}

function renderFloating() {
  const l = layout(mode, placement, screen);
  const ball = h(
    "div",
    {
      class: "ball",
      style: `left:${l.ball!.x - BALL / 2}px;top:${l.ball!.y - BALL / 2}px`,
      title: "Jarvis: click to open, drag to move, drop at the top to dock",
      onmouseenter: () => {
        if (mode === "hidden" && !dragging) {
          pointerInside = true;
          void go("peek").then(settle);
        }
      },
      onclick: () => !suppressClick && go(mode === "open" ? "peek" : "open"),
      onpointerdown: onPress,
    },
    bots.ball.el,
  );
  root.append(ball);
  if (mode === "peek") {
    const pill = h("div", { class: `pill ${l.side}`, onclick: () => !suppressClick && go("open") }, peekRow(null));
    pill.style.top = `${l.ball!.y - 18}px`;
    if (l.side === "right") pill.style.left = `${l.ball!.x + BALL / 2 + 8}px`;
    else pill.style.right = `${l.win.w - (l.ball!.x - BALL / 2 - 8)}px`;
    root.append(pill);
  } else if (mode === "open") {
    const panel = h("div", { class: `island open floating ${l.dir}`, onpointerdown: onPress }, openBody());
    if (l.dir === "down") panel.style.top = `${l.ball!.y + BALL / 2 + 10}px`;
    else panel.style.bottom = `${l.win.h - (l.ball!.y - BALL / 2 - 14)}px`;
    root.append(panel);
  }
}

/** Tell Rust which parts take clicks (the island, the ball, the pill); the rest passes through. */
function reportHitRects() {
  if (mode === "hidden") return void Bridge.setHitRects([]);
  const rects: Rect[] = [];
  root.querySelectorAll<HTMLElement>(".island, .ball, .pill").forEach((el) => {
    const r = el.getBoundingClientRect();
    rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  });
  void Bridge.setHitRects(rects);
}

let wakeTimer: number | undefined;
function onWake(e: Event) {
  const strip = e.currentTarget as HTMLElement;
  window.clearTimeout(wakeTimer);
  wakeTimer = window.setTimeout(() => {
    if (strip.matches(":hover")) {
      pointerInside = true;
      void go("peek").then(settle);
    }
  }, WAKE_DWELL);
}

function dot(kind: string): HTMLElement {
  return h("span", { class: `dot ${kind}` });
}

/** The one-line status; the docked strip leads with the robot, the floating pill does not (the ball is beside it). */
function peekRow(bot: Mascot | null): HTMLElement {
  const lead = (kind: string) => (bot ? bot.el : dot(kind));
  const card = waiting[0];
  if (card) return h("div", { class: "row" }, lead("ask"), h("b", {}, cardTitle(card)));
  if (notice && notice.until > Date.now()) return h("div", { class: "row" }, lead("info"), h("span", {}, notice.text));
  if (hermesBusy(hermes) && hermes) {
    const running = STAGES.find((s) => hermes!.stages[s] === "running") ?? "working";
    return h("div", { class: "row" }, lead("busy"), h("b", {}, hermes.project), h("span", { class: "dim" }, running));
  }
  const busy = [...sessions.values()].filter((s) => s.state === "working").length;
  if (busy) return h("div", { class: "row" }, lead("busy"), h("span", {}, `${busy} agent${busy > 1 ? "s" : ""} working`));
  return h("div", { class: "row" }, lead("idle"), h("span", { class: "dim" }, "Jarvis"));
}

function cardTitle(card: Card): string {
  if (card.source === "hermes") return "Hermes: plan ready";
  if (questionsOf(card)) return "Claude Code asks";
  return `${basename(card.payload?.cwd)} needs permission`;
}

function openBody(): HTMLElement {
  const header = h(
    "div",
    { class: "head" },
    h("div", { class: "brand" }, placement.docked ? bots.head.el : null, h("b", {}, view === "settings" ? "Settings" : "Jarvis")),
    h(
      "div",
      { class: "head-actions" },
      view === "settings"
        ? button("Back", "ghost", () => { view = "home"; preview = null; render(); settle(); })
        : button("Settings", "ghost", openSettings, "Hooks, robot, sounds"),
      waiting.length === 0 ? button("⌃", "ghost", () => go("peek").then(settle), "Fold") : null,
    ),
  );
  const body = view === "settings" ? settingsView() : waiting[0] ? cardView(waiting[0]) : homeView();
  return h("div", { class: "open-body" }, header, relayError ? h("p", { class: "error" }, relayError) : null, body);
}

function homeView(): HTMLElement {
  const parts: HTMLElement[] = [];
  if (hermes) {
    parts.push(
      h(
        "section",
        { class: "hermes" },
        h("div", { class: "label" }, `Hermes · ${hermes.project}`),
        h("ol", { class: "stages" }, ...STAGES.map((s) => h("li", { class: hermes!.stages[s] ?? "pending" }, h("i", {}), h("span", {}, s)))),
        hermes.url ? h("div", { class: "url" }, hermes.url) : null,
      ),
    );
  }
  const list = [...sessions.values()].sort((a, b) => b.updated - a.updated).slice(0, 4);
  if (list.length) {
    parts.push(
      h(
        "section",
        {},
        h("div", { class: "label" }, "Claude Code"),
        ...list.map((s) => h("div", { class: "session" }, dot(s.state === "working" ? "busy" : s.state === "waiting" ? "ask" : "idle"), h("b", {}, s.project), h("span", { class: "dim" }, s.detail))),
      ),
    );
  }
  if (!parts.length) parts.push(h("p", { class: "dim empty" }, "Nothing needs you. Permission requests from Claude Code and Hermes plans show up here."));
  return h("div", { class: "home" }, ...parts);
}

function cardView(card: Card): HTMLElement {
  const more = waiting.length > 1 ? h("span", { class: "dim" }, `+${waiting.length - 1} more`) : null;
  if (card.source === "hermes") return planCard(card, more);
  const questions = questionsOf(card);
  if (questions) return questionCard(card, questions, more);
  const p = card.payload ?? {};
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, h("b", {}, basename(p.cwd)), h("span", { class: "dim" }, "needs permission"), more),
    h("code", { class: "cmd" }, toolLine(p.tool_name, p.tool_input)),
    typeof p.cwd === "string" ? h("small", { class: "dim mono" }, p.cwd) : null,
    h(
      "div",
      { class: "actions" },
      button("Deny", "no", () => answer(card, { decision: "deny" })),
      hasSuggestions(card) ? button("Always allow", "quiet", () => answer(card, { decision: "always" }), "Allow and remember this rule") : null,
      button("Allow", "go", () => answer(card, { decision: "allow" })),
    ),
  );
}

function questionCard(card: Card, questions: NonNullable<ReturnType<typeof questionsOf>>, more: Child): HTMLElement {
  const mine = picks.get(card.id) ?? new Map<string, Set<string>>();
  picks.set(card.id, mine);
  const answers = answersFrom(questions, mine);
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, h("b", {}, "Claude Code asks"), more),
    ...questions.map((q) =>
      h(
        "div",
        { class: "question" },
        h("div", { class: "q" }, q.question, q.multiSelect ? h("span", { class: "dim" }, " (pick any)") : null),
        h(
          "div",
          { class: "options" },
          ...q.options.map((o) =>
            h(
              "button",
              {
                type: "button",
                class: `opt ${mine.get(q.question)?.has(o.label) ? "on" : ""}`,
                title: o.description || undefined,
                onclick: (e: Event) => { e.stopPropagation(); pick(mine, q, o.label); render(); },
              },
              o.label,
            ),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "actions" },
      button("Answer in terminal", "quiet", () => answer(card, { decision: null })),
      h("button", { type: "button", class: "btn go", disabled: !answers, onclick: (e: Event) => { e.stopPropagation(); if (answers) answer(card, { decision: "allow", answers }); } }, "Send"),
    ),
  );
}

function planCard(card: Card, more: Child): HTMLElement {
  const p = card.payload ?? {};
  const draft = drafts.get(card.id) ?? "";
  const box = h("textarea", { class: "feedback", rows: 2, placeholder: "What should change in the plan?" }) as HTMLTextAreaElement;
  box.value = draft;
  box.addEventListener("input", () => drafts.set(card.id, box.value));
  box.addEventListener("mousedown", () => {
    if (!typing) {
      typing = true;
      void Bridge.setKeyboard(true);
    }
  });
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, h("b", {}, `Plan ready · ${p.project ?? "Hermes"}`), more),
    typeof p.summary === "string" && p.summary ? h("p", { class: "summary" }, p.summary) : h("p", { class: "dim" }, "The plan is in your Hermes terminal. Approve it here or there."),
    box,
    h(
      "div",
      { class: "actions" },
      button("Request changes", "quiet", () => {
        const feedback = (drafts.get(card.id) ?? "").trim();
        if (!feedback) {
          box.focus();
          return;
        }
        answer(card, { decision: "revise", feedback });
      }),
      button("Approve plan", "go", () => answer(card, { decision: "approve" })),
    ),
  );
}

// ---------------------------------------------------------------------------
// Settings: the Claude Code hooks, the robot, sounds, placement

async function openSettings() {
  view = "settings";
  preview = null;
  settingsMessage = "";
  clearTimer();
  if (mode !== "open") await go("open");
  await refreshStatus();
}

async function refreshStatus() {
  try {
    hookStatus = await Bridge.hooksStatus();
  } catch (e) {
    settingsMessage = String(e);
  }
  render();
}

async function showPreview(install: boolean) {
  try {
    const p = await Bridge.hooksPreview(install);
    preview = { install, ...p };
    settingsMessage = p.changed ? "" : "Nothing to change.";
  } catch (e) {
    preview = null;
    settingsMessage = String(e);
  }
  render();
}

async function applyPreview() {
  if (!preview) return;
  try {
    const backup = await Bridge.hooksApply(preview.install);
    settingsMessage = (preview.install ? "Hooks installed." : "Hooks removed.") + (backup ? ` Backup: ${backup}` : "") + " New Claude Code sessions pick this up.";
  } catch (e) {
    settingsMessage = String(e);
  }
  preview = null;
  await refreshStatus();
}

function savePrefs(patch: Prefs) {
  prefs = { ...prefs, ...patch };
  void Bridge.prefsSet(prefs);
}

function segmented<T extends string>(value: T, options: [T, string][], set: (v: T) => void): HTMLElement {
  return h(
    "div",
    { class: "seg", role: "group" },
    ...options.map(([v, label]) =>
      h("button", { type: "button", "aria-pressed": String(v === value), onclick: (e: Event) => { e.stopPropagation(); set(v); render(); } }, label),
    ),
  );
}

function settingsView(): HTMLElement {
  const s = hookStatus;
  const hooks = h(
    "section",
    {},
    h("div", { class: "label" }, "Claude Code hooks"),
    s
      ? h(
          "div",
          {},
          h("p", {}, s.installed ? "Installed: Claude Code sends permission requests here." : "Not installed: Claude Code asks in its terminal."),
          h("small", { class: "dim mono" }, s.settingsPath),
          !s.hookExists ? h("p", { class: "error" }, `Relay missing: ${s.hookPath}`) : null,
        )
      : h("p", { class: "dim" }, "Reading settings…"),
    preview
      ? h(
          "div",
          {},
          h("pre", { class: "diff" }, ...preview.diff.split("\n").map((l) => h("span", { class: l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : "" }, `${l}\n`))),
          h(
            "div",
            { class: "actions" },
            button("Cancel", "quiet", () => { preview = null; render(); }),
            preview.changed ? button(preview.install ? "Write changes" : "Remove hooks", preview.install ? "go" : "no", () => void applyPreview()) : null,
          ),
        )
      : h(
          "div",
          { class: "actions start" },
          button(s?.installed ? "Reinstall…" : "Install…", "go", () => void showPreview(true)),
          s?.installed ? button("Remove…", "quiet", () => void showPreview(false)) : null,
        ),
    settingsMessage ? h("p", { class: "msg" }, settingsMessage) : null,
  );
  const look = h(
    "section",
    {},
    h("div", { class: "label" }, "Robot and sounds"),
    h(
      "div",
      { class: "setting" },
      h("span", {}, "Animation", h("small", { class: "dim" }, "Lite plays pre-recorded frames and uses very little CPU. Live 3D follows your pointer but costs much more.")),
      segmented(prefs.animation, [["lite", "Lite"], ["live", "Live 3D"], ["still", "Off"]], (a) => {
        savePrefs({ animation: a });
        setAnimation(a);
      }),
    ),
    h(
      "div",
      { class: "setting" },
      h("span", {}, "Sounds"),
      segmented(prefs.sound ? "on" : "off", [["off", "Off"], ["on", "On"]], (v) => {
        savePrefs({ sound: v === "on" });
        if (v === "on") play("done");
      }),
    ),
    h(
      "div",
      { class: "setting" },
      h("span", {}, "Placement", h("small", { class: "dim" }, "Drag the island down to make it a ball; drop the ball at the top to dock it.")),
      placement.docked ? h("span", { class: "dim" }, "At the top") : button("Put it back at the top", "quiet", dock),
    ),
  );
  return h("div", { class: "settings" }, hooks, look, h("div", { class: "actions" }, button("Quit Jarvis Island", "no", () => void Bridge.quit())));
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onRelease);
  root.addEventListener("pointercancel", onRelease);

  selftest = await Bridge.selftest();
  const stored = await Bridge.prefsGet();
  const info = await Bridge.screenInfo();
  if (info) screen = info;
  if (stored) prefs = { ...prefs, ...stored };
  placement = revalidate(prefs.placement, screen);
  setAnimation(prefs.animation);
  refreshMood();

  await on<Card>("card", receive);
  await on<string>("dismiss", (id) => {
    // Decided elsewhere, timed out, or the asker left.
    if (waiting.some((c) => c.id === id)) drop(id);
  });
  await on<boolean>("pointer", (inside) => {
    pointerInside = inside;
    if (!inside && typing && waiting.length === 0 && view !== "settings") releaseKeyboard();
    settle();
  });
  await on<null>("open-settings", () => void openSettings());
  await on<null>("dock", dock);
  await on<string>("relay-error", (e) => {
    relayError = `The relay could not start (${e}). Is another Jarvis Island running?`;
    showNotice("Relay error");
  });
  await applyGeometry();
  render();
  if (!IN_TAURI) demo(new URLSearchParams(location.search));
}

/** Outside the app: sample content so the UI can be designed in a browser (`?demo=…&place=float`). */
function demo(q: URLSearchParams) {
  if (q.get("place") === "float") placement = { docked: false, x: 1500, y: 300 };
  if (q.has("anim")) setAnimation(q.get("anim") as AnimationMode);
  const what = q.get("demo") ?? "card";
  // As if the pointer rests on the island, so the open views do not fold away.
  pointerInside = what === "home" || what === "settings";
  const show = (m: Mode) => {
    mode = m;
    render();
  };
  if (what === "hidden") return show("hidden");
  receive({ id: "d1", source: "hermes", event: "stage", wait: false, payload: { project: "recipe-site", stage: "frontend", status: "running" } });
  if (what === "card")
    receive({ id: "d2", source: "claude", event: "PermissionRequest", wait: true, payload: { cwd: "C:\\demo\\sample-app", tool_name: "Bash", tool_input: { command: "npm run build" }, permission_suggestions: [{}] } });
  else if (what === "question")
    receive({ id: "d3", source: "claude", event: "PermissionRequest", wait: true, payload: { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which database should the recipe site use?", header: "DB", multiSelect: false, options: [{ label: "Supabase Postgres" }, { label: "SQLite" }, { label: "Firebase" }] }] } } });
  else if (what === "plan") receive({ id: "d4", source: "hermes", event: "plan", wait: true, payload: { project: "recipe-site", round: 1 } });
  else if (what === "home") {
    receive({ id: "d5", source: "claude", event: "PreToolUse", wait: false, payload: { session_id: "a", cwd: "C:\\code\\shop", tool_name: "Edit", tool_input: { file_path: "src/cart.ts" } } });
    show("open");
  } else if (what === "peek") show("peek");
  else if (what === "settings") void openSettings();
}

void boot();
