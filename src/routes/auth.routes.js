import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { generarSecret, verificarToken, otpauthURI } from '../lib/totp.js';
import { query } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { limiteCredenciales } from '../middleware/rateLimit.js';
import { validarPasswordSegunConfig } from '../lib/password.js';
import { revocarTokens, olvidarSesion } from '../lib/sesion.js';

const router = Router();

// Hash "señuelo": se compara contra él cuando el DNI no existe, para que el
// tiempo de respuesta sea el mismo exista o no la cuenta. Sin esto, el login
// contestaba mucho más rápido ante un DNI inexistente y permitía enumerar
// qué DNI están dados de alta en el portal.
// Es un hash bcrypt real (coste 12) de una cadena aleatoria que nadie conoce:
// ninguna contraseña coincide con él, pero comparar cuesta lo mismo que comparar
// contra el hash de un usuario real.
const HASH_SENUELO = '$2a$12$vk6gjgCW2w7RPk6H7ZUJWu.9ffWjAG6zf9Gd6NG7eYSo8v/DnYiqG';

// Mensaje único para todo fallo de credenciales: no se distingue "no existe",
// "clave mala" ni "cuenta desactivada". Cualquier diferencia es información
// gratis para quien prueba DNI.
const ERR_CREDENCIALES = 'DNI o contraseña incorrectos';

const ipDe = (req) => String(req.ip || '').slice(0, 60);
const uaDe = (req) => String(req.headers['user-agent'] || '').slice(0, 300);

// Registro de accesos (Ley 25.326 art. 9). Nunca guarda contraseña ni token.
function logLogin({ dni, empleadoId, personaId, exito, motivo, req }) {
  query(
    'INSERT INTO login_audit (dni, empleado_id, persona_id, exito, motivo, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [dni || null, empleadoId || null, personaId || null, !!exito, motivo || null, ipDe(req), uaDe(req)]
  ).catch(() => { /* la auditoría nunca debe romper el login */ });
}

function bloqueada(row) {
  return !!(row?.locked_until && new Date(row.locked_until) > new Date());
}

// Suma un intento fallido y bloquea la cuenta al llegar al tope.
// Frena la fuerza bruta dirigida a UN usuario, que el límite por IP no detiene
// cuando el atacante rota direcciones.
async function sumarFallo(tabla, id) {
  const { maxIntentos, bloqueoMinutos } = config.login;
  await query(
    `UPDATE ${tabla === 'personas' ? 'personas' : 'empleados'}
        SET failed_logins = COALESCE(failed_logins,0) + 1,
            locked_until  = CASE WHEN COALESCE(failed_logins,0) + 1 >= $2
                                 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
      WHERE id = $1`,
    [id, maxIntentos, String(bloqueoMinutos)]
  ).catch(() => {});
}

async function limpiarFallos(tabla, id) {
  await query(
    `UPDATE ${tabla === 'personas' ? 'personas' : 'empleados'} SET failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [id]
  ).catch(() => {});
}

// El token lleva `tv` (token_version): si cambia en la base, todos los tokens
// emitidos antes dejan de valer al instante (ver middleware/auth.js).
function signToken(emp) {
  return jwt.sign(
    { id: emp.id, dni: emp.dni, role: emp.role, empresa_id: emp.empresa_id, tv: Number(emp.token_version || 0) },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}
// Token para una Persona del Comité de HyS (login por DNI sin ser empleado).
function signTokenPersona(per) {
  return jwt.sign(
    { pid: per.id, dni: per.dni, role: 'comite', acceso: per.acceso_comite, tv: Number(per.token_version || 0) },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

// POST /api/auth/login  { dni, password, token? }
router.post('/login', limiteCredenciales, async (req, res, next) => {
  try {
    const { dni, password } = req.body || {};
    if (!dni || !password) return res.status(400).json({ error: 'DNI y contraseña son obligatorios' });
    const dniN = String(dni).trim().slice(0, 20);
    const pwd = String(password).slice(0, 200);

    const { rows } = await query(
      `SELECT e.*, em.nombre AS empresa_nombre
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id
        WHERE e.dni = $1
        ORDER BY (e.password_hash IS NOT NULL) DESC, e.activo DESC, e.id DESC
        LIMIT 1`,
      [dniN]
    );
    const emp = rows[0];

    if (emp && emp.password_hash) {
      if (bloqueada(emp)) {
        logLogin({ dni: dniN, empleadoId: emp.id, exito: false, motivo: 'bloqueado', req });
        return res.status(429).json({ error: `Cuenta bloqueada temporalmente por intentos fallidos. Reintentá en ${config.login.bloqueoMinutos} minutos.` });
      }
      const ok = await bcrypt.compare(pwd, emp.password_hash);
      // Cuenta desactivada o empleado dado de baja: mismo mensaje que credencial
      // errónea, para no confirmarle a un tercero que ese DNI existe en el portal.
      if (!ok || emp.disabled || emp.activo === false) {
        if (!ok) await sumarFallo('empleados', emp.id);
        logLogin({ dni: dniN, empleadoId: emp.id, exito: false, motivo: ok ? 'desactivado' : 'credenciales', req });
        return res.status(401).json({ error: ERR_CREDENCIALES });
      }
      if (emp.totp_enabled) {
        const tok = (req.body || {}).token;
        if (!tok) return res.status(401).json({ error: 'Ingresá el código de tu app de autenticación', need2fa: true });
        if (!verificarToken(emp.totp_secret, tok)) {
          await sumarFallo('empleados', emp.id);
          logLogin({ dni: dniN, empleadoId: emp.id, exito: false, motivo: '2fa', req });
          return res.status(401).json({ error: 'Código de verificación inválido', need2fa: true });
        }
      }
      await limpiarFallos('empleados', emp.id);
      logLogin({ dni: dniN, empleadoId: emp.id, exito: true, motivo: 'ok', req });
      return res.json({
        token: signToken(emp),
        mustChangePassword: emp.must_change_pwd,
        user: { id: emp.id, dni: emp.dni, nom: emp.nom, role: emp.role, empresa: emp.empresa_nombre, comiteHys: !!(emp.data && emp.data.comite_hys), twofa: !!emp.totp_enabled, modulosOcultos: (emp.data && emp.data.modulosOcultos) || [] },
      });
    }

    // Fallback: Persona habilitada al Comité de HyS (no es empleado).
    const per = (await query(
      "SELECT * FROM personas WHERE dni=$1 AND acceso_comite IS NOT NULL AND password_hash IS NOT NULL",
      [dniN])).rows[0];
    if (per) {
      if (bloqueada(per)) {
        logLogin({ dni: dniN, personaId: per.id, exito: false, motivo: 'bloqueado', req });
        return res.status(429).json({ error: `Cuenta bloqueada temporalmente por intentos fallidos. Reintentá en ${config.login.bloqueoMinutos} minutos.` });
      }
      const ok = await bcrypt.compare(pwd, per.password_hash);
      if (!ok || per.disabled) {
        if (!ok) await sumarFallo('personas', per.id);
        logLogin({ dni: dniN, personaId: per.id, exito: false, motivo: ok ? 'desactivado' : 'credenciales', req });
        return res.status(401).json({ error: ERR_CREDENCIALES });
      }
      await limpiarFallos('personas', per.id);
      logLogin({ dni: dniN, personaId: per.id, exito: true, motivo: 'ok', req });
      return res.json({
        token: signTokenPersona(per),
        mustChangePassword: per.must_change_pwd,
        user: { id: null, personaId: per.id, dni: per.dni, nom: per.nom, role: 'comite', acceso: per.acceso_comite },
      });
    }

    // DNI inexistente: se compara igual contra el señuelo para gastar el mismo
    // tiempo que un intento real y no delatar qué cuentas existen.
    await bcrypt.compare(pwd, HASH_SENUELO);
    logLogin({ dni: dniN, exito: false, motivo: 'credenciales', req });
    return res.status(401).json({ error: ERR_CREDENCIALES });
  } catch (e) { next(e); }
});

// POST /api/auth/change-password  { currentPassword, newPassword }   (auth)
router.post('/change-password', limiteCredenciales, requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    // Persona del Comité (login por DNI, sin ser empleado).
    if (req.user.role === 'comite' && req.user.pid) {
      const per = (await query('SELECT * FROM personas WHERE id=$1', [req.user.pid])).rows[0];
      if (!per) return res.status(404).json({ error: 'Usuario no encontrado' });
      const okp = await bcrypt.compare(String(currentPassword || ''), per.password_hash || HASH_SENUELO);
      if (!okp) return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
      const v = validarPasswordSegunConfig(newPassword, { dni: per.dni, cuil: per.cuil, nom: per.nom }, config.password);
      if (!v.ok) return res.status(400).json({ error: v.error });
      if (await bcrypt.compare(String(newPassword), per.password_hash || HASH_SENUELO)) {
        return res.status(400).json({ error: 'La nueva contraseña no puede ser igual a la actual.' });
      }
      const hp = await bcrypt.hash(String(newPassword), config.bcryptRounds);
      await query('UPDATE personas SET password_hash=$1, must_change_pwd=false, pwd_changed_at=now(), failed_logins=0, locked_until=NULL WHERE id=$2', [hp, per.id]);
      // Cambiar la contraseña cierra las demás sesiones: si alguien tenía un token
      // robado, deja de servirle en el acto.
      await revocarTokens({ personaId: per.id });
      return res.json({ ok: true, reingresar: true });
    }

    const { rows } = await query('SELECT * FROM empleados WHERE id = $1', [req.user.id]);
    const emp = rows[0];
    if (!emp) return res.status(404).json({ error: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(String(currentPassword || ''), emp.password_hash || HASH_SENUELO);
    if (!ok) return res.status(401).json({ error: 'La contraseña actual es incorrecta' });

    const v = validarPasswordSegunConfig(newPassword, { dni: emp.dni, cuil: emp.cuil, nom: emp.nom, email: emp.email, legNum: emp.leg_num }, config.password);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (await bcrypt.compare(String(newPassword), emp.password_hash || HASH_SENUELO)) {
      return res.status(400).json({ error: 'La nueva contraseña no puede ser igual a la actual.' });
    }

    const hash = await bcrypt.hash(String(newPassword), config.bcryptRounds);
    await query('UPDATE empleados SET password_hash = $1, must_change_pwd = false, pwd_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $2', [hash, emp.id]);
    await revocarTokens({ empleadoId: emp.id });
    return res.json({ ok: true, reingresar: true });
  } catch (e) { next(e); }
});

// POST /api/auth/logout — cierra la sesión en TODOS los dispositivos.
// Antes no existía: borrar el token del navegador no impedía que una copia
// robada siguiera funcionando hasta vencer.
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await revocarTokens({ empleadoId: req.user.id || null, personaId: req.user.pid || null });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/auth/me   (auth)
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === 'comite' && req.user.pid) {
      const pr = (await query('SELECT id, dni, nom, acceso_comite, must_change_pwd FROM personas WHERE id=$1', [req.user.pid])).rows[0];
      if (!pr) return res.status(404).json({ error: 'Usuario no encontrado' });
      return res.json({ id: null, personaId: pr.id, dni: pr.dni, nom: pr.nom, role: 'comite', acceso: pr.acceso_comite, must_change_pwd: pr.must_change_pwd });
    }
    const { rows } = await query(
      `SELECT e.id, e.dni, e.nom, e.role, e.must_change_pwd, e.data, e.totp_enabled, em.nombre AS empresa
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    const r = rows[0];
    res.json({ id: r.id, dni: r.dni, nom: r.nom, role: r.role, must_change_pwd: r.must_change_pwd, empresa: r.empresa, comiteHys: !!(r.data && r.data.comite_hys), twofa: !!r.totp_enabled, modulosOcultos: (r.data && r.data.modulosOcultos) || [] });
  } catch (e) { next(e); }
});

// ── 2FA (TOTP) ──
// El alta, la activación y la baja funcionan igual que antes de la auditoría: no
// piden confirmar la contraseña actual. La auditoría de 08/2026 lo recomendó (con
// solo un token robado se puede desactivar el segundo factor de la víctima), pero
// se decidió NO cambiar el flujo de 2FA. Sí se les aplica el límite de intentos.
router.post('/2fa/setup', limiteCredenciales, requireAuth, async (req, res, next) => {
  try {
    if (!req.user.id) return res.status(400).json({ error: '2FA no disponible para este tipo de usuario' });
    const r = (await query('SELECT dni FROM empleados WHERE id=$1', [req.user.id])).rows[0];
    const secret = generarSecret();
    await query('UPDATE empleados SET totp_secret=$1, totp_enabled=false WHERE id=$2', [secret, req.user.id]);
    res.json({ secret, otpauth: otpauthURI(secret, r?.dni || String(req.user.id)) });
  } catch (e) { next(e); }
});

router.post('/2fa/activate', limiteCredenciales, requireAuth, async (req, res, next) => {
  try {
    if (!req.user.id) return res.status(400).json({ error: 'No disponible' });
    const r = (await query('SELECT totp_secret FROM empleados WHERE id=$1', [req.user.id])).rows[0];
    if (!r?.totp_secret) return res.status(400).json({ error: 'Primero generá el secreto (setup)' });
    if (!verificarToken(r.totp_secret, (req.body || {}).token)) return res.status(400).json({ error: 'Código inválido' });
    await query('UPDATE empleados SET totp_enabled=true WHERE id=$1', [req.user.id]);
    olvidarSesion({ empleadoId: req.user.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/2fa/disable', limiteCredenciales, requireAuth, async (req, res, next) => {
  try {
    if (!req.user.id) return res.status(400).json({ error: 'No disponible' });
    const r = (await query('SELECT totp_secret, totp_enabled FROM empleados WHERE id=$1', [req.user.id])).rows[0];
    if (r?.totp_enabled && !verificarToken(r.totp_secret, (req.body || {}).token)) return res.status(400).json({ error: 'Código inválido' });
    await query('UPDATE empleados SET totp_secret=NULL, totp_enabled=false WHERE id=$1', [req.user.id]);
    olvidarSesion({ empleadoId: req.user.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/2fa/estado', requireAuth, async (req, res, next) => {
  try { if (!req.user.id) return res.json({ enabled: false }); const r = (await query('SELECT totp_enabled FROM empleados WHERE id=$1', [req.user.id])).rows[0]; res.json({ enabled: !!r?.totp_enabled }); }
  catch (e) { next(e); }
});

export default router;
