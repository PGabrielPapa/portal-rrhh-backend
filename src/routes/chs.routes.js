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

// ───────────────────────── Siniestros (ART / Medicina Laboral) ─────────────────────────
const mapSin = (r) => ({ id: r.id, tipo: r.tipo, empleadoId: r.empleado_id, empleadoNom: r.empleado_nom, empleadoLeg: r.leg_num, empresa: r.empresa, fecha: r.fecha, lugar: r.lugar, descripcion: r.descripcion, causas: r.causas, acciones: r.acciones, estado: r.estado, artNro: r.art_nro, diasBaja: r.dias_baja, seguimientos: r.seguimientos || [], archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/siniestros', async (req, res, next) => {
  try {
    const { tipo, estado } = req.query; const cond = [], p = [];
    if (tipo) { p.push(tipo); cond.push(`s.tipo=$${p.length}`); }
    if (estado) { p.push(estado); cond.push(`s.estado=$${p.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT s.*, e.nom AS empleado_nom, e.leg_num, em.nombre AS empresa
         FROM chs_siniestros s LEFT JOIN empleados e ON e.id=s.empleado_id LEFT JOIN empresas em ON em.id=e.empresa_id
         ${where} ORDER BY s.fecha DESC NULLS LAST, s.id DESC`, p);
    res.json(rows.map(mapSin));
  } catch (e) { next(e); }
});

router.post('/siniestros', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_siniestros (tipo,empleado_id,fecha,lugar,descripcion,causas,acciones,estado,art_nro,dias_baja,seguimientos,archivo_nombre,archivo_mime,archivo_data,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [b.tipo || null, b.empleadoId || null, b.fecha || null, b.lugar || null, b.descripcion || null, b.causas || null, b.acciones || null, b.estado || 'Abierto', b.artNro || null, b.diasBaja || null, JSON.stringify(b.seguimientos || []), an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/siniestros/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['tipo=$1', 'empleado_id=$2', 'fecha=$3', 'lugar=$4', 'descripcion=$5', 'causas=$6', 'acciones=$7', 'estado=$8', 'art_nro=$9', 'dias_baja=$10', 'seguimientos=$11', 'updated_at=now()'];
    const params = [b.tipo || null, b.empleadoId || null, b.fecha || null, b.lugar || null, b.descripcion || null, b.causas || null, b.acciones || null, b.estado || 'Abierto', b.artNro || null, b.diasBaja || null, JSON.stringify(b.seguimientos || [])];
    if (b.archivo && b.archivo.data) {
      params.push(b.archivo.nombre || 'archivo', b.archivo.mime || 'application/octet-stream', b.archivo.data);
      sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`);
    } else if (b.quitarArchivo) {
      sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL');
    }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_siniestros SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Siniestro no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/siniestros/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_siniestros WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Siniestro no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/siniestros/:id/archivo', archivoHandler('chs_siniestros'));

// ───────────────────────── Mediciones de HyS ─────────────────────────
const mapMed = (r) => ({ id: r.id, tipo: r.tipo, empresa: r.empresa, lugar: r.lugar, empresaResponsable: r.empresa_responsable, fechaRealizacion: r.fecha_realizacion, fechaVencimiento: r.fecha_vencimiento, resultado: r.resultado, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/mediciones', async (req, res, next) => {
  try {
    const { tipo } = req.query; const cond = [], p = [];
    if (tipo) { p.push(tipo); cond.push(`tipo=$${p.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT id, tipo, empresa, lugar, empresa_responsable, fecha_realizacion, fecha_vencimiento, resultado, archivo_nombre, created_by, created_at
         FROM chs_mediciones ${where} ORDER BY fecha_vencimiento ASC NULLS LAST, id DESC`, p);
    res.json(rows.map(mapMed));
  } catch (e) { next(e); }
});

router.post('/mediciones', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_mediciones (tipo, empresa, lugar, empresa_responsable, fecha_realizacion, fecha_vencimiento, resultado, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [b.tipo || null, b.empresa || null, b.lugar || null, b.empresaResponsable || null, b.fechaRealizacion || null, b.fechaVencimiento || null, b.resultado || null, an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/mediciones/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['tipo=$1', 'empresa=$2', 'lugar=$3', 'empresa_responsable=$4', 'fecha_realizacion=$5', 'fecha_vencimiento=$6', 'resultado=$7', 'updated_at=now()'];
    const params = [b.tipo || null, b.empresa || null, b.lugar || null, b.empresaResponsable || null, b.fechaRealizacion || null, b.fechaVencimiento || null, b.resultado || null];
    if (b.archivo && b.archivo.data) {
      params.push(b.archivo.nombre || 'informe', b.archivo.mime || 'application/octet-stream', b.archivo.data);
      sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`);
    } else if (b.quitarArchivo) {
      sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL');
    }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_mediciones SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Medición no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/mediciones/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_mediciones WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Medición no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/mediciones/:id/archivo', archivoHandler('chs_mediciones'));

// ───────────────────────── Auditorías e Inspecciones ─────────────────────────
const mapAud = (r) => ({ id: r.id, fecha: r.fecha, tipo: r.tipo, responsable: r.responsable, sector: r.sector, observaciones: r.observaciones, noConformidades: r.no_conformidades, acciones: r.acciones || [], estado: r.estado, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/auditorias', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, fecha, tipo, responsable, sector, observaciones, no_conformidades, acciones, estado, archivo_nombre, created_by, created_at FROM chs_auditorias ORDER BY fecha DESC NULLS LAST, id DESC');
    res.json(rows.map(mapAud));
  } catch (e) { next(e); }
});

router.post('/auditorias', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_auditorias (fecha, tipo, responsable, sector, observaciones, no_conformidades, acciones, estado, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [b.fecha || null, b.tipo || null, b.responsable || null, b.sector || null, b.observaciones || null, b.noConformidades || null, JSON.stringify(b.acciones || []), b.estado || 'Abierta', an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/auditorias/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['fecha=$1', 'tipo=$2', 'responsable=$3', 'sector=$4', 'observaciones=$5', 'no_conformidades=$6', 'acciones=$7', 'estado=$8', 'updated_at=now()'];
    const params = [b.fecha || null, b.tipo || null, b.responsable || null, b.sector || null, b.observaciones || null, b.noConformidades || null, JSON.stringify(b.acciones || []), b.estado || 'Abierta'];
    if (b.archivo && b.archivo.data) { params.push(b.archivo.nombre || 'archivo', b.archivo.mime || 'application/octet-stream', b.archivo.data); sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`); }
    else if (b.quitarArchivo) { sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL'); }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_auditorias SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Auditoría no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/auditorias/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_auditorias WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Auditoría no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/auditorias/:id/archivo', archivoHandler('chs_auditorias'));

// ───────────────────────── No Conformidades y Mejoras ─────────────────────────
const mapNc = (r) => ({ id: r.id, fecha: r.fecha, sector: r.sector, descripcion: r.descripcion, clasificacion: r.clasificacion, prioridad: r.prioridad, accion: r.accion, responsable: r.responsable, fechaCierre: r.fecha_cierre, estado: r.estado, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/noconf', async (req, res, next) => {
  try {
    const { estado, clasificacion } = req.query; const cond = [], p = [];
    if (estado) { p.push(estado); cond.push(`estado=$${p.length}`); }
    if (clasificacion) { p.push(clasificacion); cond.push(`clasificacion=$${p.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`SELECT id, fecha, sector, descripcion, clasificacion, prioridad, accion, responsable, fecha_cierre, estado, archivo_nombre, created_by, created_at FROM chs_noconf ${where} ORDER BY fecha DESC NULLS LAST, id DESC`, p);
    res.json(rows.map(mapNc));
  } catch (e) { next(e); }
});

router.post('/noconf', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_noconf (fecha, sector, descripcion, clasificacion, prioridad, accion, responsable, fecha_cierre, estado, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [b.fecha || null, b.sector || null, b.descripcion || null, b.clasificacion || null, b.prioridad || null, b.accion || null, b.responsable || null, b.fechaCierre || null, b.estado || 'Abierta', an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/noconf/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['fecha=$1', 'sector=$2', 'descripcion=$3', 'clasificacion=$4', 'prioridad=$5', 'accion=$6', 'responsable=$7', 'fecha_cierre=$8', 'estado=$9', 'updated_at=now()'];
    const params = [b.fecha || null, b.sector || null, b.descripcion || null, b.clasificacion || null, b.prioridad || null, b.accion || null, b.responsable || null, b.fechaCierre || null, b.estado || 'Abierta'];
    if (b.archivo && b.archivo.data) { params.push(b.archivo.nombre || 'archivo', b.archivo.mime || 'application/octet-stream', b.archivo.data); sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`); }
    else if (b.quitarArchivo) { sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL'); }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_noconf SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/noconf/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_noconf WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/noconf/:id/archivo', archivoHandler('chs_noconf'));

// ───────────────────────── Cartelería ─────────────────────────
const mapCar = (r) => ({ id: r.id, tipo: r.tipo, ubicacion: r.ubicacion, fechaInstalacion: r.fecha_instalacion, estadoConservacion: r.estado_conservacion, fechaRevision: r.fecha_revision, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/carteleria', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, tipo, ubicacion, fecha_instalacion, estado_conservacion, fecha_revision, archivo_nombre, created_by, created_at FROM chs_carteleria ORDER BY id DESC');
    res.json(rows.map(mapCar));
  } catch (e) { next(e); }
});

router.post('/carteleria', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_carteleria (tipo, ubicacion, fecha_instalacion, estado_conservacion, fecha_revision, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.tipo || null, b.ubicacion || null, b.fechaInstalacion || null, b.estadoConservacion || null, b.fechaRevision || null, an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/carteleria/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['tipo=$1', 'ubicacion=$2', 'fecha_instalacion=$3', 'estado_conservacion=$4', 'fecha_revision=$5', 'updated_at=now()'];
    const params = [b.tipo || null, b.ubicacion || null, b.fechaInstalacion || null, b.estadoConservacion || null, b.fechaRevision || null];
    if (b.archivo && b.archivo.data) { params.push(b.archivo.nombre || 'foto', b.archivo.mime || 'application/octet-stream', b.archivo.data); sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`); }
    else if (b.quitarArchivo) { sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL'); }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_carteleria SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Cartel no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/carteleria/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_carteleria WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Cartel no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/carteleria/:id/archivo', archivoHandler('chs_carteleria'));

// ───────────────────────── Evidencias de Mejoras ─────────────────────────
const mapEvi = (r) => ({ id: r.id, descripcion: r.descripcion, motivo: r.motivo, fecha: r.fecha, responsable: r.responsable, estado: r.estado, resultado: r.resultado, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/evidencias', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, descripcion, motivo, fecha, responsable, estado, resultado, archivo_nombre, created_by, created_at FROM chs_evidencias ORDER BY fecha DESC NULLS LAST, id DESC');
    res.json(rows.map(mapEvi));
  } catch (e) { next(e); }
});

router.post('/evidencias', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_evidencias (descripcion, motivo, fecha, responsable, estado, resultado, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.descripcion || null, b.motivo || null, b.fecha || null, b.responsable || null, b.estado || 'Implementada', b.resultado || null, an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/evidencias/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['descripcion=$1', 'motivo=$2', 'fecha=$3', 'responsable=$4', 'estado=$5', 'resultado=$6', 'updated_at=now()'];
    const params = [b.descripcion || null, b.motivo || null, b.fecha || null, b.responsable || null, b.estado || 'Implementada', b.resultado || null];
    if (b.archivo && b.archivo.data) { params.push(b.archivo.nombre || 'evidencia', b.archivo.mime || 'application/octet-stream', b.archivo.data); sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`); }
    else if (b.quitarArchivo) { sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL'); }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_evidencias SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Evidencia no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/evidencias/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_evidencias WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Evidencia no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/evidencias/:id/archivo', archivoHandler('chs_evidencias'));

export default router;
