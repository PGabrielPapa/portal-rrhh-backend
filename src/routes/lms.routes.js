import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));
const TIPOS = ['lectura', 'video', 'quiz', 'tarea'];

// ── Módulos/lecciones de un curso ──
router.get('/cursos/:cursoId/modulos', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, curso_id, orden, titulo, tipo, url, contenido, activo FROM curso_modulos WHERE curso_id=$1 ORDER BY orden, id', [req.params.cursoId]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/cursos/:cursoId/modulos', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'El título es obligatorio' });
    const r = await query('INSERT INTO curso_modulos (curso_id, orden, titulo, tipo, url, contenido, activo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [req.params.cursoId, Number(b.orden) || 0, String(b.titulo).trim(), TIPOS.includes(b.tipo) ? b.tipo : 'lectura', b.url || null, b.contenido || null, b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/modulos/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE curso_modulos SET orden=$1, titulo=$2, tipo=$3, url=$4, contenido=$5, activo=$6 WHERE id=$7 RETURNING id',
      [Number(b.orden) || 0, String(b.titulo || '').trim(), TIPOS.includes(b.tipo) ? b.tipo : 'lectura', b.url || null, b.contenido || null, b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Módulo no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/modulos/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM curso_modulos WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Itinerarios (rutas de aprendizaje) ──
router.get('/itinerarios', async (req, res, next) => {
  try {
    const its = (await query('SELECT id, nombre, descripcion, activo FROM itinerarios ORDER BY nombre')).rows;
    const cursos = (await query(
      `SELECT ic.itinerario_id, ic.curso_id, ic.orden, c.nombre, c.horas
         FROM itinerario_cursos ic JOIN cursos c ON c.id=ic.curso_id ORDER BY ic.orden, c.nombre`)).rows;
    res.json(its.map((it) => ({ ...it, cursos: cursos.filter((c) => c.itinerario_id === it.id).map((c) => ({ cursoId: c.curso_id, nombre: c.nombre, horas: Number(c.horas), orden: c.orden })) })));
  } catch (e) { next(e); }
});
router.post('/itinerarios', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO itinerarios (nombre, descripcion, activo) VALUES ($1,$2,$3) RETURNING id', [String(b.nombre).trim(), b.descripcion || null, b.activo !== false]);
    const id = r.rows[0].id;
    if (Array.isArray(b.cursos)) {
      for (let i = 0; i < b.cursos.length; i++) await query('INSERT INTO itinerario_cursos (itinerario_id, curso_id, orden) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, b.cursos[i], i]);
    }
    res.status(201).json({ ok: true, id });
  } catch (e) { next(e); }
});
router.put('/itinerarios/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE itinerarios SET nombre=$1, descripcion=$2, activo=$3 WHERE id=$4 RETURNING id', [String(b.nombre || '').trim(), b.descripcion || null, b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Itinerario no encontrado' });
    if (Array.isArray(b.cursos)) {
      await query('DELETE FROM itinerario_cursos WHERE itinerario_id=$1', [req.params.id]);
      for (let i = 0; i < b.cursos.length; i++) await query('INSERT INTO itinerario_cursos (itinerario_id, curso_id, orden) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, b.cursos[i], i]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/itinerarios/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM itinerarios WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Progreso de una inscripción por módulo ──
router.get('/inscripciones/:id/progreso', async (req, res, next) => {
  try {
    const insc = (await query('SELECT curso_id FROM formacion_inscripciones WHERE id=$1', [req.params.id])).rows[0];
    if (!insc) return res.status(404).json({ error: 'Inscripción no encontrada' });
    const mods = (await query('SELECT id, titulo, tipo, orden FROM curso_modulos WHERE curso_id=$1 AND activo ORDER BY orden, id', [insc.curso_id])).rows;
    const prog = (await query('SELECT modulo_id, completado, fecha FROM formacion_progreso WHERE inscripcion_id=$1', [req.params.id])).rows;
    const pm = Object.fromEntries(prog.map((p) => [p.modulo_id, p]));
    const items = mods.map((m) => ({ ...m, completado: !!pm[m.id]?.completado, fecha: pm[m.id]?.fecha || null }));
    const completos = items.filter((i) => i.completado).length;
    res.json({ items, total: items.length, completos, pct: items.length ? Math.round((completos / items.length) * 100) : 0 });
  } catch (e) { next(e); }
});
router.put('/inscripciones/:id/progreso/:moduloId', async (req, res, next) => {
  try {
    const completado = !!(req.body || {}).completado;
    await query(
      `INSERT INTO formacion_progreso (inscripcion_id, modulo_id, completado, fecha) VALUES ($1,$2,$3, CASE WHEN $3 THEN now() ELSE NULL END)
       ON CONFLICT (inscripcion_id, modulo_id) DO UPDATE SET completado=$3, fecha=CASE WHEN $3 THEN now() ELSE NULL END`,
      [req.params.id, req.params.moduloId, completado]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
