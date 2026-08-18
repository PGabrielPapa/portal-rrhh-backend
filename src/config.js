import dotenv from 'dotenv';
dotenv.config();

const isProd = process.env.NODE_ENV === 'production';
const rawSecret = process.env.JWT_SECRET || '';
const WEAK_SECRETS = new Set([
  '', 'dev-secret-change-me', 'secret', 'changeme',
  'cambiar-en-produccion', 'cambiar-este-secreto-en-produccion',
  // Fallback que trae docker-compose.yml (desarrollo): si alguien levanta ese
  // compose con NODE_ENV=production, el arranque tiene que fallar igual.
  'dev-solo-local-no-usar-en-produccion-0000000000',
]);

const fatal = (msg) => { throw new Error(`[config] ${msg}`); };

// ── Arranque seguro en producción ────────────────────────────────────────────
// Estas comprobaciones se hacen al importar el módulo: si algo crítico está mal
// configurado el proceso NO arranca. Es preferible un servicio caído a uno que
// sirve datos personales con un secreto conocido o abierto a cualquier origen.
if (isProd) {
  if (WEAK_SECRETS.has(rawSecret) || rawSecret.length < 32) {
    fatal('JWT_SECRET ausente, conocido o débil. Definí un secreto aleatorio de ≥32 caracteres. Generalo con: openssl rand -hex 32');
  }
  const db = process.env.DATABASE_URL || '';
  if (!db) fatal('DATABASE_URL es obligatoria en producción.');
  if (/:(portal|postgres|password|1234|admin)@/.test(db)) {
    fatal('DATABASE_URL usa una contraseña por defecto. Cambiá la clave de Postgres.');
  }
}

// CORS: en producción hay que declarar los orígenes exactos del portal.
// Un '*' deja que cualquier sitio de internet consulte la API desde el navegador
// de un usuario logueado; además impide usar credenciales, así que nunca es lo
// que se quiere acá.
function resolverCors() {
  const raw = (process.env.CORS_ORIGIN || '').trim();
  if (!raw) {
    if (isProd) fatal('CORS_ORIGIN es obligatoria en producción (lista de orígenes separados por coma).');
    return ['http://localhost:5173'];
  }
  if (raw === '*') {
    if (isProd) fatal('CORS_ORIGIN="*" no está permitido en producción. Indicá los orígenes exactos, p. ej. https://rrhh.tu-dominio.com');
    return '*';
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Coste de bcrypt: 10 quedó corto para hardware actual. 12 es el mínimo razonable
// para hashes que protegen datos de nómina.
const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

export const config = {
  isProd,
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://portal:portal@localhost:5432/portal_rrhh',
  // En dev se permite un fallback; en prod ya validamos arriba que exista uno fuerte.
  jwtSecret: rawSecret || 'dev-secret-change-me',
  // Sesión más corta: un token robado sirve menos tiempo. El front renueva al
  // volver a entrar; 8 h era una jornada entera de exposición.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '2h',
  corsOrigin: resolverCors(),
  bcryptRounds: Number.isFinite(rounds) ? Math.max(12, rounds) : 12,
  // ── Medidas de la auditoría 08/2026 que NO se desplegaron por decisión de
  // negocio. Quedan implementadas y probadas detrás de estos interruptores;
  // activarlas es cambiar la variable de entorno, sin tocar código.
  //
  //  · politicaEstricta: exige 10+ caracteres, 3 familias de caracteres y prohíbe
  //    DNI/legajo/nombre. Apagado ⇒ rige la regla anterior (mínimo 6, sin poder
  //    ser igual al DNI).
  //  · blanqueoAleatorio: el blanqueo administrativo genera una clave temporal
  //    aleatoria en vez de dejarla igual al DNI. Apagado ⇒ la clave queda = DNI.
  password: {
    politicaEstricta: String(process.env.PWD_POLITICA_ESTRICTA || '') === 'true',
    blanqueoAleatorio: String(process.env.BLANQUEO_ALEATORIO || '') === 'true',
    // Mínimo de la regla anterior, vigente cuando politicaEstricta está apagada.
    minSimple: parseInt(process.env.PWD_MIN_SIMPLE || '6', 10),
  },
  // Bloqueo de cuenta tras intentos fallidos (freno a la fuerza bruta dirigida).
  login: {
    maxIntentos: parseInt(process.env.LOGIN_MAX_INTENTOS || '8', 10),
    bloqueoMinutos: parseInt(process.env.LOGIN_BLOQUEO_MIN || '15', 10),
  },
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
