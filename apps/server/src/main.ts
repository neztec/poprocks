import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { DEFAULT_PORT, TICK_HZ, type ClientMsg } from '@poprock/shared';
import { createApi } from './api';
import { Store } from './db';
import { EventScheduler } from './events';
import { Game, type Player } from './game';

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const dbPath = process.env.POPROCK_DB ?? new URL('../poprock.db', import.meta.url).pathname;

const store = new Store(dbPath);
const game = new Game(store);
const events = new EventScheduler(store, game);
const api = createApi(store, game, events);

const http = createServer(async (req, res) => {
  if (await api(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('poprock server — connect a client to /ws, admin API under /api');
});

const wss = new WebSocketServer({ server: http, path: '/ws' });
wss.on('connection', (ws) => {
  let player: Player | null = null;
  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }
    if (!player) {
      if (msg.t === 'hello') player = game.connect(ws, String(msg.name ?? ''));
      return;
    }
    game.handle(player, msg);
  });
  ws.on('close', () => {
    if (player) game.disconnect(player);
  });
});

// Fixed-rate tick with drift correction.
const tickMs = 1000 / TICK_HZ;
let next = performance.now();
function loop() {
  const now = performance.now();
  let steps = 0;
  while (now >= next && steps < 5) {
    game.step();
    next += tickMs;
    steps++;
  }
  if (now - next > tickMs * 5) next = now; // fell far behind, don't spiral
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();

setInterval(() => events.poll(), 1000);
setInterval(() => game.save(), 10_000);

function shutdown() {
  console.log('saving...');
  game.save();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

http.listen(port, () => {
  console.log(`poprock server on http://localhost:${port}  (db: ${dbPath})`);
});
