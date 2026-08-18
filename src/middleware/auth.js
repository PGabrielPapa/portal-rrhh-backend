import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { estadoDeSesion } from '../lib/sesion.js';

// Rutas que un usuario con "cambio de contraseña obligatorio" sí puede usar.
// Todo lo demás le queda bloqueado hasta que la cambie: antes el blanqueo entregaba
// un token plenamente funcional y el aviso de cambiarla era solo cosmético.
const PERMITIDO_SIN_CAMBIAR_PWD = [
  /^\/api\/auth\/change-password$/,
  /^\/api\/auth\/me$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/2fa\//,
];

/**
 * Verifica el JWT del header `Authorization: Bearer <token>` y lo contrasta con
 * el estado real del usuario en la base (rol, alta/baja, versión de token).
 * El rol efectivo SIEMPRE sale de la base, nunca del token: así una degradación
 * de permisos tiene efecto inmediato y no espera al vencimiento del token.
 */
export async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  try {
    const est = await estadoDeSesion(payload);
    if (!est) return res.status(401).json({ error: 'Sesión inválida. Volvé a ingresar.' });
    if (est.disabled) return res.status(401).json({ error: 'Usuario desactivado. Contactá al administrador.' });
    if (est.tipo === 'empleado' && !est.activo) return res.status(401).json({ error: 'Sesión inválida. Volvé a ingresar.' });
    if (Number(payload.tv || 0) !== est.tokenVersion) {
      return res.status(401).json({ error: 'La sesión caducó por un cambio de seguridad. Volvé a ingresar.' });
    }

    req.user = {
      id: est.id,
      pid: est.pid,
      dni: est.dni,
      // `nom` nunca venía en el token (quedaba undefined): la traza de aprobaciones
      // guardaba el DNI en vez del nombre. Ahora sale de la base.
      nom: est.nom,
      role: est.role,                 // rol EFECTIVO (de la base, no del token)
      empresa_id: est.empresa_id,
      acceso: est.acceso,
      mustChangePwd: est.mustChangePwd,
    };

    if (est.mustChangePwd) {
      const ruta = String(req.originalUrl || '').split('?')[0];
      if (!PERMITIDO_SIN_CAMBIAR_PWD.some((re) => re.test(ruta))) {
        return res.status(403).json({ error: 'Tenés que cambiar tu contraseña antes de seguir usando el portal.', mustChangePassword: true });
      }
    }
    next();
  } catch (e) { next(e); }
}

// Restringe a ciertos roles (p. ej. requireRole('rrhh','admin')).
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No tenés permisos para esta acción' });
    }
    next();
  };
}
