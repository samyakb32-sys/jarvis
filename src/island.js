// Client for Jarvis Island (island/): tells it what Hermes is doing and asks it
// for the plan approval. Everything here is best-effort — if the island is not
// running, every call returns quickly and Hermes carries on in the terminal.
//
// Endpoint and token rules mirror island/protocol/src/paths.rs; change both together.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const DIR_NAME = 'jarvis-island';
const CONNECT_BUDGET_MS = 300;
const FIRE_BUDGET_MS = 2000;
const MAX_REPLY = 64 * 1024;

function userSlug() {
  const raw = process.env.USERNAME || process.env.USER || '';
  const slug = raw.replace(/[^A-Za-z0-9_-]/g, '').toLowerCase();
  return slug || 'user';
}

export function dataDir() {
  if (process.env.JARVIS_ISLAND_DIR) return process.env.JARVIS_ISLAND_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, DIR_NAME);
  }
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, DIR_NAME);
  return path.join(os.tmpdir(), `${DIR_NAME}-${userSlug()}`);
}

export function endpoint() {
  if (process.env.JARVIS_ISLAND_PIPE) return process.env.JARVIS_ISLAND_PIPE;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${DIR_NAME}-${userSlug()}`
    : path.join(dataDir(), 'island.sock');
}

function readToken() {
  try {
    return readFileSync(path.join(dataDir(), 'token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Send one request. Resolves with the island's reply ({ decision, feedback, ... })
 * for `wait` requests, or null: island absent, declined, timed out, or aborted.
 * Aborting closes the connection, which takes the card off the island.
 */
function send(event, payload, { wait = false, timeoutMs = FIRE_BUDGET_MS, signal } = {}) {
  const token = readToken();
  if (!token) return Promise.resolve(null);
  const request = { v: 1, token, source: 'hermes', event, wait, payload };
  if (wait) request.timeout_ms = timeoutMs;

  return new Promise((resolve) => {
    let done = false;
    let buffer = '';
    const socket = net.connect(endpoint());
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(overall);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(value);
    };
    const onAbort = () => finish(null);
    const connectTimer = setTimeout(() => finish(null), CONNECT_BUDGET_MS);
    // A little longer than the island's own deadline, so its answer wins.
    const overall = setTimeout(() => finish(null), wait ? timeoutMs + 2000 : FIRE_BUDGET_MS);

    if (signal?.aborted) return finish(null);
    signal?.addEventListener('abort', onAbort);

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.write(`${JSON.stringify(request)}\n`, () => {
        if (!wait) finish(null);
      });
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_REPLY) return finish(null);
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, nl)));
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

/** Fire-and-forget: a stage started/finished, the run began or ended. Never throws. */
export async function islandEvent(event, payload) {
  await send(event, payload);
}

/**
 * Ask the island to approve the plan. Resolves with
 * { decision: 'approve' } | { decision: 'revise', feedback } | null.
 */
export async function islandAskPlan(payload, { timeoutMs = 6 * 60 * 60 * 1000, signal } = {}) {
  const reply = await send('plan', payload, { wait: true, timeoutMs, signal });
  if (reply?.decision === 'approve') return { decision: 'approve' };
  if (reply?.decision === 'revise' && typeof reply.feedback === 'string' && reply.feedback.trim()) {
    return { decision: 'revise', feedback: reply.feedback.trim() };
  }
  return null;
}
