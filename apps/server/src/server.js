import http from 'node:http';
import { createRequestHandler } from './http/handler.js';
import { createAuthorization } from './lib/auth.js';
import { createRateLimiter } from './lib/rate-limit.js';
import { createDeliveryService } from './realtime/delivery.js';
import { createDeviceService } from './services/devices.js';
import { createMessageService } from './services/messages.js';
import { createSpeechService } from './services/speech.js';
import { openDatabase, pruneDatabase } from './storage/database.js';

const HEARTBEAT_INTERVAL_MS = 25_000;

export function createServer({
  database = ':memory:',
  token,
  now = Date.now,
  kokoroUrl = '',
  speechTimeoutMs = 15_000,
} = {}) {
  const authorized = createAuthorization(token);
  const db = openDatabase(database);
  const rateLimiter = createRateLimiter(now);
  const delivery = createDeliveryService({ db, now, rateLimiter });
  const devices = createDeviceService({ db, now, delivery });
  const messages = createMessageService({ db, now, delivery });
  const speech = createSpeechService({
    db,
    now,
    url: kokoroUrl,
    timeoutMs: speechTimeoutMs,
  });
  const server = http.createServer(
    createRequestHandler({
      authorized,
      rateLimiter,
      devices,
      messages,
      speech,
    }),
  );
  server.on('upgrade', delivery.upgrade);

  const heartbeat = setInterval(() => {
    delivery.heartbeat();
    rateLimiter.prune();
    pruneDatabase(db, now);
    delivery.pumpAll();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  async function close() {
    clearInterval(heartbeat);
    speech.close();
    await delivery.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { server, db, close };
}
