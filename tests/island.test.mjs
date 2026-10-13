// Tests for src/island.js against a stand-in island speaking the same protocol
// (one JSON line in, one JSON line back for waiting requests).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { endpoint, islandAskPlan, islandEvent } from '../src/island.js';

let dir;
let server;
let received;

function startIsland(onRequest) {
  received = [];
  server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      received.push({ req, socket });
      onRequest?.(req, socket);
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(endpoint(), resolve));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'island-js-'));
  process.env.JARVIS_ISLAND_DIR = dir;
  process.env.JARVIS_ISLAND_PIPE =
    process.platform === 'win32' ? `\\\\.\\pipe\\island-js-${process.pid}-${Date.now()}` : path.join(dir, 's.sock');
  writeFileSync(path.join(dir, 'token'), 'tok\n');
});

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

test('events carry the token and source, and never wait', async () => {
  await startIsland();
  await islandEvent('stage', { project: 'p', stage: 'frontend', status: 'running' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 1);
  const { req } = received[0];
  assert.deepEqual(req, { v: 1, token: 'tok', source: 'hermes', event: 'stage', wait: false, payload: { project: 'p', stage: 'frontend', status: 'running' } });
});

test('plan approval and revision come back from the island', async () => {
  await startIsland((req, socket) => {
    const reply = req.payload.round === 1 ? { decision: 'revise', feedback: ' add auth ' } : { decision: 'approve' };
    socket.end(`${JSON.stringify(reply)}\n`);
  });
  assert.deepEqual(await islandAskPlan({ project: 'p', round: 1 }), { decision: 'revise', feedback: 'add auth' });
  assert.deepEqual(await islandAskPlan({ project: 'p', round: 2 }), { decision: 'approve' });
  assert.equal(received[0].req.wait, true);
  assert.equal(typeof received[0].req.timeout_ms, 'number');
});

test('no decision, or a revision without feedback, is no answer', async () => {
  await startIsland((req, socket) => socket.end(req.payload.round === 1 ? '{"decision":null}\n' : '{"decision":"revise","feedback":"  "}\n'));
  assert.equal(await islandAskPlan({ round: 1 }), null);
  assert.equal(await islandAskPlan({ round: 2 }), null);
});

test('without the island, calls return quickly with nothing', async () => {
  const t0 = Date.now();
  assert.equal(await islandAskPlan({ round: 1 }), null);
  await islandEvent('stage', {});
  rmSync(path.join(dir, 'token'));
  assert.equal(await islandAskPlan({ round: 1 }), null);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('aborting withdraws the card by closing the connection', async () => {
  let closed;
  const gone = new Promise((r) => (closed = r));
  await startIsland((req, socket) => socket.on('close', closed));
  const ac = new AbortController();
  const pending = islandAskPlan({ round: 1 }, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  assert.equal(await pending, null);
  await gone;
});
