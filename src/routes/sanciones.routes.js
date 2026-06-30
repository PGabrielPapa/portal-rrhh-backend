import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';

const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['manager', 'rrhh', 'admin'].includes(r);
const COLS = 's.id, s.empleado_id, s.tipo, s.fecha, s.dias, s.descripcion, s.created_by, s.created_at, s.falta, s.estado, s.resuelto_por, s.fecha_notificacion, s.fecha_cumplimiento, s.notif_nombre, (s.notif_data IS NOT NULL) AS tiene_notif';

router.get('/mias', async (req, res, next) => {
  try { const { rows } = await query(`SELECT ${COLS} FROM sanciones s WHERE s.empleado_id = $1 AND s.fecha >= CURRENT_DATE - INTERVAL '2 years' ORDER BY s.fecha DESC`, [req.user.id]); res.json(rows); }
  catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    if (!gestiona(req.user.role)) {
      const { rows } = await query(`SELECT ${COLS} FROM sanciones s WHERE s.empleado_id = $1 AND s.fecha >= CURRENT_DATE - INTERVAL '2 years' ORDER BY s.fecha DESC`, [req.user.id]);
      return res.json(rows);
    }
    const { empresa, q, estado } = req.query; const cond = [], params = [];
    if (req.user.role === 'manager') { const _ids = [...await idsEquipoDe(req.user.id)]; if (!_ids.length) return res.json([]); params.push(_ids); cond.push(`e.id = ANY($${params.length})`); }
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (estado) { params.push(estado); cond.push(`s.estado = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i})`); }
    cond.push("s.fecha >= CURRENT_DATE - INTERVAL '2 years'");
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT ${COLS}, e.nom, e.leg_num, em.nombre AS empresa FROM sanciones s
         JOIN empleados e ON e.id = s.empleado_id JOIN empresas em ON em.id = e.empresa_id
         ${where} ORDER BY (s.estado='solicitada') DESC, s.fecha DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST — gerente SOLICITA (estado=solicitada); rrhh/admin APLICA directamente
router.post('/', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empleadoId, tipo, falta, fecha, dias, descripcion, fechaNotificacion, fechaCumplimiento } = req.body || {};
    if (!empleadoId || !tipo || !fecha) return res.status(400).json({ error: 'empleado, tipo y fecha son obligatorios' });
    // Un gerente solo sanciona a su equipo (organigrama). RR.HH./admin, a cualquiera.
    if (req.user.role === 'manager') {
      const ids = await idsEquipoDe(req.user.id);
      if (!ids.has(Number(empleadoId))) return res.status(403).json({ error: 'Solo podés registrar sanciones de integrantes de tu equipo.' });
    }
    // Es solicitud (la resuelve RR.HH.) si lo pide un gerente, O si viene de la pantalla
    // "Sanciones del equipo" (flag solicitar) aunque el usuario sea admin/rrhh.
    const esSolicitud = req.user.role === 'manager' || (req.body || {}).solicitar === true;
    const estado = esSolicitud ? 'solicitada' : 'aplicada';
    // En una solicitud, la notificación/cumplimiento los carga RR.HH. al aplicarla.
    const fNotif = esSolicitud ? null : (fechaNotificacion || null);
    const fCumpl = esSolicitud ? null : (fechaCumplimiento || null);
    const r = await query(
      'INSERT INTO sanciones (empleado_id, tipo, falta, fecha, dias, descripcion, estado, fecha_notificacion, fecha_cumplimiento, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [empleadoId, tipo, falta || null, fecha, parseInt(dias, 10) || 0, descripcion || null, estado, fNotif, fCumpl, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id, estado });
  } catch (e) { next(e); }
});

// PATCH — RR.HH. aplica/rechaza una sanción solicitada
router.patch('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const estado = (req.body || {}).estado;
    if (!['aplicada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const fNotif = (req.body || {}).fechaNotificacion || null;
    const fCumpl = (req.body || {}).fechaCumplimiento || null;
    const r = await query(`UPDATE sanciones SET estado=$1, resuelto_por=$2, fecha_notificacion=COALESCE($4,fecha_notificacion), fecha_cumplimiento=COALESCE($5,fecha_cumplimiento) WHERE id=$3 AND estado='solicitada' RETURNING id`, [estado, req.user.dni, req.params.id, fNotif, fCumpl]);
    if (!r.rowCount) return res.status(409).json({ error: 'La sanción no existe o no está pendiente' });
    res.json({ ok: true, estado });
  } catch (e) { next(e); }
});

// POST /api/sanciones/:id/notificar — registra fecha de notificación y
// COMUNICA electrónicamente al empleado (crea un mensaje en su bandeja).
router.post('/:id/notificar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const fecha = (req.body || {}).fecha || new Date().toISOString().slice(0, 10);
    const sr = await query('SELECT * FROM sanciones WHERE id = $1', [req.params.id]);
    const s = sr.rows[0];
    if (!s) return res.status(404).json({ error: 'Sanción no encontrada' });
    await query('UPDATE sanciones SET fecha_notificacion = $1 WHERE id = $2', [fecha, req.params.id]);
    const cuerpo = `Se le notifica la aplicación de una sanción disciplinaria.\n` +
      `Tipo: ${s.tipo}\nFalta: ${s.falta || '—'}\nFecha del hecho: ${s.fecha}\n` +
      (s.dias ? `Días: ${s.dias}\n` : '') + (s.descripcion ? `Detalle: ${s.descripcion}\n` : '') +
      `Fecha de notificación: ${fecha}`;
    await query('INSERT INTO mensajes (empleado_id, titulo, cuerpo, autor) VALUES ($1,$2,$3,$4)',
      [s.empleado_id, 'Notificación de sanción', cuerpo, req.user.dni]);
    res.json({ ok: true, fecha });
  } catch (e) { next(e); }
});

// POST /api/sanciones/:id/notificacion — RR.HH. adjunta el comprobante de notificación cursada y marca notificada
router.post('/:id/notificacion', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { fecha, nombre, mime, data } = req.body || {};
    if (!data) return res.status(400).json({ error: 'Adjuntá el archivo de la notificación.' });
    const f = fecha || new Date().toISOString().slice(0, 10);
    const sr = await query('SELECT empleado_id, tipo, falta, fecha, dias, descripcion FROM sanciones WHERE id=$1', [req.params.id]);
    const s = sr.rows[0];
    if (!s) return res.status(404).json({ error: 'Sanción no encontrada' });
    await query('UPDATE sanciones SET notif_nombre=$1, notif_mime=$2, notif_data=$3, fecha_notificacion=$4 WHERE id=$5',
      [nombre || 'notificacion', mime || 'application/octet-stream', data, f, req.params.id]);
    const cuerpo = `Se le notifica la aplicación de una sanción disciplinaria (con comprobante adjunto en este sistema).\n` +
      `Tipo: ${s.tipo}\nFalta: ${s.falta || '—'}\nFecha del hecho: ${s.fecha}\n` +
      (s.dias ? `Días: ${s.dias}\n` : '') + (s.descripcion ? `Detalle: ${s.descripcion}\n` : '') +
      `Fecha de notificación: ${f}`;
    await query('INSERT INTO mensajes (empleado_id, titulo, cuerpo, autor) VALUES ($1,$2,$3,$4)',
      [s.empleado_id, 'Notificación de sanción', cuerpo, req.user.dni]);
    res.json({ ok: true, fecha: f });
  } catch (e) { next(e); }
});

// GET /api/sanciones/:id/notificacion — descarga del comprobante (dueño, gerente de su equipo, RR.HH./admin)
router.get('/:id/notificacion', async (req, res, next) => {
  try {
    const sr = await query('SELECT empleado_id, notif_nombre, notif_mime, notif_data FROM sanciones WHERE id=$1', [req.params.id]);
    const s = sr.rows[0];
    if (!s || !s.notif_data) return res.status(404).json({ error: 'No hay notificación adjunta' });
    const esGlobal = req.user.role === 'rrhh' || req.user.role === 'admin';
    let ok = esGlobal || s.empleado_id === req.user.id;
    if (!ok && req.user.role === 'manager') ok = (await idsEquipoDe(req.user.id)).has(s.empleado_id);
    if (!ok) return res.status(403).json({ error: 'No autorizado' });
    const buf = Buffer.from(s.notif_data, 'base64');
    res.setHeader('Content-Type', s.notif_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(s.notif_nombre || 'notificacion').replace(/[^\w.\- ]/g, '_')}"`);
    res.send(buf);
  } catch (e) { next(e); }
});
export default router;
