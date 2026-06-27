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
    // El familiar pasa a la base de Personas (tipo 'familiar'), si tiene DNI. No rompe el alta si falla.
    try {
      const fdni = String(b.dni || '').trim(); const fcuil = String(b.cuil || '').trim() || null;
      if (fdni) {
        const nomP = [String(b.apellido || '').trim(), String(b.nombre || '').trim()].filter(Boolean).join(', ').toUpperCase();
        let pid = null;
        if (fcuil) { const x = await query('SELECT id FROM personas WHERE cuil=$1', [fcuil]); if (x.rows[0]) pid = x.rows[0].id; }
        if (!pid) { const x = await query("SELECT id FROM personas WHERE dni=$1 AND (cuil IS NULL OR cuil='')", [fdni]); if (x.rows[0]) pid = x.rows[0].id; }
        if (!pid) await query("INSERT INTO personas (cuil,dni,apellido,nombres,nom,tipos,data) VALUES ($1,$2,$3,$4,$5,ARRAY['familiar'],$6)", [fcuil, fdni, b.apellido || null, b.nombre || null, nomP, JSON.stringify({ fecha_nac: b.fecha_nac || null, vinculo: b.tipo || null })]);
        else await query("UPDATE personas SET tipos = ARRAY(SELECT DISTINCT unnest(tipos || ARRAY['familiar'])) WHERE id=$1", [pid]);
      }
    } catch (e) { /* el familiar se cargó igual */ }
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
