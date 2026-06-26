// Importación de fichadas desde Pro-Soft (Reporte Marcas Extendido).
// Flujo: RR.HH. sube el Excel del período → se parsea y se cruza por legajo
// contra los empleados del portal → preview (matcheados / sin match / a revisar).
// Con ?confirmar=true se persisten las novedades en fichadas_periodo.
//
// Esta etapa NO toca el motor de liquidación: las horas extra quedan guardadas
// como informativas hasta tener el circuito de autorización del gerente.
import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { pool, query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseExtendido, normLegajo, minToHhmm } from '../lib/fichadasProsoft.js';
import { buildXlsx, buildPdf, nombreMes } from '../lib/fichadasExport.js';
import { idsDirectosDe } from '../lib/equipo.js';
import { getValidador } from '../lib/organigrama.js';

const router = Router();
router.use(requireAuth);

// Archivo en memoria (no se persiste el .xlsx). Límite 30 MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

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

// POST /api/fichadas/importar?confirmar=true|false   (multipart: archivo, anio, mes)
router.post('/importar', requireRole('rrhh', 'admin'), upload.single('archivo'), async (req, res, next) => {
  try {
    const anio = Number(req.body.anio);
    const mes = Number(req.body.mes);
    const confirmar = String(req.query.confirmar || req.body.confirmar || '') === 'true';
    if (!req.file) return res.status(400).json({ error: 'Subí el archivo Excel (campo "archivo").' });
    if (!anio || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'Indicá año y mes válidos.' });

    // Leer el Excel desde el buffer en memoria.
    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
    } catch {
      return res.status(400).json({ error: 'No pude leer el Excel. ¿Es el "Reporte Marcas Extendido" de Pro-Soft?' });
    }

    const parsed = parseExtendido(rows);
    if (parsed.columnasFaltantes.length) {
      return res.status(400).json({ error: `Al Excel le faltan columnas esperadas: ${parsed.columnasFaltantes.join(', ')}. Asegurate de exportar el "Extendido".` });
    }

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
    // Anota cada día con la licencia del portal que lo cubre. Un día laborable
    // sin marca y sin licencia (ni en Pro-Soft ni en el portal) = injustificado.
    const ids = matcheados.map((m) => m.empleadoId);
    const licMap = new Map();
    if (ids.length) {
      const ultimo = new Date(anio, mes, 0).getDate();
      const desdeP = `${anio}-${String(mes).padStart(2, '0')}-01`;
      const hastaP = `${anio}-${String(mes).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
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
          if (licP) d.licenciaSoloPortal = true;   // el portal tiene licencia; el reloj NO la registró
        } else if (d.estado === 'licencia') {
          d.sinLicenciaPortal = !licP;             // Pro-Soft marca licencia; el portal NO la tiene
        } else if (licP) {
          // Hay licencia aprobada en el portal PERO el reloj muestra trabajo/marcas
          // ese día → informó una licencia y al final no la tomó (trabajó).
          d.licenciaConflicto = true;
        }
        if (d.estado === 'injustificado') injust++;
        if (d.licenciaConflicto) conflicto++;
      }
      m.diasInjustificados = injust;
      m.diasLicenciaConflicto = conflicto;
    }
    const conRevisar = matcheados.filter((m) => m.diasARevisar.length).length;

    const resumen = {
      filas: parsed.filas,
      legajos: parsed.legajos,
      matcheados: matcheados.length,
      sinMatch: sinMatch.length,
      conRevisar,
      conInjustificados: matcheados.filter((m) => m.diasInjustificados > 0).length,
      conConflictoLicencia: matcheados.filter((m) => m.diasLicenciaConflicto > 0).length,
    };

    // Si no se confirma, devolvemos solo el preview (no se persiste).
    if (!confirmar) {
      return res.json({ confirmado: false, periodo: { anio, mes }, resumen, matcheados, sinMatch });
    }

    // Persistir: upsert por (empleado, período) + log de importación, en transacción.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const m of matcheados) {
        const data = {
          legajoProsoft: m.legajoProsoft,
          diasTrabajados: m.diasTrabajados,
          hsNetasMin: m.hsNetasMin,
          horasExtra50Min: m.horasExtra50Min,
          horasExtra100Min: m.horasExtra100Min,
          horasExtraDescartadaMin: m.horasExtraDescartadaMin,
          bancoNetoMin: m.bancoNetoMin,
          tardanzasMin: m.tardanzasMin,
          diasTardanza: m.diasTardanza,
          diasARevisar: m.diasARevisar,
          licenciasProsoft: m.licenciasProsoft,
          diasLicencia: m.diasLicencia,
          diasInjustificados: m.diasInjustificados,
          diasLicenciaConflicto: m.diasLicenciaConflicto,
          dias: m.dias,
        };
        await client.query(
          `INSERT INTO fichadas_periodo (empleado_id, anio, mes, data, origen, importado_por)
           VALUES ($1,$2,$3,$4,'prosoft-extendido',$5)
           ON CONFLICT (empleado_id, anio, mes)
           DO UPDATE SET data = EXCLUDED.data, origen = EXCLUDED.origen, importado_por = EXCLUDED.importado_por,
             -- Los datos cambiaron → vuelve a circuito: hay que re-controlar y re-aprobar.
             estado = 'pendiente', rrhh_por = NULL, rrhh_at = NULL, rrhh_obs = NULL,
             ger_por = NULL, ger_at = NULL, ger_obs = NULL`,
          [m.empleadoId, anio, mes, JSON.stringify(data), req.user.dni || null]
        );
      }
      await client.query(
        `INSERT INTO fichadas_importaciones (anio, mes, archivo, filas, legajos, matcheados, sin_match, importado_por, detalle)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [anio, mes, req.file.originalname || null, parsed.filas, parsed.legajos, matcheados.length, sinMatch.length,
         req.user.dni || null, JSON.stringify({ sinMatch: sinMatch.map((s) => ({ legajo: s.legajoProsoft, empleado: s.empleado })) })]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.json({ confirmado: true, periodo: { anio, mes }, resumen, matcheados, sinMatch });
  } catch (e) { next(e); }
});

// GET /api/fichadas/importaciones/log — historial de importaciones. (Debe ir ANTES de /:anio/:mes)
router.get('/importaciones/log', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM fichadas_importaciones ORDER BY created_at DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/fichadas/:anio/:mes/export?formato=xlsx|pdf — descarga del período
// con el MISMO contenido que la consulta (resumen + tabla + detalle diario).
// (Debe ir ANTES de /:anio/:mes para que matchee la ruta más específica.)
router.get('/:anio/:mes/export', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    const formato = String(req.query.formato || 'xlsx').toLowerCase();
    if (!anio || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'Período inválido.' });

    const { rows } = await query(
      `SELECT f.empleado_id, e.leg_num, e.nom, em.nombre AS empresa, f.data
         FROM fichadas_periodo f
         JOIN empleados e ON e.id = f.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
        WHERE f.anio = $1 AND f.mes = $2
        ORDER BY e.nom`,
      [anio, mes]
    );
    if (!rows.length) return res.status(404).json({ error: `No hay fichadas importadas para ${nombreMes(mes)} ${anio}.` });

    const base = `Fichadas_${anio}-${String(mes).padStart(2, '0')}`;
    if (formato === 'pdf') {
      const buf = await buildPdf({ anio, mes }, rows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
      return res.send(buf);
    }
    if (formato === 'xlsx') {
      const buf = buildXlsx({ anio, mes }, rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
      return res.send(buf);
    }
    return res.status(400).json({ error: 'Formato no soportado. Usá formato=xlsx o formato=pdf.' });
  } catch (e) { next(e); }
});

// Responsable directo (validador del organigrama) de un empleado, para mostrar a dónde irá el 2º control.
function responsableDe(e) {
  try {
    const v = getValidador({ nom: e.nom, cat: e.cat, emp: e.empresa, lugar: e.data?.lugar, validador: e.data?.validador, areaOrg: e.data?.areaOrg, area: e.data?.area });
    return v?.validador || null;
  } catch { return null; }
}

// GET /api/fichadas/equipo/:anio/:mes — cola del 2º control (responsable directo / CEO-admin).
// (Debe ir ANTES de /:anio/:mes.)
router.get('/equipo/:anio/:mes', requireRole('manager', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    if (!anio || !mes) return res.status(400).json({ error: 'Período inválido.' });
    const cond = ['f.anio = $1', 'f.mes = $2', `f.estado IN ('aprob_rrhh','autorizada','observada')`];
    const params = [anio, mes];
    if (req.user.role === 'manager') {
      const ids = [...await idsDirectosDe(req.user.id)];
      if (!ids.length) return res.json([]);
      params.push(ids);
      cond.push(`f.empleado_id = ANY($${params.length}::int[])`);
    }
    const { rows } = await query(
      `SELECT f.id, f.empleado_id, e.leg_num, e.nom, em.nombre AS empresa, f.data, f.estado,
              f.rrhh_por, f.rrhh_at, f.rrhh_obs, f.ger_por, f.ger_at, f.ger_obs, f.updated_at
         FROM fichadas_periodo f
         JOIN empleados e ON e.id = f.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
        WHERE ${cond.join(' AND ')}
        ORDER BY (f.estado='aprob_rrhh') DESC, e.nom`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/fichadas/:anio/:mes/liquidables — novedades AUTORIZADAS (listas para liquidar).
// (Debe ir ANTES de /:anio/:mes.)
router.get('/:anio/:mes/liquidables', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    if (!anio || !mes) return res.status(400).json({ error: 'Período inválido.' });
    // Lo liquidable: la hora extra COMPENSA primero el tiempo en contra.
    //   extra_neto = (extra50 + extra100) − tiempo_en_contra
    // donde tiempo_en_contra = suma de días con marca completa por debajo de la
    // jornada. Las horas a favor (banco positivo) son solo de control.
    const { rows } = await query(
      `SELECT f.empleado_id, e.leg_num, e.nom, em.nombre AS empresa, f.data, f.ger_por, f.ger_at
         FROM fichadas_periodo f
         JOIN empleados e ON e.id = f.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
        WHERE f.anio = $1 AND f.mes = $2 AND f.estado = 'autorizada'
        ORDER BY e.nom`,
      [anio, mes]
    );
    const out = rows.map((r) => {
      const d = r.data || {};
      // Extra POR DÍA: solo días con saldo a favor ≥ 30 min. Los <30/día no suman
      // (van a banco de horas). El extra compensa primero el tiempo en contra.
      const dias = Array.isArray(d.dias) ? d.dias : [];
      let extraBruta = 0, deficit = 0, bancoChico = 0;
      for (const x of dias) {
        const s = typeof x.saldoMin === 'number' ? x.saldoMin : null;
        if (s == null) continue;
        if (s >= 30) extraBruta += s;
        else if (s > 0) bancoChico += s;
        else if (s < 0) deficit += -s;
      }
      return {
        empleado_id: r.empleado_id, leg_num: r.leg_num, nom: r.nom, empresa: r.empresa,
        tardanzas_min: d.tardanzasMin || 0,
        resultado_mes_min: d.bancoNetoMin || 0,
        extra_liquidable_min: Math.max(0, extraBruta - deficit),
        tiempo_a_recuperar_min: Math.max(0, deficit - extraBruta),
        banco_horas_min: bancoChico,
        ger_por: r.ger_por, ger_at: r.ger_at,
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// PATCH /api/fichadas/:id/aprobacion  { etapa:'rrhh'|'gerencia', accion:'aprobar'|'rechazar', obs? }
router.patch('/:id/aprobacion', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { etapa, accion, obs } = req.body || {};
    if (!['rrhh', 'gerencia'].includes(etapa)) return res.status(400).json({ error: 'Etapa inválida.' });
    if (!['aprobar', 'rechazar'].includes(accion)) return res.status(400).json({ error: 'Acción inválida.' });
    if (accion === 'rechazar' && !String(obs || '').trim()) return res.status(400).json({ error: 'Para rechazar, indicá un comentario.' });
    const cur = (await query('SELECT id, empleado_id, estado FROM fichadas_periodo WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Novedad no encontrada.' });

    if (etapa === 'rrhh') {
      if (!['rrhh', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo RR.HH./admin.' });
      if (!['pendiente', 'observada'].includes(cur.estado)) return res.status(409).json({ error: `No se puede aceptar en estado "${cur.estado}".` });
      const nuevo = accion === 'aprobar' ? 'aprob_rrhh' : 'observada';
      await query(
        `UPDATE fichadas_periodo SET estado=$1, rrhh_por=$2, rrhh_at=now(), rrhh_obs=$3,
           ger_por=NULL, ger_at=NULL, ger_obs=NULL WHERE id=$4`,
        [nuevo, req.user.dni || null, accion === 'rechazar' ? obs : null, cur.id]);
      return res.json({ ok: true, estado: nuevo });
    }
    // etapa === 'gerencia' (responsable directo o CEO/admin)
    if (!['manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo gerente/admin.' });
    if (req.user.role === 'manager') {
      const ids = await idsDirectosDe(req.user.id);
      if (!ids.has(cur.empleado_id)) return res.status(403).json({ error: 'Ese empleado no es tu reporte directo.' });
    }
    if (cur.estado !== 'aprob_rrhh') return res.status(409).json({ error: `No se puede en estado "${cur.estado}" (RR.HH. debe aprobar primero).` });
    const nuevo = accion === 'aprobar' ? 'autorizada' : 'observada';
    await query(
      `UPDATE fichadas_periodo SET estado=$1, ger_por=$2, ger_at=now(), ger_obs=$3 WHERE id=$4`,
      [nuevo, req.user.dni || null, accion === 'rechazar' ? obs : null, cur.id]);
    return res.json({ ok: true, estado: nuevo });
  } catch (e) { next(e); }
});

// POST /api/fichadas/:anio/:mes/aprobacion-masiva  { etapa, accion, ids:[fichadaId...], obs? }
router.post('/:anio/:mes/aprobacion-masiva', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    const { etapa, accion, ids, obs } = req.body || {};
    if (!['rrhh', 'gerencia'].includes(etapa)) return res.status(400).json({ error: 'Etapa inválida.' });
    if (!['aprobar', 'rechazar'].includes(accion)) return res.status(400).json({ error: 'Acción inválida.' });
    if (accion === 'rechazar' && !String(obs || '').trim()) return res.status(400).json({ error: 'Para rechazar, indicá un comentario.' });
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No seleccionaste novedades.' });
    if (etapa === 'rrhh' && !['rrhh', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo RR.HH./admin.' });
    if (etapa === 'gerencia' && !['manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo gerente/admin.' });

    const dir = (etapa === 'gerencia' && req.user.role === 'manager') ? await idsDirectosDe(req.user.id) : null;
    const client = await pool.connect();
    let n = 0;
    try {
      await client.query('BEGIN');
      for (const id of ids) {
        const cur = (await client.query('SELECT id, empleado_id, estado FROM fichadas_periodo WHERE id=$1 AND anio=$2 AND mes=$3', [id, anio, mes])).rows[0];
        if (!cur) continue;
        if (etapa === 'rrhh') {
          if (!['pendiente', 'observada'].includes(cur.estado)) continue;
          const nuevo = accion === 'aprobar' ? 'aprob_rrhh' : 'observada';
          await client.query(
            `UPDATE fichadas_periodo SET estado=$1, rrhh_por=$2, rrhh_at=now(), rrhh_obs=$3,
               ger_por=NULL, ger_at=NULL, ger_obs=NULL WHERE id=$4`,
            [nuevo, req.user.dni || null, accion === 'rechazar' ? obs : null, cur.id]);
          n++;
        } else {
          if (dir && !dir.has(cur.empleado_id)) continue;
          if (cur.estado !== 'aprob_rrhh') continue;
          const nuevo = accion === 'aprobar' ? 'autorizada' : 'observada';
          await client.query(
            `UPDATE fichadas_periodo SET estado=$1, ger_por=$2, ger_at=now(), ger_obs=$3 WHERE id=$4`,
            [nuevo, req.user.dni || null, accion === 'rechazar' ? obs : null, cur.id]);
          n++;
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.json({ ok: true, actualizados: n });
  } catch (e) { next(e); }
});

// GET /api/fichadas/:anio/:mes — novedades importadas del período (panel RR.HH., con estado de aprobación).
router.get('/:anio/:mes', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    const { rows } = await query(
      `SELECT f.id, f.empleado_id, e.leg_num, e.nom, e.cat, e.data AS edata, em.nombre AS empresa,
              f.data, f.importado_por, f.updated_at, f.estado,
              f.rrhh_por, f.rrhh_at, f.rrhh_obs, f.ger_por, f.ger_at, f.ger_obs
         FROM fichadas_periodo f
         JOIN empleados e ON e.id = f.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
        WHERE f.anio = $1 AND f.mes = $2
        ORDER BY e.nom`,
      [anio, mes]
    );
    // Anota el responsable directo (a dónde va el 2º control) y limpia edata del payload.
    const out = rows.map((r) => {
      const responsable = responsableDe({ nom: r.nom, cat: r.cat, empresa: r.empresa, data: r.edata });
      const { edata, ...rest } = r;
      return { ...rest, responsable };
    });
    res.json(out);
  } catch (e) { next(e); }
});

export default router;
