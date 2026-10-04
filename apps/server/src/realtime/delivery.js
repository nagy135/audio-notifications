import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { hash } from '../lib/auth.js';
import { httpError } from '../lib/errors.js';

const DELIVERY_TIMEOUT_MS = 180_000;
const ACK_STATUSES = new Set(['spoken', 'failed', 'expired']);

export function createDeliveryService({ db, now, rateLimiter, logger }) {
  const clients = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const attempts = new WeakMap();

  function reject(req, socket, status, reason) {
    logger('ws_rejected', { ...attempts.get(req), status, reason });
    socket.once('finish', () => socket.destroy());
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  // ws validates the handshake after our authentication checks.
  wss.on('wsClientError', (error, socket, req) => {
    reject(req, socket, req.method === 'GET' ? 400 : 405, error.message);
  });

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
    ws.deliveryTimer = setTimeout(() => {
      ws.disconnectReason = 'Delivery acknowledgement timed out';
      logger('ws_timeout', { ...ws.logContext, reason: ws.disconnectReason });
      ws.terminate();
    }, DELIVERY_TIMEOUT_MS);
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

  function connect(deviceId, ws, context) {
    const previous = clients.get(deviceId);
    if (previous) {
      logger('ws_replaced', {
        ...previous.logContext,
        replacementConnectionId: context.connectionId,
      });
      previous.close(4000, 'Replaced by another connection');
    }
    clients.set(deviceId, ws);
    ws.logContext = { ...context, deviceId };
    const connectedAt = now();
    logger('ws_connected', ws.logContext);
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('error', (error) => {
      logger('ws_error', { ...ws.logContext, reason: error.message });
    });
    ws.on('close', (code, reason) => {
      logger('ws_disconnected', {
        ...ws.logContext,
        code,
        reason: ws.disconnectReason || reason.toString(),
        durationMs: Math.max(0, now() - connectedAt),
      });
      clearTimeout(ws.deliveryTimer);
      if (clients.get(deviceId) === ws) clients.delete(deviceId);
    });
    ws.on('message', (raw) => acknowledge(deviceId, ws, raw));
    ws.send(JSON.stringify({ type: 'ready', deviceId }));
    pump(deviceId);
  }

  function upgrade(req, socket, head) {
    const context = {
      connectionId: randomUUID(),
      remoteAddress: req.socket.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for']?.slice(0, 200),
      path: req.url?.split('?')[0].slice(0, 200),
    };
    attempts.set(req, context);
    logger('ws_attempt', context);
    socket.on('error', (error) => {
      logger('ws_transport_error', { ...context, reason: error.message });
    });
    try {
      if (req.url !== '/v1/listen') throw httpError(404, 'Not found');
      rateLimiter.check(`ws:${req.socket.remoteAddress}`, 60);
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
      const device = db
        .prepare('SELECT id FROM devices WHERE token_hash=?')
        .get(hash(bearer));
      if (!device) throw httpError(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) =>
        connect(device.id, ws, context),
      );
    } catch (error) {
      reject(req, socket, error.status || 400, error.message);
    }
  }

  function heartbeat() {
    for (const ws of clients.values()) {
      if (!ws.alive) {
        ws.disconnectReason = 'Heartbeat pong timed out';
        logger('ws_timeout', { ...ws.logContext, reason: ws.disconnectReason });
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
    const ws = clients.get(deviceId);
    if (ws) {
      logger('ws_revoked', ws.logContext);
      ws.close(4001, 'Device revoked');
    }
  }

  async function close() {
    for (const ws of clients.values()) {
      ws.disconnectReason = 'Server shutting down';
      ws.terminate();
    }
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
