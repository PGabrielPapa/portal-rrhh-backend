// Comité de Higiene y Seguridad (REG-002-CHS) — endpoints del submódulo.
// Acceso: integrantes del comité (tilde data.comite_hys) o RR.HH./Admin.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { mimeSeguro } from '../lib/adjuntos.js';

const router = Router();
router.use(requireAuth);

async function requireComite(req, res, next) {
  try {
    const u = req.user || {};
    // Persona del Comité (login por DNI sin ser empleado).
    if (u.role === 'comite') {
      if (u.acceso === 'full') return next();
      if (u.acceso === 'dashboard') {
        const path = String(req.originalUrl || '').split('?')[0];
        if (/\/dashboard$/.test(path)) return next();
        return res.status(403).json({ error: 'Acceso limitado al panel de indicadores' });
      }
      return res.status(403).json({ error: 'Acceso restringido' });
    }
    if (['rrhh', 'admin'].includes(u.role)) return next();
    const { rows } = await query("SELECT (data->>'comite_hys')::boolean AS c FROM empleados WHERE id = $1", [u.id]);
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
      res.setHeader('Content-Type', mimeSeguro(r.archivo_mime));
      res.setHeader('X-Content-Type-Options', 'nosniff');
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
    const { rows } = await query(`SELECT id, fecha, tipo, responsable, sector, observaciones,
              no_conformidades AS "noConformidades", acciones, estado,
              plazo_ejecucion AS "plazoEjecucion", fecha_ejecucion AS "fechaEjecucion",
              resolucion, fecha_resolucion AS "fechaResolucion",
              archivo_nombre AS "archivoNombre", (archivo_data IS NOT NULL) AS "tieneArchivo",
              created_by, created_at
         FROM chs_auditorias ORDER BY fecha DESC NULLS LAST, id DESC`);
    res.json(rows.map(mapAud));
  } catch (e) { next(e); }
});

router.post('/auditorias', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_auditorias (fecha, tipo, responsable, sector, observaciones, no_conformidades, acciones, estado, plazo_ejecucion, fecha_ejecucion, resolucion, fecha_resolucion, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [b.fecha || null, b.tipo || null, b.responsable || null, b.sector || null, b.observaciones || null, b.noConformidades || null, JSON.stringify(b.acciones || []), b.estado || 'Abierta', b.plazoEjecucion || null, b.fechaEjecucion || null, b.resolucion || null, b.fechaResolucion || null, an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/auditorias/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['fecha=$1', 'tipo=$2', 'responsable=$3', 'sector=$4', 'observaciones=$5', 'no_conformidades=$6', 'acciones=$7', 'estado=$8', 'plazo_ejecucion=$9', 'fecha_ejecucion=$10', 'resolucion=$11', 'fecha_resolucion=$12', 'updated_at=now()'];
    const params = [b.fecha || null, b.tipo || null, b.responsable || null, b.sector || null, b.observaciones || null, b.noConformidades || null, JSON.stringify(b.acciones || []), b.estado || 'Abierta', b.plazoEjecucion || null, b.fechaEjecucion || null, b.resolucion || null, b.fechaResolucion || null];
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

// ───────────────────────── Matriz de Riesgos ─────────────────────────
const mapRie = (r) => ({ id: r.id, proceso: r.proceso, sector: r.sector, descripcion: r.descripcion, riesgos: r.riesgos, medidas: r.medidas, eppObligatorio: r.epp_obligatorio, responsableRevision: r.responsable_revision, fechaRevision: r.fecha_revision, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/riesgos', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, proceso, sector, descripcion, riesgos, medidas, epp_obligatorio, responsable_revision, fecha_revision, archivo_nombre, created_by, created_at FROM chs_riesgos ORDER BY proceso ASC NULLS LAST, id DESC');
    res.json(rows.map(mapRie));
  } catch (e) { next(e); }
});

router.post('/riesgos', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_riesgos (proceso, sector, descripcion, riesgos, medidas, epp_obligatorio, responsable_revision, fecha_revision, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [b.proceso || null, b.sector || null, b.descripcion || null, b.riesgos || null, b.medidas || null, b.eppObligatorio || null, b.responsableRevision || null, b.fechaRevision || null, an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/riesgos/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['proceso=$1', 'sector=$2', 'descripcion=$3', 'riesgos=$4', 'medidas=$5', 'epp_obligatorio=$6', 'responsable_revision=$7', 'fecha_revision=$8', 'updated_at=now()'];
    const params = [b.proceso || null, b.sector || null, b.descripcion || null, b.riesgos || null, b.medidas || null, b.eppObligatorio || null, b.responsableRevision || null, b.fechaRevision || null];
    if (b.archivo && b.archivo.data) { params.push(b.archivo.nombre || 'matriz', b.archivo.mime || 'application/octet-stream', b.archivo.data); sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`); }
    else if (b.quitarArchivo) { sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL'); }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_riesgos SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/riesgos/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_riesgos WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/riesgos/:id/archivo', archivoHandler('chs_riesgos'));

// ───────────────────────── Dashboard de indicadores ─────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const one = async (sql) => Number((await query(sql)).rows[0].n) || 0;
    const out = {};
    out.siniestrosTotal = await one("SELECT count(*)::int n FROM chs_siniestros");
    out.siniestrosAbiertos = await one("SELECT count(*)::int n FROM chs_siniestros WHERE estado <> 'Cerrado'");
    out.siniestrosPorTipo = (await query("SELECT COALESCE(tipo,'(sin tipo)') tipo, count(*)::int n FROM chs_siniestros GROUP BY tipo ORDER BY n DESC")).rows;
    out.siniestrosPorMes = (await query("SELECT to_char(date_trunc('month', fecha),'YYYY-MM') mes, count(*)::int n FROM chs_siniestros WHERE fecha >= (CURRENT_DATE - INTERVAL '11 months') GROUP BY 1 ORDER BY 1")).rows;
    out.ncAbiertas = await one("SELECT count(*)::int n FROM chs_noconf WHERE estado <> 'Cerrada'");
    out.ncCerradas = await one("SELECT count(*)::int n FROM chs_noconf WHERE estado = 'Cerrada'");
    out.medVencidas = await one("SELECT count(*)::int n FROM chs_mediciones WHERE fecha_vencimiento < CURRENT_DATE");
    out.medPorVencer = await one("SELECT count(*)::int n FROM chs_mediciones WHERE fecha_vencimiento >= CURRENT_DATE AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '30 days'");
    out.medVigentes = await one("SELECT count(*)::int n FROM chs_mediciones WHERE fecha_vencimiento > CURRENT_DATE + INTERVAL '30 days'");
    out.medProximas = (await query("SELECT tipo, fecha_vencimiento FROM chs_mediciones WHERE fecha_vencimiento IS NOT NULL AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '30 days' ORDER BY fecha_vencimiento ASC LIMIT 10")).rows;
    out.audTotal = await one("SELECT count(*)::int n FROM chs_auditorias");
    out.audAbiertas = await one("SELECT count(*)::int n FROM chs_auditorias WHERE estado <> 'Cerrada'");
    const accAud = await one("SELECT COALESCE(sum(c),0)::int n FROM (SELECT (SELECT count(*) FROM jsonb_array_elements(acciones) a WHERE a->>'estado' <> 'Cumplida') c FROM chs_auditorias) t");
    const accMin = await one("SELECT COALESCE(sum(c),0)::int n FROM (SELECT (SELECT count(*) FROM jsonb_array_elements(acciones) a WHERE a->>'estado' <> 'Cumplida') c FROM chs_minutas) t");
    out.accionesPendientes = accAud + accMin + out.ncAbiertas;
    out.cartReponer = await one("SELECT count(*)::int n FROM chs_carteleria WHERE estado_conservacion IN ('Malo','A reponer')");
    // Habilitaciones: el estado se calcula con el mismo criterio que el panel.
    const habEstado = `SELECT ${ESTADO_HAB_SQL} AS e FROM chs_habilitaciones h`;
    out.habTotal = await one('SELECT count(*)::int n FROM chs_habilitaciones');
    out.habVencidas = await one(`SELECT count(*)::int n FROM (${habEstado}) t WHERE e = 'Vencida'`);
    out.habPorVencer = await one(`SELECT count(*)::int n FROM (${habEstado}) t WHERE e = 'Por vencer'`);
    out.habEnTramite = await one(`SELECT count(*)::int n FROM (${habEstado}) t WHERE e IN ('En trámite','En tramite')`);
    out.habProximas = (await query(
      `SELECT h.establecimiento, h.tipo, h.fecha_vencimiento, ${ESTADO_HAB_SQL} AS estado,
        (h.fecha_vencimiento - CURRENT_DATE) AS dias
       FROM chs_habilitaciones h
       WHERE h.fecha_vencimiento IS NOT NULL
         AND h.estado NOT IN ('No aplica')
         AND ${ESTADO_HAB_SQL} IN ('Vencida', 'Por vencer')
       ORDER BY h.fecha_vencimiento ASC LIMIT 12`)).rows;
    out.evidencias = await one("SELECT count(*)::int n FROM chs_evidencias");
    out.minutas = await one("SELECT count(*)::int n FROM chs_minutas");
    res.json(out);
  } catch (e) { next(e); }
});

// ───────────────────────── Plan Anual de Capacitaciones ─────────────────────────
const mapCap = (r) => ({ id: r.id, capacitacion: r.capacitacion, empresa: r.empresa, sector: r.sector, fecha: r.fecha, temario: r.temario, asistentes: r.asistentes, evaluacion: r.evaluacion, estado: r.estado, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/capacitaciones', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, capacitacion, empresa, sector, fecha, temario, asistentes, evaluacion, estado, archivo_nombre, created_by, created_at FROM chs_capacitaciones ORDER BY fecha DESC NULLS LAST, id DESC');
    res.json(rows.map(mapCap));
  } catch (e) { next(e); }
});

router.post('/capacitaciones', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_capacitaciones (capacitacion, empresa, sector, fecha, temario, asistentes, evaluacion, estado, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [b.capacitacion || null, b.empresa || null, b.sector || null, b.fecha || null, b.temario || null, b.asistentes || null, b.evaluacion || null, b.estado || 'Pendiente', an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/capacitaciones/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['capacitacion=$1', 'empresa=$2', 'sector=$3', 'fecha=$4', 'temario=$5', 'asistentes=$6', 'evaluacion=$7', 'estado=$8', 'updated_at=now()'];
    const params = [b.capacitacion || null, b.empresa || null, b.sector || null, b.fecha || null, b.temario || null, b.asistentes || null, b.evaluacion || null, b.estado || 'Pendiente'];
    if (b.archivo && b.archivo.data) { params.push(b.archivo.nombre || 'registro', b.archivo.mime || 'application/octet-stream', b.archivo.data); sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`); }
    else if (b.quitarArchivo) { sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL'); }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_capacitaciones SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Capacitación no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/capacitaciones/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_capacitaciones WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Capacitación no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/capacitaciones/:id/archivo', archivoHandler('chs_capacitaciones'));

// ───────────────────────── EPP: matriz por puesto ─────────────────────────
const mapEppM = (r) => ({ id: r.id, puesto: r.puesto, elementos: r.elementos, observaciones: r.observaciones, createdBy: r.created_by, createdAt: r.created_at });

router.get('/epp-matriz', async (req, res, next) => {
  try { const { rows } = await query('SELECT id, puesto, elementos, observaciones, created_by, created_at FROM chs_epp_matriz ORDER BY puesto ASC NULLS LAST, id DESC'); res.json(rows.map(mapEppM)); }
  catch (e) { next(e); }
});

router.post('/epp-matriz', async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows } = await query('INSERT INTO chs_epp_matriz (puesto, elementos, observaciones, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [b.puesto || null, b.elementos || null, b.observaciones || null, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/epp-matriz/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE chs_epp_matriz SET puesto=$1, elementos=$2, observaciones=$3, updated_at=now() WHERE id=$4 RETURNING id', [b.puesto || null, b.elementos || null, b.observaciones || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/epp-matriz/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM chs_epp_matriz WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ───────────────────────── EPP: registro de entregas ─────────────────────────
const mapEppE = (r) => ({ id: r.id, empleadoId: r.empleado_id, empleadoNom: r.empleado_nom, empleadoLeg: r.leg_num, puesto: r.puesto, elementos: r.elementos, fechaEntrega: r.fecha_entrega, fechaReposicion: r.fecha_reposicion, observaciones: r.observaciones, archivoNombre: r.archivo_nombre, tieneArchivo: !!r.archivo_nombre, createdBy: r.created_by, createdAt: r.created_at });

router.get('/epp-entregas', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.*, e.nom AS empleado_nom, e.leg_num FROM chs_epp_entregas s LEFT JOIN empleados e ON e.id=s.empleado_id ORDER BY s.fecha_entrega DESC NULLS LAST, s.id DESC`);
    res.json(rows.map(mapEppE));
  } catch (e) { next(e); }
});

router.post('/epp-entregas', async (req, res, next) => {
  try {
    const b = req.body || {}; const [an, am, ad] = archivoCols(b.archivo);
    const { rows } = await query(
      `INSERT INTO chs_epp_entregas (empleado_id, puesto, elementos, fecha_entrega, fecha_reposicion, observaciones, archivo_nombre, archivo_mime, archivo_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.empleadoId || null, b.puesto || null, b.elementos || null, b.fechaEntrega || null, b.fechaReposicion || null, b.observaciones || null, an, am, ad, req.user.dni]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.put('/epp-entregas/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = ['empleado_id=$1', 'puesto=$2', 'elementos=$3', 'fecha_entrega=$4', 'fecha_reposicion=$5', 'observaciones=$6', 'updated_at=now()'];
    const params = [b.empleadoId || null, b.puesto || null, b.elementos || null, b.fechaEntrega || null, b.fechaReposicion || null, b.observaciones || null];
    if (b.archivo && b.archivo.data) { params.push(b.archivo.nombre || 'constancia', b.archivo.mime || 'application/octet-stream', b.archivo.data); sets.push(`archivo_nombre=$${params.length - 2}`, `archivo_mime=$${params.length - 1}`, `archivo_data=$${params.length}`); }
    else if (b.quitarArchivo) { sets.push('archivo_nombre=NULL', 'archivo_mime=NULL', 'archivo_data=NULL'); }
    params.push(req.params.id);
    const r = await query(`UPDATE chs_epp_entregas SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'Entrega no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/epp-entregas/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM chs_epp_entregas WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'Entrega no encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

router.get('/epp-entregas/:id/archivo', archivoHandler('chs_epp_entregas'));

// ───────────────────────── Habilitaciones por establecimiento ─────────────────────────
// El estado efectivo se calcula en la consulta (no se persiste): así una habilitación
// pasa sola a "Por vencer" y a "Vencida" sin que nadie tenga que volver a guardarla.
// 'En trámite' y 'No aplica' son decisiones manuales y se respetan tal cual.
const ESTADO_HAB_SQL = `CASE
    WHEN h.estado IN ('En trámite', 'En tramite', 'No aplica') THEN h.estado
    WHEN h.fecha_vencimiento IS NULL THEN 'Vigente'
    WHEN h.fecha_vencimiento < CURRENT_DATE THEN 'Vencida'
    WHEN h.fecha_vencimiento <= CURRENT_DATE + (COALESCE(h.dias_alerta, 60) || ' days')::interval THEN 'Por vencer'
    ELSE 'Vigente'
  END`;
const ESTADOS_HAB_MANUALES = ['Automático', 'Automatico', 'En trámite', 'En tramite', 'No aplica'];
const estadoHabManual = (v) => (ESTADOS_HAB_MANUALES.includes(String(v || '').trim()) ? String(v).trim() : 'Automático');
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const ent = (v) => (v === '' || v === null || v === undefined || Number.isNaN(parseInt(v, 10)) ? null : parseInt(v, 10));

const mapHab = (r) => ({
  id: r.id, establecimiento: r.establecimiento, empresa: r.empresa, tipo: r.tipo, organismo: r.organismo,
  nroExpediente: r.nro_expediente, nroHabilitacion: r.nro_habilitacion,
  fechaOtorgamiento: r.fecha_otorgamiento, fechaVencimiento: r.fecha_vencimiento,
  diasAlerta: r.dias_alerta, estado: r.estado_efectivo, estadoManual: r.estado,
  diasRestantes: r.dias_restantes === null || r.dias_restantes === undefined ? null : Number(r.dias_restantes),
  responsable: r.responsable, tramitadoPor: r.tramitado_por,
  costo: r.costo === null ? null : Number(r.costo),
  superficie: r.superficie === null ? null : Number(r.superficie),
  capacidad: r.capacidad, rubro: r.rubro, condiciones: r.condiciones, observaciones: r.observaciones,
  cantDocs: Number(r.cant_docs) || 0, cantRenovaciones: Number(r.cant_renov) || 0,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const SELECT_HAB = `SELECT h.*, ${ESTADO_HAB_SQL} AS estado_efectivo,
    CASE WHEN h.fecha_vencimiento IS NULL THEN NULL ELSE (h.fecha_vencimiento - CURRENT_DATE) END AS dias_restantes,
    (SELECT count(*) FROM chs_hab_docs d WHERE d.habilitacion_id = h.id)::int AS cant_docs,
    (SELECT count(*) FROM chs_hab_historial x WHERE x.habilitacion_id = h.id)::int AS cant_renov
  FROM chs_habilitaciones h`;

router.get('/habilitaciones', async (req, res, next) => {
  try {
    const { rows } = await query(`${SELECT_HAB}
      ORDER BY CASE ${ESTADO_HAB_SQL}
        WHEN 'Vencida' THEN 1 WHEN 'Por vencer' THEN 2 WHEN 'En trámite' THEN 3 WHEN 'En tramite' THEN 3 WHEN 'Vigente' THEN 4 ELSE 5 END,
        h.fecha_vencimiento ASC NULLS LAST, h.establecimiento ASC, h.id DESC`);
    res.json(rows.map(mapHab));
  } catch (e) { next(e); }
});

// Campos del formulario -> parámetros del INSERT/UPDATE (mismo orden en ambos).
function habParams(b) {
  return [
    String(b.establecimiento || '').trim(), b.empresa || null, String(b.tipo || '').trim(), b.organismo || null,
    b.nroExpediente || null, b.nroHabilitacion || null,
    b.fechaOtorgamiento || null, b.fechaVencimiento || null,
    ent(b.diasAlerta) ?? 60, estadoHabManual(b.estadoManual ?? b.estado),
    b.responsable || null, b.tramitadoPor || null,
    num(b.costo), num(b.superficie), ent(b.capacidad),
    b.rubro || null, b.condiciones || null, b.observaciones || null,
  ];
}

async function guardarDocs(habId, docs, dni) {
  for (const d of (Array.isArray(docs) ? docs : []).slice(0, 20)) {
    if (!d || !d.data) continue;
    await query(
      'INSERT INTO chs_hab_docs (habilitacion_id, descripcion, archivo_nombre, archivo_mime, archivo_data, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [habId, d.descripcion || null, d.nombre || 'documento', d.mime || 'application/octet-stream', d.data, dni]);
  }
}

router.post('/habilitaciones', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!String(b.establecimiento || '').trim() || !String(b.tipo || '').trim()) {
      return res.status(400).json({ error: 'Establecimiento y tipo son obligatorios' });
    }
    const p = habParams(b);
    const { rows } = await query(
      `INSERT INTO chs_habilitaciones (establecimiento, empresa, tipo, organismo, nro_expediente, nro_habilitacion,
        fecha_otorgamiento, fecha_vencimiento, dias_alerta, estado, responsable, tramitado_por,
        costo, superficie, capacidad, rubro, condiciones, observaciones, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [...p, req.user.dni]);
    const id = rows[0].id;
    await guardarDocs(id, b.docs, req.user.dni);
    res.status(201).json({ ok: true, id });
  } catch (e) { next(e); }
});

router.put('/habilitaciones/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!String(b.establecimiento || '').trim() || !String(b.tipo || '').trim()) {
      return res.status(400).json({ error: 'Establecimiento y tipo son obligatorios' });
    }
    const prev = (await query('SELECT fecha_otorgamiento, fecha_vencimiento, nro_expediente, nro_habilitacion FROM chs_habilitaciones WHERE id=$1', [req.params.id])).rows[0];
    if (!prev) return res.status(404).json({ error: 'Habilitación no encontrada' });
    const p = habParams(b);
    await query(
      `UPDATE chs_habilitaciones SET establecimiento=$1, empresa=$2, tipo=$3, organismo=$4, nro_expediente=$5,
        nro_habilitacion=$6, fecha_otorgamiento=$7, fecha_vencimiento=$8, dias_alerta=$9, estado=$10,
        responsable=$11, tramitado_por=$12, costo=$13, superficie=$14, capacidad=$15, rubro=$16,
        condiciones=$17, observaciones=$18, updated_at=now() WHERE id=$19`,
      [...p, req.params.id]);
    // Si cambió la vigencia por edición directa, queda igual asentado en el historial:
    // el objetivo es que ninguna renovación se pierda por sobreescritura.
    const iso = (d) => (d ? String(d).slice(0, 10) : null);
    const vencAnt = iso(prev.fecha_vencimiento); const vencNue = iso(b.fechaVencimiento);
    const otorgAnt = iso(prev.fecha_otorgamiento); const otorgNue = iso(b.fechaOtorgamiento);
    if (vencAnt !== vencNue || otorgAnt !== otorgNue) {
      await query(
        `INSERT INTO chs_hab_historial (habilitacion_id, otorg_anterior, otorg_nuevo, venc_anterior, venc_nuevo,
          nro_expediente, nro_habilitacion, costo, observaciones, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.params.id, otorgAnt, otorgNue, vencAnt, vencNue, b.nroExpediente || null, b.nroHabilitacion || null,
          num(b.costo), 'Actualización de vigencia desde la ficha', req.user.dni]);
    }
    await guardarDocs(req.params.id, b.docs, req.user.dni);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/habilitaciones/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_habilitaciones WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Habilitación no encontrada' });
    res.json({ ok: true }); // docs e historial caen por ON DELETE CASCADE
  } catch (e) { next(e); }
});

// Renovación explícita: mueve la vigencia y deja el tramo anterior asentado.
router.post('/habilitaciones/:id/renovar', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.fechaVencimiento) return res.status(400).json({ error: 'Indicá la nueva fecha de vencimiento' });
    const prev = (await query('SELECT fecha_otorgamiento, fecha_vencimiento FROM chs_habilitaciones WHERE id=$1', [req.params.id])).rows[0];
    if (!prev) return res.status(404).json({ error: 'Habilitación no encontrada' });
    const iso = (d) => (d ? String(d).slice(0, 10) : null);
    await query(
      `INSERT INTO chs_hab_historial (habilitacion_id, otorg_anterior, otorg_nuevo, venc_anterior, venc_nuevo,
        nro_expediente, nro_habilitacion, costo, observaciones, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.params.id, iso(prev.fecha_otorgamiento), b.fechaOtorgamiento || null, iso(prev.fecha_vencimiento),
        b.fechaVencimiento, b.nroExpediente || null, b.nroHabilitacion || null, num(b.costo),
        b.observaciones || 'Renovación registrada', req.user.dni]);
    const sets = ['fecha_vencimiento=$1', 'estado=$2', 'updated_at=now()'];
    const params = [b.fechaVencimiento, 'Automático'];
    const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (b.fechaOtorgamiento) add('fecha_otorgamiento', b.fechaOtorgamiento);
    if (b.nroExpediente) add('nro_expediente', b.nroExpediente);
    if (b.nroHabilitacion) add('nro_habilitacion', b.nroHabilitacion);
    if (num(b.costo) !== null) add('costo', num(b.costo));
    params.push(req.params.id);
    await query(`UPDATE chs_habilitaciones SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    await guardarDocs(req.params.id, b.docs, req.user.dni);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/habilitaciones/:id/historial', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, fecha_registro, otorg_anterior, otorg_nuevo, venc_anterior, venc_nuevo,
        nro_expediente, nro_habilitacion, costo, observaciones, created_by, created_at
       FROM chs_hab_historial WHERE habilitacion_id=$1 ORDER BY fecha_registro DESC, id DESC`, [req.params.id]);
    res.json(rows.map((r) => ({
      id: r.id, fechaRegistro: r.fecha_registro, otorgAnterior: r.otorg_anterior, otorgNuevo: r.otorg_nuevo,
      vencAnterior: r.venc_anterior, vencNuevo: r.venc_nuevo, nroExpediente: r.nro_expediente,
      nroHabilitacion: r.nro_habilitacion, costo: r.costo === null ? null : Number(r.costo),
      observaciones: r.observaciones, createdBy: r.created_by, createdAt: r.created_at,
    })));
  } catch (e) { next(e); }
});

router.get('/habilitaciones/:id/docs', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, descripcion, archivo_nombre, archivo_mime, octet_length(archivo_data) AS b64_len, created_by, created_at
       FROM chs_hab_docs WHERE habilitacion_id=$1 ORDER BY id DESC`, [req.params.id]);
    res.json(rows.map((r) => ({
      id: r.id, descripcion: r.descripcion, nombre: r.archivo_nombre, mime: r.archivo_mime,
      // El dato está en base64: 4 caracteres ≈ 3 bytes del archivo original.
      bytes: r.b64_len ? Math.round((Number(r.b64_len) * 3) / 4) : 0,
      createdBy: r.created_by, createdAt: r.created_at,
    })));
  } catch (e) { next(e); }
});

router.post('/habilitaciones/:id/docs', async (req, res, next) => {
  try {
    const b = req.body || {};
    const existe = await query('SELECT 1 FROM chs_habilitaciones WHERE id=$1', [req.params.id]);
    if (!existe.rowCount) return res.status(404).json({ error: 'Habilitación no encontrada' });
    const docs = Array.isArray(b.docs) ? b.docs : (b.data ? [b] : []);
    if (!docs.length) return res.status(400).json({ error: 'Sin archivos para adjuntar' });
    await guardarDocs(req.params.id, docs, req.user.dni);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// La descarga verifica que el documento pertenezca a la habilitación del path,
// para que un id de doc suelto no habilite leer adjuntos de otro registro.
router.get('/habilitaciones/:id/docs/:docId/archivo', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT archivo_nombre, archivo_mime, archivo_data FROM chs_hab_docs WHERE id=$1 AND habilitacion_id=$2',
      [req.params.docId, req.params.id]);
    const r = rows[0];
    if (!r || !r.archivo_data) return res.status(404).json({ error: 'Sin archivo' });
    res.setHeader('Content-Type', mimeSeguro(r.archivo_mime));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${String(r.archivo_nombre || 'archivo').replace(/[^\w.\-]/g, '_')}"`);
    res.send(Buffer.from(r.archivo_data, 'base64'));
  } catch (e) { next(e); }
});

router.delete('/habilitaciones/:id/docs/:docId', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM chs_hab_docs WHERE id=$1 AND habilitacion_id=$2 RETURNING id', [req.params.docId, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Documento no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
