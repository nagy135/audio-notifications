import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';
const token = 'test-token-with-at-least-32-characters';
async function setup(t, opts = {}) {
  const app = createServer({ token, ...opts }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, data, headers = {}, method) {
    const res = await fetch(base + path, { method: method || (data ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: data ? JSON.stringify(data) : undefined });
    return { status: res.status, body: await res.json() };
  }
  async function pair() { const { body } = await api('/v1/pairing', {}); return (await api('/v1/pair', { code: body.code })).body; }
  function listen(device) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/listen', { headers: { Authorization: `Bearer ${device.token}` } });
    const queue = [], waiting = [];
    ws.on('message', data => { const m = JSON.parse(data); const w = waiting.shift(); w ? w(m) : queue.push(m); });
    return { ws, next: () => queue.length ? Promise.resolve(queue.shift()) : Promise.race([new Promise(resolve => waiting.push(resolve)), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('No websocket message')), 3000); timer.unref(); })]) };
  }
  return { app, api, pair, listen };
}
test('auth, input validation, one-time pairing and device credential isolation', async t => {
  const { api } = await setup(t);
  assert.equal((await api('/v1/devices', undefined, { Authorization: '' })).status, 401);
  assert.equal((await api('/v1/messages', { text: 'hello' })).status, 409);
  const { body: p } = await api('/v1/pairing', {});
  const d = await api('/v1/pair', { code: p.code }); assert.equal(d.status, 201);
  assert.equal((await api('/v1/pair', { code: p.code })).status, 401);
  assert.equal((await api('/v1/messages', { text: 'hello' }, { Authorization: `Bearer ${d.body.token}` })).status, 401);
  for (const data of [{ text: '' }, { text: 'x'.repeat(2001) }, { text: 'ok', ttlSeconds: -1 }, { text: 'ok', deviceId: 4 }]) assert.equal((await api('/v1/messages', data)).status, 400);
});
test('ordered delivery, acknowledgement, idempotency and reconnect without repeats', async t => {
  const { api, pair, listen } = await setup(t); const d = await pair(); const c = listen(d); assert.equal((await c.next()).type, 'ready');
  const first = await api('/v1/messages', { text: 'first' }, { 'Idempotency-Key': 'same' }); assert.equal(first.status, 202);
  const m = await c.next(); assert.equal(m.text, 'first');
  assert.equal((await api('/v1/messages', { text: 'first' }, { 'Idempotency-Key': 'same' })).body.id, first.body.id);
  assert.equal((await api('/v1/messages', { text: 'different' }, { 'Idempotency-Key': 'same' })).status, 409);
  const second = await api('/v1/messages', { text: 'second' });
  c.ws.send(JSON.stringify({ type: 'ack', id: m.id, status: 'spoken' }));
  assert.equal((await c.next()).id, second.body.id);
  assert.equal((await api('/v1/messages/' + m.id)).body.deliveries[0].status, 'spoken');
  c.ws.terminate(); await once(c.ws, 'close');
  const c2 = listen(d); await c2.next(); assert.equal((await c2.next()).id, second.body.id);
  c2.ws.send(JSON.stringify({ type: 'ack', id: second.body.id, status: 'failed', error: 'No voice installed' }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await api('/v1/messages/' + second.body.id)).body.deliveries[0].status, 'failed');
});
test('expired messages are not replayed; targeted delivery and revocation', async t => {
  let clock = Date.now(); const { api, pair, listen } = await setup(t, { now: () => clock });
  const a = await pair(), b = await pair();
  const old = await api('/v1/messages', { text: 'stale', ttlSeconds: 1 }); clock += 2000;
  assert.equal((await api('/v1/messages/' + old.body.id)).body.deliveries[0].status, 'expired');
  const m = await api('/v1/messages', { text: 'only A', deviceId: a.deviceId }); assert.equal(m.body.deliveries.length, 1);
  const c = listen(a); await c.next(); assert.equal((await c.next()).text, 'only A');
  const closed = once(c.ws, 'close'); await api('/v1/devices/' + a.deviceId, undefined, {}, 'DELETE'); assert.equal((await closed)[0], 4001);
  assert.equal((await api('/v1/devices')).body.devices[0].id, b.deviceId);
});
test('queued messages survive a server restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'db.sqlite'); let app = createServer({ token, database });
  app.db.prepare('INSERT INTO devices VALUES(?,?,?,?)').run('device', 'phone', 'hash', 1);
  app.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('message', 'persist me', 1, Date.now()+60000, null, 'hash');
  app.db.prepare('INSERT INTO deliveries(message_id,device_id,updated_at) VALUES(?,?,?)').run('message','device',1);
  await app.close(); app = createServer({ token, database });
  assert.equal(app.db.prepare('SELECT text FROM messages').get().text, 'persist me');
  assert.equal(app.db.prepare('SELECT status FROM deliveries').get().status, 'queued'); await app.close();
});
