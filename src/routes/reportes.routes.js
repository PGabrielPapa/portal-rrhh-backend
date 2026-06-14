import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('rrhh', 'admin'));

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function recibosPeriodo(anio, mes, empresa) {
  const cond = ['r.anio = $1', 'r.mes = $2'], pr = [Number(anio), Number(mes)];
  if (empresa) { pr.push(empresa); cond.push(`em.nombre = $${pr.length}`); }
  const { rows } = await query(
    `SELECT r.data, r.tipo, e.nom, e.leg_num, e.cuil, e.data AS edata, em.nombre AS empresa
       FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id
      WHERE ${cond.join(' AND ')} ORDER BY em.nombre, e.nom`, pr);
  return rows;
}
const aporteDe = (desc, re) => (desc || []).filter((d) => re.test(d.concepto)).reduce((s, d) => s + Number(d.monto || 0), 0);

// GET /api/reportes/libro-sueldos?anio=&mes=&empresa=  (Libro Art. 52 LCT)
router.get('/libro-sueldos', async (req, res, next) => {
  try {
    const rows = await recibosPeriodo(req.query.anio, req.query.mes, req.query.empresa);
    const items = rows.map((r) => {
      const t = r.data?.totales || {};
      return {
        empresa: r.empresa, legNum: r.leg_num, nom: r.nom, cuil: r.cuil, tipo: r.tipo,
        remunerativo: r2(t.totalRemun || 0), noRemunerativo: r2(t.totalNoRem || 0), exento: r2(t.totalExento || 0),
        descuentos: r2(t.totalDescuentos || 0), neto: r2(t.neto || 0),
        haberes: r.data?.haberes || [], desc: r.data?.descuentos || [],
      };
    });
    const tot = items.reduce((a, x) => ({ remunerativo: a.remunerativo + x.remunerativo, noRemunerativo: a.noRemunerativo + x.noRemunerativo, descuentos: a.descuentos + x.descuentos, neto: a.neto + x.neto }), { remunerativo: 0, noRemunerativo: 0, descuentos: 0, neto: 0 });
    res.json({ items, totales: { remunerativo: r2(tot.remunerativo), noRemunerativo: r2(tot.noRemunerativo), descuentos: r2(tot.descuentos), neto: r2(tot.neto), cant: items.length } });
  } catch (e) { next(e); }
});

// GET /api/reportes/f931  (DDJJ SUSS — bases y aportes/contribuciones por empleado)
router.get('/f931', async (req, res, next) => {
  try {
    const rows = await recibosPeriodo(req.query.anio, req.query.mes, req.query.empresa);
    const items = rows.map((r) => {
      const t = r.data?.totales || {}, d = r.data?.descuentos || [], c = r.data?.composicion?.cargas || {};
      const aJub = aporteDe(d, /Jubilación/i), aOS = aporteDe(d, /Obra Social|ANSSAL/i), aPami = aporteDe(d, /INSSJP/i), aSind = aporteDe(d, /Cuota sindical/i);
      const contrib = r.data?.costoEmpleador?.totalContrib || 0;
      return {
        empresa: r.empresa, legNum: r.leg_num, nom: r.nom, cuil: r.cuil,
        remunerativo: r2(t.totalRemun || 0), noRemunerativo: r2(t.totalNoRem || 0),
        aporteJub: r2(aJub), aporteOS: r2(aOS + aPami), aporteSind: r2(aSind),
        contribuciones: r2(contrib),
      };
    });
    const sum = (k) => r2(items.reduce((a, x) => a + x[k], 0));
    res.json({ items, totales: { cant: items.length, remunerativo: sum('remunerativo'), noRemunerativo: sum('noRemunerativo'), aporteJub: sum('aporteJub'), aporteOS: sum('aporteOS'), aporteSind: sum('aporteSind'), contribuciones: sum('contribuciones') } });
  } catch (e) { next(e); }
});

// GET /api/reportes/asiento  (asiento contable por empresa)
router.get('/asiento', async (req, res, next) => {
  try {
    const rows = await recibosPeriodo(req.query.anio, req.query.mes, req.query.empresa);
    const porEmpresa = {};
    for (const r of rows) {
      const t = r.data?.totales || {}, d = r.data?.descuentos || [], ce = r.data?.costoEmpleador || {};
      const e = porEmpresa[r.empresa] || (porEmpresa[r.empresa] = { remun: 0, noRem: 0, neto: 0, aportes: 0, contrib: 0, ganancias: 0 });
      e.remun += Number(t.totalRemun || 0); e.noRem += Number(t.totalNoRem || 0); e.neto += Number(t.neto || 0);
      e.aportes += aporteDe(d, /Jubilación|Obra Social|ANSSAL|INSSJP|Cuota sindical/i);
      e.ganancias += aporteDe(d, /Ganancias/i);
      e.contrib += Number(ce.totalContrib || 0);
    }
    const asientos = Object.entries(porEmpresa).map(([empresa, e]) => {
      const lineas = [
        { cuenta: 'Sueldos y jornales', debe: r2(e.remun), haber: 0 },
        { cuenta: 'Sumas no remunerativas', debe: r2(e.noRem), haber: 0 },
        { cuenta: 'Cargas sociales (contribuciones)', debe: r2(e.contrib), haber: 0 },
        { cuenta: 'Sueldos a pagar', debe: 0, haber: r2(e.neto) },
        { cuenta: 'Aportes y retenciones a depositar', debe: 0, haber: r2(e.aportes) },
        { cuenta: 'Retención Impuesto a las Ganancias', debe: 0, haber: r2(e.ganancias) },
        { cuenta: 'Contribuciones a depositar', debe: 0, haber: r2(e.contrib) },
      ].filter((l) => l.debe !== 0 || l.haber !== 0);
      const totalDebe = r2(lineas.reduce((s, l) => s + l.debe, 0));
      const totalHaber = r2(lineas.reduce((s, l) => s + l.haber, 0));
      return { empresa, lineas, totalDebe, totalHaber, balanceado: Math.abs(totalDebe - totalHaber) < 0.5 };
    });
    res.json({ asientos });
  } catch (e) { next(e); }
});

const contribDe = (cm, re) => (cm || []).filter((c) => re.test(c.concepto)).reduce((s, c) => s + Number(c.monto || 0), 0);

// GET /api/reportes/ddjj-sindical?anio=&mes=&empresa=  (cuotas por sindicato)
router.get('/ddjj-sindical', async (req, res, next) => {
  try {
    const rows = await recibosPeriodo(req.query.anio, req.query.mes, req.query.empresa);
    const grupos = {};
    for (const r of rows) {
      const sind = String(r.edata?.cod_sindicato || '').toUpperCase().trim() || 'SIN CONVENIO / FC';
      const cuotaEmp = aporteDe(r.data?.descuentos, /Cuota sindical/i);
      const cuotaPat = contribDe(r.data?.costoEmpleador?.contribuciones, /sindical/i);
      const baseRem = Number(r.data?.totales?.totalRemun || 0);
      const g = grupos[sind] || (grupos[sind] = { sindicato: sind, items: [], totales: { baseRem: 0, cuotaEmp: 0, cuotaPat: 0, total: 0 } });
      g.items.push({ legNum: r.leg_num, nom: r.nom, cuil: r.cuil, empresa: r.empresa, baseRem: r2(baseRem), cuotaEmp: r2(cuotaEmp), cuotaPat: r2(cuotaPat), total: r2(cuotaEmp + cuotaPat) });
      g.totales.baseRem += baseRem; g.totales.cuotaEmp += cuotaEmp; g.totales.cuotaPat += cuotaPat; g.totales.total += cuotaEmp + cuotaPat;
    }
    const out = Object.values(grupos).map((g) => ({ ...g, totales: { baseRem: r2(g.totales.baseRem), cuotaEmp: r2(g.totales.cuotaEmp), cuotaPat: r2(g.totales.cuotaPat), total: r2(g.totales.total) } }))
      .sort((a, b) => a.sindicato.localeCompare(b.sindicato));
    const tot = out.reduce((a, g) => ({ cuotaEmp: a.cuotaEmp + g.totales.cuotaEmp, cuotaPat: a.cuotaPat + g.totales.cuotaPat, total: a.total + g.totales.total }), { cuotaEmp: 0, cuotaPat: 0, total: 0 });
    res.json({ grupos: out, totales: { cuotaEmp: r2(tot.cuotaEmp), cuotaPat: r2(tot.cuotaPat), total: r2(tot.total) } });
  } catch (e) { next(e); }
});

// GET /api/reportes/documentos?empresa=&tipo=  (repositorio de documentos generados/firmados)
router.get('/documentos', async (req, res, next) => {
  try {
    const { empresa, tipo } = req.query;
    const out = [];
    const filtEmp = (em) => !empresa || em === empresa;
    if (!tipo || tipo === 'sancion') {
      const sanc = (await query(
        `SELECT s.id, s.tipo, s.falta, s.fecha, s.fecha_notificacion, s.estado, e.nom, e.leg_num, em.nombre AS empresa
           FROM sanciones s JOIN empleados e ON e.id=s.empleado_id JOIN empresas em ON em.id=e.empresa_id
          WHERE s.estado IN ('aplicada','notificada') OR s.fecha_notificacion IS NOT NULL ORDER BY s.fecha DESC`)).rows;
      for (const x of sanc) if (filtEmp(x.empresa)) out.push({ tipo: 'Sanción', refId: x.id, modulo: 'sanciones', empleado: x.nom, legNum: x.leg_num, empresa: x.empresa, detalle: `${x.tipo || ''}${x.falta ? ' — ' + x.falta : ''}`, fecha: x.fecha_notificacion || x.fecha, estado: x.estado });
    }
    if (!tipo || tipo === 'certificado') {
      const cert = (await query(
        `SELECT c.id, c.destinatario, c.estado, c.generado_at, c.created_at, e.nom, e.leg_num, em.nombre AS empresa
           FROM certificados c JOIN empleados e ON e.id=c.empleado_id JOIN empresas em ON em.id=e.empresa_id
          WHERE c.estado='generado' ORDER BY c.generado_at DESC NULLS LAST`)).rows;
      for (const x of cert) if (filtEmp(x.empresa)) out.push({ tipo: 'Certificado de trabajo', refId: x.id, modulo: 'cert-trabajo-rrhh', empleado: x.nom, legNum: x.leg_num, empresa: x.empresa, detalle: x.destinatario ? `Para: ${x.destinatario}` : '', fecha: x.generado_at || x.created_at, estado: x.estado });
    }
    if (!tipo || tipo === 'licencia') {
      const lic = (await query(
        `SELECT l.id, l.tipo, l.desde, l.estado, l.justificacion, (l.comprobante_data IS NOT NULL) AS tiene, e.nom, e.leg_num, em.nombre AS empresa
           FROM licencias l JOIN empleados e ON e.id=l.empleado_id JOIN empresas em ON em.id=e.empresa_id
          WHERE l.comprobante_data IS NOT NULL OR l.estado='aprobada' ORDER BY l.desde DESC`)).rows;
      for (const x of lic) if (filtEmp(x.empresa)) out.push({ tipo: 'Licencia', refId: x.id, modulo: 'licencias-rrhh', empleado: x.nom, legNum: x.leg_num, empresa: x.empresa, detalle: `${x.tipo}${x.tiene ? ' (con comprobante)' : ''}`, fecha: x.desde, estado: x.estado });
    }
    out.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    res.json(out);
  } catch (e) { next(e); }
});

export default router;
