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
    const { rows } = await query('SELECT id, nombre, email, telefono, etapa, nota, origen, puntaje, evaluacion, created_at FROM candidatos WHERE busqueda_id=$1 ORDER BY puntaje DESC NULLS LAST, created_at DESC', [req.params.id]);
    res.json(rows.map((r) => ({ ...r, puntaje: r.puntaje != null ? Number(r.puntaje) : null, evaluacion: r.evaluacion || [] })));
  } catch (e) { next(e); }
});

router.post('/candidatos', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.busquedaId || !b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'Búsqueda y nombre son obligatorios' });
    const r = await query('INSERT INTO candidatos (busqueda_id, nombre, email, telefono, etapa, nota, origen) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.busquedaId, String(b.nombre).trim(), b.email || null, b.telefono || null, ETAPAS.includes(b.etapa) ? b.etapa : 'postulado', b.nota || null, b.origen || null]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.patch('/candidatos/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], args = [];
    if (b.etapa !== undefined) { if (!ETAPAS.includes(b.etapa)) return res.status(400).json({ error: 'Etapa inválida' }); args.push(b.etapa); sets.push(`etapa=$${args.length}`); }
    if (b.nota !== undefined) { args.push(b.nota || null); sets.push(`nota=$${args.length}`); }
    if (b.origen !== undefined) { args.push(b.origen || null); sets.push(`origen=$${args.length}`); }
    if (b.evaluacion !== undefined) {
      const ev = Array.isArray(b.evaluacion) ? b.evaluacion.map((x) => ({ criterio: String(x.criterio || ''), peso: Number(x.peso) || 0, puntaje: Number(x.puntaje) || 0 })) : [];
      const pesoTot = ev.reduce((a, x) => a + x.peso, 0);
      const puntaje = pesoTot > 0 ? Math.round((ev.reduce((a, x) => a + x.peso * x.puntaje, 0) / pesoTot) * 100) / 100 : null;
      args.push(JSON.stringify(ev)); sets.push(`evaluacion=$${args.length}`);
      args.push(puntaje); sets.push(`puntaje=$${args.length}`);
    }
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

// GET /api/reclutamiento/embudo — métricas del embudo de selección (global o por búsqueda).
router.get('/embudo', async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.busquedaId) { args.push(req.query.busquedaId); cond.push(`busqueda_id=$${args.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const etapas = (await query(`SELECT etapa, COUNT(*)::int n FROM candidatos ${where} GROUP BY etapa`, args)).rows;
    const porOrigen = (await query(`SELECT COALESCE(origen,'sin dato') origen, COUNT(*)::int n FROM candidatos ${where} GROUP BY 1 ORDER BY n DESC`, args)).rows;
    const mapa = Object.fromEntries(etapas.map((e) => [e.etapa, e.n]));
    const embudo = ETAPAS.map((et) => ({ etapa: et, n: mapa[et] || 0 }));
    const total = ETAPAS.reduce((a, et) => a + (mapa[et] || 0), 0);
    const contratados = mapa['contratado'] || 0;
    const postulados = mapa['postulado'] || 0;
    const tasaConversion = total ? Math.round((contratados / total) * 1000) / 10 : 0;  // % contratados sobre el total
    res.json({ embudo, porOrigen, total, contratados, postulados, tasaConversion });
  } catch (e) { next(e); }
});

router.get('/etapas', (req, res) => res.json(ETAPAS));

export default router;
