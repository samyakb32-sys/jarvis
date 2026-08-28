# Setting up Hermes on your machine

Run these from PowerShell in the `jarvis` folder (wherever you clone it locally —
this all runs on your machine, not in the cloud).

## 1. Clone and install

```powershell
git clone https://github.com/samyakb32-sys/jarvis.git
cd jarvis
git checkout claude/hermes-desktop-launch-k3uyfn
npm install
```

## 2. Get your tokens

- **GitHub**: github.com/settings/tokens -> generate a classic token with `repo` scope.
- **Vercel**: vercel.com/account/tokens -> create token.
- **Supabase**: supabase.com/dashboard/account/tokens -> generate a management API token.

## 3. Fill in `.env`

```powershell
copy .env.example .env
notepad .env
```

Paste the three tokens in. Leave `HERMES_PERMISSION_MODE=acceptEdits` for your first
few runs — switch it to `bypassPermissions` only once you've watched a full run and
trust what it does (see the README's "Browser control risk" section for why).

## 4. Set up a dedicated Chrome profile

This is the one manual step that can't be scripted, because Chrome won't let an
automated instance and your regular browsing session share the same profile folder
at once.

1. Open Chrome, click your profile icon (top right) -> **Add** -> create a new profile,
   e.g. "Hermes".
2. In that new profile, log into: GitHub, Vercel, Supabase (only if you prefer
   browser-based checks over the API tokens above), Stitch (stitch.withgoogle.com),
   and anything else from your sketch you want Hermes to reach (YouTube, LinkedIn,
   WhatsApp Web, ChatGPT). Only log in accounts you're comfortable Hermes touching —
   it inherits everything that profile can do, not just the one site you asked about.
3. Find that profile's folder: in Chrome go to `chrome://version`, copy the **Profile
   Path** value, e.g. `C:\Users\you\AppData\Local\Google\Chrome\User Data\Profile 2`.
4. In `.env`, set `CHROME_PROFILE_DIR` to the **parent** `User Data` folder (not the
   `Profile 2` subfolder) — Playwright's `--user-data-dir` flag expects the profile
   root. If Hermes opens the wrong profile, point it at the `Profile 2` path directly
   instead and drop the `--browser chrome` flag in `mcp/hermes.mcp.json` in favor of a
   plain Chromium profile made just for Hermes (simplest, avoids any ambiguity).
5. **Close that Chrome window** before running Hermes — the profile must be free for
   Playwright to open it.

## 5. Confirm the `claude` CLI works standalone

```powershell
claude -p "say hi" --mcp-config mcp\hermes.mcp.json
```

If this hangs on an MCP server failing to start, check that Node/npx can reach the
internet (the GitHub/Supabase/Playwright MCP servers are fetched via `npx -y` on
first use) and that your tokens in `.env` are loaded — `claude` needs to be launched
via `npm run hermes`, not standalone, for `.env` to be picked up (Hermes loads it via
`dotenv`). For a one-off standalone test like the command above, set the env vars in
the shell first:

```powershell
$env:GITHUB_TOKEN="..."; $env:VERCEL_TOKEN="..."; $env:SUPABASE_ACCESS_TOKEN="..."; $env:CHROME_PROFILE_DIR="..."
claude -p "say hi" --mcp-config mcp\hermes.mcp.json
```

## 6. Run Hermes

```powershell
npm run hermes
```

It'll ask what to build, show you a plan, wait for your go-ahead, then build
frontend -> backend -> deploy, and keep the conversation open for follow-up
requests afterward.

## Troubleshooting

- **"claude: command not found"** — Claude Code isn't on PATH in this shell; open a
  new PowerShell window (or the one Hermes desktop launched) where `claude` already
  works, since that's the one you're running Hermes from anyway.
- **MCP server times out** — first run downloads the server packages via `npx`; run
  it again, it'll be cached after.
- **Playwright can't open the Chrome profile** — make sure no other Chrome window is
  using that profile, and that the path in `CHROME_PROFILE_DIR` doesn't have a
  trailing backslash.
