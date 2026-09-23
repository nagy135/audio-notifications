import { randomUUID } from 'node:crypto';
import { hash } from '../lib/auth.js';
import { httpError } from '../lib/errors.js';
import { transaction } from '../storage/database.js';

function validateMessage({ text, deviceId, ttlSeconds }, key) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
    throw httpError(400, 'text must contain 1–2000 characters');
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) {
    throw httpError(400, 'ttlSeconds must be 1–86400');
  }
  if (deviceId !== undefined && typeof deviceId !== 'string') {
    throw httpError(400, 'deviceId must be a string');
  }
  if (
    key !== undefined &&
    (typeof key !== 'string' || key.length > 128 || !key.length)
  ) {
    throw httpError(400, 'Invalid Idempotency-Key');
  }
}

export function createMessageService({ db, now, delivery }) {
  function get(id) {
    delivery.expire();
    const message = db
      .prepare('SELECT id,text,created_at,expires_at FROM messages WHERE id=?')
      .get(id);
    if (!message) throw httpError(404, 'Message not found');
    const deliveries = db
      .prepare(
        'SELECT device_id,status,updated_at,error FROM deliveries WHERE message_id=?',
      )
      .all(id);
    return { ...message, deliveries };
  }

  function send({ text, deviceId, ttlSeconds = 300 }, key) {
    validateMessage({ text, deviceId, ttlSeconds }, key);
    const fingerprint = hash(
      JSON.stringify([text.trim(), deviceId ?? null, ttlSeconds]),
    );
    const existing =
      key &&
      db
        .prepare('SELECT id,payload_hash FROM messages WHERE idempotency_key=?')
        .get(key);
    if (existing) {
      if (existing.payload_hash !== fingerprint) {
        throw httpError(
          409,
          'Idempotency-Key already used with different content',
        );
      }
      return { message: get(existing.id), created: false };
    }

    const recipients =
      deviceId === undefined
        ? db.prepare('SELECT id FROM devices').all()
        : db.prepare('SELECT id FROM devices WHERE id=?').all(deviceId);
    if (!recipients.length) {
      throw httpError(409, 'No paired recipient; pair your phone first');
    }

    const id = randomUUID();
    const createdAt = now();
    transaction(db, () => {
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(
        id,
        text.trim(),
        createdAt,
        createdAt + ttlSeconds * 1000,
        key ?? null,
        fingerprint,
      );
      for (const recipient of recipients) {
        db.prepare(
          'INSERT INTO deliveries(message_id,device_id,updated_at) VALUES(?,?,?)',
        ).run(id, recipient.id, createdAt);
      }
    });
    for (const recipient of recipients) delivery.pump(recipient.id);
    return { message: get(id), created: true };
  }

  return { get, send };
}
