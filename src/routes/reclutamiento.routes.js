import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('rrhh', 'admin'));

export const ETAPAS = ['postulado', 'entrevista', 'oferta', 'contratado', 'descartado'];

// ── Búsquedas ──
router.get('/busquedas', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT b.*, p.nombre AS puesto_nombre,
              (SELECT count(*)::int FROM candidatos c WHERE c.busqueda_id=b.id) AS candidatos
         FROM busquedas b LEFT JOIN puestos p ON p.id=b.puesto_id
        ORDER BY (b.estado='abierta') DESC, b.created_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/busquedas', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'El título es obligatorio' });
    const r = await query('INSERT INTO busquedas (titulo, empresa, puesto_id, descripcion, estado, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(b.titulo).trim(), b.empresa || null, b.puestoId || null, b.descripcion || null, b.estado === 'cerrada' ? 'cerrada' : 'abierta', req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.put('/busquedas/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'El título es obligatorio' });
    const r = await query('UPDATE busquedas SET titulo=$1, empresa=$2, puesto_id=$3, descripcion=$4, estado=$5 WHERE id=$6 RETURNING id',
      [String(b.titulo).trim(), b.empresa || null, b.puestoId || null, b.descripcion || null, b.estado === 'cerrada' ? 'cerrada' : 'abierta', req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Búsqueda no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/busquedas/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM busquedas WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Candidatos ──
router.get('/busquedas/:id/candidatos', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, nombre, email, telefono, etapa, nota, created_at FROM candidatos WHERE busqueda_id=$1 ORDER BY created_at DESC', [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/candidatos', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.busquedaId || !b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'Búsqueda y nombre son obligatorios' });
    const r = await query('INSERT INTO candidatos (busqueda_id, nombre, email, telefono, etapa, nota) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [b.busquedaId, String(b.nombre).trim(), b.email || null, b.telefono || null, ETAPAS.includes(b.etapa) ? b.etapa : 'postulado', b.nota || null]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.patch('/candidatos/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], args = [];
    if (b.etapa !== undefined) { if (!ETAPAS.includes(b.etapa)) return res.status(400).json({ error: 'Etapa inválida' }); args.push(b.etapa); sets.push(`etapa=$${args.length}`); }
    if (b.nota !== undefined) { args.push(b.nota || null); sets.push(`nota=$${args.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    args.push(req.params.id);
    const r = await query(`UPDATE candidatos SET ${sets.join(', ')}, updated_at=now() WHERE id=$${args.length} RETURNING id`, args);
    if (!r.rowCount) return res.status(404).json({ error: 'Candidato no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/candidatos/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM candidatos WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

router.get('/etapas', (req, res) => res.json(ETAPAS));

export default router;
