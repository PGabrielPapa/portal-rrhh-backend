// Liquidación por PRODUCCIÓN (paralela, sin aportes/contribuciones).
// Valores hora propios, contratos y ajustes por empleado, y cálculo/corrida.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { valorProd, horasProdDesdeFichadas, calcProduccion } from '../lib/produccion.js';
import { rangoQuincena } from '../lib/uocraJornal.js';

const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));

const num = (v, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v));

// Cruce de legajos robusto a prefijos de empresa (IDEE suma 5000; puede quedar 27 → 5027 → 10027).
// Normaliza restando de a 5000 hasta la "base" (27), e indexa la base de cada empleado.
const soloDigitos = (x) => String(x == null ? '' : x).replace(/\D/g, '');
function legBase(digits) { let n = Number(digits); if (!n) return ''; while (n >= 5000) n -= 5000; return String(n); }
async function indiceLegajos() {
  const emps = (await query('SELECT id, leg_num, cuil FROM empleados')).rows;
  const byLeg = new Map(); const byBase = new Map(); const byCuil = new Map();
  for (const e of emps) {
    const d = soloDigitos(e.leg_num);
    if (d) { byLeg.set(d, e.id); const b = legBase(d); if (b && !byBase.has(b)) byBase.set(b, e.id); }
    const c = soloDigitos(e.cuil); if (c) byCuil.set(c, e.id);
  }
  return {
    match(leg, cuil) {
      const d = soloDigitos(leg); const c = soloDigitos(cuil);
      return byLeg.get(d) || byLeg.get(String(Number(d) + 5000)) || byBase.get(legBase(d)) || byCuil.get(c) || null;
    },
  };
}

// ── Valor hora de producción POR EMPLEADO (varía por persona) ──
// Devuelve el valor vigente de cada empleado a una fecha (por defecto hoy).
router.get('/valores', async (req, res, next) => {
  try {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha)) ? req.query.fecha : new Date().toISOString().slice(0, 10);
    const { rows } = await query(
      `SELECT DISTINCT ON (v.empleado_id) v.empleado_id, e.nom, e.leg_num, e.cat,
              to_char(v.vigencia,'YYYY-MM-DD') AS vigencia, v.valor_hora, v.jornada_horas, v.categoria
         FROM prod_valor_hora v JOIN empleados e ON e.id=v.empleado_id
        WHERE v.vigencia <= $1
        ORDER BY v.empleado_id, v.vigencia DESC`, [fecha]);
    rows.sort((a, b) => String(a.nom).localeCompare(String(b.nom)));
    res.json(rows);
  } catch (e) { next(e); }
});
// Alta/edición de un valor por empleado. body: { valores:[{ empleadoId, vigencia, valor_hora, jornada_horas, categoria }] }
router.put('/valores', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body && req.body.valores) ? req.body.valores : [];
    let ok = 0;
    for (const r of items) {
      const emp = Number(r && r.empleadoId);
      const vig = String((r && r.vigencia) || '').trim();
      if (!emp || !/^\d{4}-\d{2}-\d{2}$/.test(vig)) continue;
      await query(`INSERT INTO prod_valor_hora (empleado_id, vigencia, valor_hora, jornada_horas, categoria) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (empleado_id, vigencia) DO UPDATE SET valor_hora=EXCLUDED.valor_hora, jornada_horas=EXCLUDED.jornada_horas, categoria=EXCLUDED.categoria`,
        [emp, vig, num(r.valor_hora), num(r.jornada_horas, 8) || 8, (r.categoria || '').trim() || null]);
      ok++;
    }
    res.json({ ok: true, guardados: ok });
  } catch (e) { next(e); }
});
// Importa valores hora desde la planilla. body: { rows:[...], vigencia }
// De la hoja LIQUIDACION toma "VALOR JORNAL" y "CANTIDAD DE HS": valor hora = jornal ÷ horas (8 o 9).
// También acepta una hoja simple con columnas Legajo/CUIL, Categoria, "Valor hora" y "Horas".
router.post('/valores/import', async (req, res, next) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    const vig = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body && req.body.vigencia)) ? req.body.vigencia : new Date().toISOString().slice(0, 10);
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No se recibieron filas.' });
    const val = (r, ...k) => { for (const x of k) if (r[x] != null && String(r[x]).trim() !== '') return r[x]; return ''; };
    const idx = await indiceLegajos();
    let ok = 0; const sinMatch = [];
    for (const r of rows) {
      const leg = String(val(r, 'Legajo', 'Nro Legajo', 'legajo', 'leg')).replace(/\D/g, '');
      const cuil = String(val(r, 'CUIL', 'cuil')).replace(/\D/g, '');
      const id = idx.match(leg, cuil);
      if (!id) { if (leg || cuil) sinMatch.push(leg || cuil); continue; }
      const horas = num(val(r, 'CANTIDAD DE HS', 'Horas', 'horas', 'jornada_horas'), 8) || 8;
      // valor hora directo, o derivado de "VALOR JORNAL" ÷ horas
      let vh = num(val(r, 'Valor hora', 'valorHora', 'valor_hora', 'vh'));
      if (!vh) { const jornal = num(val(r, 'VALOR JORNAL', 'jornal', 'Diario', 'diario')); if (jornal) vh = Math.round((jornal / horas) * 100) / 100; }
      if (!vh) continue;
      await query(`INSERT INTO prod_valor_hora (empleado_id, vigencia, valor_hora, jornada_horas, categoria) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (empleado_id, vigencia) DO UPDATE SET valor_hora=EXCLUDED.valor_hora, jornada_horas=EXCLUDED.jornada_horas, categoria=EXCLUDED.categoria`,
        [id, vig, vh, horas, String(val(r, 'Categoria', 'categoria', 'Rubro')).trim() || null]);
      ok++;
    }
    res.json({ ok: true, importados: ok, sinMatch });
  } catch (e) { next(e); }
});

// ── Contratos ──
router.get('/contratos', async (req, res, next) => {
  try {
    const { anio, mes, quincena, empleadoId } = req.query;
    const cond = ['1=1']; const p = [];
    if (empleadoId) { p.push(Number(empleadoId)); cond.push(`c.empleado_id=$${p.length}`); }
    if (anio) { p.push(Number(anio)); cond.push(`c.anio=$${p.length}`); }
    if (mes) { p.push(Number(mes)); cond.push(`c.mes=$${p.length}`); }
    if (quincena) { p.push(Number(quincena)); cond.push(`c.quincena=$${p.length}`); }
    const { rows } = await query(
      `SELECT c.*, e.nom, e.leg_num FROM prod_contratos c JOIN empleados e ON e.id=c.empleado_id
        WHERE ${cond.join(' AND ')} ORDER BY e.nom, c.fecha_fin`, p);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/contratos', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId) return res.status(400).json({ error: 'Falta el empleado.' });
    const r = await query(
      `INSERT INTO prod_contratos (empleado_id, anio, mes, quincena, fecha_fin, obra, especialidad, monto, nota, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.empleadoId, num(b.anio, null), num(b.mes, null), num(b.quincena, null), b.fechaFin || null, b.obra || null, b.especialidad || null, num(b.monto), b.nota || null, req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/contratos/:id', async (req, res, next) => {
  try { await query('DELETE FROM prod_contratos WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
// Importar contratos desde planilla. body: { rows:[{ 'Nro Legajo'|CUIL, 'fecha FIN', obra, especialidad, 'extra en la etapa'|monto }], anio, mes, quincena }
router.post('/contratos/import', async (req, res, next) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    const { anio, mes, quincena } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No se recibieron filas.' });
    const val = (r, ...k) => { for (const x of k) if (r[x] != null && String(r[x]).trim() !== '') return r[x]; return ''; };
    const idx = await indiceLegajos();
    let ok = 0; const sinMatch = [];
    for (const r of rows) {
      const leg = String(val(r, 'Nro Legajo', 'Legajo', 'legajo')).replace(/\D/g, '');
      const cuil = String(val(r, 'CUIL', 'cuil')).replace(/\D/g, '');
      const id = idx.match(leg, cuil);
      if (!id) { if (leg || cuil) sinMatch.push(leg || cuil); continue; }
      const monto = num(val(r, 'extra en la etapa', 'monto', 'Monto'));
      const fecha = val(r, 'fecha FIN', 'Fecha Fin', 'fechaFin');
      const fISO = /^\d{4}-\d{2}-\d{2}/.test(String(fecha)) ? String(fecha).slice(0, 10) : (/(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(fecha)) ? String(fecha).replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, '$3-$2-$1') : null);
      await query(`INSERT INTO prod_contratos (empleado_id, anio, mes, quincena, fecha_fin, obra, especialidad, monto, created_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, num(anio, null), num(mes, null), num(quincena, null), fISO, val(r, 'obra', 'Obra') || null, val(r, 'especialidad', 'Especialidad') || null, monto, req.user.dni]);
      ok++;
    }
    res.json({ ok: true, importados: ok, sinMatch });
  } catch (e) { next(e); }
});

// ── Ajustes (+/-) ──
router.get('/ajustes', async (req, res, next) => {
  try {
    const { anio, mes, quincena, empleadoId } = req.query;
    const cond = ['1=1']; const p = [];
    if (empleadoId) { p.push(Number(empleadoId)); cond.push(`a.empleado_id=$${p.length}`); }
    if (anio) { p.push(Number(anio)); cond.push(`a.anio=$${p.length}`); }
    if (mes) { p.push(Number(mes)); cond.push(`a.mes=$${p.length}`); }
    if (quincena) { p.push(Number(quincena)); cond.push(`a.quincena=$${p.length}`); }
    const { rows } = await query(
      `SELECT a.*, e.nom, e.leg_num FROM prod_ajustes a JOIN empleados e ON e.id=a.empleado_id
        WHERE ${cond.join(' AND ')} ORDER BY e.nom`, p);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/ajustes', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !String(b.concepto || '').trim()) return res.status(400).json({ error: 'Falta empleado o concepto.' });
    const r = await query(
      `INSERT INTO prod_ajustes (empleado_id, anio, mes, quincena, concepto, monto, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.empleadoId, num(b.anio, null), num(b.mes, null), num(b.quincena, null), String(b.concepto).trim(), num(b.monto), req.user.dni]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/ajustes/:id', async (req, res, next) => {
  try { await query('DELETE FROM prod_ajustes WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Cálculo de la liquidación de producción de un empleado ──
async function liquidarProd(empleadoId, anio, mes, quincena, over = {}) {
  const emp = (await query('SELECT id, nom, leg_num, cat FROM empleados WHERE id=$1', [empleadoId])).rows[0];
  if (!emp) return null;
  const { desde, hasta } = rangoQuincena(anio, mes, quincena);
  const fechaRef = hasta;
  const vp = await valorProd(emp.id, fechaRef);
  const valorHora = num(over.valorHora, vp.valorHora);
  const jornadaHoras = num(over.jornadaHoras, vp.jornadaHoras) || 8;
  const fp = (await query('SELECT data FROM fichadas_periodo WHERE empleado_id=$1 AND anio=$2 AND mes=$3', [empleadoId, anio, mes])).rows[0];
  const diasQ = ((fp && fp.data && fp.data.dias) || []).filter((d) => d.fecha >= desde && d.fecha <= hasta);
  const sug = horasProdDesdeFichadas(diasQ, jornadaHoras);
  const contratos = (await query('SELECT id, obra, especialidad, monto, to_char(fecha_fin,\'YYYY-MM-DD\') AS fecha_fin FROM prod_contratos WHERE empleado_id=$1 AND (anio=$2 OR anio IS NULL) AND (mes=$3 OR mes IS NULL) AND (quincena=$4 OR quincena IS NULL)', [empleadoId, anio, mes, quincena])).rows;
  const ajustes = (await query('SELECT id, concepto, monto FROM prod_ajustes WHERE empleado_id=$1 AND (anio=$2 OR anio IS NULL) AND (mes=$3 OR mes IS NULL) AND (quincena=$4 OR quincena IS NULL)', [empleadoId, anio, mes, quincena])).rows;
  const cant = {
    diasNormales: num(over.diasNormales, sug.diasNormales),
    hsSemana: num(over.hsSemana, sug.hsSemana),
    hsSabado: num(over.hsSabado, sug.hsSabado),
    hsDomingo: num(over.hsDomingo, sug.hsDomingo),
    hsFeriado: num(over.hsFeriado, sug.hsFeriado),
  };
  const calc = calcProduccion({ valorHora, jornadaHoras, ...cant, bono: over.bono, retro: over.retro, sac: over.sac, difAnterior: over.difAnterior, ajustes, contratos });
  return { empleado: { id: emp.id, nom: emp.nom, legNum: emp.leg_num, cat: emp.cat }, periodo: { anio, mes, quincena, desde, hasta }, jornadaHoras, cantidades: cant, sugeridas: sug, contratos, ajustes, ...calc };
}

router.post('/calcular', async (req, res, next) => {
  try {
    const { empleadoId, anio, mes, quincena = 1, ...over } = req.body || {};
    if (!empleadoId || !anio || !mes) return res.status(400).json({ error: 'empleadoId, anio y mes son obligatorios.' });
    const r = await liquidarProd(Number(empleadoId), Number(anio), Number(mes), Number(quincena), over);
    if (!r) return res.status(404).json({ error: 'Empleado no encontrado.' });
    res.json(r);
  } catch (e) { next(e); }
});

// Empresas disponibles (para el filtro de la corrida masiva).
router.get('/empresas', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT DISTINCT em.nombre FROM empleados e JOIN empresas em ON em.id=e.empresa_id
                                  WHERE e.activo = true ORDER BY em.nombre`);
    res.json(rows.map((r) => r.nombre));
  } catch (e) { next(e); }
});

// Candidatos para la corrida: empleados de producción (con valor hora cargado) filtrables por
// empresa y categoría. Devuelve datos para armar la selección múltiple.
router.get('/candidatos', async (req, res, next) => {
  try {
    const { empresa, categoria } = req.query;
    const cats = String(categoria || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cond = ['e.activo = true', 'EXISTS (SELECT 1 FROM prod_valor_hora v WHERE v.empleado_id=e.id)'];
    const p = [];
    if (empresa) { p.push(empresa); cond.push(`em.nombre=$${p.length}`); }
    if (cats.length) { p.push(cats); cond.push(`COALESCE(e.cat,'') = ANY($${p.length})`); }
    const { rows } = await query(
      `SELECT e.id, e.nom, e.leg_num, COALESCE(e.cat,'') AS cat, em.nombre AS empresa
         FROM empleados e JOIN empresas em ON em.id=e.empresa_id
        WHERE ${cond.join(' AND ')} ORDER BY e.nom`, p);
    res.json(rows);
  } catch (e) { next(e); }
});

// Categorías disponibles entre los empleados de producción (para el filtro).
router.get('/categorias', async (req, res, next) => {
  try {
    const { empresa } = req.query;
    const cond = ['e.activo = true', 'EXISTS (SELECT 1 FROM prod_valor_hora v WHERE v.empleado_id=e.id)'];
    const p = [];
    if (empresa) { p.push(empresa); cond.push(`em.nombre=$${p.length}`); }
    const { rows } = await query(
      `SELECT DISTINCT COALESCE(NULLIF(e.cat,''),'(sin categoría)') AS cat
         FROM empleados e JOIN empresas em ON em.id=e.empresa_id
        WHERE ${cond.join(' AND ')} ORDER BY 1`, p);
    res.json(rows.map((r) => r.cat));
  } catch (e) { next(e); }
});

// Corrida masiva. body: { anio, mes, quincena, empresa?, categoria?[], empleadoIds?[] }
// Si viene empleadoIds usa esa lista; sino toma todos los activos de producción que matcheen
// empresa/categoría. Incluye siempre a los seleccionados (aunque den 0).
router.post('/corrida', async (req, res, next) => {
  try {
    const { anio, mes, quincena = 1, empresa } = req.body || {};
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes son obligatorios.' });
    const seleccion = Array.isArray(req.body.empleadoIds) ? req.body.empleadoIds.map(Number).filter(Boolean) : [];
    let ids = seleccion;
    if (!ids.length) {
      const cats = (Array.isArray(req.body.categoria) ? req.body.categoria : String(req.body.categoria || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
      const cond = ['e.activo = true', 'EXISTS (SELECT 1 FROM prod_valor_hora v WHERE v.empleado_id=e.id)'];
      const p = [];
      if (empresa) { p.push(empresa); cond.push(`em.nombre=$${p.length}`); }
      if (cats.length) { p.push(cats); cond.push(`COALESCE(e.cat,'') = ANY($${p.length})`); }
      ids = (await query(`SELECT e.id FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')} ORDER BY e.nom`, p)).rows.map((r) => r.id);
    }
    const explicit = seleccion.length > 0;
    const items = [];
    let totalSin = 0, totalCon = 0;
    for (const id of ids) {
      const r = await liquidarProd(id, Number(anio), Number(mes), Number(quincena));
      if (!r) continue;
      // Con selección explícita se incluye a todos; sino se omiten los que dan 0.
      if (!explicit && r.totalConContrato === 0 && r.totalSinContrato === 0) continue;
      items.push(r); totalSin += r.totalSinContrato; totalCon += r.totalConContrato;
    }
    res.json({ periodo: { anio, mes, quincena }, cantidad: items.length, totalSinContrato: Math.round(totalSin * 100) / 100, totalConContrato: Math.round(totalCon * 100) / 100, items });
  } catch (e) { next(e); }
});

export default router;
