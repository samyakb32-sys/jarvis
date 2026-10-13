// The island page: hidden → peek → open, cards that wait for a click, the
// Claude Code sessions and the Hermes run, and the hooks settings.

import { Bridge, IN_TAURI, on, type Card, type HookStatus, type Reply } from "./bridge.ts";
import {
  applyHermes,
  applyHook,
  answersFrom,
  basename,
  FOLD_DELAY,
  hasSuggestions,
  hermesBusy,
  HIDE_DELAY,
  HOVER_OPEN,
  NOTICE_MS,
  onLeave,
  pick,
  questionsOf,
  STAGES,
  toolLine,
  WAKE_DWELL,
  type HermesRun,
  type Mode,
  type Session,
} from "./model.ts";

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

/** Picks on the question card on screen, by card id. */
const picks = new Map<string, Map<string, Set<string>>>();
/** Text typed in the plan-feedback box, by card id. */
const drafts = new Map<string, string>();

// Settings view
let hookStatus: HookStatus | null = null;
let preview: { install: boolean; diff: string; changed: boolean } | null = null;
let settingsMessage = "";

const root = document.getElementById("root")!;

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
// Mode changes and timers

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

async function go(next: Mode) {
  if (next === mode) return;
  const from = mode;
  mode = next;
  if (from === "hidden") await Bridge.setMode("panel");
  render();
  if (next === "hidden") {
    view = "home";
    preview = null;
    await Bridge.setHitRect(null);
    await Bridge.setMode("strip");
  }
}

/** Decide what happens now that the pointer is (or is not) on the island. */
function settle() {
  clearTimer();
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
// Cards

function receive(card: Card) {
  if (card.wait) {
    waiting.push(card);
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
    if (n) showNotice(n);
    else if (mode !== "hidden") render();
  } else if (card.source === "hermes") {
    const r = applyHermes(hermes, card);
    hermes = r.run;
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
  drop(card.id);
}

function drop(id: string) {
  const i = waiting.findIndex((c) => c.id === id);
  if (i >= 0) waiting.splice(i, 1);
  picks.delete(id);
  drafts.delete(id);
  if (typing && waiting.length === 0) releaseKeyboard();
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
  if (mode === "hidden") {
    root.append(h("div", { class: "wake", onmouseenter: onWake }));
    return;
  }
  const island = h("div", { class: `island ${mode}`, onclick: () => mode === "peek" && go("open") }, mode === "peek" ? peekRow() : openBody());
  root.append(island);
  requestAnimationFrame(() => {
    const r = island.getBoundingClientRect();
    void Bridge.setHitRect({ x: r.left, y: r.top, w: r.width, h: r.height });
  });
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

function peekRow(): HTMLElement {
  const card = waiting[0];
  if (card) return h("div", { class: "row" }, dot("ask"), h("b", {}, cardTitle(card)));
  if (notice && notice.until > Date.now()) return h("div", { class: "row" }, dot("info"), h("span", {}, notice.text));
  if (hermesBusy(hermes) && hermes) {
    const running = STAGES.find((s) => hermes!.stages[s] === "running") ?? "working";
    return h("div", { class: "row" }, dot("busy"), h("b", {}, hermes.project), h("span", { class: "dim" }, running));
  }
  const busy = [...sessions.values()].filter((s) => s.state === "working").length;
  if (busy) return h("div", { class: "row" }, dot("busy"), h("span", {}, `${busy} agent${busy > 1 ? "s" : ""} working`));
  return h("div", { class: "row" }, dot("idle"), h("span", { class: "dim" }, "Jarvis"));
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
    h("b", {}, view === "settings" ? "Claude Code hooks" : "Jarvis"),
    h(
      "div",
      { class: "head-actions" },
      view === "settings"
        ? button("Back", "ghost", () => { view = "home"; preview = null; render(); settle(); })
        : button("Hooks", "ghost", openSettings, "Install or remove the Claude Code hooks"),
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
        h("ol", { class: "stages" }, ...STAGES.map((s) => h("li", { class: hermes!.stages[s] ?? "pending" }, s))),
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
  if (!parts.length) parts.push(h("p", { class: "dim" }, "Nothing needs you. Permission requests from Claude Code and Hermes plans show up here."));
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
    typeof p.cwd === "string" ? h("small", { class: "dim" }, p.cwd) : null,
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
// Settings: the Claude Code hooks

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

function settingsView(): HTMLElement {
  const s = hookStatus;
  return h(
    "div",
    { class: "settings" },
    s
      ? h(
          "div",
          {},
          h("p", {}, s.installed ? "Installed: Claude Code sends permission requests here." : "Not installed: Claude Code asks in its terminal."),
          h("small", { class: "dim" }, s.settingsPath),
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
          { class: "actions" },
          s?.installed ? button("Remove…", "quiet", () => void showPreview(false)) : null,
          button(s?.installed ? "Reinstall…" : "Install…", "go", () => void showPreview(true)),
          button("Quit app", "no", () => void Bridge.quit()),
        ),
    settingsMessage ? h("p", { class: "msg" }, settingsMessage) : null,
  );
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  selftest = await Bridge.selftest();
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
  await on<string>("relay-error", (e) => {
    relayError = `The relay could not start (${e}). Is another Jarvis Island running?`;
    showNotice("Relay error");
  });
  render();
  if (!IN_TAURI) demo();
}

/** Outside the app: show sample content so the UI can be designed in a browser. */
function demo() {
  receive({ id: "d1", source: "hermes", event: "stage", wait: false, payload: { project: "recipe-site", stage: "frontend", status: "running" } });
  receive({ id: "d2", source: "claude", event: "PermissionRequest", wait: true, payload: { cwd: "C:\\demo\\sample-app", tool_name: "Bash", tool_input: { command: "npm run build" }, permission_suggestions: [{}] } });
}

void boot();
