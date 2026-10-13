// Pure logic of the island: no DOM, no Tauri. Unit-tested by tests/model.test.mjs.

import type { Card } from "./bridge.ts";

export type Mode = "hidden" | "peek" | "open";

// ---------------------------------------------------------------------------
// Timings (ms)

/** The pointer must rest on the wake strip this long before anything comes out. */
export const WAKE_DWELL = 50;
/** Resting on the small island opens it. */
export const HOVER_OPEN = 250;
/** After the pointer leaves an open island it folds to the small one. */
export const FOLD_DELAY = 600;
/** After the pointer leaves the small island it hides. */
export const HIDE_DELAY = 1500;
/** How long a notice (agent finished, Hermes stage) keeps the small island out. */
export const NOTICE_MS = 3500;

// ---------------------------------------------------------------------------
// What stays out

export interface Holds {
  /** A card is waiting for a human. */
  waiting: boolean;
  /** Settings (or another view the user opened on purpose) is up. */
  settings: boolean;
  /** A text field has the keyboard. */
  typing: boolean;
}

/** The island may not fold or hide by itself. */
export function pinned(h: Holds): boolean {
  return h.waiting || h.settings || h.typing;
}

/** Where the island goes when the pointer leaves it; `null` = stay. */
export function onLeave(mode: Mode, h: Holds, keepPeek: boolean): Mode | null {
  if (pinned(h)) return null;
  if (mode === "open") return "peek";
  if (mode === "peek" && !keepPeek) return "hidden";
  return null;
}

// ---------------------------------------------------------------------------
// Claude Code sessions, built from fire-and-forget hook events

export type SessionState = "idle" | "working" | "waiting" | "done";

export interface Session {
  id: string;
  project: string;
  state: SessionState;
  /** Last tool used, or the prompt being worked on. */
  detail: string;
  updated: number;
}

export function basename(path: unknown): string {
  if (typeof path !== "string" || !path) return "session";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function str(v: unknown, max = 160): string {
  if (typeof v !== "string") return "";
  const one = v.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Apply one hook event to the session list. Returns a notice to show, if any. */
export function applyHook(sessions: Map<string, Session>, card: Card, now: number): string | null {
  if (card.source !== "claude" || card.wait) return null;
  const p = card.payload ?? {};
  const id = typeof p.session_id === "string" && p.session_id ? p.session_id : "default";
  if (card.event === "SessionEnd") {
    sessions.delete(id);
    return null;
  }
  const prev = sessions.get(id);
  const s: Session = prev ?? { id, project: basename(p.cwd), state: "idle", detail: "", updated: now };
  if (typeof p.cwd === "string" && p.cwd) s.project = basename(p.cwd);
  s.updated = now;
  let notice: string | null = null;
  switch (card.event) {
    case "SessionStart":
      s.state = "idle";
      s.detail = "Session started";
      break;
    case "UserPromptSubmit":
      s.state = "working";
      s.detail = str(p.prompt) || "Working";
      break;
    case "PreToolUse":
    case "PostToolUse":
      s.state = "working";
      s.detail = toolLine(p.tool_name, p.tool_input);
      break;
    case "Notification":
      if (p.notification_type === "idle_prompt" || p.notification_type === "permission_prompt") {
        s.state = "waiting";
        s.detail = str(p.message) || "Waiting for you";
      }
      break;
    case "Stop":
      s.state = "done";
      s.detail = str(p.last_assistant_message) || "Finished";
      notice = `${s.project}: finished`;
      break;
    default:
      return null;
  }
  sessions.set(id, s);
  return notice;
}

// ---------------------------------------------------------------------------
// Permission cards

/** One line describing a tool call: `Bash · npm run build`. */
export function toolLine(tool: unknown, input: unknown): string {
  const name = typeof tool === "string" && tool ? tool : "Tool";
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const detail =
    str(i.command, 200) ||
    str(i.file_path, 200) ||
    str(i.url, 200) ||
    str(i.pattern, 200) ||
    str(i.description, 200) ||
    str(i.prompt, 200);
  return detail ? `${name} · ${detail}` : name;
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** The questions of an AskUserQuestion permission request, or null for any other tool. */
export function questionsOf(card: Card): Question[] | null {
  const p = card.payload ?? {};
  if (card.event !== "PermissionRequest" || p.tool_name !== "AskUserQuestion") return null;
  const qs = p.tool_input?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: Question[] = [];
  for (const q of qs) {
    if (!q || typeof q.question !== "string" || !Array.isArray(q.options)) return null;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      multiSelect: q.multiSelect === true,
      options: q.options
        .filter((o: unknown) => o && typeof (o as { label?: unknown }).label === "string")
        .map((o: { label: string; description?: unknown }) => ({
          label: o.label,
          description: typeof o.description === "string" ? o.description : "",
        })),
    });
  }
  return out;
}

/** Picks → the `answers` map Claude Code expects, or null while a question is unanswered. */
export function answersFrom(questions: Question[], picks: Map<string, Set<string>>): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const chosen = q.options.map((o) => o.label).filter((l) => picks.get(q.question)?.has(l));
    if (chosen.length === 0) return null;
    answers[q.question] = q.multiSelect ? chosen.join(", ") : chosen[0];
  }
  return answers;
}

/** Toggle a pick; a single-select question keeps only the latest. */
export function pick(picks: Map<string, Set<string>>, q: Question, label: string): void {
  const set = picks.get(q.question) ?? new Set<string>();
  if (q.multiSelect) {
    if (set.has(label)) set.delete(label);
    else set.add(label);
  } else {
    set.clear();
    set.add(label);
  }
  picks.set(q.question, set);
}

export function hasSuggestions(card: Card): boolean {
  const s = card.payload?.permission_suggestions;
  return Array.isArray(s) && s.length > 0;
}

// ---------------------------------------------------------------------------
// Hermes

export const STAGES = ["plan", "frontend", "backend", "deploy"] as const;
export type StageStatus = "pending" | "running" | "done" | "failed";

export interface HermesRun {
  project: string;
  stages: Record<string, StageStatus>;
  url: string | null;
  finished: boolean;
}

/** Apply a Hermes fire-and-forget event. Returns a notice to show, if any. */
export function applyHermes(run: HermesRun | null, card: Card): { run: HermesRun | null; notice: string | null } {
  if (card.source !== "hermes" || card.wait) return { run, notice: null };
  const p = card.payload ?? {};
  const project = str(p.project, 80) || run?.project || "Hermes";
  const fresh = (): HermesRun => ({
    project,
    stages: Object.fromEntries(STAGES.map((s) => [s, "pending" as StageStatus])),
    url: null,
    finished: false,
  });
  switch (card.event) {
    case "start":
      return { run: fresh(), notice: `Hermes: ${project}` };
    case "stage": {
      const next = run && !run.finished ? { ...run, stages: { ...run.stages } } : fresh();
      const stage = str(p.stage, 40);
      const status: StageStatus = ["running", "done", "failed"].includes(p.status) ? p.status : "running";
      if (!stage) return { run: next, notice: null };
      next.stages[stage] = status;
      const verb = status === "running" ? "started" : status;
      return { run: next, notice: `${stage[0].toUpperCase()}${stage.slice(1)} ${verb}` };
    }
    case "done": {
      const next = run ? { ...run } : fresh();
      next.finished = true;
      next.url = typeof p.url === "string" && /^https?:\/\//.test(p.url) ? p.url : next.url;
      return { run: next, notice: `${next.project} is live` };
    }
    default:
      return { run, notice: null };
  }
}

/** The small island stays out while Hermes is running. */
export function hermesBusy(run: HermesRun | null): boolean {
  return !!run && !run.finished && Object.values(run.stages).some((s) => s === "running");
}
