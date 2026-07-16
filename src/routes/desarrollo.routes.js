import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Progreso de un key result: (actual - inicial) / (objetivo - inicial), acotado 0-100.
function progresoKR(kr) {
  const ini = Number(kr.valor_inicial) || 0, act = Number(kr.valor_actual) || 0, obj = Number(kr.valor_objetivo) || 0;
  if (obj === ini) return act >= obj ? 100 : 0;
  const p = ((act - ini) / (obj - ini)) * 100;
  return Math.max(0, Math.min(100, r2(p)));
}

// ── OKRs ──
router.get('/okrs', async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.periodo) { args.push(req.query.periodo); cond.push(`o.periodo=$${args.length}`); }
    if (req.query.estado) { args.push(req.query.estado); cond.push(`o.estado=$${args.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const okrs = (await query(
      `SELECT o.*, e.nom AS empleado_nom FROM okrs o LEFT JOIN empleados e ON e.id=o.empleado_id ${where} ORDER BY o.created_at DESC`, args)).rows;
    const krs = (await query('SELECT * FROM okr_resultados ORDER BY id')).rows;
    res.json(okrs.map((o) => {
      const rs = krs.filter((k) => k.okr_id === o.id).map((k) => ({ id: k.id, descripcion: k.descripcion, unidad: k.unidad,
        valorInicial: Number(k.valor_inicial), valorActual: Number(k.valor_actual), valorObjetivo: Number(k.valor_objetivo), progreso: progresoKR(k) }));
      const avance = rs.length ? r2(rs.reduce((a, k) => a + k.progreso, 0) / rs.length) : 0;
      return { id: o.id, ambito: o.ambito, empleadoId: o.empleado_id, empleadoNom: o.empleado_nom, titulo: o.titulo, periodo: o.periodo, estado: o.estado, resultados: rs, avance };
    }));
  } catch (e) { next(e); }
});
router.post('/okrs', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'El título es obligatorio' });
    const r = await query('INSERT INTO okrs (ambito, empleado_id, titulo, periodo, estado, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [['empresa', 'equipo', 'empleado'].includes(b.ambito) ? b.ambito : 'empleado', b.empleadoId || null, String(b.titulo).trim(), b.periodo || null, 'activo', req.user.dni]);
    const id = r.rows[0].id;
    for (const k of (Array.isArray(b.resultados) ? b.resultados : [])) {
      if (!k.descripcion) continue;
      await query('INSERT INTO okr_resultados (okr_id, descripcion, valor_inicial, valor_actual, valor_objetivo, unidad) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, String(k.descripcion), Number(k.valorInicial) || 0, Number(k.valorActual) || 0, Number(k.valorObjetivo) || 100, k.unidad || null]);
    }
    res.status(201).json({ ok: true, id });
  } catch (e) { next(e); }
});
router.patch('/okrs/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.estado) await query('UPDATE okrs SET estado=$1 WHERE id=$2', [b.estado === 'cerrado' ? 'cerrado' : 'activo', req.params.id]);
    if (Array.isArray(b.resultados)) for (const k of b.resultados) {
      if (k.id) await query('UPDATE okr_resultados SET valor_actual=$1 WHERE id=$2 AND okr_id=$3', [Number(k.valorActual) || 0, k.id, req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/okrs/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM okrs WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Feedback 360 ──
router.get('/feedback', async (req, res, next) => {
  try {
    const sols = (await query(
      `SELECT s.*, e.nom AS empleado_nom, e.leg_num,
              (SELECT COUNT(*)::int FROM feedback_respuestas r WHERE r.solicitud_id=s.id) AS respuestas
         FROM feedback_solicitudes s JOIN empleados e ON e.id=s.empleado_id ORDER BY s.created_at DESC`)).rows;
    res.json(sols.map((s) => ({ id: s.id, empleadoId: s.empleado_id, empleadoNom: s.empleado_nom, legNum: s.leg_num,
      periodo: s.periodo, estado: s.estado, competencias: s.competencias || [], respuestas: s.respuestas })));
  } catch (e) { next(e); }
});
router.post('/feedback', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId) return res.status(400).json({ error: 'El empleado evaluado es obligatorio' });
    const comps = Array.isArray(b.competencias) ? b.competencias.map(String).filter(Boolean) : [];
    const r = await query('INSERT INTO feedback_solicitudes (empleado_id, periodo, estado, competencias, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [b.empleadoId, b.periodo || null, 'abierta', JSON.stringify(comps), req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.patch('/feedback/:id', async (req, res, next) => {
  try { const b = req.body || {}; if (b.estado) await query('UPDATE feedback_solicitudes SET estado=$1 WHERE id=$2', [b.estado === 'cerrada' ? 'cerrada' : 'abierta', req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
router.delete('/feedback/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM feedback_solicitudes WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});
router.post('/feedback/:id/respuestas', async (req, res, next) => {
  try {
    const b = req.body || {};
    const resp = Array.isArray(b.respuestas) ? b.respuestas.map((x) => ({ competencia: String(x.competencia || ''), puntaje: Number(x.puntaje) || 0, comentario: x.comentario || '' })) : [];
    await query('INSERT INTO feedback_respuestas (solicitud_id, evaluador, relacion, respuestas) VALUES ($1,$2,$3,$4)',
      [req.params.id, b.evaluador || null, ['jefe', 'par', 'reporte', 'auto'].includes(b.relacion) ? b.relacion : 'par', JSON.stringify(resp)]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});
// Resultados agregados de una solicitud: promedio por competencia y por relación.
router.get('/feedback/:id/resultados', async (req, res, next) => {
  try {
    const sol = (await query('SELECT * FROM feedback_solicitudes WHERE id=$1', [req.params.id])).rows[0];
    if (!sol) return res.status(404).json({ error: 'No encontrada' });
    const rows = (await query('SELECT evaluador, relacion, respuestas, created_at FROM feedback_respuestas WHERE solicitud_id=$1 ORDER BY created_at', [req.params.id])).rows;
    const agg = {};   // competencia -> {suma,n}
    const porRelacion = {};
    for (const r of rows) {
      for (const a of (r.respuestas || [])) {
        const c = a.competencia || 'General';
        agg[c] = agg[c] || { suma: 0, n: 0 };
        agg[c].suma += Number(a.puntaje) || 0; agg[c].n++;
        porRelacion[r.relacion] = porRelacion[r.relacion] || { suma: 0, n: 0 };
        porRelacion[r.relacion].suma += Number(a.puntaje) || 0; porRelacion[r.relacion].n++;
      }
    }
    res.json({
      solicitud: { id: sol.id, competencias: sol.competencias || [], estado: sol.estado, periodo: sol.periodo },
      evaluadores: rows.length,
      porCompetencia: Object.entries(agg).map(([competencia, v]) => ({ competencia, promedio: v.n ? r2(v.suma / v.n) : 0, respuestas: v.n })).sort((a, b) => b.promedio - a.promedio),
      porRelacion: Object.entries(porRelacion).map(([relacion, v]) => ({ relacion, promedio: v.n ? r2(v.suma / v.n) : 0 })),
      comentarios: rows.flatMap((r) => (r.respuestas || []).filter((a) => a.comentario).map((a) => ({ relacion: r.relacion, competencia: a.competencia, comentario: a.comentario }))),
    });
  } catch (e) { next(e); }
});

// Invitar evaluadores a una solicitud (RR.HH.).
router.post('/feedback/:id/invitar', async (req, res, next) => {
  try {
    const inv = Array.isArray((req.body || {}).invitados) ? req.body.invitados : [];
    for (const x of inv) {
      if (!x.empleadoId) continue;
      const rel = ['jefe', 'par', 'reporte', 'auto'].includes(x.relacion) ? x.relacion : 'par';
      await query('INSERT INTO feedback_invitados (solicitud_id, empleado_id, relacion) VALUES ($1,$2,$3) ON CONFLICT (solicitud_id, empleado_id) DO UPDATE SET relacion=EXCLUDED.relacion',
        [req.params.id, x.empleadoId, rel]);
    }
    res.status(201).json({ ok: true, invitados: inv.length });
  } catch (e) { next(e); }
});
router.get('/feedback/:id/invitados', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.empleado_id, i.relacion, i.respondido_at, e.nom, e.leg_num
         FROM feedback_invitados i JOIN empleados e ON e.id=i.empleado_id WHERE i.solicitud_id=$1 ORDER BY e.nom`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
