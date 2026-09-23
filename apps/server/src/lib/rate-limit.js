import { httpError } from './errors.js';

const WINDOW_MS = 60_000;

export function createRateLimiter(now) {
  const limits = new Map();

  function check(key, max) {
    const time = now();
    const entry = limits.get(key);
    if (!entry || entry.until < time) {
      limits.set(key, { count: 1, until: time + WINDOW_MS });
      return;
    }
    if (++entry.count > max) {
      throw httpError(429, 'Too many requests; retry after one minute');
    }
  }

  function prune() {
    for (const [key, entry] of limits) {
      if (entry.until < now()) limits.delete(key);
    }
  }

  return { check, prune };
}
