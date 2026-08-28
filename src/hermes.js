#!/usr/bin/env node
// Hermes: drives the build loop —
// plan (approved before any code) -> frontend -> backend -> deploy + self-judged
// bug-fix pass -> link -> keep going for new features, all as one continuous
// Claude Code session (via --continue) rather than restarting per stage.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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

// Runs `claude -p <prompt>` with Hermes's MCP servers attached, letting Claude Code
// do the multi-tool work (GitHub, Supabase, Vercel, browser). `continueSession: true`
// resumes the most recent conversation in this directory, so the plan and everything
// built from it stays in context across every stage and every later feature request.
function runClaudeCode(prompt, { continueSession = false } = {}) {
  const args = ['-p', prompt, '--mcp-config', MCP_CONFIG, '--permission-mode', 'acceptEdits'];
  if (continueSession) args.push('--continue');
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`claude exited ${code}`))));
    child.on('error', reject);
  });
}

async function approve(question) {
  const answer = await rl.question(`\n[Hermes] ${question} (y/n) `);
  return /^y/i.test(answer.trim());
}

async function planStage(topic, skillsContext) {
  await runClaudeCode(
    `Plan (do not write or edit any code, do not create repos or run any tool that changes ` +
      `anything) a project: ${topic}.\n` +
      (skillsContext ? `Reference my past work/skills for style and conventions:\n${skillsContext}\n` : '') +
      `Report back: the tech stack, the pages/screens, the API surface, and the DB schema. ` +
      `Just the plan — wait for approval before building anything.`
  );

  while (true) {
    if (await approve('Plan above — proceed to build?')) return;
    const feedback = await rl.question('[Hermes] What should change in the plan? ');
    if (!feedback.trim()) continue;
    await runClaudeCode(`Revise the plan: ${feedback}. Still no code yet — just report the updated plan.`, {
      continueSession: true,
    });
  }
}

async function buildRound(topic) {
  // Frontend first, then backend, then deploy — per the approved plan already in context.
  await runClaudeCode(
    `Now build the frontend for this project (${topic}), following the plan already agreed. ` +
      `If it helps, use the playwright MCP tools to open stitch.withgoogle.com (already logged ` +
      `in) and generate a design there, then export/translate it into real code — otherwise ` +
      `build it directly. Make it look polished.`,
    { continueSession: true }
  );

  await runClaudeCode(
    `Now build the backend for this project, wired to the frontend just built. Create a new ` +
      `GitHub repo for it and push everything so far. Provision any needed Supabase tables via ` +
      `the supabase MCP tools. Report the repo URL when done.`,
    { continueSession: true }
  );

  await runClaudeCode(
    `Deploy this project to Vercel via the vercel MCP tools and connect it to the Supabase DB. ` +
      `Then load the live site with the playwright MCP tools, look for bugs, and fix what you ` +
      `find. Use your own judgment for when it's solid enough to stop rechecking — you don't ` +
      `need it perfect, just working. Report the final live URL, and list anything you noticed ` +
      `but couldn't fix.`,
    { continueSession: true }
  );
}

async function main() {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  const skillsContext = loadSkillsContext();

  let topic = process.argv.slice(2).join(' ').trim();
  if (!topic) topic = await rl.question('[Hermes] What do you want to build? ');
  if (!topic.trim()) {
    console.error('Nothing to build.');
    rl.close();
    return;
  }

  console.log(`\n[Hermes] Planning: ${topic}\n`);
  await planStage(topic, skillsContext);
  await buildRound(topic);

  // Stay in the same conversation for follow-up features instead of restarting the script.
  while (true) {
    const next = await rl.question('\n[Hermes] Anything to add or change? (blank to stop) ');
    if (!next.trim()) break;
    await runClaudeCode(
      `Continuing the same project: ${next}. Make the change, commit, push, redeploy if needed, ` +
        `and re-check the live site the same way as before.`,
      { continueSession: true }
    );
  }

  console.log('\n[Hermes] Done.');
  rl.close();
}

main().catch((err) => {
  console.error('[Hermes] failed:', err.message);
  rl.close();
  process.exit(1);
});
