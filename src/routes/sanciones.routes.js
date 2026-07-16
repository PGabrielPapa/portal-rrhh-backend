import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';
import { equipoEfectivo } from '../lib/delegaciones.js';
import { ordenarPasos, pasoActual, puedeResolver, resultadoDecision } from '../lib/workflowEngine.js';
import { avisarAprobadorPendiente, avisarSolicitante } from '../lib/notifAprob.js';
import { validarAdjunto, mimeSeguro } from '../lib/adjuntos.js';

const router = Router();
router.use(requireAuth);
const gestiona = (r) => ['manager', 'rrhh', 'admin'].includes(r);
const COLS = 's.id, s.empleado_id, s.tipo, s.fecha, s.dias, s.descripcion, s.created_by, s.created_at, s.falta, s.estado, s.resuelto_por, s.fecha_notificacion, s.fecha_cumplimiento, s.notif_nombre, (s.notif_data IS NOT NULL) AS tiene_notif';

// Puesto del usuario (pasos de workflow por puesto).
async function puestoDe(userId) {
  const r = (await query('SELECT puesto_id FROM empleados WHERE id=$1', [userId])).rows[0];
  return r ? r.puesto_id : null;
}
// Snapshot del flujo activo para 'sanciones' (o null → flujo clásico).
async function wfSnapSanciones() {
  try {
    const wf = (await query("SELECT pasos FROM workflows WHERE activo AND proceso='sanciones' ORDER BY updated_at DESC LIMIT 1")).rows[0];
    if (wf && Array.isArray(wf.pasos) && wf.pasos.length) return JSON.stringify(wf.pasos);
  } catch (e) { /* sin workflow */ }
  return null;
}

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
    const wfSnap = esSolicitud ? await wfSnapSanciones() : null;
    const r = await query(
      'INSERT INTO sanciones (empleado_id, tipo, falta, fecha, dias, descripcion, estado, fecha_notificacion, fecha_cumplimiento, created_by, workflow) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [empleadoId, tipo, falta || null, fecha, parseInt(dias, 10) || 0, descripcion || null, estado, fNotif, fCumpl, req.user.dni, wfSnap]);
    if (wfSnap) { try { avisarAprobadorPendiente({ proceso: 'sanciones', paso: ordenarPasos(JSON.parse(wfSnap))[0], resumen: `${tipo}` }); } catch (e) { /* noop */ } }
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
    { const v = validarAdjunto({ nombre, mime, data }); if (!v.ok) return res.status(400).json({ error: v.error }); }
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
    res.setHeader('Content-Type', mimeSeguro(s.notif_mime));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${(s.notif_nombre || 'notificacion').replace(/[^\w.\- ]/g, '_')}"`);
    res.send(buf);
  } catch (e) { next(e); }
});
// DELETE /api/sanciones/:id — RR.HH./admin cualquiera; gerente solo las de su equipo.
router.delete('/:id', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const sr = await query('SELECT empleado_id FROM sanciones WHERE id=$1', [req.params.id]);
    const s = sr.rows[0];
    if (!s) return res.status(404).json({ error: 'Sanción no encontrada' });
    const esRRHH = ['rrhh', 'admin'].includes(req.user.role);
    if (!esRRHH) {
      const ids = await idsEquipoDe(req.user.id);
      if (!ids.has(s.empleado_id)) return res.status(403).json({ error: 'Solo podés borrar sanciones de integrantes de tu equipo.' });
    }
    await query('DELETE FROM sanciones WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/sanciones/:id/flujo — pasos, aprobaciones y paso actual (estado 'solicitada' = pendiente).
router.get('/:id/flujo', async (req, res, next) => {
  try {
    const sanc = (await query('SELECT empleado_id, estado, workflow FROM sanciones WHERE id=$1', [req.params.id])).rows[0];
    if (!sanc) return res.status(404).json({ error: 'Sanción no encontrada' });
    const pasos = Array.isArray(sanc.workflow) ? sanc.workflow : [];
    const aprob = (await query('SELECT orden, rol, etiqueta, decision, actor_nom, actor_dni, comentario, at FROM sancion_aprobaciones WHERE sancion_id=$1 ORDER BY at', [req.params.id])).rows;
    const enCurso = sanc.estado === 'solicitada';
    const actual = enCurso ? pasoActual(pasos, aprob) : null;
    let puede = false;
    if (actual) {
      const uPuesto = await puestoDe(req.user.id);
      const enEquipo = req.user.role === 'manager' ? (await equipoEfectivo(req.user, 'sanciones')).has(sanc.empleado_id) : false;
      puede = puedeResolver(actual, { role: req.user.role, puestoId: uPuesto }, { enEquipo });
    }
    res.json({ estado: sanc.estado, tieneWorkflow: pasos.length > 0, pasos: ordenarPasos(pasos), aprobaciones: aprob, pasoActual: actual, puedeResolver: puede });
  } catch (e) { next(e); }
});

// POST /api/sanciones/:id/aprobar { decision, comentario? } — multinivel; al cerrar → 'aplicada'.
router.post('/:id/aprobar', async (req, res, next) => {
  try {
    const b = req.body || {};
    const decision = b.decision === 'rechazado' ? 'rechazado' : (b.decision === 'aprobado' ? 'aprobado' : null);
    if (!decision) return res.status(400).json({ error: 'Decisión inválida' });
    const sanc = (await query('SELECT empleado_id, estado, workflow FROM sanciones WHERE id=$1', [req.params.id])).rows[0];
    if (!sanc) return res.status(404).json({ error: 'Sanción no encontrada' });
    if (sanc.estado !== 'solicitada') return res.status(409).json({ error: 'La sanción ya fue resuelta' });
    const pasos = Array.isArray(sanc.workflow) ? sanc.workflow : [];
    if (!pasos.length) return res.status(409).json({ error: 'Esta sanción no tiene flujo configurado; usá la resolución clásica de RR.HH.' });
    const aprob = (await query('SELECT orden, decision FROM sancion_aprobaciones WHERE sancion_id=$1', [req.params.id])).rows;
    const paso = pasoActual(pasos, aprob);
    if (!paso) return res.status(409).json({ error: 'No hay pasos pendientes' });
    const uPuesto = await puestoDe(req.user.id);
    const enEquipo = req.user.role === 'manager' ? (await equipoEfectivo(req.user, 'sanciones')).has(sanc.empleado_id) : false;
    if (!puedeResolver(paso, { role: req.user.role, puestoId: uPuesto }, { enEquipo }))
      return res.status(403).json({ error: `Este paso lo resuelve ${paso.etiqueta || (paso.puesto ? 'un puesto específico' : 'el rol ' + paso.rol)}.` });

    await query('INSERT INTO sancion_aprobaciones (sancion_id, orden, rol, etiqueta, decision, actor_dni, actor_nom, comentario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [req.params.id, paso.orden, paso.rol || null, paso.etiqueta || null, decision, req.user.dni, req.user.nom || req.user.dni, b.comentario || null]);

    const r = resultadoDecision(pasos, aprob, paso, decision);
    if (r.estado === 'rechazado') {
      await query("UPDATE sanciones SET estado='rechazada', resuelto_por=$1 WHERE id=$2", [req.user.dni, req.params.id]);
      avisarSolicitante({ empleadoId: sanc.empleado_id, proceso: 'sanciones', estado: 'rechazada' });
      return res.json({ ok: true, estado: 'rechazada' });
    }
    if (r.estado === 'pendiente') { avisarAprobadorPendiente({ proceso: 'sanciones', paso: r.siguiente }); return res.json({ ok: true, estado: 'solicitada', siguiente: r.siguiente }); }
    await query("UPDATE sanciones SET estado='aplicada', resuelto_por=$1 WHERE id=$2", [req.user.dni, req.params.id]);
    avisarSolicitante({ empleadoId: sanc.empleado_id, proceso: 'sanciones', estado: 'aplicada' });
    res.json({ ok: true, estado: 'aplicada' });
  } catch (e) { next(e); }
});

export default router;
