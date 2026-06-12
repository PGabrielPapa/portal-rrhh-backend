import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

async function sumaActivos(empleadoId, excluirId) {
  const r = await query(
    `SELECT COALESCE(SUM(porcentaje),0)::float AS s FROM cbus WHERE empleado_id=$1 AND activo=true AND ($2::int IS NULL OR id <> $2)`,
    [empleadoId, excluirId ?? null]
  );
  return r.rows[0].s;
}

// GET /api/cbus — CBUs del propio usuario + resumen de distribución
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, cbu, banco, alias, titular, porcentaje::float AS porcentaje, activo, created_at FROM cbus WHERE empleado_id = $1 ORDER BY activo DESC, created_at DESC',
      [req.user.id]
    );
    const suma = rows.filter((c) => c.activo).reduce((a, c) => a + Number(c.porcentaje || 0), 0);
    res.json({ items: rows, sumaActivos: Math.round(suma * 100) / 100 });
  } catch (e) { next(e); }
});

// POST /api/cbus — agregar un CBU propio con su porcentaje de acreditación
router.post('/', async (req, res, next) => {
  try {
    const { cbu, banco, alias, titular, porcentaje } = req.body || {};
    const digits = String(cbu || '').replace(/\D/g, '');
    if (digits.length !== 22) return res.status(400).json({ error: 'El CBU debe tener 22 dígitos' });
    const pct = Number(porcentaje);
    if (!(pct > 0 && pct <= 100)) return res.status(400).json({ error: 'El porcentaje debe estar entre 0,01 y 100' });
    const suma = await sumaActivos(req.user.id, null);
    if (suma + pct > 100.01) return res.status(400).json({ error: `La suma de porcentajes superaría 100% (ya asignado ${suma}%, disponible ${Math.round((100 - suma) * 100) / 100}%)` });
    const ins = await query(
      'INSERT INTO cbus (empleado_id, cbu, banco, alias, titular, porcentaje) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, digits, banco || null, alias || null, titular || null, pct]
    );
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

// PATCH /api/cbus/:id — editar datos / porcentaje (solo propios)
router.patch('/:id', async (req, res, next) => {
  try {
    const { banco, alias, titular, porcentaje } = req.body || {};
    let pct;
    if (porcentaje !== undefined) {
      pct = Number(porcentaje);
      if (!(pct > 0 && pct <= 100)) return res.status(400).json({ error: 'El porcentaje debe estar entre 0,01 y 100' });
      const suma = await sumaActivos(req.user.id, Number(req.params.id));
      if (suma + pct > 100.01) return res.status(400).json({ error: `La suma de porcentajes superaría 100% (otras cuentas ${suma}%, disponible ${Math.round((100 - suma) * 100) / 100}%)` });
    }
    const r = await query(
      `UPDATE cbus SET banco=COALESCE($1,banco), alias=COALESCE($2,alias), titular=COALESCE($3,titular), porcentaje=COALESCE($4,porcentaje)
         WHERE id=$5 AND empleado_id=$6 RETURNING id`,
      [banco ?? null, alias ?? null, titular ?? null, pct ?? null, req.params.id, req.user.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'CBU no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PATCH /api/cbus/:id/activo — activar/desactivar (solo propios)
router.patch('/:id/activo', async (req, res, next) => {
  try {
    const activo = !!(req.body || {}).activo;
    if (activo) {
      const cur = await query('SELECT porcentaje::float AS p FROM cbus WHERE id=$1 AND empleado_id=$2', [req.params.id, req.user.id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'CBU no encontrado' });
      const suma = await sumaActivos(req.user.id, Number(req.params.id));
      if (suma + Number(cur.rows[0].p) > 100.01) return res.status(400).json({ error: `Al activarla la suma superaría 100% (ya asignado ${suma}%)` });
    }
    const r = await query('UPDATE cbus SET activo = $1 WHERE id = $2 AND empleado_id = $3', [activo, req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'CBU no encontrado' });
    res.json({ ok: true, activo });
  } catch (e) { next(e); }
});

// DELETE /api/cbus/:id — quitar un CBU propio
router.delete('/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM cbus WHERE id=$1 AND empleado_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'CBU no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
