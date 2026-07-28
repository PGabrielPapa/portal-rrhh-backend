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

// ── Bono (no rem.) por categoría según paritaria ──
router.get('/bonos', async (req, res, next) => {
  try {
    const { rows } = await query("SELECT categoria, to_char(vigencia,'YYYY-MM-DD') AS vigencia, monto FROM prod_bono_categoria ORDER BY categoria, vigencia DESC");
    res.json(rows);
  } catch (e) { next(e); }
});
router.put('/bonos', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body && req.body.bonos) ? req.body.bonos : [];
    let ok = 0;
    for (const r of items) {
      const cat = String((r && r.categoria) || '').trim();
      const vig = String((r && r.vigencia) || '').trim();
      if (!cat || !/^\d{4}-\d{2}-\d{2}$/.test(vig)) continue;
      await query(`INSERT INTO prod_bono_categoria (categoria, vigencia, monto) VALUES ($1,$2,$3)
                   ON CONFLICT (categoria, vigencia) DO UPDATE SET monto=EXCLUDED.monto`, [cat, vig, num(r.monto)]);
      ok++;
    }
    res.json({ ok: true, guardados: ok });
  } catch (e) { next(e); }
});
router.delete('/bonos', async (req, res, next) => {
  try {
    const cat = String(req.query.categoria || '').trim(); const vig = String(req.query.vigencia || '').trim();
    if (!cat || !vig) return res.status(400).json({ error: 'Falta categoría o vigencia.' });
    await query('DELETE FROM prod_bono_categoria WHERE categoria=$1 AND vigencia=$2', [cat, vig]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Importa el BONO por empleado desde la planilla LIQUIDACION (columna "Bono"). body: { rows, anio, mes, quincena }
// rows: [{ Legajo|CUIL, Bono }]. Es el valor por persona tal como figura en la planilla.
router.post('/bono/import', async (req, res, next) => {
  try {
    const rows = (req.body && req.body.rows) || [];
    const { anio, mes, quincena } = req.body || {};
    if (!anio || !mes || !quincena) return res.status(400).json({ error: 'anio, mes y quincena son obligatorios.' });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No se recibieron filas.' });
    const val = (r, ...k) => { for (const x of k) if (r[x] != null && String(r[x]).trim() !== '') return r[x]; return ''; };
    const idx = await indiceLegajos();
    let ok = 0; const sinMatch = [];
    for (const r of rows) {
      const leg = String(val(r, 'Legajo', 'Nro Legajo', 'legajo', 'leg')).replace(/\D/g, '');
      const cuil = String(val(r, 'CUIL', 'cuil')).replace(/\D/g, '');
      const id = idx.match(leg, cuil);
      if (!id) { if (leg || cuil) sinMatch.push(leg || cuil); continue; }
      const monto = num(val(r, 'Bono', 'bono', 'monto'));
      await query(`INSERT INTO prod_bono (empleado_id, anio, mes, quincena, monto) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (empleado_id, anio, mes, quincena) DO UPDATE SET monto=EXCLUDED.monto`,
        [id, anio, mes, quincena, monto]);
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
// Guardado masivo de ajustes/descuentos desde la corrida. Por empleado reemplaza TODOS sus ajustes
// del período por el monto indicado (concepto 'Ajuste (masivo)'). Monto 0 = sin ajuste.
router.post('/ajustes/masivo', async (req, res, next) => {
  try {
    const { anio, mes, quincena } = req.body || {};
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!anio || !mes || !quincena) return res.status(400).json({ error: 'anio, mes y quincena son obligatorios.' });
    let guardados = 0;
    for (const it of items) {
      const emp = Number(it && it.empleadoId); if (!emp) continue;
      const monto = num(it.monto);
      await query('DELETE FROM prod_ajustes WHERE empleado_id=$1 AND anio=$2 AND mes=$3 AND quincena=$4', [emp, anio, mes, quincena]);
      if (monto !== 0) {
        await query(`INSERT INTO prod_ajustes (empleado_id, anio, mes, quincena, concepto, monto, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [emp, anio, mes, quincena, 'Ajuste (masivo)', monto, req.user.dni]);
      }
      guardados++;
    }
    res.json({ ok: true, guardados });
  } catch (e) { next(e); }
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
  // Contratos: se asignan a la quincena por su FECHA FIN (los sin fecha, por anio/mes). Robusto al
  // valor de "quincena" que se haya guardado en la importación.
  const contratos = (await query(
    `SELECT id, obra, especialidad, monto, to_char(fecha_fin,'YYYY-MM-DD') AS fecha_fin FROM prod_contratos
      WHERE empleado_id=$1 AND (
        (fecha_fin IS NOT NULL AND fecha_fin BETWEEN $2 AND $3)
        OR (fecha_fin IS NULL AND anio=$4 AND mes=$5 AND (quincena=$6 OR quincena IS NULL))
      )`, [empleadoId, desde, hasta, anio, mes, quincena])).rows;
  const ajustes = (await query('SELECT id, concepto, monto FROM prod_ajustes WHERE empleado_id=$1 AND (anio=$2 OR anio IS NULL) AND (mes=$3 OR mes IS NULL) AND (quincena=$4 OR quincena IS NULL)', [empleadoId, anio, mes, quincena])).rows;
  // Bono por empleado del período (importado de la planilla). Se usa como default si no viene override.
  const bonoEmp = (await query('SELECT monto FROM prod_bono WHERE empleado_id=$1 AND anio=$2 AND mes=$3 AND quincena=$4', [empleadoId, anio, mes, quincena])).rows[0];
  const cant = {
    diasNormales: num(over.diasNormales, sug.diasNormales),
    hsSemana: num(over.hsSemana, sug.hsSemana),
    hsSabado: num(over.hsSabado, sug.hsSabado),
    hsDomingo: num(over.hsDomingo, sug.hsDomingo),
    hsFeriado: num(over.hsFeriado, sug.hsFeriado),
  };
  const bono = num(over.bono, bonoEmp ? Number(bonoEmp.monto) : 0);
  const calc = calcProduccion({ valorHora, jornadaHoras, ...cant, bono, retro: over.retro, sac: over.sac, difAnterior: over.difAnterior, ajustes, contratos });
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
    // Diagnóstico: qué hay guardado, para entender si faltan contratos/bonos o hay desfasaje de período.
    const cPer = (await query('SELECT count(*)::int n, count(DISTINCT empleado_id)::int emp FROM prod_contratos WHERE anio=$1 AND mes=$2 AND quincena=$3', [anio, mes, quincena])).rows[0];
    const cTot = (await query('SELECT count(*)::int n FROM prod_contratos')).rows[0];
    const cPers = (await query("SELECT DISTINCT anio, mes, quincena FROM prod_contratos ORDER BY 1,2,3")).rows;
    const bTot = (await query('SELECT count(*)::int n FROM prod_bono_categoria')).rows[0];
    const debug = {
      contratosEnPeriodo: cPer.n, contratosEmpleadosEnPeriodo: cPer.emp,
      contratosTotalDB: cTot.n, periodosContratos: cPers.map((r) => `${r.anio}-${r.mes}-q${r.quincena}`),
      bonosCargados: bTot.n,
    };
    res.json({ periodo: { anio, mes, quincena }, cantidad: items.length, totalSinContrato: Math.round(totalSin * 100) / 100, totalConContrato: Math.round(totalCon * 100) / 100, items, debug });
  } catch (e) { next(e); }
});

// ── % de aumento a los valores hora (para no reimportar cuando cambia la paritaria) ──
// body: { pct, vigencia, empresa?, categoria?[], empleadoIds?[] }. Crea una nueva vigencia con
// el valor actual × (1 + pct/100) para cada empleado alcanzado (mantiene el historial anterior).
router.post('/valores/aumentar', async (req, res, next) => {
  try {
    const pct = num(req.body && req.body.pct);
    const vig = String(req.body && req.body.vigencia || '').trim();
    if (!pct || !/^\d{4}-\d{2}-\d{2}$/.test(vig)) return res.status(400).json({ error: 'Falta % o vigencia válida.' });
    const factor = 1 + pct / 100;
    let ids = Array.isArray(req.body.empleadoIds) ? req.body.empleadoIds.map(Number).filter(Boolean) : [];
    if (!ids.length) {
      const cats = (Array.isArray(req.body.categoria) ? req.body.categoria : String(req.body.categoria || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
      const cond = ['EXISTS (SELECT 1 FROM prod_valor_hora v WHERE v.empleado_id=e.id)']; const p = [];
      if (req.body.empresa) { p.push(req.body.empresa); cond.push(`em.nombre=$${p.length}`); }
      if (cats.length) { p.push(cats); cond.push(`COALESCE(e.cat,'') = ANY($${p.length})`); }
      ids = (await query(`SELECT e.id FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')}`, p)).rows.map((r) => r.id);
    }
    let ok = 0;
    for (const id of ids) {
      const cur = (await query('SELECT valor_hora, jornada_horas, categoria FROM prod_valor_hora WHERE empleado_id=$1 AND vigencia<=$2 ORDER BY vigencia DESC LIMIT 1', [id, vig])).rows[0]
        || (await query('SELECT valor_hora, jornada_horas, categoria FROM prod_valor_hora WHERE empleado_id=$1 ORDER BY vigencia DESC LIMIT 1', [id])).rows[0];
      if (!cur) continue;
      const nuevo = Math.round(Number(cur.valor_hora) * factor * 100) / 100;
      await query(`INSERT INTO prod_valor_hora (empleado_id, vigencia, valor_hora, jornada_horas, categoria) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (empleado_id, vigencia) DO UPDATE SET valor_hora=EXCLUDED.valor_hora`,
        [id, vig, nuevo, cur.jornada_horas, cur.categoria]);
      ok++;
    }
    res.json({ ok: true, actualizados: ok, pct });
  } catch (e) { next(e); }
});

// ── SAC de producción: 50% de la mejor remuneración mensual del semestre (básico+extras+contratos) ──
// Toma los datos del historial de corridas guardadas. semestre: mes 1-6 → 1, 7-12 → 2.
async function sacEmpleado(empleadoId, anio, mes) {
  const sem = mes <= 6 ? [1, 6] : [7, 12];
  const { rows } = await query(
    `SELECT c.mes, SUM(i.remun_sac)::numeric AS remun
       FROM prod_corrida_item i JOIN prod_corrida c ON c.id=i.corrida_id
      WHERE i.empleado_id=$1 AND c.anio=$2 AND c.mes BETWEEN $3 AND $4
      GROUP BY c.mes`, [empleadoId, anio, sem[0], sem[1]]);
  let mejor = 0;
  for (const r of rows) mejor = Math.max(mejor, Number(r.remun) || 0);
  return { mejorRemun: Math.round(mejor * 100) / 100, sac: Math.round((mejor / 2) * 100) / 100, mesesConDatos: rows.length };
}
router.get('/sac', async (req, res, next) => {
  try {
    const { empleadoId, anio, mes } = req.query;
    if (!empleadoId || !anio || !mes) return res.status(400).json({ error: 'empleadoId, anio y mes son obligatorios.' });
    res.json(await sacEmpleado(Number(empleadoId), Number(anio), Number(mes)));
  } catch (e) { next(e); }
});
// SAC de varios (para la corrida masiva). body: { anio, mes, empleadoIds:[] }
router.post('/sac/masivo', async (req, res, next) => {
  try {
    const { anio, mes } = req.body || {};
    const ids = Array.isArray(req.body.empleadoIds) ? req.body.empleadoIds.map(Number).filter(Boolean) : [];
    if (!anio || !mes || !ids.length) return res.status(400).json({ error: 'anio, mes y empleadoIds son obligatorios.' });
    const out = {};
    for (const id of ids) out[id] = await sacEmpleado(id, Number(anio), Number(mes));
    res.json(out);
  } catch (e) { next(e); }
});

// ── Guardar / historial de corridas ──
// Guarda la foto editada de la corrida. body: { anio, mes, quincena, empresa?, nota?, items:[...] }
router.post('/corridas', async (req, res, next) => {
  try {
    const { anio, mes, quincena, empresa, nota } = req.body || {};
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!anio || !mes || !quincena) return res.status(400).json({ error: 'anio, mes y quincena son obligatorios.' });
    if (!items.length) return res.status(400).json({ error: 'No hay ítems para guardar.' });
    let totalSin = 0, totalCon = 0;
    for (const it of items) { totalSin += num(it.totalSin); totalCon += num(it.totalCon); }
    const cab = await query(
      `INSERT INTO prod_corrida (anio, mes, quincena, empresa, nota, total_sin, total_con, usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [anio, mes, quincena, empresa || null, nota || null, Math.round(totalSin * 100) / 100, Math.round(totalCon * 100) / 100, req.user.dni]);
    const cid = cab.rows[0].id;
    for (const it of items) {
      const extras = num(it.extras);
      const contratos = num(it.contratos);
      const remunSac = Math.round((num(it.basico) + extras + contratos) * 100) / 100;   // base SAC elegida
      await query(
        `INSERT INTO prod_corrida_item (corrida_id, empleado_id, leg_num, nom, cat, jornada_horas, valor_hora,
            dias, hs_sem, hs_sab, hs_dom, hs_fer, basico, extras, bono, retro, sac, ajuste, contratos, remun_sac, total_sin, total_con)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [cid, it.empleadoId, it.legNum || null, it.nom || null, it.cat || null, num(it.jornadaHoras, 8), num(it.valorHora),
         num(it.dias), num(it.hsSem), num(it.hsSab), num(it.hsDom), num(it.hsFer), num(it.basico), extras, num(it.bono), num(it.retro), num(it.sac), num(it.ajuste), contratos, remunSac, num(it.totalSin), num(it.totalCon)]);
    }
    res.status(201).json({ ok: true, id: cid, cantidad: items.length });
  } catch (e) { next(e); }
});
router.get('/corridas', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.anio, c.mes, c.quincena, c.empresa, c.nota, c.total_sin, c.total_con, c.usuario,
              to_char(c.creada,'YYYY-MM-DD HH24:MI') AS creada, count(i.id)::int AS cantidad
         FROM prod_corrida c LEFT JOIN prod_corrida_item i ON i.corrida_id=c.id
        GROUP BY c.id ORDER BY c.creada DESC LIMIT 200`);
    res.json(rows);
  } catch (e) { next(e); }
});
router.get('/corridas/:id', async (req, res, next) => {
  try {
    const cab = (await query('SELECT * FROM prod_corrida WHERE id=$1', [Number(req.params.id)])).rows[0];
    if (!cab) return res.status(404).json({ error: 'Corrida no encontrada.' });
    const items = (await query('SELECT * FROM prod_corrida_item WHERE corrida_id=$1 ORDER BY nom', [cab.id])).rows;
    res.json({ ...cab, items });
  } catch (e) { next(e); }
});
router.delete('/corridas/:id', async (req, res, next) => {
  try { await query('DELETE FROM prod_corrida WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
