import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/mi-feedback — solicitudes de feedback 360 a las que fui invitado.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.periodo, s.estado, s.competencias, i.relacion, i.respondido_at,
              e.nom AS evaluado_nom, e.leg_num AS evaluado_leg
         FROM feedback_invitados i
         JOIN feedback_solicitudes s ON s.id=i.solicitud_id
         JOIN empleados e ON e.id=s.empleado_id
        WHERE i.empleado_id=$1 ORDER BY (i.respondido_at IS NULL) DESC, s.created_at DESC`, [req.user.id]);
    res.json(rows.map((r) => ({ solicitudId: r.id, periodo: r.periodo, estado: r.estado, competencias: r.competencias || [],
      relacion: r.relacion, respondido: !!r.respondido_at, evaluado: r.evaluado_nom, evaluadoLeg: r.evaluado_leg })));
  } catch (e) { next(e); }
});

// POST /api/mi-feedback/:solicitudId/responder — el evaluador invitado responde.
router.post('/:solicitudId/responder', async (req, res, next) => {
  try {
    const inv = (await query('SELECT relacion, respondido_at FROM feedback_invitados WHERE solicitud_id=$1 AND empleado_id=$2', [req.params.solicitudId, req.user.id])).rows[0];
    if (!inv) return res.status(403).json({ error: 'No fuiste invitado a esta evaluación.' });
    if (inv.respondido_at) return res.status(409).json({ error: 'Ya respondiste esta evaluación.' });
    const sol = (await query("SELECT estado FROM feedback_solicitudes WHERE id=$1", [req.params.solicitudId])).rows[0];
    if (!sol || sol.estado !== 'abierta') return res.status(409).json({ error: 'La evaluación no está abierta.' });
    const resp = Array.isArray((req.body || {}).respuestas) ? req.body.respuestas.map((x) => ({ competencia: String(x.competencia || ''), puntaje: Number(x.puntaje) || 0, comentario: x.comentario || '' })) : [];
    // El evaluador queda anónimo en las respuestas agregadas; se registra solo su relación.
    await query('INSERT INTO feedback_respuestas (solicitud_id, evaluador, relacion, respuestas) VALUES ($1,$2,$3,$4)',
      [req.params.solicitudId, null, inv.relacion, JSON.stringify(resp)]);
    await query('UPDATE feedback_invitados SET respondido_at=now() WHERE solicitud_id=$1 AND empleado_id=$2', [req.params.solicitudId, req.user.id]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
