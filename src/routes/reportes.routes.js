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

// Componentes de nómina agrupables en cuentas contables.
const COMPONENTES = [
  { key: 'remun', label: 'Haberes remunerativos' },
  { key: 'norem', label: 'Haberes no remunerativos' },
  { key: 'neto', label: 'Neto a pagar' },
  { key: 'aporteJub', label: 'Aporte jubilatorio (trabajador)' },
  { key: 'aporteOS', label: 'Aporte obra social / ANSSAL (trabajador)' },
  { key: 'aportePami', label: 'Aporte INSSJP–PAMI (trabajador)' },
  { key: 'aporteSind', label: 'Aporte sindical (trabajador)' },
  { key: 'ganancias', label: 'Retención Impuesto a las Ganancias' },
  { key: 'contrib', label: 'Contribuciones patronales' },
];

// Siembra el plan de cuentas por defecto la primera vez (replica el asiento clásico).
async function ensurePlan() {
  const c = await query('SELECT COUNT(*)::int AS n FROM plan_cuentas');
  if (c.rows[0].n) return;
  const def = [
    ['410100', 'Sueldos y jornales', 'debe', ['remun'], 1],
    ['410200', 'Sumas no remunerativas', 'debe', ['norem'], 2],
    ['410300', 'Cargas sociales (contribuciones)', 'debe', ['contrib'], 3],
    ['210100', 'Sueldos a pagar', 'haber', ['neto'], 4],
    ['210200', 'Aportes y retenciones a depositar', 'haber', ['aporteJub', 'aporteOS', 'aportePami', 'aporteSind'], 5],
    ['210300', 'Retención Impuesto a las Ganancias', 'haber', ['ganancias'], 6],
    ['210400', 'Contribuciones a depositar', 'haber', ['contrib'], 7],
  ];
  for (const [numero, nombre, naturaleza, comps, orden] of def)
    await query('INSERT INTO plan_cuentas (numero,nombre,naturaleza,componentes,orden) VALUES ($1,$2,$3,$4,$5)',
      [numero, nombre, naturaleza, JSON.stringify(comps), orden]);
}

// GET /api/reportes/plan-cuentas — plan + catálogo de componentes
router.get('/plan-cuentas', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensurePlan();
    const { rows } = await query('SELECT id, numero, nombre, naturaleza, componentes, orden, activo FROM plan_cuentas ORDER BY orden, numero');
    res.json({ cuentas: rows, componentes: COMPONENTES });
  } catch (e) { next(e); }
});
router.post('/plan-cuentas', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { numero, nombre, naturaleza, componentes, orden } = req.body || {};
    if (!numero || !nombre || !['debe', 'haber'].includes(naturaleza)) return res.status(400).json({ error: 'Número, nombre y naturaleza (debe/haber) son obligatorios' });
    const ins = await query('INSERT INTO plan_cuentas (numero,nombre,naturaleza,componentes,orden) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [String(numero), String(nombre), naturaleza, JSON.stringify(Array.isArray(componentes) ? componentes : []), Number(orden) || 0]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/plan-cuentas/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { numero, nombre, naturaleza, componentes, orden, activo } = req.body || {};
    const r = await query(
      `UPDATE plan_cuentas SET numero=COALESCE($1,numero), nombre=COALESCE($2,nombre), naturaleza=COALESCE($3,naturaleza),
              componentes=COALESCE($4,componentes), orden=COALESCE($5,orden), activo=COALESCE($6,activo) WHERE id=$7 RETURNING id`,
      [numero ?? null, nombre ?? null, (naturaleza === 'debe' || naturaleza === 'haber') ? naturaleza : null,
       componentes ? JSON.stringify(componentes) : null, orden != null ? Number(orden) : null, activo, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/plan-cuentas/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM plan_cuentas WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/reportes/asiento  (asiento contable por empresa)
router.get('/asiento', async (req, res, next) => {
  try {
    const rows = await recibosPeriodo(req.query.anio, req.query.mes, req.query.empresa);
    await ensurePlan();
    const plan = (await query('SELECT numero, nombre, naturaleza, componentes FROM plan_cuentas WHERE activo=true ORDER BY orden, numero')).rows;
    const porEmpresa = {};
    for (const r of rows) {
      const t = r.data?.totales || {}, d = r.data?.descuentos || [], ce = r.data?.costoEmpleador || {};
      const e = porEmpresa[r.empresa] || (porEmpresa[r.empresa] = { remun: 0, norem: 0, neto: 0, aporteJub: 0, aporteOS: 0, aportePami: 0, aporteSind: 0, ganancias: 0, contrib: 0 });
      e.remun += Number(t.totalRemun || 0); e.norem += Number(t.totalNoRem || 0); e.neto += Number(t.neto || 0);
      e.aporteJub += aporteDe(d, /Jubilación/i); e.aporteOS += aporteDe(d, /Obra Social|ANSSAL/i);
      e.aportePami += aporteDe(d, /INSSJP|PAMI/i); e.aporteSind += aporteDe(d, /sindical/i);
      e.ganancias += aporteDe(d, /Ganancias/i); e.contrib += Number(ce.totalContrib || 0);
    }
    const asientos = Object.entries(porEmpresa).map(([empresa, e]) => {
      const lineas = plan.map((c) => {
        const monto = r2((c.componentes || []).reduce((s, k) => s + Number(e[k] || 0), 0));
        return { numero: c.numero, cuenta: c.nombre, debe: c.naturaleza === 'debe' ? monto : 0, haber: c.naturaleza === 'haber' ? monto : 0 };
      }).filter((l) => l.debe !== 0 || l.haber !== 0);
      const totalDebe = r2(lineas.reduce((s, l) => s + l.debe, 0));
      const totalHaber = r2(lineas.reduce((s, l) => s + l.haber, 0));
      return { empresa, lineas, totalDebe, totalHaber, balanceado: Math.abs(totalDebe - totalHaber) < 0.5 };
    });
    res.json({ asientos });
  } catch (e) { next(e); }
});

const contribDe = (cm, re) => (cm || []).filter((c) => re.test(c.concepto)).reduce((s, c) => s + Number(c.monto || 0), 0);

// Diseño de registro vigente (lazy v1) por sindicato + jurisdicción.
async function ensureDdjjDiseno(sind, jur) {
  let r = await query('SELECT id, version, actualizado_at, descripcion FROM ddjj_disenos WHERE sindicato=$1 AND jurisdiccion=$2', [sind, jur]);
  if (!r.rows[0]) {
    await query('INSERT INTO ddjj_disenos (sindicato, jurisdiccion, descripcion) VALUES ($1,$2,$3) ON CONFLICT (sindicato, jurisdiccion) DO NOTHING',
      [sind, jur, `Diseño de registro inicial — ${sind} / ${jur}`]);
    r = await query('SELECT id, version, actualizado_at, descripcion FROM ddjj_disenos WHERE sindicato=$1 AND jurisdiccion=$2', [sind, jur]);
  }
  return r.rows[0];
}

// GET /api/reportes/ddjj-sindical?anio=&mes=&empresa=  (cuotas por sindicato + jurisdicción, con diseño vigente)
router.get('/ddjj-sindical', async (req, res, next) => {
  try {
    const rows = await recibosPeriodo(req.query.anio, req.query.mes, req.query.empresa);
    const grupos = {};
    for (const r of rows) {
      const sind = String(r.edata?.cod_sindicato || '').toUpperCase().trim() || 'SIN CONVENIO / FC';
      const jur = String(r.edata?.lugar || '').trim() || 'Sin lugar declarado';
      const key = sind + ' || ' + jur;
      const cuotaEmp = aporteDe(r.data?.descuentos, /Cuota sindical/i);
      const cuotaPat = contribDe(r.data?.costoEmpleador?.contribuciones, /sindical/i);
      const baseRem = Number(r.data?.totales?.totalRemun || 0);
      const g = grupos[key] || (grupos[key] = { sindicato: sind, jurisdiccion: jur, items: [], totales: { baseRem: 0, cuotaEmp: 0, cuotaPat: 0, total: 0 } });
      g.items.push({ legNum: r.leg_num, nom: r.nom, cuil: r.cuil, empresa: r.empresa, baseRem: r2(baseRem), cuotaEmp: r2(cuotaEmp), cuotaPat: r2(cuotaPat), total: r2(cuotaEmp + cuotaPat) });
      g.totales.baseRem += baseRem; g.totales.cuotaEmp += cuotaEmp; g.totales.cuotaPat += cuotaPat; g.totales.total += cuotaEmp + cuotaPat;
    }
    const out = [];
    for (const g of Object.values(grupos)) {
      const d = await ensureDdjjDiseno(g.sindicato, g.jurisdiccion);
      const last = (await query('SELECT version_diseno, created_at FROM ddjj_generaciones WHERE sindicato=$1 AND jurisdiccion=$2 ORDER BY created_at DESC LIMIT 1', [g.sindicato, g.jurisdiccion])).rows[0] || null;
      out.push({
        ...g,
        totales: { baseRem: r2(g.totales.baseRem), cuotaEmp: r2(g.totales.cuotaEmp), cuotaPat: r2(g.totales.cuotaPat), total: r2(g.totales.total) },
        diseno: { id: d.id, version: d.version, actualizadoAt: d.actualizado_at, descripcion: d.descripcion,
                  ultimaVersion: last ? last.version_diseno : null, ultimaFecha: last ? last.created_at : null,
                  primeraVez: !last, actualizado: last ? (d.version > last.version_diseno) : false },
      });
    }
    out.sort((a, b) => a.sindicato.localeCompare(b.sindicato) || a.jurisdiccion.localeCompare(b.jurisdiccion));
    const tot = out.reduce((a, g) => ({ cuotaEmp: a.cuotaEmp + g.totales.cuotaEmp, cuotaPat: a.cuotaPat + g.totales.cuotaPat, total: a.total + g.totales.total }), { cuotaEmp: 0, cuotaPat: 0, total: 0 });
    res.json({ grupos: out, totales: { cuotaEmp: r2(tot.cuotaEmp), cuotaPat: r2(tot.cuotaPat), total: r2(tot.total) } });
  } catch (e) { next(e); }
});

// PATCH /api/reportes/ddjj-disenos/:id — registrar actualización del diseño (bump versión)
router.patch('/ddjj-disenos/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { descripcion } = req.body || {};
    const r = await query(`UPDATE ddjj_disenos SET descripcion=COALESCE($1,descripcion), version=version+1, actualizado_por=$2, actualizado_at=now() WHERE id=$3 RETURNING *`,
      [descripcion || null, req.user.dni, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Diseño no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// POST /api/reportes/ddjj-generar — registra que se generó la DDJJ/boleta con el diseño vigente
router.post('/ddjj-generar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { sindicato, jurisdiccion, anio, mes } = req.body || {};
    if (!sindicato || !jurisdiccion) return res.status(400).json({ error: 'sindicato y jurisdicción son obligatorios' });
    const d = await ensureDdjjDiseno(String(sindicato), String(jurisdiccion));
    await query('INSERT INTO ddjj_generaciones (sindicato, jurisdiccion, version_diseno, anio, mes, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [sindicato, jurisdiccion, d.version, Number(anio) || null, Number(mes) || null, req.user.dni]);
    res.json({ ok: true, version: d.version });
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
