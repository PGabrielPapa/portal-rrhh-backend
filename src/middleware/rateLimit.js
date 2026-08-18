// Límites de tasa.
//
// Antes solo el login estaba limitado: el resto de la API (listados completos de
// nómina, exportaciones, reportes, IA) se podía llamar sin freno. Con una sola
// credencial válida se podía aspirar toda la base de datos personales en minutos,
// o tumbar el servicio con pedidos pesados en paralelo.
//
// El limitador se aplica por usuario autenticado cuando lo hay, y por IP si no.
import rateLimit from 'express-rate-limit';

// Identidad para contar: el usuario si está autenticado, la IP si no.
// (Usar solo la IP castigaría a toda una oficina detrás de un mismo NAT.)
const porUsuarioOIp = (req) => {
  const u = req.user;
  if (u && (u.id || u.pid)) return `u:${u.pid ? 'p' + u.pid : 'e' + u.id}`;
  return `ip:${req.ip}`;
};

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: porUsuarioOIp,
};

const mensaje = (txt) => (req, res) => res.status(429).json({ error: txt });

// General: techo amplio, pensado para no molestar el uso normal del portal
// (una pantalla puede disparar 10-20 llamadas) y sí cortar el scraping automatizado.
export const limiteGeneral = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_GENERAL || 300),
  handler: mensaje('Demasiados pedidos. Esperá un momento y volvé a intentar.'),
});

// Credenciales: login, cambio de contraseña, 2FA. Por IP siempre (todavía no hay usuario).
export const limiteCredenciales = rateLimit({
  ...base,
  keyGenerator: (req) => `ip:${req.ip}`,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LOGIN || 15),
  skipSuccessfulRequests: false,
  handler: mensaje('Demasiados intentos. Esperá unos minutos y volvé a probar.'),
});

// Operaciones costosas: exportaciones, reportes masivos, liquidaciones, importaciones.
export const limitePesado = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_PESADO || 30),
  handler: mensaje('Demasiadas operaciones pesadas seguidas. Esperá un minuto.'),
});

// IA: cada llamada cuesta dinero real al proveedor. Techo bajo por usuario.
export const limiteIA = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RATE_IA || 40),
  handler: mensaje('Alcanzaste el límite de consultas de IA por hora.'),
});

// Envío de mails: evita usar el portal como plataforma de spam.
export const limiteMail = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RATE_MAIL || 20),
  handler: mensaje('Alcanzaste el límite de envíos de correo por hora.'),
});
