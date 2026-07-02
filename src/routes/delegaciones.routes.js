// Alta/baja/consulta de delegaciones. El gerente (o admin) delega tareas en otro
// empleado; el delegado las ve en su panel. Adelantos solo se delega a un gerente.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { TAREAS, TAREA_LABEL, delegacionesRecibidas } from '../lib/delegaciones.js';
import { idsEquipoDe } from '../lib/equipo.js';

const router = Router();
router.use(requireAuth);

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/delegaciones/candidatos?tarea= — empleados activos elegibles como delegado.
// Para 'adelantos' solo gerentes. Excluye al propio usuario.
router.get('/candidatos', requireRole('manager', 'admin'), async (req, res, next) => {
  try {
    const tarea = String(req.query.tarea || '');
    const cond = ['e.activo = true', 'e.id <> $1'];
    const params = [req.user.id];
    // El gerente solo puede delegar en su equipo (organigrama) o en otros gerentes.
    if (req.user.role === 'manager') {
      const ids = [...await idsEquipoDe(req.user.id)];
      if (ids.length) { params.push(ids); cond.push(`(e.id = ANY($${params.length}::int[]) OR e.role = 'manager')`); }
      else { cond.push(`e.role = 'manager'`); }
    }
    if (tarea === 'adelantos') cond.push(`e.role = 'manager'`);
    const { rows } = await query(
      `SELECT e.id, e.nom, e.leg_num, e.role, em.nombre AS empresa
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id
        WHERE ${cond.join(' AND ')}
        ORDER BY e.nom`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/delegaciones/mias — delegaciones que YO creé (como delegante).
router.get('/mias', requireRole('manager', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.*, e.nom AS delegado_nom, e.leg_num AS delegado_leg, em.nombre AS delegado_empresa
         FROM delegaciones d
         JOIN empleados e ON e.id = d.delegado_id
         JOIN empresas em ON em.id = e.empresa_id
        WHERE d.delegante_id = $1
        ORDER BY (d.estado='activa') DESC, d.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/delegaciones/recibidas — delegaciones VIGENTES hacia mí (como delegado).
router.get('/recibidas', async (req, res, next) => {
  try {
    const rows = await delegacionesRecibidas(req.user.id);
    res.json(rows.map((r) => ({ ...r, tareaLabel: TAREA_LABEL[r.tarea] || r.tarea })));
  } catch (e) { next(e); }
});

// POST /api/delegaciones — crear. body: { delegadoId, tareas:[], desde?, hasta?, nota? }
router.post('/', requireRole('manager', 'admin'), async (req, res, next) => {
  try {
    const { delegadoId, tareas, desde, hasta, nota } = req.body || {};
    const lista = Array.isArray(tareas) ? tareas.filter((t) => TAREAS.includes(t)) : [];
    if (!delegadoId || !lista.length) return res.status(400).json({ error: 'Elegí un delegado y al menos una tarea.' });
    if (Number(delegadoId) === req.user.id) return res.status(400).json({ error: 'No podés delegarte a vos mismo.' });
    if ((desde && !ISO.test(desde)) || (hasta && !ISO.test(hasta))) return res.status(400).json({ error: 'Fechas inválidas (AAAA-MM-DD).' });
    if (desde && hasta && hasta < desde) return res.status(400).json({ error: 'La fecha "hasta" debe ser posterior a "desde".' });

    const del = (await query('SELECT id, nom, role, activo FROM empleados WHERE id = $1', [delegadoId])).rows[0];
    if (!del || !del.activo) return res.status(404).json({ error: 'El empleado elegido no existe o está inactivo.' });
    if (lista.includes('adelantos') && del.role !== 'manager') {
      return res.status(400).json({ error: 'Adelantos solo se puede delegar a un gerente.' });
    }

    const creadas = [];
    for (const tarea of lista) {
      // Evitar duplicar una delegación vigente idéntica.
      const dup = (await query(
        `SELECT id FROM delegaciones WHERE delegante_id=$1 AND delegado_id=$2 AND tarea=$3 AND estado='activa'`,
        [req.user.id, delegadoId, tarea])).rows[0];
      if (dup) continue;
      const ins = await query(
        `INSERT INTO delegaciones (delegante_id, delegado_id, tarea, desde, hasta, nota, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.user.id, delegadoId, tarea, desde || null, hasta || null, nota || null, req.user.dni || null]);
      creadas.push({ id: ins.rows[0].id, tarea });
    }
    res.status(201).json({ ok: true, creadas, delegado: del.nom });
  } catch (e) { next(e); }
});

// PATCH /api/delegaciones/:id/revocar — revocar (solo el delegante o admin).
router.patch('/:id/revocar', requireRole('manager', 'admin'), async (req, res, next) => {
  try {
    const cur = (await query('SELECT delegante_id, estado FROM delegaciones WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Delegación no encontrada.' });
    if (req.user.role !== 'admin' && cur.delegante_id !== req.user.id) return res.status(403).json({ error: 'Solo quien delegó (o un admin) puede revocar.' });
    if (cur.estado !== 'activa') return res.status(409).json({ error: 'La delegación ya no está activa.' });
    await query(`UPDATE delegaciones SET estado='revocada', revocada_por=$1, revocada_at=now() WHERE id=$2`, [req.user.dni || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
