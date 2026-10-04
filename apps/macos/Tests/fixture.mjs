import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { createServer } from '../../server/src/server.js';

let mode = 'unavailable';
let offset = 0;
const token = 'local-test-producer-token-32-characters';
const wav = Buffer.alloc(1644);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(1600, 40);
const worker = http.createServer((req, res) => {
  req.resume();
  if (mode === 'unavailable') { res.writeHead(503); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'audio/wav' });
  res.end(mode === 'invalid' ? Buffer.from('invalid audio') : wav);
});
await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
const app = createServer({ token, now: () => Date.now() + offset,
  kokoroUrl: `http://127.0.0.1:${worker.address().port}` });
const sockets = new Set();
app.server.on('connection', (socket) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
});
const originalHandler = app.server.listeners('request')[0];
app.server.removeAllListeners('request');
app.server.on('request', async (req, res) => {
  if (!req.url.startsWith('/test/')) { originalHandler(req, res); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  if (req.url === '/test/mode') mode = body.mode;
  if (req.url === '/test/clock') offset = body.offset;
  if (req.url === '/test/requeue') {
    app.db.prepare("UPDATE deliveries SET status='queued' WHERE message_id=? AND device_id=?")
      .run(body.id, body.deviceId);
  }
  res.setHeader('Content-Type', 'application/json');
  res.end('{}');
  if (req.url === '/test/drop') setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 30);
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
writeFileSync(process.argv[2], JSON.stringify({ url: `http://127.0.0.1:${app.server.address().port}`, token }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  await app.close(); worker.close(); process.exit(0);
});
