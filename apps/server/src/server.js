import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';

const hash = value => createHash('sha256').update(value).digest('hex');
const error = (status, message) => Object.assign(new Error(message), { status });
export function createServer({ database = ':memory:', token, now = Date.now } = {}) {
  if (!token || token.length < 32) throw new Error('API_TOKEN must contain at least 32 characters');
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pairing(code_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,text TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,idempotency_key TEXT UNIQUE,payload_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'queued',updated_at INTEGER NOT NULL,error TEXT,PRIMARY KEY(message_id,device_id));`);
  const clients = new Map();
  const limits = new Map();
  function rate(key, max) {
    const t = now(); const entry = limits.get(key);
    if (!entry || entry.until < t) { limits.set(key, { count: 1, until: t + 60000 }); return; }
    if (++entry.count > max) throw error(429, 'Too many requests; retry after one minute');
  }
  function authorized(req) {
    const given = hash(req.headers.authorization || ''); const expected = hash(`Bearer ${token}`);
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }
  function expire() {
    // A message already being spoken gets its bounded delivery window to finish.
    const inFlight = [...clients.entries()].filter(([, ws]) => ws.inflight).map(([deviceId, ws]) => [deviceId, ws.inflight]);
    const exclusions = inFlight.map(() => '(device_id=? AND message_id=?)').join(' OR ');
    db.prepare("UPDATE deliveries SET status='expired',updated_at=? WHERE status='queued' AND message_id IN (SELECT id FROM messages WHERE expires_at<=?)" + (exclusions ? ` AND NOT (${exclusions})` : '')).run(now(), now(), ...inFlight.flat());
  }
  function pump(deviceId) {
    expire();
    const ws = clients.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.inflight) return;
    const msg = db.prepare("SELECT m.* FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.device_id=? AND d.status='queued' ORDER BY m.created_at,m.rowid LIMIT 1").get(deviceId);
    if (!msg) return;
    ws.inflight = msg.id;
    ws.send(JSON.stringify({ type: 'message', id: msg.id, text: msg.text, expiresAt: msg.expires_at }));
    ws.deliveryTimer = setTimeout(() => ws.terminate(), 180000);
  }
  function message(id) {
    expire();
    const m = db.prepare('SELECT id,text,created_at,expires_at FROM messages WHERE id=?').get(id);
    if (!m) throw error(404, 'Message not found');
    return { ...m, deliveries: db.prepare('SELECT device_id,status,updated_at,error FROM deliveries WHERE message_id=?').all(id) };
  }
  async function body(req) {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) throw error(413, 'Request too large'); }
    try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; } catch { throw error(400, 'Expected a JSON object'); }
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return reply(200, { ok: true });
      rate(req.socket.remoteAddress, 180);
      if (req.method === 'POST' && path === '/v1/pair') {
        rate(`pair:${req.socket.remoteAddress}`, 10);
        const { code, name = 'Android phone' } = await body(req);
        if (typeof code !== 'string' || typeof name !== 'string' || !name.trim() || name.length > 80) throw error(400, 'Invalid pairing details');
        const codeHash = hash(code.trim().toUpperCase());
        const pairing = db.prepare('SELECT * FROM pairing WHERE code_hash=? AND expires_at>?').get(codeHash, now());
        if (!pairing) throw error(401, 'Pairing code is invalid or expired');
        const id = randomUUID(), deviceToken = randomBytes(32).toString('hex');
        db.exec('BEGIN');
        try {
          db.prepare('DELETE FROM pairing WHERE code_hash=?').run(codeHash);
          db.prepare('INSERT INTO devices VALUES(?,?,?,?)').run(id, name.trim(), hash(deviceToken), now());
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return reply(201, { deviceId: id, token: deviceToken });
      }
      if (!authorized(req)) throw error(401, 'Unauthorized');
      if (req.method === 'POST' && path === '/v1/pairing') {
        const code = randomBytes(5).toString('hex').toUpperCase();
        const expiresAt = now() + 7 * 86400000;
        db.prepare('INSERT INTO pairing VALUES(?,?)').run(hash(code), expiresAt);
        return reply(201, { code, expiresAt });
      }
      if (req.method === 'GET' && path === '/v1/devices') return reply(200, { devices: db.prepare('SELECT id,name,created_at FROM devices').all().map(d => ({ ...d, connected: clients.get(d.id)?.readyState === WebSocket.OPEN })) });
      if (req.method === 'DELETE' && path.startsWith('/v1/devices/')) {
        const id = path.slice('/v1/devices/'.length);
        db.prepare('DELETE FROM devices WHERE id=?').run(id); clients.get(id)?.close(4001, 'Device revoked');
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const { text, deviceId, ttlSeconds = 300 } = await body(req);
        const key = req.headers['idempotency-key'];
        if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw error(400, 'text must contain 1–2000 characters');
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) throw error(400, 'ttlSeconds must be 1–86400');
        if (deviceId !== undefined && typeof deviceId !== 'string') throw error(400, 'deviceId must be a string');
        if (key !== undefined && (typeof key !== 'string' || key.length > 128 || !key.length)) throw error(400, 'Invalid Idempotency-Key');
        const fingerprint = hash(JSON.stringify([text.trim(), deviceId ?? null, ttlSeconds]));
        const old = key && db.prepare('SELECT id,payload_hash FROM messages WHERE idempotency_key=?').get(key);
        if (old) { if (old.payload_hash !== fingerprint) throw error(409, 'Idempotency-Key already used with different content'); return reply(200, message(old.id)); }
        const devices = deviceId === undefined ? db.prepare('SELECT id FROM devices').all() : db.prepare('SELECT id FROM devices WHERE id=?').all(deviceId);
        if (!devices.length) throw error(409, 'No paired recipient; pair your phone first');
        const id = randomUUID(), created = now();
        db.exec('BEGIN');
        try {
          db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id, text.trim(), created, created + ttlSeconds * 1000, key ?? null, fingerprint);
          for (const d of devices) db.prepare('INSERT INTO deliveries(message_id,device_id,updated_at) VALUES(?,?,?)').run(id, d.id, created);
          db.exec('COMMIT');
        } catch(e) { db.exec('ROLLBACK'); throw e; }
        devices.forEach(d => pump(d.id));
        return reply(202, message(id));
      }
      if (req.method === 'GET' && path.startsWith('/v1/messages/')) return reply(200, message(path.slice('/v1/messages/'.length)));
      throw error(404, 'Not found');
    } catch (e) { if (!e.status) console.error(e); reply(e.status || 500, { error: e.status ? e.message : 'Internal server error' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.url !== '/v1/listen') throw error(404, 'Not found');
      rate(`ws:${req.socket.remoteAddress}`, 60);
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
      const device = db.prepare('SELECT id FROM devices WHERE token_hash=?').get(hash(bearer));
      if (!device) throw error(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, ws => {
        clients.get(device.id)?.close(4000, 'Replaced by another connection');
        clients.set(device.id, ws); ws.alive = true;
        ws.on('pong', () => { ws.alive = true; });
        ws.on('error', () => {});
        ws.on('close', () => { clearTimeout(ws.deliveryTimer); if (clients.get(device.id) === ws) clients.delete(device.id); });
        ws.on('message', raw => {
          try {
            const ack = JSON.parse(raw.toString());
            if (ack.type !== 'ack' || ack.id !== ws.inflight || !['spoken','failed','expired'].includes(ack.status)) return;
            db.prepare("UPDATE deliveries SET status=?,updated_at=?,error=? WHERE device_id=? AND message_id=? AND status='queued'").run(ack.status, now(), typeof ack.error === 'string' ? ack.error.slice(0,200) : null, device.id, ack.id);
            clearTimeout(ws.deliveryTimer); ws.inflight = null; pump(device.id);
          } catch { ws.close(1008, 'Invalid acknowledgement'); }
        });
        ws.send(JSON.stringify({ type: 'ready', deviceId: device.id })); pump(device.id);
      });
    } catch (e) { socket.end(`HTTP/1.1 ${e.status || 400} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  const heartbeat = setInterval(() => {
    for (const ws of clients.values()) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    for (const [key, value] of limits) if (value.until < now()) limits.delete(key);
    db.prepare('DELETE FROM pairing WHERE expires_at<=?').run(now());
    // Retain delivery receipts and idempotency keys for seven days.
    db.prepare('DELETE FROM messages WHERE expires_at<?').run(now() - 7 * 86400000);
    for (const id of clients.keys()) pump(id);
  }, 25000);
  heartbeat.unref();
  return { server, db, close: async () => { clearInterval(heartbeat); for (const ws of clients.values()) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); db.close(); } };
}
