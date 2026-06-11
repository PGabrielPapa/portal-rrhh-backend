import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[api] Portal RR.HH. escuchando en :${config.port}`);
});

// Apagado prolijo
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[api] ${sig} recibido, cerrando…`);
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
