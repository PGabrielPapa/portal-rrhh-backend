import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Verifica que la inscripción sea del empleado logueado.
async function esMia(inscId, empId) {
  const r = (await query('SELECT empleado_id, curso_id FROM formacion_inscripciones WHERE id=$1', [inscId])).rows[0];
  return r && Number(r.empleado_id) === Number(empId) ? r : null;
}

// GET /api/mi-formacion — cursos en los que estoy inscripto, con % de avance.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.id, i.estado, i.calificacion, c.nombre, c.descripcion, c.modalidad, c.horas,
              (SELECT COUNT(*)::int FROM curso_modulos m WHERE m.curso_id=c.id AND m.activo) AS modulos,
              (SELECT COUNT(*)::int FROM formacion_progreso p JOIN curso_modulos m ON m.id=p.modulo_id
                 WHERE p.inscripcion_id=i.id AND p.completado AND m.activo) AS completos
         FROM formacion_inscripciones i JOIN cursos c ON c.id=i.curso_id
        WHERE i.empleado_id=$1 ORDER BY i.created_at DESC`, [req.user.id]);
    res.json(rows.map((r) => ({ inscripcionId: r.id, estado: r.estado, calificacion: r.calificacion, nombre: r.nombre,
      descripcion: r.descripcion, modalidad: r.modalidad, horas: Number(r.horas),
      modulos: r.modulos, completos: r.completos, pct: r.modulos ? Math.round((r.completos / r.modulos) * 100) : 0 })));
  } catch (e) { next(e); }
});

// GET /api/mi-formacion/:inscripcionId/modulos — módulos del curso con mi progreso.
router.get('/:inscripcionId/modulos', async (req, res, next) => {
  try {
    const insc = await esMia(req.params.inscripcionId, req.user.id);
    if (!insc) return res.status(403).json({ error: 'Esa inscripción no es tuya.' });
    const mods = (await query('SELECT id, titulo, tipo, url, orden FROM curso_modulos WHERE curso_id=$1 AND activo ORDER BY orden, id', [insc.curso_id])).rows;
    const prog = (await query('SELECT modulo_id, completado FROM formacion_progreso WHERE inscripcion_id=$1', [req.params.inscripcionId])).rows;
    const pm = Object.fromEntries(prog.map((p) => [p.modulo_id, p.completado]));
    res.json(mods.map((m) => ({ ...m, completado: !!pm[m.id] })));
  } catch (e) { next(e); }
});

// PUT /api/mi-formacion/:inscripcionId/modulos/:moduloId — marcar/desmarcar mi progreso.
router.put('/:inscripcionId/modulos/:moduloId', async (req, res, next) => {
  try {
    const insc = await esMia(req.params.inscripcionId, req.user.id);
    if (!insc) return res.status(403).json({ error: 'Esa inscripción no es tuya.' });
    const completado = !!(req.body || {}).completado;
    await query(
      `INSERT INTO formacion_progreso (inscripcion_id, modulo_id, completado, fecha) VALUES ($1,$2,$3, CASE WHEN $3 THEN now() ELSE NULL END)
       ON CONFLICT (inscripcion_id, modulo_id) DO UPDATE SET completado=$3, fecha=CASE WHEN $3 THEN now() ELSE NULL END`,
      [req.params.inscripcionId, req.params.moduloId, completado]);
    // Si completó todos los módulos, marcar la inscripción como en curso/aprobada según corresponda (suave).
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
