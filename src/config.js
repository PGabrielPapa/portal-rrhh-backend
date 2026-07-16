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
  // Integración Pro-Soft (Gestión de Personal). Credenciales SIEMPRE por env.
  prosoft: {
    base: process.env.PROSOFT_BASE || 'https://apild.azurewebsites.net/api',
    user: process.env.PROSOFT_USER || '',
    pass: process.env.PROSOFT_PASS || '',
    // 'true' habilita la importación automática diaria del mes en curso.
    auto: String(process.env.PROSOFT_AUTO || '') === 'true',
    // Hora local (0-23) en que corre la tarea diaria.
    autoHora: parseInt(process.env.PROSOFT_AUTO_HORA || '6', 10),
  },
  // Envío de mails (SMTP). Si no se configura host, el envío queda deshabilitado.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || '') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },
  // Asistencia por IA (opcional). Si no se define IA_API_KEY, las funciones de IA
  // quedan deshabilitadas y el resto del portal funciona igual.
  ia: {
    provider: process.env.IA_PROVIDER || 'anthropic',   // anthropic | openai
    apiKey: process.env.IA_API_KEY || '',
    model: process.env.IA_MODEL || '',                  // si vacío, se usa un default por proveedor
    baseUrl: process.env.IA_BASE_URL || '',             // opcional, para gateways/compatibles
    maxTokens: parseInt(process.env.IA_MAX_TOKENS || '1200', 10),
  },
};
