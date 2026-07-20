import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { puedeVerConfidenciales } from '../lib/confidencial.js';

const router = Router();
router.use(requireAuth);

// Tipos soportados y cómo se mapean a las opciones del motor de liquidación.
export const TIPOS_NOVEDAD = [
  ['he50', 'Horas extra 50%', 'cantidad'],
  ['he100', 'Horas extra 100%', 'cantidad'],
  ['heEx', 'Horas extra exentas (Ganancias)', 'cantidad'],
  ['feriadosTrabajados', 'Feriados trabajados', 'cantidad'],
  ['diasSuspension', 'Días de suspensión', 'cantidad'],
  ['ausencias', 'Ausencias injustificadas (días)', 'cantidad'],
  ['otrosRemun', 'Otros haberes remunerativos', 'monto'],
  ['otrosNoRem', 'Otros haberes no remunerativos', 'monto'],
  ['otrosExentos', 'Otros conceptos exentos', 'monto'],
  ['otrosDesc', 'Otros descuentos', 'monto'],
  ['bonoProductividadExento', 'Bono productividad (exento)', 'monto'],
];
const TIPO_INFO = Object.fromEntries(TIPOS_NOVEDAD.map(([k, l, u]) => [k, { label: l, unidad: u }]));
const MAP_CANT = { he50: 'he50', he100: 'he100', heEx: 'heEx', feriadosTrabajados: 'ferT', diasSuspension: 'diasSuspension', ausencias: 'ausenciasInjustificadas' };
const MAP_MONTO = { otrosRemun: 'otrosRemun', otrosNoRem: 'otrosNoRem', otrosExentos: 'otrosExentos', otrosDesc: 'otrosDesc', bonoProductividadExento: 'bonoProductividadExento' };

// Helper para la liquidación: agrega las novedades del empleado/período en opts del motor.
export async function novedadesOpts(empleadoId, anio, mes) {
  const { rows } = await query('SELECT tipo, cantidad, monto, detalle FROM novedades WHERE empleado_id=$1 AND anio=$2 AND mes=$3', [empleadoId, Number(anio), Number(mes)]);
  const opts = {}; const labels = {};
  for (const n of rows) {
    if (MAP_CANT[n.tipo]) opts[MAP_CANT[n.tipo]] = (Number(opts[MAP_CANT[n.tipo]]) || 0) + Number(n.cantidad || 0);
    else if (MAP_MONTO[n.tipo]) { const k = MAP_MONTO[n.tipo]; opts[k] = (Number(opts[k]) || 0) + Number(n.monto || 0); if (n.detalle && !labels[k]) labels[k] = n.detalle; }
  }
  if (labels.otrosRemun) opts.otrosRemunLabel = labels.otrosRemun;
  if (labels.otrosNoRem) opts.otrosNoRemLabel = labels.otrosNoRem;
  if (labels.otrosExentos) opts.otrosExentosLabel = labels.otrosExentos;
  if (labels.otrosDesc) opts.otrosDescLabel = labels.otrosDesc;
  return opts;
}

// ── Topes por novedad (control del acumulado por legajo y período) ─────────────
// Réplica de Tango: se controla la cantidad/valor acumulado de cada novedad por
// legajo dentro de una ventana (anual, semestral o mensual). tope 0 = sin control.
const PERIODOS_TOPE = ['anual', 'semestral', 'mensual'];

async function topeDe(tipo) {
  const r = await query('SELECT tipo, periodo, tope_cantidad, tope_monto, bloquear FROM novedad_topes WHERE tipo=$1', [tipo]);
  return r.rows[0] || null;
}

// Acumulado de un tipo para un legajo dentro de la ventana del período.
async function acumuladoNovedad(empleadoId, tipo, periodo, anio, mes) {
  anio = Number(anio); mes = Number(mes);
  let cond, args;
  if (periodo === 'mensual') { cond = 'anio=$3 AND mes=$4'; args = [empleadoId, tipo, anio, mes]; }
  else if (periodo === 'semestral') { const lo = mes <= 6 ? 1 : 7, hi = mes <= 6 ? 6 : 12; cond = 'anio=$3 AND mes BETWEEN $4 AND $5'; args = [empleadoId, tipo, anio, lo, hi]; }
  else { cond = 'anio=$3'; args = [empleadoId, tipo, anio]; }
  const r = await query(`SELECT COALESCE(SUM(cantidad),0) c, COALESCE(SUM(monto),0) m FROM novedades WHERE empleado_id=$1 AND tipo=$2 AND ${cond}`, args);
  return { cantidad: Number(r.rows[0].c), monto: Number(r.rows[0].m) };
}

// null si está dentro del tope; si no, detalle del exceso.
async function chequearTope(empleadoId, anio, mes, tipo, addCant, addMonto) {
  const t = await topeDe(tipo);
  if (!t) return null;
  const unidad = TIPO_INFO[tipo]?.unidad;
  const tope = unidad === 'cantidad' ? Number(t.tope_cantidad) : Number(t.tope_monto);
  if (!tope || tope <= 0) return null;
  const acc = await acumuladoNovedad(empleadoId, tipo, t.periodo, anio, mes);
  const usado = unidad === 'cantidad' ? acc.cantidad : acc.monto;
  const add = unidad === 'cantidad' ? Number(addCant || 0) : Number(addMonto || 0);
  const total = usado + add;
  if (total > tope + 1e-9) return { tope, usado, add, total, periodo: t.periodo, unidad, bloquear: t.bloquear, label: TIPO_INFO[tipo]?.label || tipo };
  return null;
}
function msgTope(c) {
  const v = (n) => Number(n).toLocaleString('es-AR');
  const u = c.unidad === 'cantidad' ? '' : '$ ';
  return `Supera el tope ${c.periodo} de "${c.label}": tope ${u}${v(c.tope)}, ya registrado ${u}${v(c.usado)}, intentás sumar ${u}${v(c.add)} (total ${u}${v(c.total)}).`;
}

// GET /api/novedades/topes — configuración (todos los tipos, con defaults).
router.get('/topes', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const rows = (await query('SELECT tipo, periodo, tope_cantidad, tope_monto, bloquear FROM novedad_topes')).rows;
    const byTipo = Object.fromEntries(rows.map((r) => [r.tipo, r]));
    res.json(TIPOS_NOVEDAD.map(([tipo, label, unidad]) => {
      const t = byTipo[tipo];
      return { tipo, label, unidad, periodo: t?.periodo || 'anual', topeCantidad: Number(t?.tope_cantidad || 0), topeMonto: Number(t?.tope_monto || 0), bloquear: t ? t.bloquear : true };
    }));
  } catch (e) { next(e); }
});

// PUT /api/novedades/topes — guarda la configuración.
router.put('/topes', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const arr = Array.isArray(req.body?.topes) ? req.body.topes : [];
    for (const t of arr) {
      if (!TIPO_INFO[t.tipo]) continue;
      const periodo = PERIODOS_TOPE.includes(t.periodo) ? t.periodo : 'anual';
      await query(
        `INSERT INTO novedad_topes (tipo, periodo, tope_cantidad, tope_monto, bloquear, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (tipo) DO UPDATE SET periodo=EXCLUDED.periodo, tope_cantidad=EXCLUDED.tope_cantidad, tope_monto=EXCLUDED.tope_monto, bloquear=EXCLUDED.bloquear, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [t.tipo, periodo, Number(t.topeCantidad) || 0, Number(t.topeMonto) || 0, t.bloquear !== false, req.user?.email || '']);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/_tipos', (req, res) => res.json(TIPOS_NOVEDAD.map(([k, l, u]) => ({ tipo: k, label: l, unidad: u }))));

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.anio) { args.push(Number(req.query.anio)); cond.push(`n.anio=$${args.length}`); }
    if (req.query.mes) { args.push(Number(req.query.mes)); cond.push(`n.mes=$${args.length}`); }
    if (req.query.empresa) { args.push(req.query.empresa); cond.push(`em.nombre=$${args.length}`); }
    if (req.query.empleadoId) { args.push(Number(req.query.empleadoId)); cond.push(`n.empleado_id=$${args.length}`); }
    if (!(await puedeVerConfidenciales(req.user))) cond.push('e.confidencial = false');
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await query(
      `SELECT n.*, e.nom, e.leg_num, em.nombre AS empresa FROM novedades n
         JOIN empleados e ON e.id=n.empleado_id JOIN empresas em ON em.id=e.empresa_id
         ${where} ORDER BY em.nombre, e.nom, n.tipo`, args);
    res.json(rows.map((r) => ({ id: r.id, empleadoId: r.empleado_id, nom: r.nom, legNum: r.leg_num, empresa: r.empresa,
      anio: r.anio, mes: r.mes, tipo: r.tipo, tipoLabel: TIPO_INFO[r.tipo]?.label || r.tipo, unidad: TIPO_INFO[r.tipo]?.unidad,
      cantidad: Number(r.cantidad), monto: Number(r.monto), detalle: r.detalle })));
  } catch (e) { next(e); }
});

// Alta individual
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.anio || !b.mes || !b.tipo) return res.status(400).json({ error: 'empleadoId, anio, mes y tipo son obligatorios' });
    if (!TIPO_INFO[b.tipo]) return res.status(400).json({ error: 'Tipo de novedad inválido' });
    const chk = await chequearTope(b.empleadoId, b.anio, b.mes, b.tipo, b.cantidad, b.monto);
    if (chk && chk.bloquear) return res.status(400).json({ error: msgTope(chk) });
    const r = await query('INSERT INTO novedades (empleado_id, anio, mes, tipo, cantidad, monto, detalle, origen, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [b.empleadoId, Number(b.anio), Number(b.mes), b.tipo, Number(b.cantidad) || 0, Number(b.monto) || 0, b.detalle || null, b.origen || 'manual', req.user?.email || '']);
    res.status(201).json({ ok: true, id: r.rows[0].id, aviso: chk ? msgTope(chk) : undefined });
  } catch (e) { next(e); }
});

// Importación masiva por Excel (filas ya parseadas por el front).
// body: { anio, mes, reemplazar?, rows:[{ Legajo|CUIL, Tipo, Cantidad, Monto, Detalle }] }
router.post('/import', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const anio = Number(b.anio), mes = Number(b.mes);
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!anio || !mes) return res.status(400).json({ error: 'Indicá año y mes' });
    if (!rows.length) return res.status(400).json({ error: 'El archivo no tiene filas' });
    const pick = (r, ...ks) => { for (const k of ks) for (const rk of Object.keys(r)) if (rk.trim().toLowerCase() === k.toLowerCase() && String(r[rk]).trim() !== '') return r[rk]; return ''; };
    const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
    let okN = 0; const errores = [], avisos = [];
    // Si se pide reemplazar, borra las novedades del período antes de cargar.
    if (b.reemplazar) await query('DELETE FROM novedades WHERE anio=$1 AND mes=$2 AND origen=$3', [anio, mes, 'excel']);
    for (const r of rows) {
      const leg = String(pick(r, 'Legajo', 'Leg', 'leg_num')).trim();
      const cuil = onlyDigits(pick(r, 'CUIL', 'Cuil'));
      const tipo = String(pick(r, 'Tipo', 'tipo')).trim();
      if (!TIPO_INFO[tipo]) { errores.push(`Tipo inválido: "${tipo}"`); continue; }
      let emp = null;
      if (leg) emp = (await query('SELECT id FROM empleados WHERE leg_num=$1 ORDER BY activo DESC LIMIT 1', [leg])).rows[0];
      if (!emp && cuil) emp = (await query("SELECT id FROM empleados WHERE regexp_replace(cuil,'\\D','','g')=$1 LIMIT 1", [cuil])).rows[0];
      if (!emp) { errores.push(`Empleado no encontrado (leg ${leg || '-'} / cuil ${cuil || '-'})`); continue; }
      const cantidad = Number(String(pick(r, 'Cantidad', 'Cant', 'Horas', 'Dias') || '0').replace(',', '.')) || 0;
      const monto = Number(String(pick(r, 'Monto', 'Importe') || '0').replace(/\./g, '').replace(',', '.')) || 0;
      const detalle = String(pick(r, 'Detalle', 'Concepto', 'Observaciones')).trim() || null;
      const chk = await chequearTope(emp.id, anio, mes, tipo, cantidad, monto);
      if (chk && chk.bloquear) { errores.push(`Legajo ${leg || cuil}: ${msgTope(chk)}`); continue; }
      if (chk) avisos.push(`Legajo ${leg || cuil}: ${msgTope(chk)}`);
      await query('INSERT INTO novedades (empleado_id, anio, mes, tipo, cantidad, monto, detalle, origen, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [emp.id, anio, mes, tipo, cantidad, monto, detalle, 'excel', req.user?.email || '']);
      okN++;
    }
    res.json({ ok: true, importadas: okN, errores, avisos });
  } catch (e) { next(e); }
});

// Generar novedades de horas extra a partir de las FICHADAS autorizadas del período.
router.post('/desde-fichadas', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const anio = Number(b.anio), mes = Number(b.mes);
    if (!anio || !mes) return res.status(400).json({ error: 'Indicá año y mes' });
    const cond = ['f.anio=$1', 'f.mes=$2', "f.estado='autorizada'"]; const args = [anio, mes];
    if (b.empresa) { args.push(b.empresa); cond.push(`em.nombre=$${args.length}`); }
    const rows = (await query(
      `SELECT f.empleado_id, f.data FROM fichadas_periodo f
         JOIN empleados e ON e.id=f.empleado_id JOIN empresas em ON em.id=e.empresa_id
        WHERE ${cond.join(' AND ')}`, args)).rows;
    if (b.reemplazar !== false) {
      // borra solo las novedades de horas extra generadas antes desde fichadas
      await query("DELETE FROM novedades WHERE anio=$1 AND mes=$2 AND origen='fichadas'", [anio, mes]);
    }
    let creadas = 0, conExtra = 0;
    for (const r of rows) {
      const d = r.data || {};
      // Extra ya calculado por el parser (banco compensatorio corrido), separado
      // en 50 % (hábil + sábado) y 100 % (domingo/feriado).
      const h50 = Math.round(((d.horasExtra50Min || 0) / 60) * 100) / 100;
      const h100 = Math.round(((d.horasExtra100Min || 0) / 60) * 100) / 100;
      let algo = false;
      if (h50 > 0) {
        await query('INSERT INTO novedades (empleado_id, anio, mes, tipo, cantidad, monto, detalle, origen, created_by) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8)',
          [r.empleado_id, anio, mes, 'he50', h50, 'Horas extra 50% de fichadas (autorizadas)', 'fichadas', req.user?.email || '']);
        creadas++; algo = true;
      }
      if (h100 > 0) {
        await query('INSERT INTO novedades (empleado_id, anio, mes, tipo, cantidad, monto, detalle, origen, created_by) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8)',
          [r.empleado_id, anio, mes, 'he100', h100, 'Horas extra 100% de fichadas (autorizadas)', 'fichadas', req.user?.email || '']);
        creadas++; algo = true;
      }
      if (algo) conExtra++;
    }
    res.json({ ok: true, fichadasAutorizadas: rows.length, conExtra, creadas });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM novedades WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
