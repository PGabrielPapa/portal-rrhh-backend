import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Aplica el esquema (idempotente) en cada arranque, así un cambio de schema
// se refleja también con la recarga del modo dev (node --watch).
try {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[boot] esquema verificado ✓');
} catch (e) {
  console.error('[boot] error aplicando el esquema:', e.message);
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[api] Portal RR.HH. escuchando en :${config.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[api] ${sig} recibido, cerrando…`);
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
