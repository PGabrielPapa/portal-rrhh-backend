// Procesamiento compartido de fichadas: cruce por legajo con el portal, cruce de
// licencias aprobadas, armado del resumen y persistencia. Lo usan tanto la
// importación por Excel como la conexión directa con Pro-Soft, así ambos caminos
// calculan y guardan EXACTAMENTE igual.
import { pool, query } from '../db.js';
import { normLegajo, minToHhmm } from './fichadasProsoft.js';

// Feriados (YYYY-MM-DD) dentro de un rango, como Set. Se pasan a parseExtendido
// para no exigir jornada ni marcar injustificado en días feriados.
export async function getFeriadosSet(desde, hasta) {
  if (!desde || !hasta) return new Set();
  const { rows } = await query(
    `SELECT to_char(fecha, 'YYYY-MM-DD') AS d FROM feriados WHERE fecha BETWEEN $1 AND $2`,
    [desde, hasta]);
  return new Set(rows.map((r) => r.d));
}

// Da formato de presentación a un agregado por empleado.
function vista(a) {
  return {
    diasTrabajados: a.diasTrabajados,
    hsNetas: minToHhmm(a.hsNetasMin),
    horasExtra50: minToHhmm(a.horasExtra50Min),
    horasExtra100: minToHhmm(a.horasExtra100Min),
    horasExtra50Min: a.horasExtra50Min,
    horasExtra100Min: a.horasExtra100Min,
    hsNetasMin: a.hsNetasMin,
    horasExtraDescartada: minToHhmm(a.horasExtraDescartadaMin),
    horasExtraDescartadaMin: a.horasExtraDescartadaMin,
    bancoNeto: minToHhmm(a.bancoNetoMin),
    bancoNetoMin: a.bancoNetoMin,
    tardanzas: minToHhmm(a.tardanzasMin),
    tardanzasMin: a.tardanzasMin,
    diasTardanza: a.diasTardanza,
    diasARevisar: a.diasARevisar,
    licenciasProsoft: a.licenciasProsoft,
    diasLicencia: Object.values(a.licenciasProsoft || {}).reduce((t, n) => t + n, 0),
    dias: a.dias,
  };
}

/**
 * Cruza el parseado contra el portal, anota licencias y (si confirmar) persiste.
 * @param {object} opts
 * @param {object} opts.parsed         resultado de parseExtendido()
 * @param {number} opts.anio
 * @param {number} opts.mes
 * @param {boolean} opts.confirmar     si true, persiste; si no, solo preview
 * @param {string}  opts.origen        etiqueta de origen ('prosoft-extendido' | 'prosoft-api')
 * @param {string?} opts.importadoPor  DNI/usuario que importó
 * @param {string?} opts.archivoNombre nombre del archivo / descripción del origen
 * @param {boolean} opts.soloPendientes si true, NO pisa períodos ya aprobados (para la tarea diaria)
 * @returns {{resumen, matcheados, sinMatch}}
 */
export async function procesarParsed({ parsed, anio, mes, confirmar, origen = 'prosoft-extendido', importadoPor = null, archivoNombre = null, soloPendientes = false, desde = null, hasta = null }) {
  // Mapa de empleados del portal por legajo normalizado.
  const { rows: emps } = await query(
    `SELECT e.id, e.leg_num, e.nom, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id = e.empresa_id`
  );
  const porLeg = new Map();
  for (const e of emps) porLeg.set(normLegajo(e.leg_num), e);

  const matcheados = [];
  const sinMatch = [];
  for (const [leg, a] of Object.entries(parsed.porLegajo)) {
    const emp = porLeg.get(leg);
    const v = vista(a);
    if (emp) {
      matcheados.push({ empleadoId: emp.id, legNum: emp.leg_num, nom: emp.nom, empresa: emp.empresa, legajoProsoft: a.legajoProsoft, ...v });
    } else {
      sinMatch.push({ legajoProsoft: a.legajoProsoft, empleado: a.empleado, empresaProsoft: a.empresaProsoft, area: a.area, ...v });
    }
  }
  matcheados.sort((x, y) => x.nom.localeCompare(y.nom));
  sinMatch.sort((x, y) => x.empleado.localeCompare(y.empleado));

  // ── Cruce con licencias APROBADAS del portal ──
  const ids = matcheados.map((m) => m.empleadoId);
  const licMap = new Map();
  if (ids.length) {
    // Ventana de licencias = rango real (puede cruzar meses); si no se pasa, el mes calendario.
    const ultimo = new Date(anio, mes, 0).getDate();
    const desdeP = desde || `${anio}-${String(mes).padStart(2, '0')}-01`;
    const hastaP = hasta || `${anio}-${String(mes).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
    const { rows: lics } = await query(
      `SELECT empleado_id, tipo, desde, hasta FROM licencias
        WHERE estado = 'aprobada' AND empleado_id = ANY($1::int[]) AND desde <= $2 AND hasta >= $3`,
      [ids, hastaP, desdeP]);
    for (const l of lics) {
      if (!licMap.has(l.empleado_id)) licMap.set(l.empleado_id, []);
      licMap.get(l.empleado_id).push({ tipo: l.tipo, desde: String(l.desde).slice(0, 10), hasta: String(l.hasta).slice(0, 10) });
    }
  }
  for (const m of matcheados) {
    const ranges = licMap.get(m.empleadoId) || [];
    let injust = 0, conflicto = 0;
    for (const d of (m.dias || [])) {
      const licP = ranges.find((r) => d.fecha >= r.desde && d.fecha <= r.hasta);
      d.licenciaPortal = licP ? licP.tipo : null;
      if (d.estado === 'sin-marca') {
        d.estado = licP ? 'licencia-portal' : 'injustificado';
        if (licP) d.licenciaSoloPortal = true;
      } else if (d.estado === 'licencia') {
        d.sinLicenciaPortal = !licP;
      } else if (licP) {
        d.licenciaConflicto = true;
      }
      if (d.estado === 'injustificado') injust++;
      if (d.licenciaConflicto) conflicto++;
    }
    m.diasInjustificados = injust;
    m.diasLicenciaConflicto = conflicto;
  }

  const resumen = {
    filas: parsed.filas,
    legajos: parsed.legajos,
    matcheados: matcheados.length,
    sinMatch: sinMatch.length,
    conRevisar: matcheados.filter((m) => m.diasARevisar.length).length,
    conInjustificados: matcheados.filter((m) => m.diasInjustificados > 0).length,
    conConflictoLicencia: matcheados.filter((m) => m.diasLicenciaConflicto > 0).length,
  };

  if (!confirmar) return { resumen, matcheados, sinMatch };

  // Persistir: upsert por (empleado, período) + log, en transacción.
  // soloPendientes=true → la cláusula WHERE evita pisar lo ya aprobado (tarea diaria).
  const guardaSiNoAprobada = soloPendientes ? `WHERE fichadas_periodo.estado IN ('pendiente','observada')` : '';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of matcheados) {
      const data = {
        legajoProsoft: m.legajoProsoft, diasTrabajados: m.diasTrabajados, hsNetasMin: m.hsNetasMin,
        horasExtra50Min: m.horasExtra50Min, horasExtra100Min: m.horasExtra100Min,
        horasExtraDescartadaMin: m.horasExtraDescartadaMin, bancoNetoMin: m.bancoNetoMin,
        tardanzasMin: m.tardanzasMin, diasTardanza: m.diasTardanza, diasARevisar: m.diasARevisar,
        licenciasProsoft: m.licenciasProsoft, diasLicencia: m.diasLicencia,
        diasInjustificados: m.diasInjustificados, diasLicenciaConflicto: m.diasLicenciaConflicto, dias: m.dias,
      };
      await client.query(
        `INSERT INTO fichadas_periodo (empleado_id, anio, mes, data, origen, importado_por)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (empleado_id, anio, mes)
         DO UPDATE SET data = EXCLUDED.data, origen = EXCLUDED.origen, importado_por = EXCLUDED.importado_por,
           estado = 'pendiente', rrhh_por = NULL, rrhh_at = NULL, rrhh_obs = NULL,
           ger_por = NULL, ger_at = NULL, ger_obs = NULL
         ${guardaSiNoAprobada}`,
        [m.empleadoId, anio, mes, JSON.stringify(data), origen, importadoPor]
      );
    }
    await client.query(
      `INSERT INTO fichadas_importaciones (anio, mes, archivo, filas, legajos, matcheados, sin_match, importado_por, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [anio, mes, archivoNombre, parsed.filas, parsed.legajos, matcheados.length, sinMatch.length,
       importadoPor, JSON.stringify({ origen, sinMatch: sinMatch.map((s) => ({ legajo: s.legajoProsoft, empleado: s.empleado })) })]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { resumen, matcheados, sinMatch };
}
