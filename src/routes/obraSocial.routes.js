// src/routes/obraSocial.routes.js
// Cambios de obra social del empleado, con histórico (mismo patrón que cambios_domicilio).
// - Empleado: solicita el cambio desde "Mis Datos" (queda pendiente).
// - RR.HH./Admin: aprueba/rechaza; al aprobar impacta empleado.data y queda en el histórico.
// - RR.HH./Admin (ABM): puede aplicar el cambio directo (origen 'rrhh'), también con histórico.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['rrhh', 'admin'].includes(r);
const sicossDe = (codigo) => String(codigo || '').replace(/\D/g, '').slice(-6).padStart(6, '0');

// Aplica el cambio sobre empleado.data (código SICOSS + RNOS + nombre).
async function aplicarEnEmpleado(empleadoId, osCodigo, osNombre) {
  await query(
    `UPDATE empleados SET data = data || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ codigoObraSocial: sicossDe(osCodigo), os_codigo: osCodigo, os_nombre: osNombre }), empleadoId]);
}

// Histórico propio (empleado)
router.get('/mias', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM cambios_obra_social WHERE empleado_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Listado: empleado ve el propio; RR.HH./Admin ve todos (con filtros estado/q).
router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) {
      const { rows } = await query('SELECT * FROM cambios_obra_social WHERE empleado_id=$1 ORDER BY created_at DESC', [req.user.id]);
      return res.json(rows);
    }
    const { estado, q } = req.query; const cond = [], params = [];
    if (estado) { params.push(estado); cond.push(`c.estado=$${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT c.*, e.nom, e.leg_num, em.nombre AS empresa
         FROM cambios_obra_social c JOIN empleados e ON e.id=c.empleado_id JOIN empresas em ON em.id=e.empresa_id
         ${where} ORDER BY COALESCE(c.resuelto_at, c.created_at) DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Empleado solicita el cambio (queda pendiente de aprobación de RR.HH.)
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.os_codigo || !b.os_nombre) return res.status(400).json({ error: 'Elegí una obra social' });
    const er = await query('SELECT data FROM empleados WHERE id=$1', [req.user.id]);
    const d = er.rows[0]?.data || {};
    const r = await query(
      `INSERT INTO cambios_obra_social (empleado_id, os_codigo, os_nombre, os_anterior_codigo, os_anterior_nombre, origen)
       VALUES ($1,$2,$3,$4,$5,'empleado') RETURNING *`,
      [req.user.id, b.os_codigo, b.os_nombre, d.os_codigo || null, d.os_nombre || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// RR.HH./Admin: aprobar / rechazar una solicitud pendiente
router.patch('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const estado = (req.body || {}).estado;
    if (!['aprobado', 'rechazado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const cr = await query(
      `UPDATE cambios_obra_social SET estado=$1, resuelto_por=$2, resuelto_at=now() WHERE id=$3 AND estado='pendiente' RETURNING *`,
      [estado, req.user.dni, req.params.id]);
    const c = cr.rows[0];
    if (!c) return res.status(409).json({ error: 'No existe o ya fue resuelto' });
    if (estado === 'aprobado') await aplicarEnEmpleado(c.empleado_id, c.os_codigo, c.os_nombre);
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

// RR.HH./Admin (ABM): aplicar cambio directo a un empleado (genera histórico aprobado).
router.post('/aplicar/:empleadoId', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.os_codigo || !b.os_nombre) return res.status(400).json({ error: 'Elegí una obra social' });
    const er = await query('SELECT data FROM empleados WHERE id=$1', [req.params.empleadoId]);
    if (!er.rowCount) return res.status(404).json({ error: 'Empleado inexistente' });
    const d = er.rows[0].data || {};
    // No duplica histórico si no cambió.
    if (d.os_codigo === b.os_codigo) return res.json({ ok: true, sinCambios: true });
    const r = await query(
      `INSERT INTO cambios_obra_social (empleado_id, os_codigo, os_nombre, os_anterior_codigo, os_anterior_nombre, origen, estado, resuelto_por, resuelto_at)
       VALUES ($1,$2,$3,$4,$5,'rrhh','aprobado',$6,now()) RETURNING *`,
      [req.params.empleadoId, b.os_codigo, b.os_nombre, d.os_codigo || null, d.os_nombre || null, req.user.dni]);
    await aplicarEnEmpleado(req.params.empleadoId, b.os_codigo, b.os_nombre);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// Histórico de un empleado (RR.HH./Admin, para el ABM)
router.get('/empleado/:empleadoId', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM cambios_obra_social WHERE empleado_id=$1 ORDER BY created_at DESC', [req.params.empleadoId]);
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
