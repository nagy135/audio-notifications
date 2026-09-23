import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from './server.js';
const database = process.env.DATABASE_PATH || './data/audio.sqlite';
mkdirSync(dirname(database), { recursive: true });
const app = createServer({ database, token: process.env.API_TOKEN });
app.server.listen(Number(process.env.PORT || 8787), '0.0.0.0', () => console.log('Audio notification server listening'));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
