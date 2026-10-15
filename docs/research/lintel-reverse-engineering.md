# Lintel — reverse-engineering notes

Target: <https://lintel.thisissbk.com/> · Tooling: [REA](https://github.com/morluto/rea) 6.4.0 · Date: 2026-10-13

## TL;DR

- **The website** is a hand-written static site (no framework, no build-time bundler at runtime): one HTML page per route, one CSS file, one 12 KB vanilla JS file. It sets no cookies, uses no storage, and makes exactly **one** outbound call: `GET https://api.github.com/repos/shakibbinkabir/lintel/releases/latest` from the download page.
- **The product** it advertises, *Lintel*, is a free GPL-3.0 "dynamic island" for Windows 10/11: a 6 px strip at the top of the screen that slides out on hover or when something needs you — chiefly **Allow/Deny cards for coding-agent permission prompts** (Claude Code, Codex, Gemini, Cursor, …), plus media controls, HUDs and ~38 toggleable tools.
- It is **open source** (<https://github.com/shakibbinkabir/lintel>), and the repo's `site/` directory is **byte-identical** to what the live site serves (checked `index.html`, `features.html`, `docs.html`, `css/site.css`, `js/site.js` with `cmp`). So nothing had to be guessed from minified output — the findings below are confirmed against source.
- Stack: **Tauri 2** (Rust backend + WebView2), plain TypeScript + Vite frontend (no UI framework), a Rust hook relay `lintel-hook.exe`, and an optional elevated .NET 8 helper for sensors/fans.

## 1. What REA found on the website

REA's web tools attach to an existing Chrome via CDP. Because the live files equal the repo's `site/` directory, the copy was served on `127.0.0.1` and inspected with headless Chromium 141 (this avoids pushing the browser through the sandbox's TLS proxy).

```sh
rea list-browser-targets http://127.0.0.1:9333
rea inspect-web-page   http://127.0.0.1:9333 <TARGET> --include-script-sources
rea analyze-web-bundle http://127.0.0.1:9333 <TARGET>
rea analyze-javascript-application lintel-src/src      # the app's own frontend
```

Evidence (trimmed) is in [`lintel-rea/`](lintel-rea/).

| Observation | Result |
|---|---|
| Scripts | 2 — `js/site.js` (11,965 B, classic script, no source map) and a 44 B inline `document.documentElement.classList.add("js")` |
| Chunk graph / routes | none — no bundler, no client-side router; every route is a real `.html` file |
| Endpoints | 1 — `fetch("https://api.github.com/repos/shakibbinkabir/lintel/releases/latest")` (`site.js:210`) |
| Storage | localStorage / sessionStorage / IndexedDB / Cache Storage all empty; no cookies |
| Workers / WebMCP | none |
| Resources | `css/site.css`, self-hosted Geist, Geist Mono and Poppins `woff2` fonts, PNG screenshots |

What `site.js` does: mobile nav toggle, scroll-reveal (`.reveal` + IntersectionObserver), the animated **island demo** on the hero (a state machine cycling `data-scene` = `ask` → `level` → `play`, with a canvas-drawn mascot and a pause button), and the download page's "latest release" lookup. The demo is pure CSS/DOM — it is a mock-up of the app, not the app.

The site source lives in `site/_src/` (`pages/` + `build.mjs` + `check.mjs`): a tiny custom static-site generator that stamps the shared header/footer into each page.

## 2. How the Lintel app actually works

### 2.1 Process layout

```
lintel.exe (Tauri 2, Rust, unelevated)
 ├─ island window   — one transparent, topmost, non-activating WebView2 (index.html)
 ├─ settings window — settings.html
 ├─ feature windows — window.html?feature=<id>&page=<name>
 ├─ named-pipe server  \\.\pipe\lintel-<user SID>
 └─ 48 Rust crates: core + brand, 12 shared services (svc-audio, svc-media, svc-input, …), 34 feature crates
lintel-hook.exe     — tiny relay spawned by the agent CLI on every hook event
lintel-hw.exe       — optional .NET 8 helper, elevated only on opt-in (temps, fans)
```

### 2.2 The island window (the "notch")

From `src-tauri/tauri.conf.json`, `src-tauri/src/island.rs`, `docs/ARCHITECTURE.md` §4:

- Window is created at **240×6 px**, `transparent`, `decorations:false`, `alwaysOnTop`, `skipTaskbar`, `focus:false`; Rust adds `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` so showing it never steals focus.
- Click-through is toggled with `set_ignore_cursor_events` against the island's current rect, so the transparent part of the 720×360 panel passes clicks to the window underneath.
- A Rust cursor poll runs at **60 Hz only while the island is out**, drops to 10 Hz when a strip is "resting", and **parks entirely** when hidden (window shrunk back to the strip) — that is how they claim ~0.5 % of one core idle.
- Frontend FSM (`src/island/fsm.ts`): `hidden → peek (32 px strip) → open (640 wide)` plus a 1.6 s `greet` on launch. Timings: pointer must dwell 50 ms on the wake strip, 250 ms on the peek strip to open, 0.6 s to fold after leaving.
- Keyboard: the island never takes focus by appearing. While the pointer is over an open island, a **low-level keyboard hook** (`platform/keyhook.rs`) swallows only the island's own combos (Esc, Alt+letter, section keys) and re-dispatches them into the page. A click calls `SetForegroundWindow` to hand it the keyboard fully.
- Full-screen apps, lock and sleep hide it; notices are queued until a normal window is in front.

### 2.3 Agent permission cards — the headline feature

This is the part worth copying. Files: `src-tauri/src/hooks.rs`, `src-tauri/src/agents.rs`, `hook/src/{main,normalize,reply}.rs`, `src-tauri/src/pipe.rs`.

1. **Install.** Lintel merges entries into `%USERPROFILE%\.claude\settings.json` (and the equivalent files for Codex, Gemini, Cursor, Copilot, OpenCode, Antigravity, Amp, Muse, Hermes) for 12 hook events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` (timeout 120 s), `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`. It takes a dated backup, shows a diff and writes only after a click. The hook command is the quoted exe path with forward slashes, because Claude Code on Windows runs hooks through Git Bash.
2. **Relay.** The agent spawns `lintel-hook.exe <Event>` with the hook JSON on stdin. The relay normalises other agents' field names to Claude Code's, strips huge fields (`tool_response`, `transcript_path`), caps strings (2 KB; 256 KB for Edit/Write diffs; 900 KB per line) and writes one JSON line to `\\.\pipe\lintel-<SID>`.
3. **Never block the agent.** 300 ms to connect, or it exits 0 with "no opinion". Fire-and-forget events have a 2 s total budget. Only `PermissionRequest` waits — up to **110 s** on the hook side, 108 s on the app side, so the app always answers first.
4. **Ack before waiting.** The app forwards the event to the island and waits **800 ms** for the island to confirm the card is actually on screen; otherwise it declines immediately and the terminal prompt appears as if Lintel weren't installed.
5. **Answer.** The island replies `allow` / `deny` / `always`, or `{"answers":{…}}` for a question card. The relay turns that into Claude Code's documented output:

   ```json
   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
   {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Lintel"}}}
   ```

6. **Trust boundary.** The pipe ACL allows only the current user and SYSTEM; a client has 5 s to send its request; Allow/Deny cards are only raised for the relay the app itself deployed, identified by an unguessable id.

The status line is also hooked (`lintel-hook --statusline`) to read plan-usage limits, then chains to the user's previous status line command so that keeps working.

### 2.4 Feature system

- One Rust crate per feature implementing `notch_core::Feature { manifest, start, stop, call, settings_changed, strings }` (the old code name `notch` survives in crate names). `src-tauri/build.rs` reads `src-tauri/Cargo.toml` and generates the feature list, so adding a crate needs no registry edit.
- One TS directory per feature with `defineFeature({ id, activities, sections, settings, windows, commands, shortcuts, voice, start })`, discovered via `import.meta.glob`.
- The frontend talks to Rust only through `feature_call { feature, method, args }` plus about 70 base `#[tauri::command]`s (`src/core/bridge.ts` wraps `invoke`). A disabled feature's `start` is never called, so it creates no threads, hooks or windows.
- CSP: `default-src 'self'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost`. The webview itself can't reach the network; all HTTP goes through Rust.

### 2.5 Network surface (from the Rust source)

Only services the user configures: OpenAI, Anthropic, Gemini, OpenRouter, Hugging Face (local model download), any OpenAI-compatible base URL, GitHub, Stripe and Resend integrations, Open-Meteo (weather), plus meeting-link detection for Zoom, Meet, Teams and Webex. Keys are stored in Windows Credential Manager through the `keyring` crate. With a fresh install nothing is called.

## 3. REA's coverage here, honestly

- **Website:** REA's CDP tools (`inspect-web-page`, `analyze-web-bundle`) gave a complete, verifiable picture. The site is small and unminified, so there was little left to recover.
- **App frontend:** `analyze-javascript-application` parsed 144 files and 265 K AST nodes. It found the localStorage use and a few endpoint keys, but reported **0 IPC operations**, because its boundary model is Electron's (`ipcRenderer`, `contextBridge`), not Tauri's `invoke`. The Tauri command map above comes from reading the source.
- **Native binary:** not needed, because the GPL source is public. Analysing `lintel-1.0.0-setup.exe` would need a native provider (Hopper, Ghidra or IDA), and none is installed in this container.

## 4. What is reusable for Jarvis/Hermes

Hermes runs `claude -p … --permission-mode acceptEdits`, so today approvals are either pre-granted or happen in the terminal. Lintel's design shows a clean way to put a human in the loop **without** blocking the agent:

- Register a `PermissionRequest` hook (and, for status, `PreToolUse`, `Stop` and `Notification`) in a project-level `.claude/settings.json` that runs a small relay.
- The relay forwards the JSON to a local listener (a named pipe on Windows, a Unix socket elsewhere). It waits for a decision only on `PermissionRequest`, and always falls back to "no opinion" on a timeout. It prints the `hookSpecificOutput` JSON above.
- The listener can be anything: a phone notification, a Slack button, a small local web page. That would let Hermes run in `default` permission mode and still be approved remotely.

Keep Lintel's rules if you build it: tight connect timeout, confirm the prompt is visible before waiting, a decision timeout shorter than the hook's, never overwrite the user's settings file without a diff, and treat GPL-3.0 code as reference only unless Jarvis adopts a compatible license.
