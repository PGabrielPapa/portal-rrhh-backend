import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';

const router = Router();

// P0 — Freno a la fuerza bruta: límite de intentos por IP en endpoints de credenciales.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 20,                // 20 intentos por ventana por IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Esperá unos minutos y volvé a probar.' },
});

function signToken(emp) {
  return jwt.sign(
    { id: emp.id, dni: emp.dni, role: emp.role, empresa_id: emp.empresa_id },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

// POST /api/auth/login  { dni, password }
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { dni, password } = req.body || {};
    if (!dni || !password) return res.status(400).json({ error: 'DNI y contraseña son obligatorios' });

    const { rows } = await query(
      `SELECT e.*, em.nombre AS empresa_nombre
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id
        WHERE e.dni = $1`,
      [String(dni).trim()]
    );
    const emp = rows[0];
    // Respuesta genérica para no filtrar si el DNI existe.
    if (!emp || !emp.password_hash) return res.status(401).json({ error: 'DNI o contraseña incorrectos' });
    if (emp.disabled) return res.status(403).json({ error: 'Usuario desactivado. Contactá al administrador.' });

    const ok = await bcrypt.compare(String(password), emp.password_hash);
    if (!ok) return res.status(401).json({ error: 'DNI o contraseña incorrectos' });

    return res.json({
      token: signToken(emp),
      mustChangePassword: emp.must_change_pwd,
      user: { id: emp.id, dni: emp.dni, nom: emp.nom, role: emp.role, empresa: emp.empresa_nombre },
    });
  } catch (e) { next(e); }
});

// POST /api/auth/change-password  { currentPassword, newPassword }   (auth)
router.post('/change-password', loginLimiter, requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6)
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });

    const { rows } = await query('SELECT * FROM empleados WHERE id = $1', [req.user.id]);
    const emp = rows[0];
    if (!emp) return res.status(404).json({ error: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(String(currentPassword || ''), emp.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
    if (String(newPassword) === String(emp.dni))
      return res.status(400).json({ error: 'La nueva contraseña no puede ser igual al DNI' });

    const hash = await bcrypt.hash(String(newPassword), config.bcryptRounds);
    await query('UPDATE empleados SET password_hash = $1, must_change_pwd = false WHERE id = $2', [hash, emp.id]);
    return res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/auth/me   (auth)
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.dni, e.nom, e.role, e.must_change_pwd, em.nombre AS empresa
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

export default router;
