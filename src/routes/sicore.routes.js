import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { generarSicore, disenoVigente, autoActualizarSicoreDiseno } from '../lib/sicore.js';

const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Junta retenciones y devoluciones de Ganancias 4ª de un período, por empleado.
async function items(anio, mes, empresa) {
  const params = [Number(anio), Number(mes)];
  let filtro = '';
  if (empresa) { params.push(empresa); filtro = ` AND em.nombre = $${params.length}`; }
  const { rows } = await query(
    `SELECT e.cuil, e.nom, e.leg_num, em.nombre AS empresa, r.tipo, r.data
       FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id
      WHERE r.anio=$1 AND r.mes=$2${filtro}`, params);
  const porCuil = {};
  for (const row of rows) {
    const cuil = (row.cuil || '').replace(/\D/g, '');
    const d = row.data || {};
    let ret = 0, dev = 0;
    for (const x of (d.descuentos || [])) {
      if (/ganancias/i.test(x.concepto || '')) { const m = Number(x.monto) || 0; if (m >= 0) ret += m; else dev += -m; }
    }
    for (const h of (d.haberes || [])) {
      if (/devoluci.*ganancia/i.test(h.concepto || '')) dev += Number(h.monto) || 0;
    }
    if (ret === 0 && dev === 0) continue;
    const k = cuil || `leg${row.leg_num}`;
    porCuil[k] = porCuil[k] || { cuil, nom: row.nom, legNum: row.leg_num, empresa: row.empresa, retencion: 0, devolucion: 0 };
    porCuil[k].retencion += ret; porCuil[k].devolucion += dev;
  }
  const ultimoDia = new Date(Number(anio), Number(mes), 0).getDate();
  const fecha = `${anio}-${String(mes).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
  return Object.values(porCuil).map((x, i) => ({
    ...x, retencion: r2(x.retencion), devolucion: r2(x.devolucion), neto: r2(x.retencion - x.devolucion),
    fecha, comprobanteNro: String(i + 1),
  }));
}

// GET /api/sicore/ganancias/preview?anio=&mes=&empresa=
router.get('/ganancias/preview', async (req, res, next) => {
  try {
    const its = await items(req.query.anio, req.query.mes, req.query.empresa || null);
    const g = generarSicore(its.map((x) => ({ cuil: x.cuil, fecha: x.fecha, importe: x.neto, comprobanteNro: x.comprobanteNro })));
    res.json({ items: its, resumen: g.resumen });
  } catch (e) { next(e); }
});

// GET /api/sicore/ganancias/txt?anio=&mes=&empresa=  → archivo SICORE (ancho fijo)
router.get('/ganancias/txt', async (req, res, next) => {
  try {
    const its = await items(req.query.anio, req.query.mes, req.query.empresa || null);
    const g = generarSicore(its.map((x) => ({ cuil: x.cuil, fecha: x.fecha, importe: x.neto, comprobanteNro: x.comprobanteNro })),
      { impuesto: req.query.impuesto || undefined, regimen: req.query.regimen || undefined });
    const dv = disenoVigente();
    await query('INSERT INTO sicore_generaciones (version_diseno, modo, anio, mes, empresa, cantidad, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [dv.version, dv.modo, Number(req.query.anio) || null, Number(req.query.mes) || null, req.query.empresa || null, g.resumen.registros, req.user.dni]).catch(() => {});
    const fname = `SICORE_GANANCIAS_${req.query.anio}${String(req.query.mes).padStart(2, '0')}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=latin1');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(g.txt);
  } catch (e) { next(e); }
});

// GET /api/sicore/ganancias/csv?anio=&mes=&empresa=
router.get('/ganancias/csv', async (req, res, next) => {
  try {
    const its = await items(req.query.anio, req.query.mes, req.query.empresa || null);
    const head = 'CUIL;Empleado;Legajo;Empresa;Fecha;Retencion;Devolucion;Neto';
    const body = its.map((x) => [x.cuil, x.nom, x.legNum, x.empresa, x.fecha, x.retencion, x.devolucion, x.neto].join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ganancias_retenciones_${req.query.anio}${String(req.query.mes).padStart(2, '0')}.csv"`);
    res.send(head + '\n' + body + '\n');
  } catch (e) { next(e); }
});

// GET /api/sicore/diseno — verificación del diseño vigente (como el F.931/SICOSS).
//   Informa la versión/modo vigente, si cambió desde la última generación y si el
//   período consultado ya fue generado con el diseño actual (validación mensual).
router.get('/diseno', async (req, res, next) => {
  try {
    const est = await autoActualizarSicoreDiseno();   // asegura y sincroniza la fila
    const d = (await query('SELECT version, modo, descripcion, url_arca, actualizado_at, actualizado_por FROM sicore_diseno WHERE id=1')).rows[0];
    const last = (await query('SELECT version_diseno, modo, created_at FROM sicore_generaciones ORDER BY created_at DESC LIMIT 1')).rows[0] || null;
    let mesGenerado = null;
    if (req.query.anio && req.query.mes) {
      const r = (await query('SELECT version_diseno, created_at FROM sicore_generaciones WHERE anio=$1 AND mes=$2 ORDER BY created_at DESC LIMIT 1', [Number(req.query.anio), Number(req.query.mes)])).rows[0];
      if (r) mesGenerado = { version: r.version_diseno, alDia: r.version_diseno >= d.version, fecha: r.created_at };
    }
    res.json({
      version: d.version, modo: d.modo, descripcion: d.descripcion, urlArca: d.url_arca,
      actualizadoAt: d.actualizado_at, actualizadoPor: d.actualizado_por, autoActualizada: est.cambiada,
      ultimaVersion: last ? last.version_diseno : null, ultimaFecha: last ? last.created_at : null,
      primeraVez: !last, actualizado: last ? (d.version > last.version_diseno) : false,
      mesGenerado,
    });
  } catch (e) { next(e); }
});

// PATCH /api/sicore/diseno — registrar manualmente una versión nueva del diseño
// (cuando ARCA lo cambia y todavía no está en el calendario del sistema).
router.patch('/diseno', async (req, res, next) => {
  try {
    await autoActualizarSicoreDiseno();
    const b = req.body || {};
    const modo = ['SICORE', 'SIRE'].includes(b.modo) ? b.modo : null;
    const r = await query(
      `UPDATE sicore_diseno SET version=version+1, modo=COALESCE($1,modo), descripcion=COALESCE($2,descripcion),
          url_arca=COALESCE($3,url_arca), actualizado_por=$4, actualizado_at=now() WHERE id=1 RETURNING *`,
      [modo, b.descripcion || null, b.urlArca || null, req.user.dni]);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

export default router;
