import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { DEFAULTS, TIPOS_VENTANA, TIPOS_LINEA, SECCIONES, TIPOS_RECIBO, sumarAcumulador, recibosDeVentana } from '../lib/acumuladores.js';

const router = Router();
router.use(requireAuth);
const hoy = () => { const d = new Date(); return { anio: d.getFullYear(), mes: d.getMonth() + 1 }; };

function mapRow(r) {
  return { id: r.id, codigo: r.codigo, nombre: r.nombre, tipo: r.tipo, afectaGanancias: r.afecta_ganancias, activo: r.activo, orden: r.orden, reglas: r.reglas || [], updatedBy: r.updated_by, updatedAt: r.updated_at };
}

// Siembra los acumuladores por defecto si la tabla está vacía.
async function seedSiVacio() {
  const c = (await query('SELECT COUNT(*)::int AS n FROM acumuladores')).rows[0].n;
  if (c > 0) return;
  for (const d of DEFAULTS) {
    await query('INSERT INTO acumuladores (codigo, nombre, tipo, afecta_ganancias, activo, orden, reglas) VALUES ($1,$2,$3,$4,true,$5,$6::jsonb) ON CONFLICT (codigo) DO NOTHING',
      [d.codigo, d.nombre, d.tipo, !!d.afecta_ganancias, d.orden || 0, JSON.stringify(d.reglas || [])]);
  }
}

router.get('/catalogos', (req, res) => res.json({ tiposVentana: TIPOS_VENTANA, tiposLinea: TIPOS_LINEA, secciones: SECCIONES }));

// Listado (ABM)
router.get('/', async (req, res, next) => {
  try { await seedSiVacio(); const { rows } = await query('SELECT * FROM acumuladores ORDER BY orden, nombre'); res.json(rows.map(mapRow)); }
  catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.codigo || !b.nombre) return res.status(400).json({ error: 'Código y nombre son obligatorios' });
    const r = await query('INSERT INTO acumuladores (codigo, nombre, tipo, afecta_ganancias, activo, orden, reglas, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *',
      [String(b.codigo).toUpperCase().replace(/\s+/g, '_'), b.nombre, b.tipo || 'MENSUAL', !!b.afectaGanancias, b.activo !== false, Number(b.orden) || 0, JSON.stringify(b.reglas || []), req.user?.email || '']);
    res.status(201).json(mapRow(r.rows[0]));
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un acumulador con ese código' }); next(e); }
});

router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE acumuladores SET nombre=$1, tipo=$2, afecta_ganancias=$3, activo=$4, orden=$5, reglas=$6::jsonb, updated_by=$7, updated_at=now() WHERE id=$8 RETURNING *',
      [b.nombre, b.tipo || 'MENSUAL', !!b.afectaGanancias, b.activo !== false, Number(b.orden) || 0, JSON.stringify(b.reglas || []), req.user?.email || '', req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json(mapRow(r.rows[0]));
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM acumuladores WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// Consulta: matriz empleado x acumulador para un período.
router.get('/consulta', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await seedSiVacio();
    const def = hoy();
    const anio = Number(req.query.anio) || def.anio;
    let meses = String(req.query.meses || '').split(',').map(Number).filter((m) => m >= 1 && m <= 12);
    if (!meses.length) meses = [Number(req.query.mes) || def.mes];
    meses = [...new Set(meses)].sort((a, b) => a - b);
    const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;

    const acums = (await query('SELECT * FROM acumuladores WHERE activo=true ORDER BY orden, nombre')).rows.map(mapRow);

    const cond = ['e.activo = true']; const args = [];
    if (empresaId) { args.push(empresaId); cond.push(`e.empresa_id = $${args.length}`); }
    const emps = (await query(`SELECT e.id, e.nom, e.leg_num, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')} ORDER BY e.nom`, args)).rows;

    const recibos = (await query('SELECT empleado_id, mes, tipo, data FROM recibos WHERE anio=$1 AND tipo = ANY($2)', [anio, TIPOS_RECIBO])).rows;
    const porEmp = new Map();
    for (const r of recibos) { if (!porEmp.has(r.empleado_id)) porEmp.set(r.empleado_id, []); porEmp.get(r.empleado_id).push(r); }

    const porEmpleado = [];
    const porLiquidacion = [];
    const totales = {}; for (const a of acums) totales[a.codigo] = 0;
    const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

    for (const m of meses) {
      const totMes = {}; for (const a of acums) totMes[a.codigo] = 0;
      let cuenta = 0;
      for (const e of emps) {
        const recs = porEmp.get(e.id) || [];
        if (!recs.some((r) => Number(r.mes) === m)) continue;  // detalle por período: solo si hubo liquidación ese mes
        cuenta++;
        const valores = {};
        for (const a of acums) {
          const v = sumarAcumulador(recibosDeVentana(recs, a.tipo, m, 1, m), a.reglas);
          valores[a.codigo] = v; totMes[a.codigo] += v;
        }
        porEmpleado.push({ empleadoId: e.id, legNum: e.leg_num, nom: e.nom, empresa: e.empresa, mes: m, valores });
      }
      for (const a of acums) { totMes[a.codigo] = r2(totMes[a.codigo]); totales[a.codigo] += totMes[a.codigo]; }
      porLiquidacion.push({ mes: m, empleados: cuenta, valores: totMes });
    }
    for (const a of acums) totales[a.codigo] = r2(totales[a.codigo]);

    res.json({ anio, meses, acumuladores: acums.map((a) => ({ codigo: a.codigo, nombre: a.nombre, tipo: a.tipo, afectaGanancias: a.afectaGanancias })), porEmpleado, porLiquidacion, totales });
  } catch (e) { next(e); }
});

// Acumuladores de UN empleado para un período (para mostrar en el recibo / F.1357).
router.get('/empleado/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await seedSiVacio();
    const def = hoy();
    const anio = Number(req.query.anio) || def.anio, mes = Number(req.query.mes) || def.mes;
    const acums = (await query('SELECT * FROM acumuladores WHERE activo=true ORDER BY orden, nombre')).rows.map(mapRow);
    const recs = (await query('SELECT mes, tipo, data FROM recibos WHERE empleado_id=$1 AND anio=$2 AND tipo = ANY($3)', [req.params.id, anio, TIPOS_RECIBO])).rows;
    const out = acums.map((a) => ({ codigo: a.codigo, nombre: a.nombre, tipo: a.tipo, afectaGanancias: a.afectaGanancias, valor: sumarAcumulador(recibosDeVentana(recs, a.tipo, mes), a.reglas) }));
    res.json({ anio, mes, acumuladores: out });
  } catch (e) { next(e); }
});

export default router;
