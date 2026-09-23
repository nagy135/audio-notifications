import { createHash, timingSafeEqual } from 'node:crypto';

export function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createAuthorization(token) {
  if (!token || token.length < 32) {
    throw new Error('API_TOKEN must contain at least 32 characters');
  }

  const expected = Buffer.from(hash(`Bearer ${token}`));
  return (req) => {
    const given = Buffer.from(hash(req.headers.authorization || ''));
    return timingSafeEqual(given, expected);
  };
}
