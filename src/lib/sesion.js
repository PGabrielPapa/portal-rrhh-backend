// Estado vivo de la sesión.
//
// El JWT es autocontenido y dura 8 h: por sí solo NO sabe si, después de emitirse,
// al usuario lo desactivaron, le bajaron el rol o le blanquearon la contraseña.
// Antes eso significaba que un empleado dado de baja (o un token robado) seguía
// operando hasta 8 h. Acá se contrasta cada pedido contra la fila real del usuario:
//
//   - `disabled`      → la cuenta quedó inhabilitada          → 401
//   - `activo=false`  → el empleado fue dado de baja          → 401
//   - `token_version` → cambió la contraseña/el rol/se cerró  → 401 (token viejo)
//   - `role`          → el rol del token quedó desactualizado → se usa el de la BD
//
// Para no pagar una consulta por request, el resultado se cachea unos segundos.
// La ventana de caché es el retardo máximo con el que se aplica una revocación.
import { query } from '../db.js';

const TTL_MS = Number(process.env.SESION_CACHE_MS || 15_000);
const cache = new Map(); // clave -> { exp, estado }

function clave(u) {
  return u.pid ? `p:${u.pid}` : `e:${u.id}`;
}

async function leerEstado(u) {
  if (u.pid) {
    const r = (await query(
      'SELECT id, dni, nom, disabled, must_change_pwd, token_version, acceso_comite FROM personas WHERE id=$1',
      [u.pid])).rows[0];
    if (!r) return null;
    return {
      tipo: 'persona',
      id: null, pid: r.id, dni: r.dni, nom: r.nom,
      role: 'comite',
      acceso: r.acceso_comite,
      disabled: !!r.disabled,
      activo: true,
      mustChangePwd: !!r.must_change_pwd,
      tokenVersion: Number(r.token_version || 0),
    };
  }
  const r = (await query(
    'SELECT id, dni, nom, role, empresa_id, activo, disabled, must_change_pwd, token_version FROM empleados WHERE id=$1',
    [u.id])).rows[0];
  if (!r) return null;
  return {
    tipo: 'empleado',
    id: r.id, pid: null, dni: r.dni, nom: r.nom,
    role: r.role,
    empresa_id: r.empresa_id,
    disabled: !!r.disabled,
    activo: !!r.activo,
    mustChangePwd: !!r.must_change_pwd,
    tokenVersion: Number(r.token_version || 0),
  };
}

// Estado del usuario del token, con caché corta. Devuelve null si ya no existe.
export async function estadoDeSesion(u) {
  if (!u || (!u.id && !u.pid)) return null;
  const k = clave(u);
  const hit = cache.get(k);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.estado;
  const estado = await leerEstado(u);
  cache.set(k, { exp: now + TTL_MS, estado });
  return estado;
}

// Invalida la caché de un usuario (tras cambiarle rol, estado o contraseña).
export function olvidarSesion({ empleadoId, personaId } = {}) {
  if (empleadoId) cache.delete(`e:${empleadoId}`);
  if (personaId) cache.delete(`p:${personaId}`);
}

/**
 * Incrementa token_version → invalida TODOS los JWT ya emitidos de ese usuario.
 * Se llama al cambiar la contraseña, cambiar el rol, desactivar la cuenta o
 * cerrar sesión en todos los dispositivos.
 */
export async function revocarTokens({ empleadoId, personaId } = {}) {
  try {
    if (empleadoId) await query('UPDATE empleados SET token_version = COALESCE(token_version,0) + 1 WHERE id=$1', [empleadoId]);
    if (personaId) await query('UPDATE personas SET token_version = COALESCE(token_version,0) + 1 WHERE id=$1', [personaId]);
  } finally {
    olvidarSesion({ empleadoId, personaId });
  }
}

// Limpieza periódica de entradas vencidas (evita que el Map crezca sin fin).
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
}, 60_000).unref();
