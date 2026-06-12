import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/mensajes — vista del empleado: lo que envió a RR.HH. (con estado) + lo que recibió de RR.HH./broadcast
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, titulo, cuerpo, autor, created_at, direccion, estado, borrar_al_leer,
              (direccion = 'a_empleado' AND empleado_id IS NULL) AS broadcast
         FROM mensajes
        WHERE (direccion = 'a_rrhh' AND remitente_id = $1)
           OR (direccion = 'a_empleado' AND (empleado_id = $1 OR empleado_id IS NULL))
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/mensajes — el empleado envía un mensaje a RR.HH.
// body: { cuerpo, borrarAlLeer? }
router.post('/', async (req, res, next) => {
  try {
    const { cuerpo, borrarAlLeer } = req.body || {};
    const texto = String(cuerpo || '').trim();
    if (!texto) return res.status(400).json({ error: 'Escribí un mensaje' });
    if (texto.length > 500) return res.status(400).json({ error: 'El mensaje no puede superar los 500 caracteres' });
    const ins = await query(
      `INSERT INTO mensajes (empleado_id, remitente_id, titulo, cuerpo, autor, direccion, estado, borrar_al_leer)
       VALUES ($1,$1,'Mensaje a RR.HH.',$2,$3,'a_rrhh','nuevo',$4) RETURNING id`,
      [req.user.id, texto, req.user.dni, !!borrarAlLeer]
    );
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

// DELETE /api/mensajes/:id — el empleado borra un mensaje propio (típicamente ya leído)
router.delete('/:id', async (req, res, next) => {
  try {
    const r = await query(
      `DELETE FROM mensajes WHERE id=$1 AND direccion='a_rrhh' AND remitente_id=$2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Mensaje no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── RR.HH./admin ──

// GET /api/mensajes/recibidos — bandeja de mensajes que los empleados enviaron a RR.HH.
router.get('/recibidos', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { q, estado } = req.query;
    const cond = ["m.direccion = 'a_rrhh'"], params = [];
    if (estado) { params.push(estado); cond.push(`m.estado = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    const { rows } = await query(
      `SELECT m.id, m.cuerpo, m.created_at, m.estado, m.borrar_al_leer,
              e.nom, e.leg_num, em.nombre AS empresa
         FROM mensajes m
         JOIN empleados e ON e.id = m.remitente_id
         LEFT JOIN empresas em ON em.id = e.empresa_id
        WHERE ${cond.join(' AND ')}
        ORDER BY (m.estado='nuevo') DESC, m.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// PATCH /api/mensajes/:id/leido — RR.HH. marca como leído (si borrar_al_leer, se elimina)
router.patch('/:id/leido', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query(`SELECT borrar_al_leer FROM mensajes WHERE id=$1 AND direccion='a_rrhh'`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Mensaje no encontrado' });
    if (r.rows[0].borrar_al_leer) {
      await query('DELETE FROM mensajes WHERE id=$1', [req.params.id]);
      return res.json({ ok: true, eliminado: true });
    }
    await query(`UPDATE mensajes SET estado='leido' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, estado: 'leido' });
  } catch (e) { next(e); }
});

// POST /api/mensajes/difundir — RR.HH. envía a un DNI o a todos (broadcast)
router.post('/difundir', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { titulo, cuerpo, destinatarioDni } = req.body || {};
    if (!titulo || !cuerpo) return res.status(400).json({ error: 'Título y cuerpo son obligatorios' });
    let empleadoId = null;
    if (destinatarioDni) {
      const r = await query('SELECT id FROM empleados WHERE dni = $1', [String(destinatarioDni).trim()]);
      if (!r.rows[0]) return res.status(404).json({ error: `No existe un empleado con DNI ${destinatarioDni}` });
      empleadoId = r.rows[0].id;
    }
    const ins = await query(
      `INSERT INTO mensajes (empleado_id, titulo, cuerpo, autor, direccion, estado)
       VALUES ($1,$2,$3,$4,'a_empleado','nuevo') RETURNING id`,
      [empleadoId, String(titulo).trim(), String(cuerpo).trim(), req.user.dni]
    );
    res.status(201).json({ ok: true, id: ins.rows[0].id, broadcast: empleadoId === null });
  } catch (e) { next(e); }
});

export default router;
