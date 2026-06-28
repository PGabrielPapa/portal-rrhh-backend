import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

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

router.get('/_tipos', (req, res) => res.json(TIPOS_NOVEDAD.map(([k, l, u]) => ({ tipo: k, label: l, unidad: u }))));

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.anio) { args.push(Number(req.query.anio)); cond.push(`n.anio=$${args.length}`); }
    if (req.query.mes) { args.push(Number(req.query.mes)); cond.push(`n.mes=$${args.length}`); }
    if (req.query.empresa) { args.push(req.query.empresa); cond.push(`em.nombre=$${args.length}`); }
    if (req.query.empleadoId) { args.push(Number(req.query.empleadoId)); cond.push(`n.empleado_id=$${args.length}`); }
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
    const r = await query('INSERT INTO novedades (empleado_id, anio, mes, tipo, cantidad, monto, detalle, origen, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [b.empleadoId, Number(b.anio), Number(b.mes), b.tipo, Number(b.cantidad) || 0, Number(b.monto) || 0, b.detalle || null, b.origen || 'manual', req.user?.email || '']);
    res.status(201).json({ ok: true, id: r.rows[0].id });
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
    let okN = 0; const errores = [];
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
      await query('INSERT INTO novedades (empleado_id, anio, mes, tipo, cantidad, monto, detalle, origen, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [emp.id, anio, mes, tipo, cantidad, monto, detalle, 'excel', req.user?.email || '']);
      okN++;
    }
    res.json({ ok: true, importadas: okN, errores });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM novedades WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
