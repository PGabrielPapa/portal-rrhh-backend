// Reporte "Asiento de sueldos (libro completo)": las 14 hojas del Excel mensual
// de Contabilidad, generadas desde la liquidación del período.
//
//   GET    /api/asiento-sueldos?anio=&mes=&empresa=   → JSON con las 14 hojas
//   GET    /api/asiento-sueldos/xlsx?anio=&mes=&...   → libro .xlsx
//   GET    /api/asiento-sueldos/cuentas               → mapeo columna → cuenta
//   PUT    /api/asiento-sueldos/cuentas/:id           → editar una cuenta
//   POST   /api/asiento-sueldos/cuentas               → agregar una cuenta
//   DELETE /api/asiento-sueldos/cuentas/:id           → quitar una cuenta
import { Router } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { construirLibro } from '../lib/asientoSueldos.js';
import { migrarAsiento } from '../db/migrateAsiento.js';
import { migrarAsientoAux } from '../db/migrateAsientoAux.js';
import { paramsParaFecha } from './parametros.routes.js';
import { valoresLegalesVigentes } from './valoresLegales.routes.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('rrhh', 'admin'));

const periodo = (req) => {
  const anio = Number(req.query.anio), mes = Number(req.query.mes);
  if (!anio || !mes || mes < 1 || mes > 12) return null;
  return { anio, mes, empresa: req.query.empresa ? String(req.query.empresa) : null };
};

router.get('/', async (req, res, next) => {
  try {
    const p = periodo(req);
    if (!p) return res.status(400).json({ error: 'Indicá año y mes' });
    res.json(await construirLibro(p));
  } catch (e) { next(e); }
});

router.get('/xlsx', async (req, res, next) => {
  try {
    const p = periodo(req);
    if (!p) return res.status(400).json({ error: 'Indicá año y mes' });
    const libro = await construirLibro(p);
    const wb = XLSX.utils.book_new();
    for (const h of libro.hojas) {
      const aoa = [h.columnas, ...h.filas];
      if (h.resumen) { aoa.push([]); for (const r of h.resumen) aoa.push(r); }
      if (h.totales) aoa.push([], ['TOTALES', '', '', '', '', h.totales.debe, h.totales.haber]);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // El nombre de hoja de Excel admite 31 caracteres.
      XLSX.utils.book_append_sheet(wb, ws, String(h.titulo).slice(0, 31));
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const nombre = `${p.anio}-${String(p.mes).padStart(2, '0')} Asiento ${p.empresa || 'Grupo'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre.replace(/[^\w .\-]/g, '_')}"`);
    res.send(buf);
  } catch (e) { next(e); }
});

router.get('/cuentas', async (_req, res, next) => {
  try {
    await migrarAsiento();
    const { rows } = await query(
      `SELECT id, columna, centro_costo, cuenta, descripcion, naturaleza, orden, activo
         FROM asiento_cuentas ORDER BY orden, columna`);
    res.json({ cuentas: rows });
  } catch (e) { next(e); }
});

router.post('/cuentas', async (req, res, next) => {
  try {
    const { columna, centro_costo, cuenta, descripcion, naturaleza, orden } = req.body || {};
    if (!columna || !cuenta) return res.status(400).json({ error: 'Columna y cuenta son obligatorias' });
    const ins = await query(
      `INSERT INTO asiento_cuentas (columna, centro_costo, cuenta, descripcion, naturaleza, orden, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [String(columna).trim(), centro_costo ? String(centro_costo).trim().toLowerCase() : null,
       String(cuenta).trim(), String(descripcion || ''), naturaleza || 'auto', Number(orden) || 0, req.user?.nom || null]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

router.put('/cuentas/:id', async (req, res, next) => {
  try {
    const { cuenta, descripcion, naturaleza, orden, activo } = req.body || {};
    const r = await query(
      `UPDATE asiento_cuentas
          SET cuenta = COALESCE($1, cuenta), descripcion = COALESCE($2, descripcion),
              naturaleza = COALESCE($3, naturaleza), orden = COALESCE($4, orden),
              activo = COALESCE($5, activo), updated_by = $6, updated_at = now()
        WHERE id = $7 RETURNING id`,
      [cuenta ?? null, descripcion ?? null, naturaleza ?? null,
       orden != null ? Number(orden) : null, typeof activo === 'boolean' ? activo : null,
       req.user?.nom || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Centro de costos / centro de operaciones por legajo ─────────────────────
// Son los dos ejes de apertura del asiento y hoy no son campos del legajo:
// se guardan en empleados.data.centroCosto / .centroOperacion.

// Los centros de costo válidos salen del propio plan de cuentas, para que el
// desplegable nunca ofrezca un centro sin cuenta asignada.
async function catalogos() {
  await migrarAsiento();
  const cc = (await query(
    `SELECT DISTINCT centro_costo FROM asiento_cuentas
      WHERE centro_costo IS NOT NULL AND activo = true ORDER BY centro_costo`)).rows.map((r) => r.centro_costo);
  const co = (await query('SELECT codigo, denominacion FROM centros_operaciones ORDER BY denominacion')).rows;
  return { centrosCosto: cc, centrosOperacion: co };
}

router.get('/centros', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.leg_num, e.nom, em.nombre AS empresa, e.activo,
              e.data->>'centroCosto'      AS centro_costo,
              e.data->>'centroOperacion'  AS centro_operacion,
              e.data->>'codPlanOs'        AS cod_plan_os,
              e.data->>'impPlanOs'        AS imp_plan_os,
              e.data->>'cod_os'           AS cod_os,
              e.cuil,
              e.data->>'lugar'            AS lugar
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id
        ORDER BY em.nombre,
                 NULLIF(regexp_replace(e.leg_num, '\\D', '', 'g'), '')::bigint NULLS LAST, e.nom`);
    res.json({ legajos: rows, ...(await catalogos()) });
  } catch (e) { next(e); }
});

// Asignación masiva. Acepta [{ leg_num | id, centroCosto, centroOperacion }].
// El legajo se compara por su parte numérica, así "12" y "000012" son el mismo.
router.put('/centros', async (req, res, next) => {
  try {
    const asignaciones = Array.isArray(req.body?.asignaciones) ? req.body.asignaciones : null;
    if (!asignaciones) return res.status(400).json({ error: 'Enviá un arreglo "asignaciones"' });
    let actualizados = 0; const noEncontrados = [];
    for (const a of asignaciones) {
      const patch = {};
      if (a.centroCosto !== undefined) patch.centroCosto = String(a.centroCosto || '').trim().toLowerCase();
      if (a.centroOperacion !== undefined) patch.centroOperacion = String(a.centroOperacion || '').trim();
      if (a.codPlanOs !== undefined) patch.codPlanOs = String(a.codPlanOs || '').trim();
      if (a.impPlanOs !== undefined) patch.impPlanOs = Number(a.impPlanOs) || 0;
      if (!Object.keys(patch).length) continue;
      const r = a.id
        ? await query('UPDATE empleados SET data = data || $1::jsonb, updated_at = now() WHERE id = $2 RETURNING id',
            [JSON.stringify(patch), a.id])
        : await query(
            `UPDATE empleados SET data = data || $1::jsonb, updated_at = now()
              WHERE NULLIF(regexp_replace(leg_num, '\\D', '', 'g'), '')::bigint = $2 RETURNING id`,
            [JSON.stringify(patch), Number(String(a.leg_num).replace(/\D/g, '')) || -1]);
      if (r.rowCount) actualizados += r.rowCount; else noEncontrados.push(a.leg_num ?? a.id);
    }
    res.json({ ok: true, actualizados, noEncontrados });
  } catch (e) { next(e); }
});

// Alta rápida de un centro de operaciones que todavía no exista en el maestro.
router.post('/centros-operacion', async (req, res, next) => {
  try {
    const { codigo, denominacion } = req.body || {};
    if (!denominacion) return res.status(400).json({ error: 'La denominación es obligatoria' });
    const cod = String(codigo || denominacion).trim().toUpperCase().slice(0, 20);
    await query(
      `INSERT INTO centros_operaciones (codigo, denominacion) VALUES ($1,$2)
       ON CONFLICT (codigo) DO UPDATE SET denominacion = EXCLUDED.denominacion`,
      [cod, String(denominacion).trim()]);
    res.status(201).json({ ok: true, codigo: cod });
  } catch (e) { next(e); }
});

// ── Reconstrucción de bases imponibles en recibos ya liquidados ─────────────
// Desde el cambio en lib/liquidacion.js cada recibo nuevo guarda su bloque
// `bases`. Los períodos anteriores no lo tienen y la hoja Contribuciones sale
// incompleta. Esto lo reconstruye SIN tocar ningún importe del recibo: usa los
// totales ya guardados y los topes y la detracción vigentes de ese período.
// Queda marcado con `reconstruido: true` para distinguirlo del cálculo en vivo.
const nBase = (v) => Number(v) || 0;
const rr2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const sumaConcepto = (haberes, re) =>
  rr2((haberes || []).filter((h) => re.test(String(h.concepto || ''))).reduce((a, h) => a + nBase(h.monto), 0));

function basesDesdeRecibo(rec, p) {
  const t = rec.data?.totales || {};
  const totalRemun = nBase(t.totalRemun), totalNoRem = nBase(t.totalNoRem), totalExento = nBase(t.totalExento);
  const topeMax = nBase(p.topeAportesMax) > 0 ? nBase(p.topeAportesMax) : Infinity;
  const topeMin = nBase(p.topeAportesMin) > 0 ? nBase(p.topeAportesMin) : 0;
  const esQuincenal = rec.tipo === 'quincenal_1' || rec.tipo === 'quincenal_2';
  const detrPlena = nBase(p.detraccionContrib);
  const detr = rec.tipo === 'mensual' ? detrPlena : (esQuincenal ? detrPlena * 0.5 : 0);
  const baseAportes = Math.min(Math.max(totalRemun, topeMin), topeMax);
  const baseSegSoc = Math.max(0, totalRemun - detr);
  const h = rec.data?.haberes || [];
  return {
    remTotal: rr2(totalRemun + totalNoRem),
    remImp1: rr2(baseAportes), remImp2: rr2(baseSegSoc), remImp3: rr2(baseSegSoc),
    remImp4: rr2(baseAportes), remImp5: rr2(baseAportes),
    remImp8: rr2(totalRemun), remImp9: rr2(totalRemun + totalNoRem), remImp10: 0, remImp11: 0,
    baseAportesSs: rr2(baseAportes), baseContribSs: rr2(baseSegSoc),
    baseAportesOs: rr2(baseAportes), baseArt: rr2(totalRemun),
    detraccion: rr2(detr),
    topeMin: Number.isFinite(topeMin) ? rr2(topeMin) : null,
    topeMax: Number.isFinite(topeMax) ? rr2(topeMax) : null,
    sac: sumaConcepto(h, /\bsac\b|aguinaldo/i),
    vacaciones: sumaConcepto(h, /vacacion/i),
    horasExtras: sumaConcepto(h, /hora[s]?\s*extra/i),
    noRemunerativo: rr2(totalNoRem), exento: rr2(totalExento),
    reconstruido: true,
    nota: 'Reconstruido desde los totales del recibo y los topes del período; el recibo no fue recalculado. La base de obra social de jornada parcial puede diferir.',
  };
}

// POST /api/asiento-sueldos/backfill-bases
// body: { anio?, mes?, empresa?, rehacer?, dryRun? }  — sin anio/mes procesa todos los períodos.
router.post('/backfill-bases', async (req, res, next) => {
  try {
    const { anio, mes, empresa, rehacer, dryRun } = req.body || {};
    const cond = [], pr = [];
    if (anio) { pr.push(Number(anio)); cond.push(`r.anio = $${pr.length}`); }
    if (mes) { pr.push(Number(mes)); cond.push(`r.mes = $${pr.length}`); }
    if (empresa) { pr.push(String(empresa)); cond.push(`em.nombre = $${pr.length}`); }
    if (!rehacer) cond.push(`(r.data->'bases') IS NULL`);
    const { rows } = await query(
      `SELECT r.id, r.anio, r.mes, r.tipo, r.data
         FROM recibos r
         JOIN empleados e ON e.id = r.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        ORDER BY r.anio, r.mes`, pr);

    // Los parámetros y topes se leen una sola vez por período.
    const cache = new Map();
    const paramsDe = async (a, m) => {
      const k = `${a}-${m}`;
      if (cache.has(k)) return cache.get(k);
      const fecha = `${a}-${String(m).padStart(2, '0')}-15`;
      const p = { ...(await paramsParaFecha(fecha)) };
      const v = await valoresLegalesVigentes(fecha);
      if (v) {
        if (v.topeSipaMax > 0) p.topeAportesMax = v.topeSipaMax;
        if (v.topeSipaMin > 0) p.topeAportesMin = v.topeSipaMin;
      }
      cache.set(k, p);
      return p;
    };

    const porPeriodo = {}; let actualizados = 0;
    for (const rec of rows) {
      const k = `${rec.anio}-${String(rec.mes).padStart(2, '0')}`;
      porPeriodo[k] = (porPeriodo[k] || 0) + 1;
      if (dryRun) continue;
      const bases = basesDesdeRecibo(rec, await paramsDe(rec.anio, rec.mes));
      await query(`UPDATE recibos SET data = jsonb_set(data, '{bases}', $1::jsonb, true) WHERE id = $2`,
        [JSON.stringify(bases), rec.id]);
      actualizados++;
    }
    res.json({ ok: true, dryRun: !!dryRun, recibos: rows.length, actualizados, porPeriodo });
  } catch (e) { next(e); }
});

// ── Tablas auxiliares: obras sociales, categorías y conceptos del gremio ────
router.get('/auxiliares', async (_req, res, next) => {
  try {
    await migrarAsientoAux();
    const [os, cat, sind] = await Promise.all([
      query(`SELECT cod_os, nombre, por_aporte, imp_aporte, por_reten, imp_reten,
                    direccion, localidad, cp, telefono, activo
               FROM obras_sociales_aportes ORDER BY nombre`),
      query(`SELECT cod_categoria, descripcion, hs_normal, hs_min_imp, di_min_imp, aplica_tope
               FROM categoria_params ORDER BY cod_categoria`),
      query(`SELECT id, columna, descripcion, cod_sindicato, tipo, base, pct, importe,
                    cuenta, confirmado, nota, activo
               FROM conceptos_sindicales ORDER BY columna`),
    ]);
    res.json({ obrasSociales: os.rows, categorias: cat.rows, sindicales: sind.rows });
  } catch (e) { next(e); }
});

// Actualización parcial genérica, con lista blanca de campos por tabla.
const TABLAS_AUX = {
  os:         { tabla: 'obras_sociales_aportes', pk: 'cod_os',        campos: ['nombre', 'por_aporte', 'imp_aporte', 'por_reten', 'imp_reten', 'direccion', 'localidad', 'cp', 'telefono', 'activo'] },
  categorias: { tabla: 'categoria_params',       pk: 'cod_categoria', campos: ['descripcion', 'hs_normal', 'hs_min_imp', 'di_min_imp', 'aplica_tope'] },
  sindicales: { tabla: 'conceptos_sindicales',   pk: 'id',            campos: ['descripcion', 'cod_sindicato', 'tipo', 'base', 'pct', 'importe', 'cuenta', 'confirmado', 'nota', 'activo'] },
};

router.put('/auxiliares/:tabla/:clave', async (req, res, next) => {
  try {
    const def = TABLAS_AUX[req.params.tabla];
    if (!def) return res.status(404).json({ error: 'Tabla desconocida' });
    const sets = [], vals = [];
    for (const c of def.campos) {
      if (req.body?.[c] === undefined) continue;
      vals.push(req.body[c]); sets.push(`${c} = $${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No hay campos para actualizar' });
    vals.push(req.user?.nom || null); const iBy = vals.length;
    vals.push(req.params.clave);
    const r = await query(
      `UPDATE ${def.tabla} SET ${sets.join(', ')}, updated_by = $${iBy}, updated_at = now()
        WHERE ${def.pk} = $${vals.length} RETURNING ${def.pk}`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'Registro no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/auxiliares/os', async (req, res, next) => {
  try {
    const { cod_os, nombre } = req.body || {};
    if (!cod_os || !nombre) return res.status(400).json({ error: 'Código y nombre son obligatorios' });
    await query(
      `INSERT INTO obras_sociales_aportes (cod_os, nombre, por_aporte, imp_aporte, por_reten, imp_reten)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (cod_os) DO NOTHING`,
      [String(cod_os).trim().toUpperCase(), String(nombre).trim(),
       Number(req.body.por_aporte) || 0, Number(req.body.imp_aporte) || 0,
       Number(req.body.por_reten) || 0, Number(req.body.imp_reten) || 0]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/auxiliares/sindicales', async (req, res, next) => {
  try {
    const { columna, descripcion } = req.body || {};
    if (!columna || !descripcion) return res.status(400).json({ error: 'Columna y descripción son obligatorias' });
    await query(
      `INSERT INTO conceptos_sindicales (columna, descripcion, cod_sindicato, tipo, base, pct, importe, cuenta, nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (columna) DO NOTHING`,
      [String(columna).trim().toUpperCase(), String(descripcion).trim(),
       req.body.cod_sindicato || null, req.body.tipo || 'contribucion', req.body.base || 'fijo',
       Number(req.body.pct) || 0, Number(req.body.importe) || 0, req.body.cuenta || null, req.body.nota || null]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/cuentas/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM asiento_cuentas WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
