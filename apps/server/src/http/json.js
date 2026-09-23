import { httpError } from '../lib/errors.js';

const MAX_BODY_BYTES = 8192;

export async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      throw httpError(413, 'Request too large');
    }
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid JSON object');
    }
    return value;
  } catch {
    throw httpError(400, 'Expected a JSON object');
  }
}

export function replyJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
