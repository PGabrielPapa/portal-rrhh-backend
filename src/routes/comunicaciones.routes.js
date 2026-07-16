import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const esRH = (r) => r === 'rrhh' || r === 'admin';

// ── Comunicados (muro) ──
// Todos los autenticados ven los comunicados activos, con marca de leído propio.
router.get('/comunicados', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM comunicado_lecturas l WHERE l.comunicado_id=c.id) AS leidos,
              EXISTS(SELECT 1 FROM comunicado_lecturas l WHERE l.comunicado_id=c.id AND l.empleado_id=$1) AS leido
         FROM comunicados c WHERE c.activo ORDER BY c.fijado DESC, c.created_at DESC`, [req.user.id]);
    res.json(rows.map((c) => ({ id: c.id, titulo: c.titulo, cuerpo: c.cuerpo, autorDni: c.autor_dni, fijado: c.fijado, leido: c.leido, leidos: c.leidos, createdAt: c.created_at })));
  } catch (e) { next(e); }
});
router.post('/comunicados', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'El título es obligatorio' });
    const r = await query('INSERT INTO comunicados (titulo, cuerpo, autor_dni, fijado) VALUES ($1,$2,$3,$4) RETURNING id',
      [String(b.titulo).trim(), b.cuerpo || '', req.user.dni, !!b.fijado]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.patch('/comunicados/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.fijado !== undefined) await query('UPDATE comunicados SET fijado=$1 WHERE id=$2', [!!b.fijado, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/comunicados/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM comunicados WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});
router.post('/comunicados/:id/leido', async (req, res, next) => {
  try {
    await query('INSERT INTO comunicado_lecturas (comunicado_id, empleado_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Detalle de acuses de un comunicado (solo RR.HH.).
router.get('/comunicados/:id/lecturas', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.nom, e.leg_num, l.created_at FROM comunicado_lecturas l JOIN empleados e ON e.id=l.empleado_id WHERE l.comunicado_id=$1 ORDER BY l.created_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Reconocimientos entre pares ──
router.get('/reconocimientos', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.valor, r.mensaje, r.created_at,
              d.nom AS de_nom, p.nom AS para_nom, p.leg_num AS para_leg
         FROM reconocimientos r
         LEFT JOIN empleados d ON d.id=r.de_empleado_id
         JOIN empleados p ON p.id=r.para_empleado_id
        WHERE r.publico ORDER BY r.created_at DESC LIMIT 100`);
    res.json(rows.map((r) => ({ id: r.id, valor: r.valor, mensaje: r.mensaje, de: r.de_nom || 'Anónimo', para: r.para_nom, paraLeg: r.para_leg, createdAt: r.created_at })));
  } catch (e) { next(e); }
});
router.post('/reconocimientos', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.paraEmpleadoId) return res.status(400).json({ error: 'Elegí a quién reconocer' });
    if (Number(b.paraEmpleadoId) === Number(req.user.id)) return res.status(400).json({ error: 'No podés reconocerte a vos mismo' });
    await query('INSERT INTO reconocimientos (de_empleado_id, para_empleado_id, valor, mensaje, publico) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, b.paraEmpleadoId, b.valor || null, String(b.mensaje || '').trim(), b.publico !== false]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});
// Ranking simple: quiénes recibieron más reconocimientos (para RR.HH.).
router.get('/reconocimientos/ranking', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.nom, e.leg_num, COUNT(*)::int n FROM reconocimientos r JOIN empleados e ON e.id=r.para_empleado_id
        GROUP BY e.id, e.nom, e.leg_num ORDER BY n DESC LIMIT 20`);
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
