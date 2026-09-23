import { hash } from '../lib/auth.js';
import { httpError } from '../lib/errors.js';
import voices from './kokoro-voices.json' with { type: 'json' };

export const PREVIEW_TEXT =
  'Audio notifications are ready. You can lock your phone and I will keep listening.';
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_TTL_MS = 120_000;

export function createSpeechService({ db, now, url = '', timeoutMs = 15_000 }) {
  const cache = new Map();
  const pending = new Map();
  const controllers = new Set();
  let cacheBytes = 0;

  function authorize(req) {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const device = db
      .prepare('SELECT id FROM devices WHERE token_hash=?')
      .get(hash(bearer));
    if (!device) throw httpError(401, 'Unauthorized');
    return device.id;
  }

  function source(deviceId, { messageId, preview }) {
    if (preview === true && messageId === undefined) return PREVIEW_TEXT;
    if (preview !== undefined && preview !== false) {
      throw httpError(400, 'Invalid preview request');
    }
    if (typeof messageId !== 'string') {
      throw httpError(400, 'messageId is required');
    }
    const message = db
      .prepare(
        `
      SELECT m.text,m.expires_at,d.status FROM messages m
      JOIN deliveries d ON d.message_id=m.id
      WHERE m.id=? AND d.device_id=?
    `,
      )
      .get(messageId, deviceId);
    if (!message) throw httpError(404, 'Message not found');
    if (message.expires_at <= now() || message.status !== 'queued') {
      throw httpError(410, 'Message is no longer queued or has expired');
    }
    return message.text;
  }

  async function request(path, options = {}, timeout = timeoutMs) {
    if (!url) throw httpError(503, 'Kokoro is not configured');
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(new URL(path, url), {
        ...options,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw httpError(503, 'Kokoro is unavailable or busy');
      // Consume under the same deadline; a stalled body must also fall back.
      if (path === '/health') {
        await response.body?.cancel();
        return true;
      }
      if (!response.headers.get('content-type')?.startsWith('audio/wav')) {
        await response.body?.cancel();
        throw httpError(502, 'Kokoro returned invalid audio');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_AUDIO_BYTES) {
          controller.abort();
          throw httpError(502, 'Kokoro audio is too large');
        }
        chunks.push(chunk);
      }
      const audio = Buffer.concat(chunks);
      if (
        audio.length < 44 ||
        audio.toString('ascii', 0, 4) !== 'RIFF' ||
        audio.toString('ascii', 8, 12) !== 'WAVE'
      ) {
        throw httpError(502, 'Kokoro returned invalid audio');
      }
      return audio;
    } catch (error) {
      if (error.status) throw error;
      throw httpError(503, 'Kokoro timed out or is unavailable');
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function catalogue() {
    const available = await request('/health', {}, 1500).catch(() => false);
    return { enabled: !!url, available, defaultVoice: 'af_heart', voices };
  }

  function evict(key) {
    cacheBytes -= cache.get(key).audio.length;
    cache.delete(key);
  }

  async function synthesize(text, voice) {
    for (const [key, entry] of cache) if (entry.expires <= now()) evict(key);
    const key = hash(JSON.stringify([text, voice]));
    if (cache.has(key)) return cache.get(key).audio;
    if (pending.has(key)) return pending.get(key);
    // One CPU job at a time. Duplicate requests share it; others fall back.
    if (pending.size) throw httpError(503, 'Kokoro is busy');
    const job = request('/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    })
      .then((audio) => {
        while (cacheBytes + audio.length > MAX_CACHE_BYTES) {
          evict(cache.keys().next().value);
        }
        cache.set(key, { audio, expires: now() + CACHE_TTL_MS });
        cacheBytes += audio.length;
        return audio;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  async function render(req, payload) {
    const deviceId = authorize(req);
    const voice = payload.voice ?? 'af_heart';
    if (!voices.some((item) => item.id === voice)) {
      throw httpError(400, 'Unknown Kokoro voice');
    }
    const text = source(deviceId, payload);
    const audio = await synthesize(text, voice);
    // Re-check expiry and revocation after a potentially slow synthesis.
    authorize(req);
    source(deviceId, payload);
    return audio;
  }

  function close() {
    for (const controller of controllers) controller.abort();
    cache.clear();
    cacheBytes = 0;
  }

  return { authorize, catalogue, render, close };
}
