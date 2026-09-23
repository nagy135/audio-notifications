import { httpError } from '../lib/errors.js';
import { readJson, replyJson } from './json.js';

export function createRequestHandler({
  authorized,
  rateLimiter,
  devices,
  messages,
}) {
  return async (req, res) => {
    const reply = (status, value) => replyJson(res, status, value);
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') {
        return reply(200, { ok: true });
      }

      rateLimiter.check(req.socket.remoteAddress, 180);
      if (req.method === 'POST' && path === '/v1/pair') {
        rateLimiter.check(`pair:${req.socket.remoteAddress}`, 10);
        return reply(201, devices.pair(await readJson(req)));
      }

      if (!authorized(req)) throw httpError(401, 'Unauthorized');
      if (req.method === 'POST' && path === '/v1/pairing') {
        return reply(201, devices.createPairing());
      }
      if (req.method === 'GET' && path === '/v1/devices') {
        return reply(200, { devices: devices.list() });
      }
      if (req.method === 'DELETE' && path.startsWith('/v1/devices/')) {
        devices.revoke(path.slice('/v1/devices/'.length));
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const result = messages.send(
          await readJson(req),
          req.headers['idempotency-key'],
        );
        return reply(result.created ? 202 : 200, result.message);
      }
      if (req.method === 'GET' && path.startsWith('/v1/messages/')) {
        return reply(200, messages.get(path.slice('/v1/messages/'.length)));
      }
      throw httpError(404, 'Not found');
    } catch (error) {
      if (!error.status) console.error(error);
      reply(error.status || 500, {
        error: error.status ? error.message : 'Internal server error',
      });
    }
  };
}
