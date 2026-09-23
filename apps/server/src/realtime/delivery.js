import { WebSocket, WebSocketServer } from 'ws';
import { hash } from '../lib/auth.js';
import { httpError } from '../lib/errors.js';

const DELIVERY_TIMEOUT_MS = 180_000;
const ACK_STATUSES = new Set(['spoken', 'failed', 'expired']);

export function createDeliveryService({ db, now, rateLimiter }) {
  const clients = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  function expire() {
    // A message already being spoken gets its bounded delivery window to finish.
    const inFlight = [...clients.entries()]
      .filter(([, ws]) => ws.inflight)
      .map(([deviceId, ws]) => [deviceId, ws.inflight]);
    const exclusions = inFlight
      .map(() => '(device_id=? AND message_id=?)')
      .join(' OR ');
    db.prepare(
      `
      UPDATE deliveries SET status='expired',updated_at=?
      WHERE status='queued'
        AND message_id IN (SELECT id FROM messages WHERE expires_at<=?)
        ${exclusions ? `AND NOT (${exclusions})` : ''}
    `,
    ).run(now(), now(), ...inFlight.flat());
  }

  function pump(deviceId) {
    expire();
    const ws = clients.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.inflight) return;
    const message = db
      .prepare(
        `
      SELECT m.* FROM messages m
      JOIN deliveries d ON d.message_id=m.id
      WHERE d.device_id=? AND d.status='queued'
      ORDER BY m.created_at,m.rowid LIMIT 1
    `,
      )
      .get(deviceId);
    if (!message) return;

    ws.inflight = message.id;
    ws.send(
      JSON.stringify({
        type: 'message',
        id: message.id,
        text: message.text,
        expiresAt: message.expires_at,
      }),
    );
    ws.deliveryTimer = setTimeout(() => ws.terminate(), DELIVERY_TIMEOUT_MS);
  }

  function acknowledge(deviceId, ws, raw) {
    try {
      const ack = JSON.parse(raw.toString());
      if (
        ack.type !== 'ack' ||
        ack.id !== ws.inflight ||
        !ACK_STATUSES.has(ack.status)
      )
        return;
      db.prepare(
        `
        UPDATE deliveries SET status=?,updated_at=?,error=?
        WHERE device_id=? AND message_id=? AND status='queued'
      `,
      ).run(
        ack.status,
        now(),
        typeof ack.error === 'string' ? ack.error.slice(0, 200) : null,
        deviceId,
        ack.id,
      );
      clearTimeout(ws.deliveryTimer);
      ws.inflight = null;
      pump(deviceId);
    } catch {
      ws.close(1008, 'Invalid acknowledgement');
    }
  }

  function connect(deviceId, ws) {
    clients.get(deviceId)?.close(4000, 'Replaced by another connection');
    clients.set(deviceId, ws);
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(ws.deliveryTimer);
      if (clients.get(deviceId) === ws) clients.delete(deviceId);
    });
    ws.on('message', (raw) => acknowledge(deviceId, ws, raw));
    ws.send(JSON.stringify({ type: 'ready', deviceId }));
    pump(deviceId);
  }

  function upgrade(req, socket, head) {
    try {
      if (req.url !== '/v1/listen') throw httpError(404, 'Not found');
      rateLimiter.check(`ws:${req.socket.remoteAddress}`, 60);
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
      const device = db
        .prepare('SELECT id FROM devices WHERE token_hash=?')
        .get(hash(bearer));
      if (!device) throw httpError(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => connect(device.id, ws));
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error.status || 400} Rejected\r\nConnection: close\r\n\r\n`,
      );
    }
  }

  function heartbeat() {
    for (const ws of clients.values()) {
      if (!ws.alive) {
        ws.terminate();
      } else {
        ws.alive = false;
        ws.ping();
      }
    }
  }

  function pumpAll() {
    for (const deviceId of clients.keys()) pump(deviceId);
  }

  function isConnected(deviceId) {
    return clients.get(deviceId)?.readyState === WebSocket.OPEN;
  }

  function disconnect(deviceId) {
    clients.get(deviceId)?.close(4001, 'Device revoked');
  }

  async function close() {
    for (const ws of clients.values()) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }

  return {
    expire,
    pump,
    pumpAll,
    upgrade,
    heartbeat,
    isConnected,
    disconnect,
    close,
  };
}
