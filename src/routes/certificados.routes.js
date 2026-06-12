import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { makeUid } from '../lib/identity.js';

const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['rrhh', 'admin'].includes(r);

// Solicitudes propias
router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM certificados WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

// Gestión (rrhh/admin): todas con filtros
router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) { const { rows } = await query('SELECT * FROM certificados WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]); return res.json(rows); }
    const { estado, q, empresa } = req.query; const cond = [], params = [];
    if (estado) { params.push(estado); cond.push(`c.estado = $${params.length}`); }
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT c.*, e.nom, e.leg_num, em.nombre AS empresa FROM certificados c
         JOIN empleados e ON e.id = c.empleado_id JOIN empresas em ON em.id = e.empresa_id
         ${where} ORDER BY (c.estado='pendiente') DESC, c.created_at DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Solicitar (empleado)
router.post('/', async (req, res, next) => {
  try {
    const { destinatario, campos } = req.body || {};
    const r = await query('INSERT INTO certificados (empleado_id, destinatario, campos) VALUES ($1,$2,$3) RETURNING *',
      [req.user.id, destinatario || null, JSON.stringify(campos || {})]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// Generar / rechazar (rrhh/admin)
router.patch('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { estado, motivo } = req.body || {};
    if (!['generado', 'rechazado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const r = await query(`UPDATE certificados SET estado=$1, motivo=$2, generado_por=$3, generado_at=now() WHERE id=$4 AND estado='pendiente' RETURNING id`,
      [estado, motivo || null, req.user.dni, req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'El pedido no existe o ya fue resuelto' });
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

// Datos para imprimir el certificado (propio o rrhh/admin)
router.get('/:id/datos', async (req, res, next) => {
  try {
    const cr = await query(
      `SELECT c.*, e.leg_num, e.dni, e.cuil, e.nom, e.email, e.cat, e.tramo, e.ingreso, e.bruto, e.data, em.nombre AS empresa, em.cuit
         FROM certificados c JOIN empleados e ON e.id = c.empleado_id JOIN empresas em ON em.id = e.empresa_id WHERE c.id = $1`,
      [req.params.id]);
    const c = cr.rows[0];
    if (!c) return res.status(404).json({ error: 'No encontrado' });
    if (c.empleado_id !== req.user.id && !gestiona(req.user.role)) return res.status(403).json({ error: 'Sin permiso' });
    res.json({
      destinatario: c.destinatario, campos: c.campos, estado: c.estado,
      empleado: {
        nom: c.nom, dni: c.dni, cuil: c.cuil, legNum: c.leg_num, empresa: c.empresa, cuit: c.cuit,
        ingreso: c.ingreso, cat: c.cat, tramo: c.tramo, bruto: Number(c.bruto),
        condicion: c.data?.condicion || '', tarea: c.data?.tarea || '', lugar: c.data?.lugar || '',
      },
    });
  } catch (e) { next(e); }
});

export default router;
