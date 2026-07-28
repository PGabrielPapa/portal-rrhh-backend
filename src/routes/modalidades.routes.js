import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));

// Sincroniza la lista de modalidades con las de AFIP (codigos_afip tipo=modalidad),
// agregando las que falten por código (incluida la Ley 22.250). Idempotente: NO pisa
// ni borra las existentes. Regímenes especiales (construcción 22.250, agrario 22.248,
// pasantías, becarios, aprendizaje) van SIN indemnización por antigüedad.
const SIN_INDEMNIZACION = new Set([2, 3, 9, 10, 23, 24, 27]); // códigos AFIP sin indemn. clásica
async function ensure() {
  const { rows: afip } = await query(`SELECT codigo, nombre FROM codigos_afip WHERE tipo='modalidad' AND activo ORDER BY codigo`);
  if (!afip.length) {
    // Fallback: si aún no se cargaron los códigos AFIP, sembrar base mínima (solo si está vacía).
    if ((await query('SELECT COUNT(*)::int c FROM modalidades_contratacion')).rows[0].c > 0) return;
    const base = [['Tiempo indeterminado', '008', true, true, true], ['Plazo fijo', '021', false, true, true], ['Eventual', '012', false, false, true], ['Personal de la construcción Ley 22.250', '024', true, false, true]];
    for (const [nombre, cod, pp, ind, sac] of base) await query('INSERT INTO modalidades_contratacion (nombre, cod_afip, periodo_prueba, indemnizacion, sac) VALUES ($1,$2,$3,$4,$5)', [nombre, cod, pp, ind, sac]);
    return;
  }
  const existentes = new Set((await query('SELECT cod_afip FROM modalidades_contratacion')).rows.map((r) => String(r.cod_afip || '').replace(/\D/g, '').padStart(3, '0')));
  for (const m of afip) {
    const cod = String(m.codigo).padStart(3, '0');
    if (existentes.has(cod)) continue; // ya está esa modalidad
    const ind = !SIN_INDEMNIZACION.has(Number(m.codigo));
    await query('INSERT INTO modalidades_contratacion (nombre, cod_afip, periodo_prueba, indemnizacion, sac) VALUES ($1,$2,$3,$4,$5)', [m.nombre, cod, true, ind, true]);
  }
}

router.get('/', async (req, res, next) => {
  try { await ensure(); const { rows } = await query('SELECT * FROM modalidades_contratacion ORDER BY nombre'); res.json(rows); }
  catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query('INSERT INTO modalidades_contratacion (nombre, cod_afip, periodo_prueba, indemnizacion, sac, nota, activo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [String(b.nombre).trim(), b.codAfip || b.cod_afip || null, b.periodoPrueba !== false, b.indemnizacion !== false, b.sac !== false, b.nota || null, b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});
router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE modalidades_contratacion SET nombre=$1, cod_afip=$2, periodo_prueba=$3, indemnizacion=$4, sac=$5, nota=$6, activo=$7 WHERE id=$8 RETURNING id',
      [String(b.nombre || '').trim(), b.codAfip || b.cod_afip || null, b.periodoPrueba !== false, b.indemnizacion !== false, b.sac !== false, b.nota || null, b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/:id', async (req, res, next) => {
  try { const r = await query('DELETE FROM modalidades_contratacion WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrada' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
