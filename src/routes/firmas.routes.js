import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ── Empleado: documentos que me asignaron para firmar ──
router.get('/pendientes', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.id, d.titulo, d.descripcion, d.url, d.created_at, x.firmado_at
         FROM documento_destinatarios x JOIN documentos_firma d ON d.id=x.documento_id
        WHERE x.empleado_id=$1 AND d.activo ORDER BY (x.firmado_at IS NULL) DESC, d.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/:id/firmar', async (req, res, next) => {
  try {
    const nombre = (req.body || {}).nombre ? String(req.body.nombre) : (req.user.nom || req.user.dni);
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
    const r = await query(
      `UPDATE documento_destinatarios SET firmado_at=now(), firma_nombre=$1, firma_ip=$2
        WHERE documento_id=$3 AND empleado_id=$4 AND firmado_at IS NULL RETURNING documento_id`,
      [nombre, String(ip || ''), req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'El documento no está pendiente para vos (o ya lo firmaste).' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── RR.HH.: gestión ──
router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.*, (SELECT COUNT(*)::int FROM documento_destinatarios x WHERE x.documento_id=d.id) AS total,
              (SELECT COUNT(*)::int FROM documento_destinatarios x WHERE x.documento_id=d.id AND x.firmado_at IS NOT NULL) AS firmados
         FROM documentos_firma d WHERE d.activo ORDER BY d.created_at DESC`);
    res.json(rows.map((d) => ({ id: d.id, titulo: d.titulo, descripcion: d.descripcion, url: d.url, total: d.total, firmados: d.firmados, createdAt: d.created_at })));
  } catch (e) { next(e); }
});
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.titulo || !String(b.titulo).trim()) return res.status(400).json({ error: 'El título es obligatorio' });
    const r = await query('INSERT INTO documentos_firma (titulo, descripcion, url, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [String(b.titulo).trim(), b.descripcion || '', b.url || null, req.user.dni]);
    const id = r.rows[0].id;
    // Destinatarios: lista explícita, o todos los activos (opcionalmente de una empresa).
    let ids = [];
    if (Array.isArray(b.empleadoIds) && b.empleadoIds.length) ids = b.empleadoIds.map(Number);
    else {
      const cond = ['COALESCE(activo,true)=true'], args = [];
      if (b.empresa) { args.push(b.empresa); cond.push(`empresa_id=(SELECT id FROM empresas WHERE nombre=$${args.length})`); }
      ids = (await query(`SELECT id FROM empleados WHERE ${cond.join(' AND ')}`, args)).rows.map((x) => x.id);
    }
    for (const eid of ids) await query('INSERT INTO documento_destinatarios (documento_id, empleado_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, eid]);
    res.status(201).json({ ok: true, id, destinatarios: ids.length });
  } catch (e) { next(e); }
});
router.get('/:id/acuses', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.nom, e.leg_num, em.nombre AS empresa, x.firmado_at, x.firma_nombre
         FROM documento_destinatarios x JOIN empleados e ON e.id=x.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE x.documento_id=$1 ORDER BY (x.firmado_at IS NULL) DESC, e.nom`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM documentos_firma WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
