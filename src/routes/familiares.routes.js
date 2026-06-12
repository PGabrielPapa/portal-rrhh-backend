import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['rrhh', 'admin'].includes(r);

// Propios
router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM familiares WHERE empleado_id=$1 ORDER BY vigencia_hasta NULLS FIRST, tipo', [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

// RR.HH.: ?empleadoId= para ver los de un empleado
router.get('/', async (req, res, next) => {
  try {
    const empId = (gestiona(req.user.role) && req.query.empleadoId) ? Number(req.query.empleadoId) : req.user.id;
    const { rows } = await query('SELECT * FROM familiares WHERE empleado_id=$1 ORDER BY vigencia_hasta NULLS FIRST, tipo', [empId]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.tipo || !b.nombre) return res.status(400).json({ error: 'Vínculo y nombre son obligatorios' });
    const r = await query(
      `INSERT INTO familiares (empleado_id,tipo,apellido,nombre,genero,dni,cuil,fecha_nac,fecha_vinculo,discapacidad,vigencia_desde)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,CURRENT_DATE)) RETURNING *`,
      [req.user.id, b.tipo, b.apellido || null, b.nombre, b.genero || null, b.dni || null, b.cuil || null, b.fecha_nac || null, b.fecha_vinculo || null, !!b.discapacidad, b.vigencia_desde || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query(
      `UPDATE familiares SET tipo=$1,apellido=$2,nombre=$3,genero=$4,dni=$5,cuil=$6,fecha_nac=$7,fecha_vinculo=$8,discapacidad=$9
        WHERE id=$10 AND empleado_id=$11 RETURNING *`,
      [b.tipo, b.apellido || null, b.nombre, b.genero || null, b.dni || null, b.cuil || null, b.fecha_nac || null, b.fecha_vinculo || null, !!b.discapacidad, req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Familiar no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// Cerrar vínculo (divorcio / fallecimiento / mayoría)
router.patch('/:id/cerrar', async (req, res, next) => {
  try {
    const { fecha, motivo } = req.body || {};
    const r = await query('UPDATE familiares SET vigencia_hasta=$1, motivo_cierre=$2 WHERE id=$3 AND empleado_id=$4 RETURNING id',
      [fecha || new Date().toISOString().slice(0, 10), motivo || null, req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Familiar no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM familiares WHERE id=$1 AND empleado_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Familiar no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
