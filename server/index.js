// 실행: node server/index.js
// 환경 변수: PORT(기본 8790) · HOST(기본 127.0.0.1 — 테일넷 노출은 tailscale serve 가 맡음) · DATA_DIR
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), 'lab', 'paper-organizer-data');

const { server } = createApp({ dataDir: DATA_DIR });
server.listen(PORT, HOST, () => {
  console.log(`[paper-organizer] http://${HOST}:${PORT}  데이터: ${DATA_DIR}`);
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[paper-organizer] ${sig} — 끝냄`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
