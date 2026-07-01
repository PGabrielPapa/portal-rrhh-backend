import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as sicoss from '../lib/sicoss.js';
import * as lsd from '../lib/lsd.js';

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

// ── Diseño de registro SICOSS (F.931) versionado — verificación previa a generar ──
async function ensureSicoss() {
  await query(
    `INSERT INTO sicoss_diseno (id, version, descripcion, url_arca) VALUES (1,1,$1,$2) ON CONFLICT (id) DO NOTHING`,
    ['Diseño de registro SICOSS (ARCA/AFIP) — versión inicial', 'https://www.afip.gob.ar/aportes-y-contribuciones-de-seguridad-social/']);
}
// GET /api/reportes/sicoss-diseno — versión vigente + ¿cambió desde la última generación?
router.get('/sicoss-diseno', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensureSicoss();
    const d = (await query('SELECT version, descripcion, url_arca, actualizado_at FROM sicoss_diseno WHERE id=1')).rows[0];
    const last = (await query('SELECT version_diseno, created_at FROM sicoss_generaciones ORDER BY created_at DESC LIMIT 1')).rows[0] || null;
    res.json({ version: d.version, descripcion: d.descripcion, urlArca: d.url_arca, actualizadoAt: d.actualizado_at,
      ultimaVersion: last ? last.version_diseno : null, ultimaFecha: last ? last.created_at : null,
      primeraVez: !last, actualizado: last ? (d.version > last.version_diseno) : false });
  } catch (e) { next(e); }
});
// PATCH /api/reportes/sicoss-diseno — registrar nueva versión del diseño (cuando ARCA lo actualiza)
router.patch('/sicoss-diseno', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensureSicoss();
    const { descripcion, urlArca } = req.body || {};
    const r = await query(`UPDATE sicoss_diseno SET descripcion=COALESCE($1,descripcion), url_arca=COALESCE($2,url_arca), version=version+1, actualizado_por=$3, actualizado_at=now() WHERE id=1 RETURNING *`,
      [descripcion || null, urlArca || null, req.user.dni]);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});
// POST /api/reportes/f931-generar — registra la generación con el diseño vigente
router.post('/f931-generar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensureSicoss();
    const d = (await query('SELECT version FROM sicoss_diseno WHERE id=1')).rows[0];
    const { anio, mes } = req.body || {};
    await query('INSERT INTO sicoss_generaciones (version_diseno, anio, mes, created_by) VALUES ($1,$2,$3,$4)', [d.version, Number(anio) || null, Number(mes) || null, req.user.dni]);
    res.json({ ok: true, version: d.version });
  } catch (e) { next(e); }
});

// GET /api/reportes/sicoss-archivo?anio=&mes=&empresa=  -> archivo posicional SICOSS real (.txt, 499 chars/registro)
// Topes opcionales por querystring: topePersonal, topePatronal, topeOtros (0 = sin tope).
const haberDe = (haberes, re) => (haberes || []).filter((h) => re.test(h.concepto || '')).reduce((s, h) => s + Number(h.monto || 0), 0);
router.get('/sicoss-archivo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { anio, mes, empresa } = req.query;
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes son obligatorios' });
    const topes = {
      jubilatorioPersonal: Number(req.query.topePersonal) || 0,
      jubilatorioPatronal: Number(req.query.topePatronal) || 0,
      otrosAportesPersonales: Number(req.query.topeOtros) || 0,
    };
    const rows = await recibosPeriodo(anio, mes, empresa);
    if (!rows.length) return res.status(404).json({ error: 'no hay liquidaciones para el periodo/empresa' });

    const registros = rows.map((r) => {
      const ed = r.edata || {};
      const t = r.data?.totales || {};
      const haberes = r.data?.haberes || [];
      const emp = {
        ...sicoss.DEFAULTS_SICOSS,
        ...ed,
        cuil: String(r.cuil || ed.cuil || '').replace(/\D/g, ''),
        nombre: r.nom,
        codigoObraSocial: ed.codigoObraSocial != null
          ? String(ed.codigoObraSocial).replace(/\D/g, '').slice(-6)
          : (ed.os_codigo ? String(ed.os_codigo).replace(/\D/g, '').slice(-6) : 0),
      };
      const liq = {
        remunerativo: t.totalRemun || 0,
        noRemunerativo: t.totalNoRem || 0,
        sac: haberDe(haberes, /SAC|aguinaldo/i),
        horasExtras: haberDe(haberes, /hora.?\s*extra/i),
        vacaciones: haberDe(haberes, /vacacion/i),
        zonaDesfavorable: haberDe(haberes, /zona/i),
        asigFamiliares: haberDe(haberes, /asignaci[óo]n(es)? familiar/i),
      };
      return sicoss.mapEmpleado(emp, liq, topes);
    });

    const contenido = sicoss.buildFile(registros);

    try {
      await ensureSicoss();
      const dv = (await query('SELECT version FROM sicoss_diseno WHERE id=1')).rows[0];
      await query(
        `INSERT INTO sicoss_generaciones (version_diseno, anio, mes, empresa, cantidad, archivo, created_by)
         VALUES ($1,$2,$3,$4,$5,true,$6)`,
        [dv?.version || null, Number(anio), Number(mes), empresa || null, registros.length, req.user.dni]);
    } catch (logErr) { console.warn('[sicoss-archivo] log:', logErr.message); }

    const fname = `SICOSS_${anio}${String(mes).padStart(2, '0')}${empresa ? '_' + String(empresa).replace(/\W+/g, '') : ''}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=latin1');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(contenido, 'latin1'));
  } catch (e) { next(e); }
});


// ── Libro de Sueldos Digital (LSD): diseño de registro versionado + verificación ──
async function ensureLsd() {
  await query(
    `INSERT INTO lsd_diseno (id, version, descripcion, url_arca) VALUES (1,1,$1,$2) ON CONFLICT (id) DO NOTHING`,
    [`Diseño de interfaz - liquidación LSD (ARCA) ${lsd.DISENO.version}`, lsd.DISENO.url]);
}
// GET /api/reportes/lsd-diseno — versión vigente + ¿cambió desde la última generación?
router.get('/lsd-diseno', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensureLsd();
    const d = (await query('SELECT version, descripcion, url_arca, actualizado_at FROM lsd_diseno WHERE id=1')).rows[0];
    const last = (await query('SELECT version_diseno, created_at FROM lsd_generaciones ORDER BY created_at DESC LIMIT 1')).rows[0] || null;
    res.json({ version: d.version, descripcion: d.descripcion, urlArca: d.url_arca, actualizadoAt: d.actualizado_at,
      disenoLib: lsd.DISENO.version, fuente: lsd.DISENO.fuente,
      ultimaVersion: last ? last.version_diseno : null, ultimaFecha: last ? last.created_at : null,
      primeraVez: !last, actualizado: last ? (d.version > last.version_diseno) : false });
  } catch (e) { next(e); }
});
// PATCH /api/reportes/lsd-diseno — registrar nueva versión del diseño (cuando ARCA lo actualiza)
router.patch('/lsd-diseno', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await ensureLsd();
    const { descripcion, urlArca } = req.body || {};
    const r = await query(`UPDATE lsd_diseno SET descripcion=COALESCE($1,descripcion), url_arca=COALESCE($2,url_arca), version=version+1, actualizado_por=$3, actualizado_at=now() WHERE id=1 RETURNING *`,
      [descripcion || null, urlArca || null, req.user.dni]);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// GET /api/reportes/lsd-archivo?anio=&mes=&empresa=&nroLiq=&tipoLiq=&fechaPago=&fechaRubrica=
//   -> archivo .txt del Libro de Sueldos Digital (registros 01/02/03/04) para importar en ARCA.
router.get('/lsd-archivo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { anio, mes, empresa } = req.query;
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes son obligatorios' });
    const periodo = `${anio}${String(mes).padStart(2, '0')}`;
    const tipoLiq = (req.query.tipoLiq || 'M').toString().toUpperCase();
    const nroLiq = Number(req.query.nroLiq) || 1;
    const ultimoDia = new Date(Number(anio), Number(mes), 0).getDate();
    const fechaPago = (req.query.fechaPago || `${periodo}${String(ultimoDia).padStart(2, '0')}`).toString().replace(/\D/g, '');
    const fechaRubrica = (req.query.fechaRubrica || fechaPago).toString().replace(/\D/g, '');

    // Filas + CUIT de la empresa (reg 01 es por CUIT del empleador).
    const cond = ['r.anio = $1', 'r.mes = $2'], pr = [Number(anio), Number(mes)];
    if (empresa) { pr.push(empresa); cond.push(`em.nombre = $${pr.length}`); }
    const { rows } = await query(
      `SELECT r.data, r.tipo, e.nom, e.leg_num, e.cuil, e.data AS edata, em.nombre AS empresa, em.cuit AS empcuit
         FROM recibos r JOIN empleados e ON e.id=r.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE ${cond.join(' AND ')} ORDER BY em.nombre, e.nom`, pr);
    if (!rows.length) return res.status(404).json({ error: 'no hay liquidaciones para el periodo/empresa' });

    // Agrupar por empresa (CUIT). ARCA importa por CUIT empleador.
    const grupos = new Map();
    for (const r of rows) {
      const k = r.empresa || '';
      if (!grupos.has(k)) grupos.set(k, { cuit: r.empcuit, rows: [] });
      grupos.get(k).rows.push(r);
    }

    const ctx = { periodo, fechaPago, fechaRubrica, formaPago: '1' };
    const registros = [];
    for (const [, g] of grupos) {
      registros.push(lsd.reg01({ cuit: g.cuit, periodo, tipoLiq, nroLiq, cantTrab: g.rows.length }));
      for (const r of g.rows) {
        const ed = r.edata || {};
        const t = r.data?.totales || {};
        const haberes = r.data?.haberes || [];
        const descuentos = r.data?.descuentos || [];
        const emp = {
          ...sicoss.DEFAULTS_SICOSS,
          ...ed,
          cuil: String(r.cuil || ed.cuil || '').replace(/\D/g, ''),
          nombre: r.nom,
          legajo: r.leg_num,
          codigoObraSocial: ed.codigoObraSocial != null
            ? String(ed.codigoObraSocial).replace(/\D/g, '').slice(-6)
            : (ed.os_codigo ? String(ed.os_codigo).replace(/\D/g, '').slice(-6) : 0),
        };
        const liq = {
          remunerativo: t.totalRemun || 0,
          noRemunerativo: t.totalNoRem || 0,
          sac: haberDe(haberes, /SAC|aguinaldo/i),
          horasExtras: haberDe(haberes, /hora.?\s*extra/i),
          vacaciones: haberDe(haberes, /vacacion/i),
          zonaDesfavorable: haberDe(haberes, /zona/i),
          asigFamiliares: haberDe(haberes, /asignaci[óo]n(es)? familiar/i),
        };
        const s = sicoss.mapEmpleado(emp, liq, {});
        registros.push(lsd.reg02(emp, ctx));
        for (const x of lsd.regs03(emp, { haberes, descuentos }, ctx)) registros.push(x);
        registros.push(lsd.reg04(emp, s));
      }
    }

    const contenido = lsd.buildFile(registros);

    try {
      await ensureLsd();
      const dv = (await query('SELECT version FROM lsd_diseno WHERE id=1')).rows[0];
      const trabajadores = registros.filter((x) => x.tipo === '04').length;
      await query(
        `INSERT INTO lsd_generaciones (version_diseno, anio, mes, empresa, cantidad, archivo, created_by)
         VALUES ($1,$2,$3,$4,$5,true,$6)`,
        [dv?.version || null, Number(anio), Number(mes), empresa || null, trabajadores, req.user.dni]);
    } catch (logErr) { console.warn('[lsd-archivo] log:', logErr.message); }

    const fname = `LSD_${periodo}${empresa ? '_' + String(empresa).replace(/\W+/g, '') : ''}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=latin1');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(contenido, 'latin1'));
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

// ── Generador de reportes: catálogo de datasets + datos ──────────────────────
// GET /api/reportes/datasets                         → lista de datasets disponibles
// GET /api/reportes/dataset/:key?anio=&mes=&empresa= → { key, label, campos, rows }
const REPORT_DATASETS = [
  { key: 'empleados',   label: 'Empleados (nómina)',        periodo: 'opt' },
  { key: 'familiares',  label: 'Familiares (grupo familiar)', periodo: 'opt' },
  { key: 'empresas',    label: 'Empresas',                  periodo: 'opt' },
  { key: 'nomina',      label: 'Nómina — conceptos liquidados', periodo: 'req' },
  { key: 'costos',      label: 'Costos laborales (mensual)', periodo: 'req' },
  { key: 'liquidaciones', label: 'Liquidaciones (resumen)',  periodo: 'req' },
  { key: 'fichadas',    label: 'Fichadas (período)',        periodo: 'req' },
  { key: 'conceptos',   label: 'Conceptos (catálogo)',      periodo: 'opt' },
  { key: 'cbus',        label: 'CBUs / cuentas',            periodo: 'opt' },
  { key: 'elementos',   label: 'Elementos de trabajo',      periodo: 'opt' },
  { key: 'beneficios',  label: 'Beneficios',                periodo: 'opt' },
  { key: 'art',         label: 'ART por empresa',           periodo: 'opt' },
  { key: 'licencias',   label: 'Licencias',                 periodo: 'opt' },
  { key: 'sanciones',   label: 'Sanciones',                 periodo: 'opt' },
  { key: 'anticipos',   label: 'Adelantos',                 periodo: 'opt' },
  { key: 'dotacion',          label: 'Dotación / antigüedad',          periodo: 'opt' },
  { key: 'dotacion_empresa',  label: 'Dotación por empresa (resumen)', periodo: 'opt' },
  { key: 'prueba',            label: 'Períodos de prueba (hitos)',     periodo: 'opt' },
  { key: 'cumpleanios',       label: 'Cumpleaños del mes',             periodo: 'req' },
  { key: 'aniversarios',      label: 'Aniversarios de ingreso del mes', periodo: 'req' },
  { key: 'masa_convenio',     label: 'Masa salarial por convenio',     periodo: 'opt' },
  { key: 'licencias_vigentes',label: 'Licencias vigentes (a hoy)',     periodo: 'opt' },
  { key: 'art_vencimientos',  label: 'ART — vencimientos',             periodo: 'opt' },
  { key: 'cuentas_incompletas', label: 'CBU incompletos (<100%)',      periodo: 'opt' },
];

const CAMPOS = {
  empleados: [['legNum','Legajo'],['nom','Nombre'],['dni','DNI'],['cuil','CUIL'],['empresa','Empresa'],['email','Email'],
    ['cat','Categoría'],['tramo','Tramo'],['tarea','Tarea'],['lugar','Lugar de trabajo'],['condicion','Condición'],['ingreso','Ingreso','date'],['activo','Activo','bool'],
    ['bruto','Bruto','num'],['neto','Neto','num'],['basico','Básico','num'],['antiguedad_monto','Antigüedad $','num'],['norem','No remunerativo','num'],
    ['fecha_nac','Fecha nac.','date'],['sexo','Sexo'],['estado_civil','Estado civil'],['nacionalidad','Nacionalidad'],
    ['dom_calle','Calle'],['dom_nro','Número'],['dom_piso','Piso'],['dom_depto','Depto'],['dom_torre','Torre'],['dom_bloque','Bloque'],['dom_loc','Localidad'],['dom_cp','C.P.'],['dom_prov','Provincia'],
    ['cod_convenio','Convenio'],['cod_sindicato','Sindicato'],['os_codigo','Obra social (cód.)'],['os_nombre','Obra social'],
    ['codigoSituacion','SICOSS situación','int'],['codigoCondicion','SICOSS condición','int'],['codigoModalidad','SICOSS modalidad','int'],['codigoZona','SICOSS zona','int'],['conyuge','Cónyuge','int'],['hijos','Hijos','int'],['adherentes','Adherentes','int']],
  familiares: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['tipo','Vínculo'],['apellido','Apellido'],['nombre','Nombre'],['dni','DNI'],['cuil','CUIL'],['fecha_nac','Fecha nac.','date'],['genero','Género'],['discapacidad','Discapacidad','bool'],['fecha_vinculo','Fecha vínculo','date'],['vigencia_desde','Desde','date'],['vigencia_hasta','Hasta','date']],
  empresas: [['nombre','Empresa'],['cuit','CUIT'],['slug','Slug'],['cantidadEmpleados','Empleados','int'],['tieneLogo','Logo','bool'],['tieneFirma','Firma','bool'],['created_at','Alta','date']],
  nomina: [['empresa','Empresa'],['legajo','Legajo'],['nombre','Nombre'],['cuil','CUIL'],['anio','Año','int'],['mes','Mes','int'],['tipoRecibo','Tipo recibo'],['seccion','Sección'],['concepto','Concepto'],['monto','Monto','num']],
  costos: [['empresa','Empresa'],['legajo','Legajo'],['nombre','Nombre'],['cuil','CUIL'],['remun','Remunerativo','num'],['noRem','No remunerativo','num'],['exento','Exento','num'],['descuentos','Descuentos','num'],['neto','Neto','num'],['contribuciones','Contribuciones','num'],['costoTotal','Costo total','num']],
  liquidaciones: [['empresa','Empresa'],['legajo','Legajo'],['nombre','Nombre'],['cuil','CUIL'],['anio','Año','int'],['mes','Mes','int'],['tipoRecibo','Tipo'],['remun','Remun.','num'],['noRem','No rem.','num'],['descuentos','Descuentos','num'],['neto','Neto','num']],
  fichadas: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['diasTrabajados','Días trab.','int'],['hsNetas','Hs netas','num'],['he50','HE 50% (hs)','num'],['he100','HE 100% (hs)','num'],['tardanzas','Tardanzas (hs)','num'],['aRevisar','Días a revisar','int'],['legajoProsoft','Legajo Pro-Soft']],
  conceptos: [['codigo','Código'],['descripcion','Descripción'],['tipo','Tipo'],['formula','Fórmula'],['base_legal','Base legal'],['activo','Activo','bool']],
  cbus: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['banco','Banco'],['cbu','CBU'],['alias','Alias'],['titular','Titular'],['activo','Activo','bool']],
  elementos: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['tipo','Tipo'],['descripcion','Descripción'],['identificador','Identificador'],['estado','Estado'],['fecha_entrega','Entrega','date'],['fecha_devolucion','Devolución','date']],
  beneficios: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['tipo','Tipo'],['modalidad','Modalidad'],['monto','Monto','num'],['proveedor','Proveedor'],['vigencia_desde','Desde','date'],['vigencia_hasta','Hasta','date'],['activo','Activo','bool']],
  art: [['empresa','Empresa'],['art_nombre','ART'],['art_codigo','Cód. ART'],['nro_contrato','Contrato'],['fecha_inicio','Inicio','date'],['fecha_fin','Fin','date'],['alicuotaActual','Alícuota %','num'],['activo','Activo','bool']],
  licencias: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['tipo','Tipo'],['desde','Desde','date'],['hasta','Hasta','date'],['dias','Días','int'],['motivo','Motivo'],['estado','Estado'],['resuelto_por','Resuelto por']],
  sanciones: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['tipo','Tipo'],['fecha','Fecha','date'],['dias','Días','int'],['descripcion','Descripción'],['created_by','Cargado por']],
  anticipos: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['monto','Monto','num'],['motivo','Motivo'],['cuotas','Cuotas','int'],['estado','Estado'],['recomendacion','Recomendación'],['created_at','Fecha','date']],
  dotacion: [['empresa','Empresa'],['legNum','Legajo'],['nom','Nombre'],['ingreso','Ingreso','date'],['antiguedad','Antigüedad (años)','num'],['edad','Edad','int'],['cat','Categoría'],['tarea','Tarea'],['lugar','Lugar'],['activo','Activo','bool']],
  dotacion_empresa: [['empresa','Empresa'],['empleados','Empleados','int'],['activos','Activos','int'],['bajas','Bajas','int'],['masaBruta','Masa salarial bruta','num'],['brutoPromedio','Bruto promedio','num'],['antiguedadProm','Antigüedad prom. (años)','num']],
  prueba: [['empresa','Empresa'],['legNum','Legajo'],['nom','Nombre'],['ingreso','Ingreso','date'],['dias','Días desde ingreso','int'],['hito','Próximo hito'],['finPrueba','Fin período prueba','date']],
  cumpleanios: [['empresa','Empresa'],['legNum','Legajo'],['nom','Nombre'],['fecha_nac','Fecha nac.','date'],['dia','Día','int'],['edadCumple','Cumple','int']],
  aniversarios: [['empresa','Empresa'],['legNum','Legajo'],['nom','Nombre'],['ingreso','Ingreso','date'],['dia','Día','int'],['anios','Años','int']],
  masa_convenio: [['convenio','Convenio'],['empleados','Empleados','int'],['masaBruta','Masa salarial bruta','num'],['brutoPromedio','Bruto promedio','num']],
  licencias_vigentes: [['empresa','Empresa'],['leg_num','Legajo'],['empleado','Empleado'],['tipo','Tipo'],['desde','Desde','date'],['hasta','Hasta','date'],['dias','Días','int'],['estado','Estado']],
  art_vencimientos: [['empresa','Empresa'],['art_nombre','ART'],['nro_contrato','Contrato'],['fecha_inicio','Inicio','date'],['fecha_fin','Vence','date'],['diasParaVencer','Días p/vencer','int'],['activo','Activo','bool']],
  cuentas_incompletas: [['empresa','Empresa'],['legNum','Legajo'],['nom','Nombre'],['pctTotal','% asignado','num'],['cuentas','Cuentas','int']],
};

router.get('/datasets', (req, res) => res.json(REPORT_DATASETS));

router.get('/dataset/:key', async (req, res, next) => {
  try {
    const key = req.params.key;
    const meta = REPORT_DATASETS.find((d) => d.key === key);
    if (!meta) return res.status(404).json({ error: 'dataset desconocido' });
    const empresa = req.query.empresa || null;
    const now = new Date();
    const anio = Number(req.query.anio) || now.getFullYear();
    const mes = Number(req.query.mes) || (now.getMonth() + 1);
    const ultimoDia = new Date(anio, mes, 0).getDate();
    const inicioMes = `${anio}-${String(mes).padStart(2, '0')}-01`;
    const finMes = `${anio}-${String(mes).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
    const filtrarPeriodo = meta.periodo === 'req' || (meta.periodo === 'opt' && String(req.query.periodo) === '1');
    let rows = [];
    const hoyD = new Date();
    const aniosDe = (d) => { if (!d) return null; const f = new Date(d); return isNaN(f) ? null : r2((hoyD - f) / (365.25 * 86400000)); };
    const diasDe = (d) => { if (!d) return null; const f = new Date(d); return isNaN(f) ? null : Math.floor((hoyD - f) / 86400000); };
    const diasHasta = (d) => { if (!d) return null; const f = new Date(d); return isNaN(f) ? null : Math.ceil((f - hoyD) / 86400000); };

    if (key === 'empleados') {
      const q = await query(`SELECT e.*, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id ${filtrarPeriodo ? `WHERE e.ingreso <= '${finMes}'` : ''} ORDER BY em.nombre, e.leg_num`);
      rows = q.rows.map((e) => ({ ...(e.data || {}), legNum: e.leg_num, nom: e.nom, dni: e.dni, cuil: e.cuil, empresa: e.empresa, email: e.email, cat: e.cat, tramo: e.tramo, ingreso: e.ingreso, bruto: Number(e.bruto), neto: Number(e.neto), activo: e.activo }));
    } else if (key === 'familiares') {
      const w = filtrarPeriodo ? `WHERE f.vigencia_desde <= $1 AND (f.vigencia_hasta IS NULL OR f.vigencia_hasta >= $1)` : '';
      rows = (await query(`SELECT f.*, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM familiares f JOIN empleados e ON e.id=f.empleado_id JOIN empresas em ON em.id=e.empresa_id ${w} ORDER BY em.nombre, e.leg_num, f.tipo`, filtrarPeriodo ? [finMes] : [])).rows;
    } else if (key === 'empresas') {
      const q = await query(`SELECT em.*, (SELECT count(*) FROM empleados x WHERE x.empresa_id=em.id) AS "cantidadEmpleados" FROM empresas em ${filtrarPeriodo ? `WHERE em.created_at::date <= '${finMes}'` : ''} ORDER BY em.nombre`);
      rows = q.rows.map((e) => ({ nombre: e.nombre, cuit: e.cuit, slug: e.slug, cantidadEmpleados: Number(e.cantidadEmpleados), tieneLogo: !!e.logo, tieneFirma: !!e.firma, created_at: e.created_at }));
    } else if (key === 'nomina' || key === 'costos' || key === 'liquidaciones') {
      const recs = await recibosPeriodo(anio, mes, empresa);
      if (key === 'nomina') {
        const secc = { rem: 'Remunerativo', norem: 'No remunerativo', exento: 'Exento' };
        for (const r of recs) {
          const base = { empresa: r.empresa, legajo: r.leg_num, nombre: r.nom, cuil: r.cuil, anio: Number(anio), mes: Number(mes), tipoRecibo: r.tipo };
          for (const h of (r.data?.haberes || [])) rows.push({ ...base, seccion: secc[h.tipo] || h.tipo, concepto: h.concepto, monto: r2(h.monto) });
          for (const d of (r.data?.descuentos || [])) rows.push({ ...base, seccion: 'Descuento', concepto: d.concepto, monto: r2(d.monto) });
        }
      } else if (key === 'costos') {
        rows = recs.map((r) => { const t = r.data?.totales || {}, c = r.data?.costoEmpleador || {}; return {
          empresa: r.empresa, legajo: r.leg_num, nombre: r.nom, cuil: r.cuil,
          remun: r2(t.totalRemun || 0), noRem: r2(t.totalNoRem || 0), exento: r2(t.totalExento || 0),
          descuentos: r2(t.totalDescuentos || 0), neto: r2(t.neto || 0), contribuciones: r2(c.totalContrib || 0), costoTotal: r2(c.costoTotal || 0) }; });
      } else {
        rows = recs.map((r) => { const t = r.data?.totales || {}; return {
          empresa: r.empresa, legajo: r.leg_num, nombre: r.nom, cuil: r.cuil, anio: Number(anio), mes: Number(mes), tipoRecibo: r.tipo,
          remun: r2(t.totalRemun || 0), noRem: r2(t.totalNoRem || 0), descuentos: r2(t.totalDescuentos || 0), neto: r2(t.neto || 0) }; });
      }
    } else if (key === 'fichadas') {
      const q = await query(`SELECT f.data, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM fichadas_periodo f JOIN empleados e ON e.id=f.empleado_id JOIN empresas em ON em.id=e.empresa_id WHERE f.anio=$1 AND f.mes=$2 ORDER BY em.nombre, e.leg_num`, [anio, mes]);
      rows = q.rows.map((r) => { const d = r.data || {}; return { empresa: r.empresa, leg_num: r.leg_num, empleado: r.empleado,
        diasTrabajados: d.diasTrabajados != null ? d.diasTrabajados : null,
        hsNetas: d.hsNetasMin != null ? r2(d.hsNetasMin / 60) : null,
        he50: d.horasExtra50Min != null ? r2(d.horasExtra50Min / 60) : null,
        he100: d.horasExtra100Min != null ? r2(d.horasExtra100Min / 60) : null,
        tardanzas: d.tardanzasMin != null ? r2(d.tardanzasMin / 60) : null,
        aRevisar: Array.isArray(d.diasARevisar) ? d.diasARevisar.length : 0,
        legajoProsoft: d.legajoProsoft || null }; });
    } else if (key === 'conceptos') {
      rows = (await query(`SELECT codigo, descripcion, tipo, formula, base_legal, activo FROM conceptos ${filtrarPeriodo ? `WHERE created_at::date <= '${finMes}'` : ''} ORDER BY codigo`)).rows;
    } else if (key === 'cbus') {
      rows = (await query(`SELECT c.banco, c.cbu, c.alias, c.titular, c.activo, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM cbus c JOIN empleados e ON e.id=c.empleado_id JOIN empresas em ON em.id=e.empresa_id ${filtrarPeriodo ? `WHERE c.created_at::date <= '${finMes}'` : ''} ORDER BY em.nombre, e.leg_num`)).rows;
    } else if (key === 'elementos') {
      const w = filtrarPeriodo ? `WHERE (el.fecha_entrega IS NULL OR el.fecha_entrega <= $1) AND (el.fecha_devolucion IS NULL OR el.fecha_devolucion >= $1)` : '';
      rows = (await query(`SELECT el.tipo, el.descripcion, el.identificador, el.estado, el.fecha_entrega, el.fecha_devolucion, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM elementos_trabajo el JOIN empleados e ON e.id=el.empleado_id JOIN empresas em ON em.id=e.empresa_id ${w} ORDER BY em.nombre, e.leg_num`, filtrarPeriodo ? [finMes] : [])).rows;
    } else if (key === 'beneficios') {
      const w = filtrarPeriodo ? `WHERE (b.vigencia_desde IS NULL OR b.vigencia_desde <= $1) AND (b.vigencia_hasta IS NULL OR b.vigencia_hasta >= $1)` : '';
      rows = (await query(`SELECT b.tipo, b.modalidad, b.monto, b.proveedor, b.vigencia_desde, b.vigencia_hasta, b.activo, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM beneficios b JOIN empleados e ON e.id=b.empleado_id JOIN empresas em ON em.id=e.empresa_id ${w} ORDER BY em.nombre, e.leg_num`, filtrarPeriodo ? [finMes] : [])).rows;
    } else if (key === 'art') {
      const q = await query(`SELECT a.*, em.nombre AS empresa FROM art_contratos a JOIN empresas em ON em.id=a.empresa_id ${filtrarPeriodo ? `WHERE a.fecha_inicio <= '${finMes}' AND (a.fecha_fin IS NULL OR a.fecha_fin >= '${finMes}')` : ''} ORDER BY em.nombre, a.fecha_inicio DESC`);
      rows = q.rows.map((a) => { const al = Array.isArray(a.alicuotas) ? a.alicuotas : []; const ult = al[al.length - 1] || {}; return {
        empresa: a.empresa, art_nombre: a.art_nombre, art_codigo: a.art_codigo, nro_contrato: a.nro_contrato,
        fecha_inicio: a.fecha_inicio, fecha_fin: a.fecha_fin, alicuotaActual: ult.pct != null ? Number(ult.pct) : null, activo: a.activo }; });
    } else if (key === 'licencias') {
      const w = filtrarPeriodo ? `WHERE l.desde <= $1 AND l.hasta >= $2` : '';
      rows = (await query(`SELECT l.tipo, l.desde, l.hasta, l.dias, l.motivo, l.estado, l.resuelto_por, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM licencias l JOIN empleados e ON e.id=l.empleado_id JOIN empresas em ON em.id=e.empresa_id ${w} ORDER BY l.desde DESC`, filtrarPeriodo ? [finMes, inicioMes] : [])).rows;
    } else if (key === 'sanciones') {
      const w = filtrarPeriodo ? `WHERE s.fecha >= $1 AND s.fecha <= $2` : '';
      rows = (await query(`SELECT s.tipo, s.fecha, s.dias, s.descripcion, s.created_by, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM sanciones s JOIN empleados e ON e.id=s.empleado_id JOIN empresas em ON em.id=e.empresa_id ${w} ORDER BY s.fecha DESC`, filtrarPeriodo ? [inicioMes, finMes] : [])).rows;
    } else if (key === 'anticipos') {
      const w = filtrarPeriodo ? `WHERE a.created_at::date >= $1 AND a.created_at::date <= $2` : '';
      rows = (await query(`SELECT a.monto, a.motivo, a.cuotas, a.estado, a.recomendacion, a.created_at, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM anticipos a JOIN empleados e ON e.id=a.empleado_id JOIN empresas em ON em.id=e.empresa_id ${w} ORDER BY a.created_at DESC`, filtrarPeriodo ? [inicioMes, finMes] : [])).rows;
    } else if (key === 'dotacion') {
      const q = await query(`SELECT e.*, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id ${filtrarPeriodo ? `WHERE e.ingreso <= '${finMes}'` : ''} ORDER BY em.nombre, e.leg_num`);
      rows = q.rows.map((e) => { const d = e.data || {}; return { empresa: e.empresa, legNum: e.leg_num, nom: e.nom, ingreso: e.ingreso,
        antiguedad: aniosDe(e.ingreso), edad: d.fecha_nac ? Math.floor(aniosDe(d.fecha_nac)) : null, cat: e.cat, tarea: d.tarea || null, lugar: d.lugar || null, activo: e.activo }; });
    } else if (key === 'dotacion_empresa') {
      const q = await query(`SELECT e.*, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id ${filtrarPeriodo ? `WHERE e.ingreso <= '${finMes}'` : ''}`);
      const g = {};
      for (const e of q.rows) { const o = (g[e.empresa] ||= { empresa: e.empresa, empleados: 0, activos: 0, bajas: 0, masa: 0, antig: 0 });
        o.empleados++; if (e.activo) { o.activos++; o.masa += Number(e.bruto) || 0; o.antig += (aniosDe(e.ingreso) || 0); } else o.bajas++; }
      rows = Object.values(g).map((o) => ({ empresa: o.empresa, empleados: o.empleados, activos: o.activos, bajas: o.bajas,
        masaBruta: r2(o.masa), brutoPromedio: r2(o.activos ? o.masa / o.activos : 0), antiguedadProm: r2(o.activos ? o.antig / o.activos : 0) }));
    } else if (key === 'prueba') {
      const q = await query(`SELECT e.*, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE COALESCE(e.activo,true)=true ${filtrarPeriodo ? `AND e.ingreso <= '${finMes}'` : ''} ORDER BY em.nombre, e.leg_num`);
      const refP = filtrarPeriodo ? new Date(finMes) : hoyD;
      rows = q.rows.map((e) => { const dias = e.ingreso ? Math.floor((refP - new Date(e.ingreso)) / 86400000) : null; if (dias == null || dias < 0 || dias > 180) return null;
        const hito = dias <= 60 ? '60 días' : dias <= 120 ? '120 días' : dias <= 170 ? '170 días' : 'Fin (180 días)';
        const fin = e.ingreso ? new Date(new Date(e.ingreso).getTime() + 180 * 86400000).toISOString().slice(0, 10) : null;
        return { empresa: e.empresa, legNum: e.leg_num, nom: e.nom, ingreso: e.ingreso, dias, hito, finPrueba: fin }; }).filter(Boolean);
    } else if (key === 'cumpleanios') {
      const q = await query(`SELECT e.*, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE COALESCE(e.activo,true)=true`);
      rows = q.rows.map((e) => { const fn = (e.data || {}).fecha_nac; if (!fn) return null; const f = new Date(fn); if (isNaN(f) || f.getMonth() + 1 !== Number(mes)) return null;
        return { empresa: e.empresa, legNum: e.leg_num, nom: e.nom, fecha_nac: fn, dia: f.getDate(), edadCumple: hoyD.getFullYear() - f.getFullYear() }; }).filter(Boolean).sort((a, b) => a.dia - b.dia);
    } else if (key === 'aniversarios') {
      const q = await query(`SELECT e.*, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE COALESCE(e.activo,true)=true`);
      rows = q.rows.map((e) => { if (!e.ingreso) return null; const f = new Date(e.ingreso); if (isNaN(f) || f.getMonth() + 1 !== Number(mes)) return null;
        return { empresa: e.empresa, legNum: e.leg_num, nom: e.nom, ingreso: e.ingreso, dia: f.getDate(), anios: hoyD.getFullYear() - f.getFullYear() }; }).filter(Boolean).sort((a, b) => a.dia - b.dia);
    } else if (key === 'masa_convenio') {
      const q = await query(`SELECT e.* FROM empleados e WHERE COALESCE(e.activo,true)=true ${filtrarPeriodo ? `AND e.ingreso <= '${finMes}'` : ''}`);
      const g = {};
      for (const e of q.rows) { const k = (e.data || {}).cod_convenio || 'Sin convenio'; const o = (g[k] ||= { convenio: k, empleados: 0, masa: 0 }); o.empleados++; o.masa += Number(e.bruto) || 0; }
      rows = Object.values(g).map((o) => ({ convenio: o.convenio, empleados: o.empleados, masaBruta: r2(o.masa), brutoPromedio: r2(o.empleados ? o.masa / o.empleados : 0) }));
    } else if (key === 'licencias_vigentes') {
      rows = (await query(`SELECT l.tipo, l.desde, l.hasta, l.dias, l.estado, e.nom AS empleado, e.leg_num, em.nombre AS empresa FROM licencias l JOIN empleados e ON e.id=l.empleado_id JOIN empresas em ON em.id=e.empresa_id WHERE l.estado='aprobada' AND ${filtrarPeriodo ? `l.desde <= '${finMes}' AND l.hasta >= '${finMes}'` : 'l.hasta >= CURRENT_DATE'} ORDER BY l.hasta`)).rows;
    } else if (key === 'art_vencimientos') {
      const q = await query(`SELECT a.*, em.nombre AS empresa FROM art_contratos a JOIN empresas em ON em.id=a.empresa_id WHERE a.fecha_fin IS NOT NULL ${filtrarPeriodo ? `AND a.fecha_fin >= '${inicioMes}'` : ''} ORDER BY a.fecha_fin`);
      rows = q.rows.map((a) => ({ empresa: a.empresa, art_nombre: a.art_nombre, nro_contrato: a.nro_contrato, fecha_inicio: a.fecha_inicio, fecha_fin: a.fecha_fin, diasParaVencer: diasHasta(a.fecha_fin), activo: a.activo }));
    } else if (key === 'cuentas_incompletas') {
      const q = await query(`SELECT e.leg_num, e.nom, em.nombre AS empresa,
          COALESCE(SUM(c.porcentaje) FILTER (WHERE c.activo), 0) AS pct, COUNT(c.id) FILTER (WHERE c.activo) AS cuentas
        FROM empleados e JOIN empresas em ON em.id=e.empresa_id LEFT JOIN cbus c ON c.empleado_id=e.id
        WHERE COALESCE(e.activo,true)=true ${filtrarPeriodo ? `AND e.ingreso <= '${finMes}'` : ''}
        GROUP BY e.id, e.leg_num, e.nom, em.nombre
        HAVING COALESCE(SUM(c.porcentaje) FILTER (WHERE c.activo), 0) <> 100 ORDER BY em.nombre, e.leg_num`);
      rows = q.rows.map((r) => ({ empresa: r.empresa, legNum: r.leg_num, nom: r.nom, pctTotal: Number(r.pct), cuentas: Number(r.cuentas) }));
    }

    // Filtro por empresa para datasets no liquidados (los de período ya filtran en la query).
    if (empresa && !['nomina', 'costos', 'liquidaciones', 'empresas', 'conceptos', 'masa_convenio'].includes(key)) {
      rows = rows.filter((r) => r.empresa === empresa);
    }
    res.json({ key, label: meta.label, periodo: meta.periodo, anio, mes, campos: CAMPOS[key] || [], rows });
  } catch (e) { next(e); }
});

// ── Reportes guardados (definiciones reutilizables) ──
router.get('/definiciones', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, nombre, config, created_by, created_at FROM reportes_definiciones ORDER BY nombre');
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/definiciones', async (req, res, next) => {
  try {
    const { id, nombre, config } = req.body || {};
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (id) {
      const r = await query('UPDATE reportes_definiciones SET nombre=$1, config=$2, updated_at=now() WHERE id=$3 RETURNING id', [String(nombre).trim(), JSON.stringify(config || {}), id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Reporte no encontrado' });
      return res.json({ ok: true, id: Number(id) });
    }
    const r = await query('INSERT INTO reportes_definiciones (nombre, config, created_by) VALUES ($1,$2,$3) RETURNING id', [String(nombre).trim(), JSON.stringify(config || {}), req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/definiciones/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM reportes_definiciones WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
