import { Router } from 'express';
import { query, pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const soloRRHH = requireRole('rrhh', 'admin');

// ── EMPLEADO: encuestas abiertas que aún no respondió ──
router.get('/disponibles', async (req, res, next) => {
  try {
    const encs = (await query(
      `SELECT e.id, e.titulo, e.descripcion, e.anonima FROM encuestas e
        WHERE e.estado='abierta'
          AND NOT EXISTS (SELECT 1 FROM encuesta_participaciones p WHERE p.encuesta_id=e.id AND p.empleado_id=$1)
        ORDER BY e.created_at DESC`, [req.user.id])).rows;
    for (const e of encs) e.preguntas = (await query('SELECT id, texto, tipo, orden FROM encuesta_preguntas WHERE encuesta_id=$1 ORDER BY orden, id', [e.id])).rows;
    res.json(encs);
  } catch (e) { next(e); }
});

// ── EMPLEADO: responder ──
router.post('/:id/responder', async (req, res, next) => {
  const encId = Number(req.params.id);
  const client = await pool.connect();
  try {
    const enc = (await client.query("SELECT id, estado, anonima FROM encuestas WHERE id=$1", [encId])).rows[0];
    if (!enc || enc.estado !== 'abierta') return res.status(409).json({ error: 'La encuesta no está abierta' });
    const ya = (await client.query('SELECT 1 FROM encuesta_participaciones WHERE encuesta_id=$1 AND empleado_id=$2', [encId, req.user.id])).rowCount;
    if (ya) return res.status(409).json({ error: 'Ya respondiste esta encuesta' });
    const respuestas = Array.isArray((req.body || {}).respuestas) ? req.body.respuestas.slice(0, 500) : [];
    // Solo se aceptan preguntas que pertenecen a ESTA encuesta. Antes el id de
    // pregunta venía del cuerpo sin verificar, así que se podían insertar respuestas
    // en preguntas de otra encuesta (falseando sus resultados) sin haber sido invitado.
    const validas = new Set((await client.query('SELECT id FROM encuesta_preguntas WHERE encuesta_id=$1', [encId]))
      .rows.map((p) => Number(p.id)));
    await client.query('BEGIN');
    for (const r of respuestas) {
      const pid = Number(r.preguntaId);
      if (!validas.has(pid)) continue;
      const valor = r.valor != null && r.valor !== '' ? Number(r.valor) : null;
      if (valor != null && !Number.isFinite(valor)) continue;
      const texto = r.texto ? String(r.texto).slice(0, 4000) : null;
      if (valor == null && !texto) continue;
      await client.query('INSERT INTO encuesta_respuestas (encuesta_id, pregunta_id, empleado_id, valor, texto) VALUES ($1,$2,$3,$4,$5)',
        [encId, pid, enc.anonima ? null : req.user.id, valor, texto]);
    }
    await client.query('INSERT INTO encuesta_participaciones (encuesta_id, empleado_id) VALUES ($1,$2)', [encId, req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

// ── RR.HH.: ABM ──
router.get('/', soloRRHH, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.*, (SELECT count(*)::int FROM encuesta_participaciones p WHERE p.encuesta_id=e.id) AS respondieron,
              (SELECT count(*)::int FROM encuesta_preguntas q WHERE q.encuesta_id=e.id) AS preguntas
         FROM encuestas e ORDER BY e.created_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'El título es obligatorio' });
    const tipo = ['clima', 'pulso', 'enps'].includes(b.tipo) ? b.tipo : 'clima';
    const r = await query('INSERT INTO encuestas (titulo, descripcion, anonima, estado, tipo, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(b.titulo).trim(), b.descripcion || null, b.anonima !== false, 'borrador', tipo, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/:id', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    const estado = ['borrador', 'abierta', 'cerrada'].includes(b.estado) ? b.estado : undefined;
    const sets = [], args = [];
    if (b.titulo !== undefined) { args.push(String(b.titulo).trim()); sets.push(`titulo=$${args.length}`); }
    if (b.descripcion !== undefined) { args.push(b.descripcion || null); sets.push(`descripcion=$${args.length}`); }
    if (b.anonima !== undefined) { args.push(b.anonima !== false); sets.push(`anonima=$${args.length}`); }
    if (b.tipo !== undefined && ['clima', 'pulso', 'enps'].includes(b.tipo)) { args.push(b.tipo); sets.push(`tipo=$${args.length}`); }
    if (estado) { args.push(estado); sets.push(`estado=$${args.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    args.push(req.params.id);
    const r = await query(`UPDATE encuestas SET ${sets.join(', ')} WHERE id=$${args.length} RETURNING id`, args);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/:id', soloRRHH, async (req, res, next) => {
  try { const r = await query('DELETE FROM encuestas WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// Preguntas
router.get('/:id/preguntas', soloRRHH, async (req, res, next) => {
  try { const { rows } = await query('SELECT id, texto, tipo, orden FROM encuesta_preguntas WHERE encuesta_id=$1 ORDER BY orden, id', [req.params.id]); res.json(rows); }
  catch (e) { next(e); }
});
router.post('/:id/preguntas', soloRRHH, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.texto || !String(b.texto).trim()) return res.status(400).json({ error: 'El texto es obligatorio' });
    const r = await query('INSERT INTO encuesta_preguntas (encuesta_id, texto, tipo, orden) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.params.id, String(b.texto).trim(), ['texto', 'nps'].includes(b.tipo) ? b.tipo : 'escala', Number(b.orden) || 0]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/preguntas/:id', soloRRHH, async (req, res, next) => {
  try { const r = await query('DELETE FROM encuesta_preguntas WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// Resultados (agregado; respeta anonimato)
router.get('/:id/resultados', soloRRHH, async (req, res, next) => {
  try {
    const enc = (await query('SELECT id, titulo, anonima FROM encuestas WHERE id=$1', [req.params.id])).rows[0];
    if (!enc) return res.status(404).json({ error: 'No encontrada' });
    const respondieron = (await query('SELECT count(*)::int AS n FROM encuesta_participaciones WHERE encuesta_id=$1', [req.params.id])).rows[0].n;
    const preguntas = (await query('SELECT id, texto, tipo, orden FROM encuesta_preguntas WHERE encuesta_id=$1 ORDER BY orden, id', [req.params.id])).rows;
    for (const p of preguntas) {
      if (p.tipo === 'escala') {
        const rows = (await query('SELECT valor, count(*)::int AS n FROM encuesta_respuestas WHERE pregunta_id=$1 AND valor IS NOT NULL GROUP BY valor', [p.id])).rows;
        const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let suma = 0, tot = 0;
        for (const r of rows) { dist[r.valor] = r.n; suma += r.valor * r.n; tot += r.n; }
        p.promedio = tot ? Math.round((suma / tot) * 100) / 100 : null; p.respuestas = tot; p.distribucion = dist;
      } else if (p.tipo === 'nps') {
        const rows = (await query('SELECT valor, count(*)::int AS n FROM encuesta_respuestas WHERE pregunta_id=$1 AND valor IS NOT NULL GROUP BY valor', [p.id])).rows;
        let prom = 0, det = 0, pas = 0, tot = 0;
        for (const r of rows) { const v = Number(r.valor); tot += r.n; if (v >= 9) prom += r.n; else if (v <= 6) det += r.n; else pas += r.n; }
        p.respuestas = tot;
        p.enps = tot ? Math.round(((prom - det) / tot) * 100) : null;   // eNPS: -100 a +100
        p.promotores = prom; p.pasivos = pas; p.detractores = det;
      } else {
        p.textos = (await query('SELECT texto FROM encuesta_respuestas WHERE pregunta_id=$1 AND texto IS NOT NULL ORDER BY created_at DESC', [p.id])).rows.map((r) => r.texto);
      }
    }
    res.json({ encuesta: enc, respondieron, preguntas });
  } catch (e) { next(e); }
});

export default router;
