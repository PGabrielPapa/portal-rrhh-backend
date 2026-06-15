import dotenv from 'dotenv';
dotenv.config();

const isProd = process.env.NODE_ENV === 'production';
const rawSecret = process.env.JWT_SECRET || '';
const WEAK_SECRETS = new Set(['', 'dev-secret-change-me', 'secret', 'changeme']);

// P0 — Fail-fast: en producción NO se permite arrancar con un secreto JWT
// ausente, conocido o corto. Un secreto débil permitiría falsificar tokens.
if (isProd && (WEAK_SECRETS.has(rawSecret) || rawSecret.length < 32)) {
  throw new Error(
    '[config] JWT_SECRET ausente o débil. En producción definí un secreto aleatorio de ' +
    '≥32 caracteres. Generalo con: openssl rand -hex 32'
  );
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://portal:portal@localhost:5432/portal_rrhh',
  // En dev se permite un fallback; en prod ya validamos arriba que exista uno fuerte.
  jwtSecret: rawSecret || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
};
