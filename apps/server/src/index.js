import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from './server.js';
import { logEvent } from './lib/logger.js';
const database = process.env.DATABASE_PATH || './data/audio.sqlite';
mkdirSync(dirname(database), { recursive: true });
const app = createServer({
  database,
  token: process.env.API_TOKEN,
  kokoroUrl: process.env.KOKORO_URL || '',
});
app.server.listen(Number(process.env.PORT || 8787), '0.0.0.0', () =>
  logEvent('server_listening', { port: app.server.address().port }),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
