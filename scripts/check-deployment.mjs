import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
const config = JSON.parse(readFileSync(`${homedir()}/.config/audio-notifications/client.json`, 'utf8'));
async function api(path, body, method) {
  const r = await fetch(config.url + path, { method: method || (body ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert(r.ok, `HTTP ${r.status}: ${await (!r.ok ? r.text() : Promise.resolve(''))}`); return r.json();
}
let device, ws;
try {
  const code = await api('/v1/pairing', {});
  device = await api('/v1/pair', { code: code.code, name: 'Temporary deployment verification' });
  ws = new WebSocket(config.url.replace('https:', 'wss:') + '/v1/listen', { headers: { Authorization: `Bearer ${device.token}` } });
  const [ready] = await once(ws, 'message'); assert.equal(JSON.parse(ready).type, 'ready');
  const received = once(ws, 'message');
  const sent = await api('/v1/messages', { text: 'Protocol verification; no physical speech expected.', deviceId: device.deviceId });
  const [raw] = await received; const message = JSON.parse(raw); assert.equal(message.id, sent.id);
  ws.send(JSON.stringify({ type: 'ack', id: sent.id, status: 'spoken' }));
  let receipt;
  for (let i = 0; i < 20; i++) { receipt = await api('/v1/messages/' + sent.id); if (receipt.deliveries[0].status === 'spoken') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(receipt.deliveries[0].status, 'spoken');
  console.log('PASS: deployed HTTPS pairing, REST enqueue, WSS delivery, and simulated spoken acknowledgement.');
} finally {
  ws?.terminate();
  if (device) await api('/v1/devices/' + device.deviceId, undefined, 'DELETE');
}
