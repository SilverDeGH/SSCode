import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp, SERVER_VERSION } from './app.ts';

const dataDir = process.env.SSCODE_DATA_DIR ?? path.join(os.homedir(), '.sscode');
const port = Number(process.env.SSCODE_PORT ?? 7823);

fs.mkdirSync(dataDir, { recursive: true });
const app = createApp({ dataDir });

app.server.listen(port, '127.0.0.1', () => {
  console.log(`sscode-server v${SERVER_VERSION} listening on http://127.0.0.1:${port}`);
  console.log(`data dir: ${dataDir}`);
  console.log(`auth token (also stored in db kv 'auth_token'): ${app.authToken}`);
});
