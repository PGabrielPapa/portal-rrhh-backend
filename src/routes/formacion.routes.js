import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('rrhh', 'admin', 'manager'));
const soloRRHH = requireRole('rrhh', 'admin');

export const ESTADOS = ['inscripto', 'en_curso', 'aprobado', 'desaprobado', 'ausente'];

// ── Catálogo de cursos ──
router.get('/cursos', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, (SELECT count(*)::int FROM formacion_inscripciones i WHERE i.curso_id=c.id) AS inscriptos
         FROM cursos c ORDER BY (c.activo) DESC, c.nombre`);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/cursos', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO cursos (nombre, descripcion, proveedor, modalidad, horas, activo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(b.nombre).trim(), b.descripcion || null, b.proveedor || null, b.modalidad || null, Number(b.horas) || 0, b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/cursos/:id', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('UPDATE cursos SET nombre=$1, descripcion=$2, proveedor=$3, modalidad=$4, horas=$5, activo=$6 WHERE id=$7 RETURNING id',
      [String(b.nombre).trim(), b.descripcion || null, b.proveedor || null, b.modalidad || null, Number(b.horas) || 0, b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Curso no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/cursos/:id', soloRRHH, async (req, res, next) => {
  try { const r = await query('DELETE FROM cursos WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Inscripciones ──
router.get('/cursos/:id/inscripciones', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.id, i.empleado_id, i.fecha, i.estado, i.calificacion, i.costo, i.nota, e.nom, e.leg_num, em.nombre AS empresa
         FROM formacion_inscripciones i JOIN empleados e ON e.id=i.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE i.curso_id=$1 ORDER BY e.nom`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.get('/empleado/:empleadoId', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.id, i.fecha, i.estado, i.calificacion, i.costo, c.nombre AS curso, c.horas
         FROM formacion_inscripciones i JOIN cursos c ON c.id=i.curso_id
        WHERE i.empleado_id=$1 ORDER BY i.fecha DESC NULLS LAST, i.id DESC`, [req.params.empleadoId]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/inscripciones', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.cursoId || !b.empleadoId) return res.status(400).json({ error: 'Curso y empleado son obligatorios' });
    const r = await query('INSERT INTO formacion_inscripciones (curso_id, empleado_id, fecha, estado, costo) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [b.cursoId, b.empleadoId, b.fecha || null, ESTADOS.includes(b.estado) ? b.estado : 'inscripto', b.costo != null ? Number(b.costo) : null]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.patch('/inscripciones/:id', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], args = [];
    if (b.estado !== undefined) { if (!ESTADOS.includes(b.estado)) return res.status(400).json({ error: 'Estado inválido' }); args.push(b.estado); sets.push(`estado=$${args.length}`); }
    if (b.calificacion !== undefined) { args.push(b.calificacion === '' ? null : Number(b.calificacion)); sets.push(`calificacion=$${args.length}`); }
    if (b.nota !== undefined) { args.push(b.nota || null); sets.push(`nota=$${args.length}`); }
    if (b.costo !== undefined) { args.push(b.costo === '' ? null : Number(b.costo)); sets.push(`costo=$${args.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    args.push(req.params.id);
    const r = await query(`UPDATE formacion_inscripciones SET ${sets.join(', ')} WHERE id=$${args.length} RETURNING id`, args);
    if (!r.rowCount) return res.status(404).json({ error: 'Inscripción no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/inscripciones/:id', soloRRHH, async (req, res, next) => {
  try { const r = await query('DELETE FROM formacion_inscripciones WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});
router.get('/estados', (req, res) => res.json(ESTADOS));

export default router;
