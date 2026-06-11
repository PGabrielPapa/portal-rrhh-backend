import pg from 'pg';
import { config } from './config.js';

// Pool de conexiones a Postgres. Reutilizado en toda la app.
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  console.error('[db] error inesperado en cliente idle:', err);
});

// Helper: query con parámetros (siempre parametrizado → evita SQL injection).
export const query = (text, params) => pool.query(text, params);
