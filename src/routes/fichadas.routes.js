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
import { parseExtendido, normLegajo, minToHhmm, recomputarTotales, aplicarIntermedioDia } from '../lib/fichadasProsoft.js';
import { buildXlsx, buildPdf, nombreMes } from '../lib/fichadasExport.js';
import { idsDirectosDe } from '../lib/equipo.js';
import { getValidador } from '../lib/organigrama.js';
import { equipoEfectivo, esGestorDeTarea, notaDelegacion } from '../lib/delegaciones.js';
import { procesarParsed, getFeriadosSet, getTurnosReglas } from '../lib/fichadasProcesar.js';

const router = Router();
router.use(requireAuth);

// Archivo en memoria (no se persiste el .xlsx). Límite 30 MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// POST /api/fichadas/importar?confirmar=true|false   (multipart: archivo, anio, mes)
router.post('/importar', requireRole('rrhh', 'admin'), upload.single('archivo'), async (req, res, next) => {
  try {
    const anio = Number(req.body.anio);
    const mes = Number(req.body.mes);
    const desde = req.body.desde || null, hasta = req.body.hasta || null; // rango real (período de liquidación)
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

    const feriados = await getFeriadosSet(desde, hasta);
    const turnos = await getTurnosReglas();
    const parsed = parseExtendido(rows, { desde, hasta, feriados, turnos });
    if (parsed.columnasFaltantes.length) {
      return res.status(400).json({ error: `Al Excel le faltan columnas esperadas: ${parsed.columnasFaltantes.join(', ')}. Asegurate de exportar el "Extendido".` });
    }

    // Cruce + cálculo + persistencia (lógica compartida con la conexión Pro-Soft).
    const { resumen, matcheados, sinMatch } = await procesarParsed({
      parsed, anio, mes, confirmar, desde, hasta,
      origen: 'prosoft-extendido',
      importadoPor: req.user.dni || null,
      archivoNombre: req.file.originalname || null,
    });
    return res.json({ confirmado: confirmar, periodo: { anio, mes }, resumen, matcheados, sinMatch });
  } catch (e) { next(e); }
});

// GET /api/fichadas/importaciones/log — historial de importaciones. (Debe ir ANTES de /:anio/:mes)
router.get('/importaciones/log', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM fichadas_importaciones ORDER BY created_at DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/fichadas/turnos-reglas/sync — trae los turnos de Pro-Soft y deduce las
// reglas (jornada, horario de ingreso, restringido). No hay que cargarlos a mano.
router.post('/turnos-reglas/sync', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { prosoftConfigOk, getTurnos, reglasDesdeTurnos } = await import('../lib/prosoft.js');
    if (!prosoftConfigOk()) return res.status(400).json({ error: 'Pro-Soft no está configurado (PROSOFT_USER / PROSOFT_PASS).' });
    const turnos = await getTurnos();
    const reglas = reglasDesdeTurnos(turnos);
    for (const r of reglas) {
      await query(
        `INSERT INTO turnos_reglas (turno, jornada_min, inicio, restringido, updated_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (turno) DO UPDATE SET jornada_min=EXCLUDED.jornada_min, inicio=EXCLUDED.inicio, restringido=EXCLUDED.restringido, updated_at=now()`,
        [r.turno, r.jornada_min, r.inicio, r.restringido]);
    }
    res.json({ ok: true, sincronizados: reglas.length });
  } catch (e) { next(e); }
});

// DELETE /api/fichadas/importaciones/todo — limpia TODO el historial de importaciones.
// Solo borra el registro del historial; NO toca las fichadas ya cargadas.
router.delete('/importaciones/todo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM fichadas_importaciones');
    res.json({ ok: true, borradas: r.rowCount });
  } catch (e) { next(e); }
});

// GET /api/fichadas/turnos-reglas — reglas de cada turno (jornada, horario de inicio, restringido).
router.get('/turnos-reglas', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT turno, jornada_min, inicio, restringido FROM turnos_reglas ORDER BY turno');
    res.json(rows);
  } catch (e) { next(e); }
});

// PUT /api/fichadas/turnos-reglas  { reglas: [{ turno, jornada_min, inicio, restringido }] }
router.put('/turnos-reglas', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const reglas = Array.isArray(req.body && req.body.reglas) ? req.body.reglas : [];
    for (const r of reglas) {
      const turno = String((r && r.turno) || '').trim();
      if (!turno) continue;
      const jm = Math.max(1, Math.round(Number(r.jornada_min) || 540));
      const inicio = /^\d{1,2}:\d{2}$/.test(String((r.inicio || '')).trim()) ? String(r.inicio).trim() : null;
      const restr = !!r.restringido;
      await query(
        `INSERT INTO turnos_reglas (turno, jornada_min, inicio, restringido, updated_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (turno) DO UPDATE SET jornada_min=EXCLUDED.jornada_min, inicio=EXCLUDED.inicio, restringido=EXCLUDED.restringido, updated_at=now()`,
        [turno, jm, inicio, restr]);
    }
    res.json({ ok: true, guardadas: reglas.length });
  } catch (e) { next(e); }
});

// DELETE /api/fichadas/importaciones/:id — borra un registro del historial (solo el log).
router.delete('/importaciones/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM fichadas_importaciones WHERE id=$1', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Importación no encontrada.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/fichadas/:anio/:mes/export?formato=xlsx|pdf — descarga del período
// con el MISMO contenido que la consulta (resumen + tabla + detalle diario).
// (Debe ir ANTES de /:anio/:mes para que matchee la ruta más específica.)
router.get('/:anio/:mes/export', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    const formato = String(req.query.formato || 'xlsx').toLowerCase();
    // `empresa` y `sucursal` aceptan una o VARIAS opciones separadas por coma (selección múltiple).
    const empresas = req.query.empresa
      ? String(req.query.empresa).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const sucursales = req.query.sucursal
      ? String(req.query.sucursal).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    if (!anio || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'Período inválido.' });

    const cond = ['f.anio = $1', 'f.mes = $2'];
    const params = [anio, mes];
    if (empresas.length) { params.push(empresas); cond.push(`em.nombre = ANY($${params.length}::text[])`); }
    if (sucursales.length) { params.push(sucursales); cond.push(`(e.data->>'lugar') = ANY($${params.length}::text[])`); }
    const { rows } = await query(
      `SELECT f.empleado_id, e.leg_num, e.nom, em.nombre AS empresa, (e.data->>'lugar') AS sucursal, f.data
         FROM fichadas_periodo f
         JOIN empleados e ON e.id = f.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
        WHERE ${cond.join(' AND ')}
        ORDER BY em.nombre, e.nom`,
      params
    );
    const scope = [...empresas, ...sucursales];
    if (!rows.length) return res.status(404).json({ error: `No hay fichadas importadas para ${nombreMes(mes)} ${anio}${scope.length ? ` (${scope.join(', ')})` : ''}.` });

    const slug = scope.length ? '_' + scope.map((e) => e.replace(/[^\w]+/g, '')).join('-') : '';
    const base = `Fichadas_${anio}-${String(mes).padStart(2, '0')}${slug}`;
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
router.get('/equipo/:anio/:mes', async (req, res, next) => {
  try {
    if (!await esGestorDeTarea(req.user, 'fichadas')) return res.status(403).json({ error: 'No tenés acceso a las fichadas del equipo.' });
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    if (!anio || !mes) return res.status(400).json({ error: 'Período inválido.' });
    const cond = ['f.anio = $1', 'f.mes = $2', `f.estado IN ('aprob_rrhh','autorizada','observada')`];
    const params = [anio, mes];
    // Alcance: directos propios (si es gerente) + subárbol de quienes le delegaron fichadas.
    // Admin ve todo (sin filtro por equipo).
    if (req.user.role !== 'admin') {
      const ids = [...await equipoEfectivo(req.user, 'fichadas', idsDirectosDe)];
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
      // Los totales ya vienen del parser con el banco compensatorio corrido:
      // extra 50 (hábil >30/día + sábado) + extra 100 (domingo/feriado). El banco
      // (+ a favor / − a recuperar) es el saldo compensatorio que quedó.
      const banco = d.bancoNetoMin || 0;
      return {
        empleado_id: r.empleado_id, leg_num: r.leg_num, nom: r.nom, empresa: r.empresa,
        tardanzas_min: d.tardanzasMin || 0,
        resultado_mes_min: banco,
        extra_liquidable_min: (d.horasExtra50Min || 0) + (d.horasExtra100Min || 0),
        extra_50_min: d.horasExtra50Min || 0,
        extra_100_min: d.horasExtra100Min || 0,
        tiempo_a_recuperar_min: banco < 0 ? -banco : (d.aRecuperarMin || 0),
        banco_horas_min: banco > 0 ? banco : 0,
        ger_por: r.ger_por, ger_at: r.ger_at,
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Extra neto liquidable del período (mismo criterio que /liquidables y calcLiquidable
// del front): total de horas extra ya calculadas por el parser (50 % + 100 %). El
// tiempo en contra ya fue compensado dentro del banco corrido.
function extraNetoMin(data) {
  const d = data || {};
  return (d.horasExtra50Min || 0) + (d.horasExtra100Min || 0);
}

// PATCH /api/fichadas/:id/dia-intermedio { fecha, computar } — marca (o desmarca) el
// intervalo intermedio de un día como jornada trabajada. Suma ese tiempo al neto,
// recalcula el período y guarda el ajuste (persiste entre reimportaciones).
router.patch('/:id/dia-intermedio', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { fecha, computar } = req.body || {};
    if (!fecha) return res.status(400).json({ error: 'Indicá la fecha del día.' });
    const cur = (await query('SELECT id, empleado_id, data FROM fichadas_periodo WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Período no encontrado.' });
    const data = cur.data || {};
    const dia = (data.dias || []).find((d) => d.fecha === fecha);
    if (!dia) return res.status(404).json({ error: 'No se encontró ese día en el período.' });
    if (!((dia.intermedioMin || 0) > 0)) return res.status(400).json({ error: 'Ese día no tiene intervalo intermedio para computar.' });

    aplicarIntermedioDia(dia, !!computar);
    Object.assign(data, recomputarTotales(data.dias));
    await query('UPDATE fichadas_periodo SET data=$1 WHERE id=$2', [JSON.stringify(data), cur.id]);
    if (computar) {
      await query(`INSERT INTO fichadas_ajuste_intermedio (empleado_id, fecha) VALUES ($1,$2) ON CONFLICT (empleado_id, fecha) DO NOTHING`, [cur.empleado_id, fecha]);
    } else {
      await query('DELETE FROM fichadas_ajuste_intermedio WHERE empleado_id=$1 AND fecha=$2', [cur.empleado_id, fecha]);
    }
    res.json({ ok: true, computar: !!computar });
  } catch (e) { next(e); }
});

// PATCH /api/fichadas/:id/no-extra { valor } — marca/desmarca "no liquidar horas extra" de esa
// persona en el período. No cambia las fichadas; la liquidación no paga sus horas extra.
router.patch('/:id/no-extra', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cur = (await query('SELECT empleado_id, anio, mes FROM fichadas_periodo WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Período no encontrado.' });
    const valor = !!(req.body || {}).valor;
    if (valor) await query('INSERT INTO fichadas_no_extra (empleado_id, anio, mes) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [cur.empleado_id, cur.anio, cur.mes]);
    else await query('DELETE FROM fichadas_no_extra WHERE empleado_id=$1 AND anio=$2 AND mes=$3', [cur.empleado_id, cur.anio, cur.mes]);
    res.json({ ok: true, noExtra: valor });
  } catch (e) { next(e); }
});

// PATCH /api/fichadas/:id/aprobacion  { etapa:'rrhh'|'gerencia', accion:'aprobar'|'rechazar', obs? }
router.patch('/:id/aprobacion', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { etapa, accion, obs } = req.body || {};
    if (!['rrhh', 'gerencia'].includes(etapa)) return res.status(400).json({ error: 'Etapa inválida.' });
    if (!['aprobar', 'rechazar'].includes(accion)) return res.status(400).json({ error: 'Acción inválida.' });
    if (accion === 'rechazar' && !String(obs || '').trim()) return res.status(400).json({ error: 'Para rechazar, indicá un comentario.' });
    const cur = (await query('SELECT id, empleado_id, estado, data FROM fichadas_periodo WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Novedad no encontrada.' });

    if (etapa === 'rrhh') {
      if (!['rrhh', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo RR.HH./admin.' });
      if (!['pendiente', 'observada'].includes(cur.estado)) return res.status(409).json({ error: `No se puede aceptar en estado "${cur.estado}".` });
      if (accion === 'rechazar') {
        await query(
          `UPDATE fichadas_periodo SET estado='observada', rrhh_por=$1, rrhh_at=now(), rrhh_obs=$2,
             ger_por=NULL, ger_at=NULL, ger_obs=NULL WHERE id=$3`,
          [req.user.dni || null, obs, cur.id]);
        return res.json({ ok: true, estado: 'observada' });
      }
      // Aprobar: si NO genera horas extra netas, queda FIRME (autorizada) sin pasar por el gerente.
      // Si genera horas extra, queda 'aprob_rrhh' a la espera de que el gerente las autorice.
      if (extraNetoMin(cur.data) > 0) {
        await query(
          `UPDATE fichadas_periodo SET estado='aprob_rrhh', rrhh_por=$1, rrhh_at=now(), rrhh_obs=NULL,
             ger_por=NULL, ger_at=NULL, ger_obs=NULL WHERE id=$2`,
          [req.user.dni || null, cur.id]);
        return res.json({ ok: true, estado: 'aprob_rrhh' });
      }
      await query(
        `UPDATE fichadas_periodo SET estado='autorizada', rrhh_por=$1, rrhh_at=now(), rrhh_obs=NULL,
           ger_por='(sin hs. extra)', ger_at=now(), ger_obs=NULL WHERE id=$2`,
        [req.user.dni || null, cur.id]);
      return res.json({ ok: true, estado: 'autorizada' });
    }
    // etapa === 'gerencia' (responsable directo, CEO/admin o delegado)
    if (!await esGestorDeTarea(req.user, 'fichadas')) return res.status(403).json({ error: 'Solo gerente/admin o delegado.' });
    if (req.user.role !== 'admin') {
      const ids = await equipoEfectivo(req.user, 'fichadas', idsDirectosDe);
      if (!ids.has(cur.empleado_id)) return res.status(403).json({ error: 'Ese empleado no está en tu equipo (ni delegado).' });
    }
    if (cur.estado !== 'aprob_rrhh') return res.status(409).json({ error: `No se puede en estado "${cur.estado}" (RR.HH. debe aprobar primero).` });
    const nuevo = accion === 'aprobar' ? 'autorizada' : 'observada';
    const notaG = await notaDelegacion(req.user, 'fichadas');
    const gerPor = notaG ? `${req.user.dni || ''} (${notaG})` : (req.user.dni || null);
    await query(
      `UPDATE fichadas_periodo SET estado=$1, ger_por=$2, ger_at=now(), ger_obs=$3 WHERE id=$4`,
      [nuevo, gerPor, accion === 'rechazar' ? obs : null, cur.id]);
    return res.json({ ok: true, estado: nuevo });
  } catch (e) { next(e); }
});

// POST /api/fichadas/:anio/:mes/aprobacion-masiva  { etapa, accion, ids:[fichadaId...], obs? }
router.post('/:anio/:mes/aprobacion-masiva', async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    const { etapa, accion, ids, obs } = req.body || {};
    if (!['rrhh', 'gerencia'].includes(etapa)) return res.status(400).json({ error: 'Etapa inválida.' });
    if (!['aprobar', 'rechazar'].includes(accion)) return res.status(400).json({ error: 'Acción inválida.' });
    if (accion === 'rechazar' && !String(obs || '').trim()) return res.status(400).json({ error: 'Para rechazar, indicá un comentario.' });
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No seleccionaste novedades.' });
    if (etapa === 'rrhh' && !['rrhh', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo RR.HH./admin.' });
    if (etapa === 'gerencia' && !await esGestorDeTarea(req.user, 'fichadas')) return res.status(403).json({ error: 'Solo gerente/admin o delegado.' });

    const dir = (etapa === 'gerencia' && req.user.role !== 'admin') ? await equipoEfectivo(req.user, 'fichadas', idsDirectosDe) : null;
    const notaG = etapa === 'gerencia' ? await notaDelegacion(req.user, 'fichadas') : null;
    const gerPorMasa = notaG ? `${req.user.dni || ''} (${notaG})` : (req.user.dni || null);
    const client = await pool.connect();
    let n = 0;
    try {
      await client.query('BEGIN');
      for (const id of ids) {
        const cur = (await client.query('SELECT id, empleado_id, estado, data FROM fichadas_periodo WHERE id=$1 AND anio=$2 AND mes=$3', [id, anio, mes])).rows[0];
        if (!cur) continue;
        if (etapa === 'rrhh') {
          if (!['pendiente', 'observada'].includes(cur.estado)) continue;
          if (accion === 'rechazar') {
            await client.query(
              `UPDATE fichadas_periodo SET estado='observada', rrhh_por=$1, rrhh_at=now(), rrhh_obs=$2,
                 ger_por=NULL, ger_at=NULL, ger_obs=NULL WHERE id=$3`,
              [req.user.dni || null, obs, cur.id]);
            n++; continue;
          }
          if (extraNetoMin(cur.data) > 0) {
            await client.query(
              `UPDATE fichadas_periodo SET estado='aprob_rrhh', rrhh_por=$1, rrhh_at=now(), rrhh_obs=NULL,
                 ger_por=NULL, ger_at=NULL, ger_obs=NULL WHERE id=$2`,
              [req.user.dni || null, cur.id]);
          } else {
            await client.query(
              `UPDATE fichadas_periodo SET estado='autorizada', rrhh_por=$1, rrhh_at=now(), rrhh_obs=NULL,
                 ger_por='(sin hs. extra)', ger_at=now(), ger_obs=NULL WHERE id=$2`,
              [req.user.dni || null, cur.id]);
          }
          n++;
        } else {
          if (dir && !dir.has(cur.empleado_id)) continue;
          if (cur.estado !== 'aprob_rrhh') continue;
          const nuevo = accion === 'aprobar' ? 'autorizada' : 'observada';
          await client.query(
            `UPDATE fichadas_periodo SET estado=$1, ger_por=$2, ger_at=now(), ger_obs=$3 WHERE id=$4`,
            [nuevo, gerPorMasa, accion === 'rechazar' ? obs : null, cur.id]);
          n++;
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.json({ ok: true, actualizados: n });
  } catch (e) { next(e); }
});

// GET /api/fichadas/mias/ultima — la última fichada disponible del propio usuario (pantalla de inicio).
router.get('/mias/ultima', async (req, res, next) => {
  try {
    const row = (await query(
      `SELECT id, anio, mes, data, estado, rrhh_at, ger_at FROM fichadas_periodo WHERE empleado_id=$1 ORDER BY anio DESC, mes DESC LIMIT 1`,
      [req.user.id])).rows[0];
    res.json(row || null);
  } catch (e) { next(e); }
});

// GET /api/fichadas/mias/:anio/:mes — la fichada del PROPIO usuario para el período (pantalla de inicio).
router.get('/mias/:anio/:mes', async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    if (!anio || !mes) return res.status(400).json({ error: 'Período inválido.' });
    const row = (await query(
      `SELECT id, anio, mes, data, estado, rrhh_at, ger_at FROM fichadas_periodo WHERE empleado_id=$1 AND anio=$2 AND mes=$3`,
      [req.user.id, anio, mes])).rows[0];
    res.json(row || null);
  } catch (e) { next(e); }
});

// GET /api/fichadas/:anio/:mes — novedades importadas del período (panel RR.HH., con estado de aprobación).
router.get('/:anio/:mes', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.params.anio), mes = Number(req.params.mes);
    const { rows } = await query(
      `SELECT f.id, f.empleado_id, e.leg_num, e.nom, e.cat, e.data AS edata, em.nombre AS empresa,
              f.data, f.importado_por, f.updated_at, f.estado,
              f.rrhh_por, f.rrhh_at, f.rrhh_obs, f.ger_por, f.ger_at, f.ger_obs,
              (nx.empleado_id IS NOT NULL) AS no_extra
         FROM fichadas_periodo f
         JOIN empleados e ON e.id = f.empleado_id
         JOIN empresas em ON em.id = e.empresa_id
         LEFT JOIN fichadas_no_extra nx ON nx.empleado_id=f.empleado_id AND nx.anio=f.anio AND nx.mes=f.mes
        WHERE f.anio = $1 AND f.mes = $2
        ORDER BY e.nom`,
      [anio, mes]
    );
    // Anota el responsable directo (a dónde va el 2º control) y la sucursal
    // (lugar de trabajo), y limpia edata del payload.
    const out = rows.map((r) => {
      const responsable = responsableDe({ nom: r.nom, cat: r.cat, empresa: r.empresa, data: r.edata });
      const sucursal = r.edata?.lugar || '';
      const { edata, ...rest } = r;
      return { ...rest, responsable, sucursal };
    });
    res.json(out);
  } catch (e) { next(e); }
});

export default router;
