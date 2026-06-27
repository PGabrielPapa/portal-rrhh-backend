// Comité de Higiene y Seguridad (REG-002-CHS) — endpoints del submódulo.
// Acceso: integrantes del comité (tilde data.comite_hys) o RR.HH./Admin.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

async function requireComite(req, res, next) {
  try {
    if (['rrhh', 'admin'].includes(req.user.role)) return next();
    const { rows } = await query("SELECT (data->>'comite_hys')::boolean AS c FROM empleados WHERE id = $1", [req.user.id]);
    if (rows[0] && rows[0].c) return next();
    return res.status(403).json({ error: 'Acceso restringido a los integrantes del Comité de HyS' });
  } catch (e) { next(e); }
}
router.use(requireComite);

// Descarga de un archivo adjunto (base64 en TEXT). `tabla` es interna (no input de usuario).
function archivoHandler(tabla) {
  return async (req, res, next) => {
    try {
      const { rows } = await query(`SELECT archivo_nombre, archivo_mime, archivo_data FROM ${tabla} WHERE id=$1`, [req.params.id]);
      const r = rows[0];
      if (!r || !r.archivo_data) return res.status(404).json({ error: 'Sin archivo' });
      res.setHeader('Content-Type', r.archivo_mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${String(r.archivo_nombre || 'archivo').replace(/[^\w.\-]/g, '_')}"`);
      res.send(Buffer.from(r.archivo_data, 'base64'));
    } catch (e) { next(e); }
  };
}
const archivoCols = (a) => [a && a.data ? (a.nombre || 'archivo') : null, a && a.data ? (a.mime || 'application/octet-stream') : null, (a && a.data) || null];

// ───────────────────────── Minutas del Comité ─────────────────────────
const mapMinuta = (r) => ({
  id: r.id, comite: r.comite, fecha: r.fecha, participantes: r.participantes,
  temas: r.temas, decisiones: r.decisiones, observaciones: r.observaciones,
  acciones: r.acciones || [], archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre,
  createdBy: r.created_by, createdAt: r.created_at,
});

router.get('/minutas', async (req, res, next) => {
  try {
    const { comite } = req.query; const cond = [], p = [];
    if (comite) { p.push(comite); cond.push(`comite = $${p.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT id, comite, fecha, participantes, temas, decisiones, observaciones, acciones, archivo_nombre, created_by, created_at
         FROM chs_minutas ${where} ORDER BY fecha DESC NULLS LAST, id DESC`, p);
    res.json(rows.map(mapMinuta));
  } catch (e) { next(e); }
});

router.post('/minutas', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_minutas (comite, fecha, participantes, temas, decisiones, observaciones, acciones, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [b.comite || null, b.fecha || null, b.participantes || null, b.temas || null, b.decisiones || null, b.observaciones || null,
       JSON.stringify(b.acciones || []), an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/minutas/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['comite=$1', 'fecha=$2', 'participantes=$3', 'temas=$4', 'decisiones=$5', 'observaciones=$6', 'acciones=$7', 'updated_at=now()'];
    const params = [b.comite || null, b.fecha || null, b.participantes || null, b.temas || null, b.decisiones || null, b.observaciones || null, JSON.stringify(b.acciones || [])];
    if (b.archivo && b.archivo.data) {
      params.push(b.archivo.nombre || 'acta', b.archivo.mime || 'application/octet-stream', b.archivo.data);
      sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`);
    } else if (b.quitarArchivo) {
      sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL');
    }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_minutas SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Minuta no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/minutas/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_minutas WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Minuta no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/minutas/:id/archivo', archivoHandler('chs_minutas'));

// ───────────────────────── Política de HyS ─────────────────────────
const mapPol = (r) => ({ id: r.id, version: r.version, vigencia: r.vigencia, comentario: r.comentario, vigente: r.vigente, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/politica', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, version, vigencia, comentario, vigente, archivo_nombre, created_by, created_at FROM chs_politica ORDER BY vigente DESC, vigencia DESC NULLS LAST, id DESC');
    res.json(rows.map(mapPol));
  } catch (e) { next(e); }
});

router.post('/politica', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    if (b.vigente) await query('UPDATE chs_politica SET vigente=false WHERE vigente=true');
    const { rows } = await query(
      `INSERT INTO chs_politica (version, vigencia, comentario, vigente, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.version || null, b.vigencia || null, b.comentario || null, !!b.vigente, an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.post('/politica/:id/vigente', async (req, res, next) => {
  try {
    await query('UPDATE chs_politica SET vigente=false WHERE vigente=true');
    const r = await query('UPDATE chs_politica SET vigente=true WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/politica/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_politica WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/politica/:id/archivo', archivoHandler('chs_politica'));

// ───────────────────────── Difusión de la política ─────────────────────────
const mapDif = (r) => ({ id: r.id, fecha: r.fecha, alcance: r.alcance, observacion: r.observacion, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/difusion', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, fecha, alcance, observacion, archivo_nombre, created_by, created_at FROM chs_difusion ORDER BY fecha DESC NULLS LAST, id DESC');
    res.json(rows.map(mapDif));
  } catch (e) { next(e); }
});

router.post('/difusion', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_difusion (fecha, alcance, observacion, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.fecha || null, b.alcance || null, b.observacion || null, an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.delete('/difusion/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_difusion WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/difusion/:id/archivo', archivoHandler('chs_difusion'));

export default router;
