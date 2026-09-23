import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';
import { PREVIEW_TEXT } from '../src/services/speech.js';
const token = 'test-token-with-at-least-32-characters';
async function setup(t, opts = {}) {
  const app = createServer({ token, ...opts });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, data, headers = {}, method) {
    const res = await fetch(base + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  async function pair() {
    const { body } = await api('/v1/pairing', {});
    return (await api('/v1/pair', { code: body.code })).body;
  }
  function listen(device) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/listen', {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    const queue = [],
      waiting = [];
    ws.on('message', (data) => {
      const m = JSON.parse(data);
      const w = waiting.shift();
      w ? w(m) : queue.push(m);
    });
    return {
      ws,
      next: () =>
        queue.length
          ? Promise.resolve(queue.shift())
          : Promise.race([
              new Promise((resolve) => waiting.push(resolve)),
              new Promise((_, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('No websocket message')),
                  3000,
                );
                timer.unref();
              }),
            ]),
    };
  }
  return { app, api, pair, listen, base };
}
test('auth, input validation, one-time pairing and device credential isolation', async (t) => {
  const { api } = await setup(t);
  assert.equal(
    (await api('/v1/devices', undefined, { Authorization: '' })).status,
    401,
  );
  assert.equal((await api('/v1/messages', { text: 'hello' })).status, 409);
  const { body: p } = await api('/v1/pairing', {});
  const d = await api('/v1/pair', { code: p.code });
  assert.equal(d.status, 201);
  assert.equal((await api('/v1/pair', { code: p.code })).status, 401);
  assert.equal(
    (
      await api(
        '/v1/messages',
        { text: 'hello' },
        { Authorization: `Bearer ${d.body.token}` },
      )
    ).status,
    401,
  );
  for (const data of [
    { text: '' },
    { text: 'x'.repeat(2001) },
    { text: 'ok', ttlSeconds: -1 },
    { text: 'ok', deviceId: 4 },
  ])
    assert.equal((await api('/v1/messages', data)).status, 400);
});
test('ordered delivery, acknowledgement, idempotency and reconnect without repeats', async (t) => {
  const { api, pair, listen } = await setup(t);
  const d = await pair();
  const c = listen(d);
  assert.equal((await c.next()).type, 'ready');
  const first = await api(
    '/v1/messages',
    { text: 'first' },
    { 'Idempotency-Key': 'same' },
  );
  assert.equal(first.status, 202);
  const m = await c.next();
  assert.equal(m.text, 'first');
  assert.equal(
    (
      await api(
        '/v1/messages',
        { text: 'first' },
        { 'Idempotency-Key': 'same' },
      )
    ).body.id,
    first.body.id,
  );
  assert.equal(
    (
      await api(
        '/v1/messages',
        { text: 'different' },
        { 'Idempotency-Key': 'same' },
      )
    ).status,
    409,
  );
  const second = await api('/v1/messages', { text: 'second' });
  c.ws.send(JSON.stringify({ type: 'ack', id: m.id, status: 'spoken' }));
  assert.equal((await c.next()).id, second.body.id);
  assert.equal(
    (await api('/v1/messages/' + m.id)).body.deliveries[0].status,
    'spoken',
  );
  c.ws.terminate();
  await once(c.ws, 'close');
  const c2 = listen(d);
  await c2.next();
  assert.equal((await c2.next()).id, second.body.id);
  c2.ws.send(
    JSON.stringify({
      type: 'ack',
      id: second.body.id,
      status: 'failed',
      error: 'No voice installed',
    }),
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    (await api('/v1/messages/' + second.body.id)).body.deliveries[0].status,
    'failed',
  );
});
test('expired messages are not replayed; targeted delivery and revocation', async (t) => {
  let clock = Date.now();
  const { api, pair, listen } = await setup(t, { now: () => clock });
  const a = await pair(),
    b = await pair();
  const old = await api('/v1/messages', { text: 'stale', ttlSeconds: 1 });
  clock += 2000;
  assert.equal(
    (await api('/v1/messages/' + old.body.id)).body.deliveries[0].status,
    'expired',
  );
  const m = await api('/v1/messages', { text: 'only A', deviceId: a.deviceId });
  assert.equal(m.body.deliveries.length, 1);
  const c = listen(a);
  await c.next();
  assert.equal((await c.next()).text, 'only A');
  const closed = once(c.ws, 'close');
  await api('/v1/devices/' + a.deviceId, undefined, {}, 'DELETE');
  assert.equal((await closed)[0], 4001);
  assert.equal((await api('/v1/devices')).body.devices[0].id, b.deviceId);
});
test('queued messages survive a server restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'db.sqlite');
  let app = createServer({ token, database });
  app.db
    .prepare('INSERT INTO devices VALUES(?,?,?,?)')
    .run('device', 'phone', 'hash', 1);
  app.db
    .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)')
    .run('message', 'persist me', 1, Date.now() + 60000, null, 'hash');
  app.db
    .prepare(
      'INSERT INTO deliveries(message_id,device_id,updated_at) VALUES(?,?,?)',
    )
    .run('message', 'device', 1);
  await app.close();
  app = createServer({ token, database });
  assert.equal(
    app.db.prepare('SELECT text FROM messages').get().text,
    'persist me',
  );
  assert.equal(
    app.db.prepare('SELECT status FROM deliveries').get().status,
    'queued',
  );
  await app.close();
});

test('expiry does not invalidate a message already being spoken', async (t) => {
  let clock = Date.now();
  const { api, pair, listen } = await setup(t, { now: () => clock });
  const device = await pair(),
    c = listen(device);
  await c.next();
  const sent = await api('/v1/messages', {
    text: 'already speaking',
    ttlSeconds: 1,
  });
  await c.next();
  clock += 2000;
  assert.equal(
    (await api('/v1/messages/' + sent.body.id)).body.deliveries[0].status,
    'queued',
  );
  c.ws.send(
    JSON.stringify({ type: 'ack', id: sent.body.id, status: 'spoken' }),
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    (await api('/v1/messages/' + sent.body.id)).body.deliveries[0].status,
    'spoken',
  );
});

test('HTTP routes preserve JSON errors, body limits and response headers', async (t) => {
  const { api, base } = await setup(t);
  assert.deepEqual(await api('/health', undefined, { Authorization: '' }), {
    status: 200,
    body: { ok: true },
  });
  assert.equal((await api('/missing')).status, 404);
  assert.equal((await api('/v1/messages/missing')).status, 404);

  for (const body of ['{', 'null', '[]', '"text"']) {
    const response = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), {
      error: 'Expected a JSON object',
    });
  }

  const oversized = await api('/v1/messages', { text: 'x'.repeat(8192) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error, 'Request too large');
});

test('pairing expires and rate limits reset after one minute', async (t) => {
  let clock = Date.now();
  const { api } = await setup(t, { now: () => clock });
  const { body: pairing } = await api('/v1/pairing', {});
  clock = pairing.expiresAt;
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await api('/v1/pair', { code: pairing.code })).status, 401);
  }
  assert.equal((await api('/v1/pair', { code: pairing.code })).status, 429);
  clock += 60_001;
  const { body: fresh } = await api('/v1/pairing', {});
  assert.equal((await api('/v1/pair', { code: fresh.code })).status, 201);
});

test('WebSocket authentication and malformed acknowledgements preserve queued delivery', async (t) => {
  const { api, pair, listen } = await setup(t);
  const unauthorized = listen({ token });
  const rejected = once(unauthorized.ws, 'error');
  const closed = new Promise((resolve) =>
    unauthorized.ws.once('close', resolve),
  );
  assert.match((await rejected)[0].message, /401/);
  await closed;

  const device = await pair();
  const client = listen(device);
  await client.next();
  assert.equal((await api('/v1/devices')).body.devices[0].connected, true);
  const sent = await api('/v1/messages', { text: 'retry after invalid ack' });
  await client.next();
  const disconnected = once(client.ws, 'close');
  client.ws.send('{');
  assert.equal((await disconnected)[0], 1008);
  assert.equal(
    (await api('/v1/messages/' + sent.body.id)).body.deliveries[0].status,
    'queued',
  );

  const reconnected = listen(device);
  await reconnected.next();
  assert.equal((await reconnected.next()).id, sent.body.id);
});

// A minimal PCM WAV keeps transport tests independent of model downloads.
function testWav() {
  const wav = Buffer.alloc(46);
  wav.write('RIFF');
  wav.writeUInt32LE(38, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2, 40);
  return wav;
}

async function speechWorker(t, respond) {
  const worker = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.end('{}');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    await respond(JSON.parse(body), res);
  });
  worker.listen(0, '127.0.0.1');
  await once(worker, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        worker.close(resolve);
        worker.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${worker.address().port}`;
}

function speechRequest(base, device, payload) {
  return fetch(base + '/v1/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${device.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

test('Kokoro audio is device scoped, previews use fixed text, and voice choices are validated', async (t) => {
  const calls = [];
  const kokoroUrl = await speechWorker(t, (body, res) => {
    calls.push(body);
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(testWav());
  });
  const { api, pair, base } = await setup(t, { kokoroUrl });
  const a = await pair(),
    b = await pair();
  assert.equal((await api('/v1/voices')).status, 401);
  const catalog = await api('/v1/voices', undefined, {
    Authorization: `Bearer ${a.token}`,
  });
  assert.equal(catalog.body.available, true);
  assert.equal(catalog.body.voices.length, 10);
  const sent = await api('/v1/messages', {
    text: 'Only phone A can get this audio.',
    deviceId: a.deviceId,
  });
  assert.equal(
    (await speechRequest(base, b, { messageId: sent.body.id })).status,
    404,
  );
  assert.equal(
    (await speechRequest(base, { token }, { messageId: sent.body.id })).status,
    401,
  );
  assert.equal(
    (
      await speechRequest(base, a, {
        messageId: sent.body.id,
        voice: '../../bad',
      })
    ).status,
    400,
  );
  assert.equal(
    (await speechRequest(base, a, { text: 'arbitrary text' })).status,
    400,
  );
  const audio = await speechRequest(base, a, {
    messageId: sent.body.id,
    voice: 'bf_emma',
  });
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('cache-control'), 'no-store');
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), testWav());
  assert.deepEqual(calls[0], {
    text: 'Only phone A can get this audio.',
    voice: 'bf_emma',
  });
  const preview = await speechRequest(base, a, {
    preview: true,
    text: 'Do not synthesize this',
  });
  assert.equal(preview.status, 200);
  await preview.arrayBuffer();
  assert.equal(calls[1].text, PREVIEW_TEXT);
  assert.equal(
    (await api('/v1/messages/' + sent.body.id)).body.deliveries[0].status,
    'queued',
  );
});

test('Kokoro cache shares concurrent synthesis and re-checks expiry and revocation', async (t) => {
  let release,
    calls = 0,
    clock = Date.now();
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const kokoroUrl = await speechWorker(t, async (_body, res) => {
    calls++;
    await gate;
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(testWav());
  });
  const { api, pair, base } = await setup(t, { kokoroUrl, now: () => clock });
  const device = await pair();
  const sent = await api('/v1/messages', {
    text: 'Shared generation',
    ttlSeconds: 600,
  });
  const payload = { messageId: sent.body.id };
  const first = speechRequest(base, device, payload),
    second = speechRequest(base, device, payload);
  // Wait for the worker without assuming machine timing.
  for (let i = 0; !calls && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  const busy = await speechRequest(base, device, {
    ...payload,
    voice: 'af_bella',
  });
  assert.equal(busy.status, 503);
  release();
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  await (await speechRequest(base, device, payload)).arrayBuffer();
  assert.equal(calls, 1);
  clock += 120_001;
  await (await speechRequest(base, device, payload)).arrayBuffer();
  assert.equal(calls, 2);
  clock += 600_000;
  assert.equal((await speechRequest(base, device, payload)).status, 410);
  await api('/v1/devices/' + device.deviceId, undefined, {}, 'DELETE');
  assert.equal(
    (await speechRequest(base, device, { preview: true })).status,
    401,
  );
});

test('unavailable, corrupt, oversized and stalled Kokoro responses fail promptly without blocking delivery', async (t) => {
  let mode = 'unavailable';
  const kokoroUrl = await speechWorker(t, (_body, res) => {
    if (mode === 'unavailable') {
      res.writeHead(503);
      res.end();
    } else if (mode === 'corrupt') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end('bad wav');
    } else if (mode === 'oversized') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
    } else {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.flushHeaders();
    }
  });
  const { api, pair, listen, base } = await setup(t, {
    kokoroUrl,
    speechTimeoutMs: 200,
  });
  const device = await pair();
  const client = listen(device);
  await client.next();
  const sent = await api('/v1/messages', {
    text: 'Still delivered when Kokoro is broken.',
  });
  assert.equal((await client.next()).id, sent.body.id);
  for (const [scenario, status] of [
    ['unavailable', 503],
    ['corrupt', 502],
    ['oversized', 502],
    ['stalled', 503],
  ]) {
    mode = scenario;
    const response = await speechRequest(base, device, {
      messageId: sent.body.id,
    });
    assert.equal(response.status, status, scenario);
    await response.json();
  }
  client.ws.send(
    JSON.stringify({ type: 'ack', id: sent.body.id, status: 'spoken' }),
  );
  const next = await api('/v1/messages', {
    text: 'Next notification after Android fallback.',
  });
  assert.equal((await client.next()).id, next.body.id);
  assert.equal(
    (await api('/v1/messages/' + sent.body.id)).body.deliveries[0].status,
    'spoken',
  );
});

test('Kokoro does not return audio if a message expires during generation', async (t) => {
  let clock = Date.now();
  const kokoroUrl = await speechWorker(t, (_body, res) => {
    clock += 2000;
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(testWav());
  });
  const { api, pair, base } = await setup(t, { kokoroUrl, now: () => clock });
  const device = await pair();
  const sent = await api('/v1/messages', {
    text: 'Expired while generating',
    ttlSeconds: 1,
  });
  assert.equal(
    (await speechRequest(base, device, { messageId: sent.body.id })).status,
    410,
  );
});
