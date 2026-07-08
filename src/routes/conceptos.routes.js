import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { evaluarFormula, analizarFormula, FUNCIONES_DISPONIBLES } from '../lib/formulas.js';
import { cargarAux } from './valoresAux.routes.js';

const router = Router();
router.use(requireAuth);

const TIPOS = ['remunerativo', 'no_remunerativo', 'descuento', 'aporte', 'contribucion'];

// GET /api/conceptos?q=&tipo=&activos=
router.get('/', async (req, res, next) => {
  try {
    const { q, tipo, activos } = req.query;
    const cond = [], params = [];
    if (tipo) { params.push(tipo); cond.push(`tipo = $${params.length}`); }
    if (activos === 'true') cond.push('activo = true');
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(descripcion) LIKE $${i} OR codigo LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM conceptos ${where} ORDER BY codigo`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/conceptos  (rrhh/admin)
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.codigo || !b.descripcion) return res.status(400).json({ error: 'Código y descripción son obligatorios' });
    const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'remunerativo';
    const data = (b.data && typeof b.data === 'object') ? b.data : {};
    const { rows } = await query(
      `INSERT INTO conceptos (codigo, descripcion, tipo, formula, base_legal, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(b.codigo).trim(), String(b.descripcion).trim(), tipo, b.formula || null, b.base_legal || null, JSON.stringify(data)]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// PUT /api/conceptos/:id  (rrhh/admin)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = { descripcion: b.descripcion, tipo: TIPOS.includes(b.tipo) ? b.tipo : undefined, formula: b.formula, base_legal: b.base_legal };
    const sets = [], params = [];
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); } }
    if (b.data && typeof b.data === 'object') { params.push(JSON.stringify(b.data)); sets.push(`data = data || $${params.length}::jsonb`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(req.params.id);
    const { rows } = await query(`UPDATE conceptos SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// PATCH /api/conceptos/:id/activo  (rrhh/admin)
router.patch('/:id/activo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    await query('UPDATE conceptos SET activo = $1 WHERE id = $2', [!!(req.body || {}).activo, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});


// ── Motor de fórmulas: catálogo de variables y contexto de ejemplo para "probar" ──
const VARIABLES_FORMULA = [
  ['basico', 'Sueldo básico del legajo'],
  ['sueldo', 'Sueldo cargado'],
  ['complemento', 'Complemento variable'],
  ['norem', 'Asignación no remunerativa'],
  ['antiguedad_monto', 'Adicional por antigüedad (monto)'],
  ['bruto', 'Sueldo bruto'],
  ['anios', 'Años de antigüedad'],
  ['remun', 'Total remunerativo del período'],
  ['noRem', 'Total no remunerativo del período'],
  ['dias', 'Días trabajados'],
  ['he50', 'Horas extra al 50%'],
  ['he100', 'Horas extra al 100%'],
  ['ausencias', 'Ausencias injustificadas (días)'],
  ['feriados', 'Feriados trabajados'],
  ['smvm', 'Salario Mínimo Vital y Móvil'],
  ['topeSipa', 'Tope máximo SIPA'],
];
const SAMPLE_CTX = { basico: 500000, sueldo: 500000, complemento: 0, norem: 0, antiguedad_monto: 25000, bruto: 600000, anios: 5, remun: 600000, noRem: 0, dias: 30, he50: 0, he100: 0, ausencias: 0, feriados: 0, smvm: 372400, topeSipa: 4509567.41 };

// GET /api/conceptos/variables — catálogo para el editor de fórmulas.
router.get('/variables', requireRole('rrhh', 'admin'), (req, res) => {
  res.json({ variables: VARIABLES_FORMULA.map(([clave, desc]) => ({ clave, desc })), funciones: FUNCIONES_DISPONIBLES, ejemplo: SAMPLE_CTX });
});

// POST /api/conceptos/probar-formula { formula, condicion?, contexto? } — valida y evalúa con datos de ejemplo.
router.post('/probar-formula', requireRole('rrhh', 'admin'), async (req, res) => {
  const b = req.body || {};
  if (!b.formula || !String(b.formula).trim()) return res.status(400).json({ ok: false, error: 'Ingresá una fórmula' });
  const aux = await cargarAux();
  const ctx = { ...SAMPLE_CTX, ...(b.contexto && typeof b.contexto === 'object' ? b.contexto : {}), __aux: aux };
  const mopts = { strict: false, macros: aux.macros };
  try {
    const an = analizarFormula(b.formula);
    const valor = evaluarFormula(b.formula, ctx, mopts);
    let aplica = true, valorCondicion = null;
    if (b.condicion && String(b.condicion).trim()) { analizarFormula(b.condicion); valorCondicion = evaluarFormula(b.condicion, ctx, mopts); aplica = valorCondicion !== 0; }
    // Variables usadas que no están en el catálogo (posibles errores de tipeo o campos cx_).
    const conocidas = new Set(VARIABLES_FORMULA.map(([k]) => k.toLowerCase()));
    const fueraCatalogo = an.variables.filter((v) => !conocidas.has(v.toLowerCase()) && !v.toLowerCase().startsWith('cx_'));
    res.json({ ok: true, valor, aplica, valorCondicion, variables: an.variables, funciones: an.funciones, fueraCatalogo });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

export default router;
