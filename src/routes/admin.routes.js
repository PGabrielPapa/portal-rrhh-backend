import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { empSlug } from '../lib/identity.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const ROLES = ['employee', 'manager', 'rrhh', 'admin'];
async function audit(actor, accion, detalle, target) {
  try { await query('INSERT INTO audit_log (actor_dni, accion, detalle, target) VALUES ($1,$2,$3,$4)', [actor, accion, detalle || null, target || null]); } catch { /* noop */ }
}

// GET /api/admin/usuarios?q=&empresa=&role=
router.get('/usuarios', async (req, res, next) => {
  try {
    const { q, empresa, role } = req.query; const cond = [], params = [];
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (role) { params.push(role); cond.push(`e.role = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i} OR e.dni LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT e.id, e.leg_num, e.dni, e.nom, e.role, e.disabled, e.must_change_pwd, em.nombre AS empresa
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id ${where} ORDER BY e.nom`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// PATCH /api/admin/usuarios/:id  { role?, disabled? }
router.patch('/usuarios/:id', async (req, res, next) => {
  try {
    const { role, disabled } = req.body || {};
    const id = Number(req.params.id);
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
      if (id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'No podés quitarte el rol admin a vos mismo' });
      await query('UPDATE empleados SET role = $1 WHERE id = $2', [role, id]);
      await audit(req.user.dni, 'cambio_rol', `rol → ${role}`, String(id));
    }
    if (disabled !== undefined) {
      if (id === req.user.id && disabled) return res.status(400).json({ error: 'No podés desactivarte a vos mismo' });
      await query('UPDATE empleados SET disabled = $1 WHERE id = $2', [!!disabled, id]);
      await audit(req.user.dni, disabled ? 'usuario_desactivado' : 'usuario_activado', null, String(id));
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/admin/usuarios/:id/blanquear — resetea la clave al DNI (cambio forzado)
router.post('/usuarios/:id/blanquear', async (req, res, next) => {
  try {
    const r = await query('SELECT dni FROM empleados WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    const hash = await bcrypt.hash(String(r.rows[0].dni), config.bcryptRounds);
    await query('UPDATE empleados SET password_hash = $1, must_change_pwd = true WHERE id = $2', [hash, req.params.id]);
    await audit(req.user.dni, 'blanqueo_password', 'clave reseteada al DNI', String(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/admin/auditoria?q=
router.get('/auditoria', async (req, res, next) => {
  try {
    const { q } = req.query; const cond = [], params = [];
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(accion) LIKE $${i} OR lower(coalesce(detalle,'')) LIKE $${i} OR actor_dni LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/admin/empresas — listado de empresas (con logo y datos)
router.get('/empresas', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, nombre, slug, cuit, logo, firma, data FROM empresas ORDER BY nombre');
    res.json(rows);
  } catch (e) { next(e); }
});

// PATCH /api/admin/empresas/:id  { cuit?, data?, logo? }
router.patch('/empresas/:id', async (req, res, next) => {
  try {
    const { cuit, data, logo } = req.body || {};
    const sets = [], params = [];
    if (cuit !== undefined) { params.push(cuit); sets.push(`cuit = $${params.length}`); }
    if (data !== undefined) { params.push(JSON.stringify(data)); sets.push(`data = $${params.length}`); }
    if (logo !== undefined) { params.push(logo || null); sets.push(`logo = $${params.length}`); }
    if (req.body.firma !== undefined) { params.push(req.body.firma || null); sets.push(`firma = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(req.params.id);
    await query(`UPDATE empresas SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    await audit(req.user.dni, 'empresa_editada', cuit ? `CUIT: ${cuit}` : (logo !== undefined ? 'logo actualizado' : 'datos'), String(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/admin/empresas — alta de empresa
router.post('/empresas', async (req, res, next) => {
  try {
    const { nombre, cuit, data, logo, firma } = req.body || {};
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query(
      'INSERT INTO empresas (nombre, slug, cuit, data, logo, firma) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(nombre).trim(), empSlug(nombre), cuit || null, JSON.stringify(data || {}), logo || null, firma || null]);
    await audit(req.user.dni, 'empresa_alta', String(nombre), String(r.rows[0].id));
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una empresa con ese nombre' }); next(e); }
});

// DELETE /api/admin/empresas/:id — eliminar (solo si no tiene empleados)
router.delete('/empresas/:id', async (req, res, next) => {
  try {
    const c = await query('SELECT count(*)::int AS n FROM empleados WHERE empresa_id = $1', [req.params.id]);
    if (c.rows[0].n > 0) return res.status(409).json({ error: `No se puede eliminar: la empresa tiene ${c.rows[0].n} empleado(s). Reasignalos o dalos de baja primero.` });
    const r = await query('DELETE FROM empresas WHERE id = $1 RETURNING nombre', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Empresa no encontrada' });
    await audit(req.user.dni, 'empresa_baja', r.rows[0].nombre, String(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
