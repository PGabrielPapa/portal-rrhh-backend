import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { evaluarFormula, analizarFormula, FUNCIONES_DISPONIBLES } from '../lib/formulas.js';
import { cargarAux } from './valoresAux.routes.js';
import { logCambios } from '../lib/configHist.js';

const router = Router();
router.use(requireAuth);

const CHFIELDS = [['descripcion','Descripción'],['tipo','Tipo'],['formula','Fórmula'],['base_legal','Base legal'],['activo','Activo']];
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
    await logCambios('conceptos', rows[0].codigo, null, rows[0], CHFIELDS, req.user.dni);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// PUT /api/conceptos/:id  (rrhh/admin)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const _prev = (await query('SELECT * FROM conceptos WHERE id=$1', [req.params.id])).rows[0];
    const fields = { descripcion: b.descripcion, tipo: TIPOS.includes(b.tipo) ? b.tipo : undefined, formula: b.formula, base_legal: b.base_legal };
    const sets = [], params = [];
    for (const [k, v] of Object.entries(fields)) { if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); } }
    if (b.data && typeof b.data === 'object') { params.push(JSON.stringify(b.data)); sets.push(`data = data || $${params.length}::jsonb`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(req.params.id);
    const { rows } = await query(`UPDATE conceptos SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Concepto no encontrado' });
    await logCambios('conceptos', rows[0].codigo, _prev || null, rows[0], CHFIELDS, req.user.dni);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// PATCH /api/conceptos/:id/activo  (rrhh/admin)
router.patch('/:id/activo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const _p = (await query('SELECT codigo, activo FROM conceptos WHERE id=$1', [req.params.id])).rows[0];
    const _nuevo = !!(req.body || {}).activo;
    await query('UPDATE conceptos SET activo = $1 WHERE id = $2', [_nuevo, req.params.id]);
    if (_p) await logCambios('conceptos', _p.codigo, { activo: _p.activo }, { activo: _nuevo }, [['activo', 'Activo']], req.user.dni);
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
  ['afiliado', 'Afiliado al sindicato (1/0)'],
  ['noAfiliado', 'Dentro de convenio y NO afiliado (1/0)'],
  ['pctObraSocial', '% obra social (parámetros)'],
  ['pctAnssal', '% ANSSAL (parámetros)'],
  ['pctCuotaSindical', '% cuota sindical del sindicato (afiliado)'],
  ['pctSolidario', '% aporte solidario del sindicato (no afiliado)'],
  ['sacBase', 'Base del SAC (mejor remuneración del semestre)'],
  ['baseAportes', 'Base de aportes SIPA (con tope)'],
  ['baseAportesOs', 'Base de aportes de obra social (con tope/jornada)'],
  ['pctJubilacion', '% jubilación (parámetros)'],
  ['pctPami', '% INSSJP/PAMI empleado (parámetros)'],
  ['feriados', 'Feriados trabajados (cantidad)'],
  ['feriadosNoTrab', 'Feriados NO trabajados (plus LCT)'],
  ['diasLicenciaConGoce', 'Días de licencia con goce — total (plus LCT)'],
  ['diasVacaciones', 'Días de vacaciones del período'],
  ['diasExamen', 'Días de examen/estudio del período'],
  ['diasLicOtras', 'Días de otras licencias con goce'],
  ['pctAntigPorAnio', '% antigüedad por año (sindicato)'],
  ['pctPresentismo', '% presentismo (sindicato)'],
  ['basePres', 'Base de cálculo del presentismo'],
  ['presentismoPleno', 'Presentismo pleno (sin castigo)'],
  ['escalaObjetivo', 'Monto objetivo de la escala unificada'],
];
const SAMPLE_CTX = { basico: 500000, sueldo: 500000, complemento: 0, norem: 85000, antiguedad_monto: 25000, bruto: 600000, anios: 5, remun: 600000, noRem: 85000, dias: 30, he50: 0, he100: 0, ausencias: 0, feriados: 0, smvm: 372400, topeSipa: 4509567.41, afiliado: 0, noAfiliado: 1, pctObraSocial: 2.55, pctAnssal: 0.45, pctCuotaSindical: 2, pctSolidario: 1.4 };

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
