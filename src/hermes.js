#!/usr/bin/env node
// Hermes: drives the build loop sketched out on paper —
// spec -> Claude Code builds backend -> push GitHub -> frontend -> connect DB
// -> bug-check loop -> human approval -> link -> repeat for new features.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MCP_CONFIG = path.join(ROOT, 'mcp', 'hermes.mcp.json');
const SKILLS_DIR = path.join(ROOT, 'memory', 'skills');
const PROJECTS_DIR = path.join(ROOT, 'memory', 'projects');

const rl = createInterface({ input: process.stdin, output: process.stdout });

function loadSkillsContext() {
  if (!existsSync(SKILLS_DIR)) return '';
  const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md'));
  return files
    .map((f) => `### ${f}\n${readFileSync(path.join(SKILLS_DIR, f), 'utf8')}`)
    .join('\n\n');
}

// Runs `claude -p <prompt>` non-interactively with Hermes's MCP servers attached,
// letting Claude Code itself do the multi-tool work (GitHub, Supabase, Vercel, browser).
function runClaudeCode(prompt, { cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', prompt, '--mcp-config', MCP_CONFIG, '--permission-mode', 'acceptEdits'],
      { cwd, stdio: 'inherit', env: process.env }
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`claude exited ${code}`))));
    child.on('error', reject);
  });
}

async function approve(question) {
  const answer = await rl.question(`\n[Hermes] ${question} (y/n) `);
  return /^y/i.test(answer.trim());
}

async function main() {
  const topic = process.argv.slice(2).join(' ').trim();
  if (!topic) {
    console.error('Usage: npm run hermes -- "<what to build>"');
    process.exit(1);
  }

  mkdirSync(PROJECTS_DIR, { recursive: true });
  const skillsContext = loadSkillsContext();

  console.log(`\n[Hermes] Building: ${topic}\n`);

  // 1. Backend + repo, using whatever's in memory/skills as style/reference context.
  await runClaudeCode(
    `Build the backend for this project: ${topic}.\n` +
      (skillsContext ? `Reference my past work/skills for style and conventions:\n${skillsContext}\n` : '') +
      `Create a new GitHub repo for it and push the initial commit. ` +
      `Provision any needed Supabase tables via the supabase MCP tools. ` +
      `Report the repo URL when done.`
  );

  if (!(await approve('Backend + repo created. Continue to frontend?'))) return;

  // 2. Frontend. Stitch has no API, but Hermes has real browser control (playwright MCP,
  // driven from a Chrome profile that's already logged into Stitch/YouTube/LinkedIn/etc),
  // so Claude Code can open Stitch itself, generate a design, export it, and wire it up —
  // the same way it can pull reference from any other logged-in site when useful.
  await runClaudeCode(
    `Build the frontend for this project (${topic}). If it helps, use the playwright MCP ` +
      `tools to open stitch.withgoogle.com (already logged in) and generate a design there, ` +
      `then export/translate it into real code. Otherwise build it directly. Make it look ` +
      `polished, wire it to the backend already committed in this repo. Commit and push.`
  );

  if (!(await approve('Frontend wired up. Deploy to Vercel and run the bug-check loop?'))) return;

  // 3. Deploy + self-check loop.
  await runClaudeCode(
    `Deploy this project to Vercel via the vercel MCP tools, connect it to the Supabase DB, ` +
      `then check the live site for errors (use the playwright MCP tools to actually load it), ` +
      `fix any bugs found, and re-check until clean. Report the final live URL.`
  );

  console.log('\n[Hermes] Done for this round. Re-run with a new instruction to add features.');
  rl.close();
}

main().catch((err) => {
  console.error('[Hermes] failed:', err.message);
  rl.close();
  process.exit(1);
});
