# Hermes

Hermes is an orchestrator agent that drives the build loop from the original sketch:

```
topic ("build a site about X")
  -> plan only, no code — tech stack, pages, API surface, DB schema
  -> you approve the plan (or send feedback and it revises, on repeat)
  -> Claude Code builds the frontend (optionally via Stitch, opened through
     Hermes's own browser control) following the approved plan
  -> Claude Code builds the backend, creates a GitHub repo, pushes it
  -> deploy to Vercel, connect the Supabase DB
  -> load the live site with browser control, find bugs, fix them —
     Claude Code judges for itself when it's solid enough to stop, and
     reports anything it couldn't fix
  -> hand you the live link
  -> stays in the same conversation: keep asking for changes/new features
     without restarting the script, until you say you're done
```

Hermes itself doesn't reimplement GitHub/Supabase/Vercel clients — it shells out to
the `claude` CLI you already run, with an MCP config (`mcp/hermes.mcp.json`) attached
so Claude Code can call those services directly. Every stage after the plan runs with
`claude --continue`, so the whole build — plan through however many feature requests
you add afterward — is one ongoing Claude Code conversation, not a fresh session per
stage. Hermes's own job is: hold project memory across runs, assemble the right
prompt per stage, and gate the plan (and only the plan) on your explicit approval —
everything after that runs unattended unless you interject at the "anything else?"
prompt.

**Browser control is the universal connector.** Rather than wiring a bespoke
integration per site (Stitch, YouTube, LinkedIn, WhatsApp, ChatGPT, ...), Hermes
launches Chrome via the `playwright` MCP server pointed at a persistent profile
that's already logged into those sites. Claude Code then just... uses them, the same
way you would. This is also the riskiest piece — see **Browser control risk** below.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in `GITHUB_TOKEN`, `VERCEL_TOKEN`,
   `SUPABASE_ACCESS_TOKEN`.
3. Create a **dedicated** Chrome profile (not your daily-driver one) and log it into
   GitHub/Vercel/Supabase dashboards, Stitch, and anything else you want Hermes to
   reach. Point `CHROME_PROFILE_DIR` in `.env` at that profile's folder. Chrome
   can't have two processes open on the same profile dir at once, so this must be a
   profile you aren't also browsing in day-to-day.
4. Make sure `claude`, `npx`, and `node` are on PATH (they already are, since you're
   reading this from a Claude Code session).
5. Drop any reference material — your past project write-ups, style notes, skills —
   as `.md` files in `memory/skills/`. Hermes feeds these to Claude Code as context
   on every build so new projects match your existing work.

## Running it

```
npm run hermes -- "a portfolio site for my photography, dark theme, gallery + contact form"
```

Hermes will run the backend stage, stop and ask for your go-ahead, run the frontend
stage, stop again, then run deploy + the bug-fix loop and hand you the live URL.

## What's a real API integration vs. browser automation

| Service | Mechanism |
|---|---|
| GitHub | MCP server, real API (`GITHUB_TOKEN`) |
| Supabase | MCP server, real management API (`SUPABASE_ACCESS_TOKEN`) |
| Vercel | Hosted MCP endpoint, real API (`VERCEL_TOKEN`) |
| Stitch, YouTube, LinkedIn, WhatsApp, ChatGPT | No API — driven via browser control against your logged-in profile |

## Browser control risk

Giving an agent your real logged-in browser session means it can act on **anything**
that profile has access to, not just the site you asked about — that's the tradeoff
for skipping per-service integration work. Mitigations already in place:

- Use a **separate** Chrome profile scoped to only the accounts Hermes needs, not
  your main browser identity.
- `--permission-mode acceptEdits` in `src/hermes.js` lets Claude Code edit files
  without asking each time, but destructive/external actions (sending messages,
  posting, deleting) still prompt for approval by default — don't widen that
  without a reason.
- The approval gates in `hermes.js` (`approve(...)`) are there so nothing deploys,
  pushes publicly, or moves to the next stage without you seeing it first. Don't
  remove them to "make it more autonomous" without accepting that tradeoff.

## Extending the loop

To add a new capability (e.g. auto-posting the finished project to LinkedIn), add a
stage to `src/hermes.js` that calls `runClaudeCode(...)` with a prompt telling it to
use the `playwright` MCP tools against the relevant logged-in site, gated behind
another `approve(...)` call.
