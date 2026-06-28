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
    const anio = Number(req.query.anio) || def.anio, mes = Number(req.query.mes) || def.mes;
    const mesDesde = Number(req.query.mesDesde) || 1, mesHasta = Number(req.query.mesHasta) || mes;
    const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
    const soloCodigo = req.query.codigo ? String(req.query.codigo) : null;

    const acums = (await query('SELECT * FROM acumuladores WHERE activo=true' + (soloCodigo ? ' AND codigo=$1' : '') + ' ORDER BY orden, nombre', soloCodigo ? [soloCodigo] : [])).rows.map(mapRow);

    const cond = ['e.activo = true']; const args = [];
    if (empresaId) { args.push(empresaId); cond.push(`e.empresa_id = $${args.length}`); }
    const emps = (await query(`SELECT e.id, e.nom, e.leg_num, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')} ORDER BY e.nom`, args)).rows;

    // Traer todos los recibos del año de una vez.
    const recibos = (await query(
      `SELECT empleado_id, mes, tipo, data FROM recibos WHERE anio=$1 AND tipo = ANY($2)`, [anio, TIPOS_RECIBO])).rows;
    const porEmp = new Map();
    for (const r of recibos) { if (!porEmp.has(r.empleado_id)) porEmp.set(r.empleado_id, []); porEmp.get(r.empleado_id).push(r); }

    const filas = emps.map((e) => {
      const recs = porEmp.get(e.id) || [];
      const valores = {};
      for (const a of acums) {
        const ventana = recibosDeVentana(recs, a.tipo, mes, mesDesde, mesHasta);
        valores[a.codigo] = sumarAcumulador(ventana, a.reglas);
      }
      return { empleadoId: e.id, legNum: e.leg_num, nom: e.nom, empresa: e.empresa, valores };
    });

    const totales = {};
    for (const a of acums) totales[a.codigo] = Math.round(filas.reduce((s, f) => s + (f.valores[a.codigo] || 0), 0) * 100) / 100;
    res.json({ periodo: { anio, mes, mesDesde, mesHasta }, acumuladores: acums.map((a) => ({ codigo: a.codigo, nombre: a.nombre, tipo: a.tipo, afectaGanancias: a.afectaGanancias })), filas, totales });
  } catch (e) { next(e); }
});

export default router;
