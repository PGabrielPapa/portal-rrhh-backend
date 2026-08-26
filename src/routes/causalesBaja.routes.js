// Causales de baja (motivos de egreso). Lista ÚNICA para la pantalla de Liquidación final, la de
// Conceptos (alcance por motivo de egreso) y el Simulador de Ganancias. Se siembra desde la tabla de
// ARCA en db/migrateCausalesBaja.js; indemnización y preaviso los puede ajustar RR.HH.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logCambios } from '../lib/configHist.js';

const router = Router();
router.use(requireAuth);

const CHFIELDS = [['nombre', 'Nombre'], ['codArca', 'Código ARCA'], ['indemnizacion', 'Indemnización'], ['preaviso', 'Preaviso'], ['activo', 'Activo']];
const INDEM = ['plena', 'media', 'ninguna'];
const map = (r) => ({
  id: r.id, clave: r.clave, codArca: r.cod_arca || '', nombre: r.nombre,
  indemnizacion: r.indemnizacion, preaviso: r.preaviso === true,
  orden: r.orden, activo: r.activo === true, nota: r.nota || '',
});

// GET /api/causales-baja?activos=true
router.get('/', async (req, res, next) => {
  try {
    const soloActivos = String(req.query.activos || '') === 'true';
    const { rows } = await query(`SELECT * FROM causales_baja ${soloActivos ? 'WHERE activo' : ''} ORDER BY orden, nombre`);
    res.json(rows.map(map));
  } catch (e) { next(e); }
});

// PUT /api/causales-baja/:id
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const prev = (await query('SELECT * FROM causales_baja WHERE id=$1', [req.params.id])).rows[0];
    if (!prev) return res.status(404).json({ error: 'Causal no encontrada' });
    const indem = INDEM.includes(b.indemnizacion) ? b.indemnizacion : prev.indemnizacion;
    const { rows } = await query(
      `UPDATE causales_baja SET nombre=$1, cod_arca=$2, indemnizacion=$3, preaviso=$4, activo=$5, nota=$6
       WHERE id=$7 RETURNING *`,
      [b.nombre || prev.nombre, (b.codArca === undefined ? prev.cod_arca : b.codArca) || null, indem,
        b.preaviso === true, b.activo !== false, b.nota === undefined ? prev.nota : b.nota, req.params.id]);
    await logCambios('causales_baja', rows[0].clave, map(prev), map(rows[0]), CHFIELDS, req.user.dni);
    res.json(map(rows[0]));
  } catch (e) { next(e); }
});

// INTERRUPTOR: mientras RR.HH. no revise la indemnización y el preaviso de cada causal, el motor
// sigue usando su criterio nativo de siempre. O sea: sumar causales nuevas NO cambia ninguna
// liquidación final. Cuando la tabla esté revisada, poner esto en true y el motor pasa a usarla.
const APLICAR_EN_LIQUIDACION = false;

// Tratamiento de una causal para el motor. Devuelve null si no está en la tabla o si el interruptor
// de arriba está apagado: en ese caso el motor cae a su criterio nativo y nunca rompe una final.
export async function causalDe(clave) {
  if (!APLICAR_EN_LIQUIDACION || !clave) return null;
  try {
    const r = (await query('SELECT indemnizacion, preaviso, cod_arca FROM causales_baja WHERE clave=$1 AND activo', [String(clave)])).rows[0];
    if (!r) return null;
    return { indemnizacion: r.indemnizacion, preaviso: r.preaviso === true, codArca: r.cod_arca || null };
  } catch { return null; }
}

export default router;
