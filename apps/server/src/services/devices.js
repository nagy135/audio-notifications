import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '../lib/auth.js';
import { httpError } from '../lib/errors.js';
import { transaction } from '../storage/database.js';

const PAIRING_TTL_MS = 7 * 86_400_000;

export function createDeviceService({ db, now, delivery }) {
  function createPairing() {
    const code = randomBytes(5).toString('hex').toUpperCase();
    const expiresAt = now() + PAIRING_TTL_MS;
    db.prepare('INSERT INTO pairing VALUES(?,?)').run(hash(code), expiresAt);
    return { code, expiresAt };
  }

  function pair({ code, name = 'Android phone' }) {
    if (
      typeof code !== 'string' ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 80
    ) {
      throw httpError(400, 'Invalid pairing details');
    }
    const codeHash = hash(code.trim().toUpperCase());
    const pairing = db
      .prepare('SELECT * FROM pairing WHERE code_hash=? AND expires_at>?')
      .get(codeHash, now());
    if (!pairing) throw httpError(401, 'Pairing code is invalid or expired');

    const deviceId = randomUUID();
    const token = randomBytes(32).toString('hex');
    transaction(db, () => {
      db.prepare('DELETE FROM pairing WHERE code_hash=?').run(codeHash);
      db.prepare('INSERT INTO devices VALUES(?,?,?,?)').run(
        deviceId,
        name.trim(),
        hash(token),
        now(),
      );
    });
    return { deviceId, token };
  }

  function list() {
    return db
      .prepare('SELECT id,name,created_at FROM devices')
      .all()
      .map((device) => ({
        ...device,
        connected: delivery.isConnected(device.id),
      }));
  }

  function revoke(id) {
    db.prepare('DELETE FROM devices WHERE id=?').run(id);
    delivery.disconnect(id);
  }

  return { createPairing, pair, list, revoke };
}
