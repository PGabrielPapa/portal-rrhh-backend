// Conexión directa con Pro-Soft (Gestión de Personal): trae las fichadas por API
// en lugar de subir el Excel. Reutiliza el mismo cruce/cálculo/persistencia.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { prosoftConfigOk, importarMes, importarRango, getResumen, fechaISO } from '../lib/prosoft.js';
import { normLegajo, hhmmToMin } from '../lib/fichadasProsoft.js';
import { idsEquipoDe } from '../lib/equipo.js';
import { query } from '../db.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const primeraNoVacia = (obj, keys) => { for (const k of keys) { const v = String(obj?.[k] ?? '').trim(); if (v) return v; } return ''; };

const router = Router();
router.use(requireAuth);

// GET /api/prosoft/estado — ¿está configurada la conexión?
router.get('/estado', requireRole('rrhh', 'admin'), (req, res) => {
  res.json({ configurado: prosoftConfigOk(), auto: false });
});

// POST /api/prosoft/importar?confirmar=true|false
//   body: { anio, mes, desde?, hasta? }  (anio/mes = período de liquidación a etiquetar;
//   desde/hasta = rango real a traer, puede cruzar meses; si falta, el mes calendario).
router.post('/importar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    if (!prosoftConfigOk()) {
      return res.status(400).json({ error: 'La conexión con Pro-Soft no está configurada (faltan PROSOFT_USER / PROSOFT_PASS en el servidor).' });
    }
    const anio = Number(req.body.anio), mes = Number(req.body.mes);
    const desde = req.body.desde || null, hasta = req.body.hasta || null;
    const confirmar = String(req.query.confirmar || req.body.confirmar || '') === 'true';
    if (!anio || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'Indicá un período (mes y año) válido.' });
    if ((desde && !ISO.test(desde)) || (hasta && !ISO.test(hasta))) return res.status(400).json({ error: 'Fechas inválidas (usá AAAA-MM-DD).' });
    if (desde && hasta && hasta < desde) return res.status(400).json({ error: 'La fecha "hasta" debe ser posterior a "desde".' });

    const r = (desde && hasta)
      ? await importarRango(desde, hasta, anio, mes, { confirmar, importadoPor: req.user.dni || null })
      : await importarMes(anio, mes, { confirmar, importadoPor: req.user.dni || null });
    res.json({ confirmado: confirmar, periodo: r.periodo, resumen: r.resumen, matcheados: r.matcheados, sinMatch: r.sinMatch });
  } catch (e) { next(e); }
});

// GET /api/prosoft/dia?fecha=YYYY-MM-DD&scope=mias|equipo|todas
// Marcas del día EN VIVO desde Pro-Soft, cruzadas por legajo y acotadas por rol.
//   mias   → el propio empleado (cualquier rol)
//   equipo → equipo a cargo (manager) / todos (admin)
//   todas  → todos (rrhh/admin)
router.get('/dia', async (req, res, next) => {
  try {
    if (!prosoftConfigOk()) return res.status(400).json({ error: 'La conexión con Pro-Soft no está configurada.' });
    const fecha = ISO.test(String(req.query.fecha || '')) ? String(req.query.fecha) : hoyISO();
    const scope = String(req.query.scope || 'mias');

    // Empleados en alcance (del portal).
    let sql = `SELECT e.id, e.leg_num, e.nom, em.nombre AS empresa
                 FROM empleados e JOIN empresas em ON em.id = e.empresa_id
                WHERE e.activo = true`;
    const params = [];
    if (scope === 'mias') {
      params.push(req.user.id); sql += ` AND e.id = $${params.length}`;
    } else if (scope === 'equipo') {
      if (!['manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo gerente/admin.' });
      if (req.user.role === 'manager') {
        const ids = [...await idsEquipoDe(req.user.id)];
        if (!ids.length) return res.json({ fecha, empleados: [], resumen: { total: 0, ficharon: 0, sinFichar: 0 } });
        params.push(ids); sql += ` AND e.id = ANY($${params.length}::int[])`;
      }
    } else if (scope === 'todas') {
      if (!['rrhh', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Solo RR.HH./admin.' });
    } else {
      return res.status(400).json({ error: 'scope inválido (mias|equipo|todas).' });
    }
    const { rows: emps } = await query(sql, params);

    // Marcas del día desde Pro-Soft (todo el día; se cruza localmente por legajo).
    const datos = await getResumen(fecha, fecha);
    const porLeg = new Map();
    for (const d of datos) porLeg.set(normLegajo(d.legajo), d);

    let ficharon = 0, sinFichar = 0;
    const empleados = emps.map((e) => {
      const d = porLeg.get(normLegajo(e.leg_num));
      const entrada = d ? primeraNoVacia(d, ['e1', 'e2', 'e3', 'e4']) : '';
      const salida = d ? primeraNoVacia(d, ['s4', 's3', 's2', 's1']) : '';
      const estado = d ? String(d.estado || '').trim() : '';
      const comentario = d ? String(d.comentario || '').trim() : '';
      const esFranco = /franco|descanso|libre|feriado/i.test(estado);
      const laborable = d ? hhmmToMin(d.hs_normal) > 0 : false;
      const ficho = !!entrada;
      // Ausente según el reloj: hay fila, no fichó, no es franco/feriado ni tiene comentario.
      const sinF = !!d && !ficho && !esFranco && !comentario;
      if (ficho) ficharon++;
      if (sinF) sinFichar++;
      return {
        empleado_id: e.id, leg_num: e.leg_num, nom: e.nom, empresa: e.empresa,
        entrada, salida, hsNetas: d?.hsnetas || '', estado: d?.estado || '',
        tarde: d?.tarde || '', turno: d?.turno || '', comentario, laborable, ficho, sinFichar: sinF,
        marcas: d ? ['e1', 's1', 'e2', 's2', 'e3', 's3', 'e4', 's4'].map((k) => String(d[k] || '').trim()).filter(Boolean) : [],
      };
    });
    // Primero los que no ficharon (para que salten a la vista), después por nombre.
    empleados.sort((a, b) => (a.sinFichar === b.sinFichar ? a.nom.localeCompare(b.nom) : (a.sinFichar ? -1 : 1)));

    res.json({ fecha, empleados, resumen: { total: empleados.length, ficharon, sinFichar } });
  } catch (e) { next(e); }
});

// Empleados del portal en alcance según rol. Devuelve {rows} o {forbidden}/{bad}.
async function scopeEmpleados(req, scope) {
  let sql = `SELECT e.id, e.leg_num, e.nom, em.nombre AS empresa
               FROM empleados e JOIN empresas em ON em.id = e.empresa_id
              WHERE e.activo = true`;
  const params = [];
  if (scope === 'mias') {
    params.push(req.user.id); sql += ` AND e.id = $${params.length}`;
  } else if (scope === 'equipo') {
    if (!['manager', 'admin'].includes(req.user.role)) return { forbidden: true };
    // Siempre el equipo del usuario según el organigrama — también para admin
    // (el tablero es "del equipo"; para ver todos está la pantalla de RR.HH.).
    const ids = [...await idsEquipoDe(req.user.id)];
    if (!ids.length) return { rows: [] };
    params.push(ids); sql += ` AND e.id = ANY($${params.length}::int[])`;
  } else if (scope === 'todas') {
    if (!['rrhh', 'admin'].includes(req.user.role)) return { forbidden: true };
  } else {
    return { bad: true };
  }
  const { rows } = await query(sql, params);
  return { rows };
}

// GET /api/prosoft/tablero?anio=&mes=&scope=equipo|todas
// Una sola llamada al reloj (mes a la fecha) → fichadas de hoy + ausentes de hoy
// (con justificación: comentario del reloj o licencia aprobada del portal) +
// tardanzas ACUMULADAS del mes. Todo acotado por rol/equipo.
router.get('/tablero', async (req, res, next) => {
  try {
    if (!prosoftConfigOk()) return res.status(400).json({ error: 'La conexión con Pro-Soft no está configurada.' });
    const scope = String(req.query.scope || 'equipo');
    const now = new Date();
    const anio = Number(req.query.anio) || now.getFullYear();
    const mes = Number(req.query.mes) || (now.getMonth() + 1);

    const s = await scopeEmpleados(req, scope);
    if (s.forbidden) return res.status(403).json({ error: 'No autorizado.' });
    if (s.bad) return res.status(400).json({ error: 'scope inválido.' });
    const emps = s.rows;
    const hoy = hoyISO();
    const esMesActual = anio === now.getFullYear() && mes === (now.getMonth() + 1);
    const primero = `${anio}-${String(mes).padStart(2, '0')}-01`;
    const finMes = `${anio}-${String(mes).padStart(2, '0')}-${String(new Date(anio, mes, 0).getDate()).padStart(2, '0')}`;
    const hasta = esMesActual ? hoy : finMes;

    // Un solo pull del reloj: mes a la fecha.
    const datos = emps.length ? await getResumen(primero, hasta) : [];
    const porLeg = new Map();
    for (const d of datos) { const k = normLegajo(d.legajo); if (!porLeg.has(k)) porLeg.set(k, []); porLeg.get(k).push(d); }

    // Licencias del portal que cubren HOY (para justificar ausencias).
    const ids = emps.map((e) => e.id);
    const licHoy = new Map();
    if (ids.length && esMesActual) {
      const { rows: lics } = await query(
        `SELECT empleado_id, tipo FROM licencias WHERE estado='aprobada' AND empleado_id = ANY($1::int[]) AND desde <= $2 AND hasta >= $2`,
        [ids, hoy]);
      for (const l of lics) if (!licHoy.has(l.empleado_id)) licHoy.set(l.empleado_id, l.tipo);
    }

    const entrada = (d) => primeraNoVacia(d, ['e1', 'e2', 'e3', 'e4']);
    const salida = (d) => primeraNoVacia(d, ['s4', 's3', 's2', 's1']);

    let ficharon = 0, injustificados = 0, tardCasos = 0, tardTotal = 0;
    const ausentes = [], rankingTarde = [], detalleTarde = [];

    for (const e of emps) {
      const filas = porLeg.get(normLegajo(e.leg_num)) || [];

      // ── Hoy (solo si es el mes en curso) ──
      // El reloj marca "Ausente" a todo el que no fichó (sin motivo). El motivo
      // (vacaciones/licencia) sale del portal. Franco/feriado NO cuenta como ausente.
      if (esMesActual) {
        const hoyRow = filas.find((d) => fechaISO(d.dia) === hoy);
        const fichoHoy = hoyRow ? !!entrada(hoyRow) : false;
        const estadoHoy = hoyRow ? String(hoyRow.estado || '').trim() : '';
        const comentHoy = hoyRow ? String(hoyRow.comentario || '').trim() : '';
        const esFranco = /franco|descanso|libre|feriado/i.test(estadoHoy);
        if (fichoHoy) {
          ficharon++;
        } else if (!esFranco) {
          // Motivo: comentario del reloj, licencia del portal, o el estado si trae uno.
          const estadoMotivo = estadoHoy && !/ausente|sin estado|presente/i.test(estadoHoy) ? estadoHoy : null;
          const justificacion = comentHoy || licHoy.get(e.id) || estadoMotivo || null;
          if (!justificacion) injustificados++;
          ausentes.push({ empleado_id: e.id, nom: e.nom, empresa: e.empresa, justificacion });
        }
      }

      // ── Tardanzas acumuladas del mes (días con marca completa) ──
      let tardEmp = 0;
      for (const d of filas) {
        const completa = !!entrada(d) && !!salida(d) && hhmmToMin(d.hsnetas) > 0;
        const t = hhmmToMin(d.tarde);
        if (completa && t > 0) {
          tardEmp += t;
          detalleTarde.push({ nom: e.nom, fecha: fechaISO(d.dia), dia: d.diasemana || null, entrada: entrada(d) || null, min: t });
        }
      }
      if (tardEmp > 0) { tardCasos++; tardTotal += tardEmp; rankingTarde.push({ nom: e.nom, min: tardEmp }); }
    }

    ausentes.sort((a, b) => (!!a.justificacion === !!b.justificacion ? a.nom.localeCompare(b.nom) : (a.justificacion ? 1 : -1)));
    rankingTarde.sort((a, b) => b.min - a.min);
    detalleTarde.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || (b.min - a.min));

    res.json({
      fecha: hoy,
      periodo: { anio, mes },
      fichadas: { total: emps.length, ficharon, ausentes: ausentes.length, injustificados },
      ausentes,
      tardanzas: { casos: tardCasos, totalMin: tardTotal, ranking: rankingTarde.slice(0, 8), detalle: detalleTarde.slice(0, 200) },
    });
  } catch (e) { next(e); }
});

export default router;
