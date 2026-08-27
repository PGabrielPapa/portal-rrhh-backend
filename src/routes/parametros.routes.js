import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
// Configuración de liquidación: TODO el módulo es de RR.HH./admin, lecturas incluidas. Antes los
// GET estaban abiertos a cualquier usuario autenticado y se accedía escribiendo la URL.
router.use(requireAuth, requireRole('rrhh', 'admin'));

// GET /api/parametros — parámetros de liquidación vigentes
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT data, updated_by, updated_at FROM parametros_liq WHERE id = 1');
    res.json(rows[0] || { data: {} });
  } catch (e) { next(e); }
});

// PUT /api/parametros  (rrhh/admin) — merge superficial de los campos enviados
router.put('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const patch = req.body || {};
    if (typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'Cuerpo inválido' });
    const cur = (await query('SELECT data FROM parametros_liq WHERE id=1')).rows[0]?.data || {};
    const { rows } = await query(
      `UPDATE parametros_liq SET data = data || $1::jsonb, updated_by = $2, updated_at = now()
        WHERE id = 1 RETURNING data, updated_by, updated_at`,
      [JSON.stringify(patch), req.user.dni]
    );
    // Historial: una fila por campo que efectivamente cambió (quién, de → a).
    for (const k of Object.keys(patch)) {
      const sb = cur[k] == null ? '' : String(cur[k]);
      const sa = patch[k] == null ? '' : String(patch[k]);
      if (sb !== sa) {
        query('INSERT INTO parametros_hist (campo, valor_anterior, valor_nuevo, actor_dni) VALUES ($1,$2,$3,$4)',
          [k, sb || null, sa || null, req.user.dni]).catch(() => {});
      }
    }
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// GET /api/parametros/historial — cambios de cada parámetro (quién, cuándo, de → a).
router.get('/historial', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, campo, valor_anterior, valor_nuevo, actor_dni, created_at FROM parametros_hist ORDER BY created_at DESC, id DESC LIMIT 300');
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Versionado por vigencia ──
// Parámetros vigentes a una fecha: la versión con mayor vigencia_desde <= fecha; si no hay, los actuales (id=1).
export async function paramsParaFecha(fechaISO) {
  const ref = String(fechaISO || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const v = (await query('SELECT data FROM parametros_periodos WHERE vigencia_desde <= $1 ORDER BY vigencia_desde DESC LIMIT 1', [ref])).rows[0];
  if (v) return v.data || {};
  return (await query('SELECT data FROM parametros_liq WHERE id=1')).rows[0]?.data || {};
}

router.get('/periodos', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const { rows } = await query('SELECT id, vigencia_desde, nota, updated_by, updated_at FROM parametros_periodos ORDER BY vigencia_desde DESC'); res.json(rows); }
  catch (e) { next(e); }
});

router.get('/periodos/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM parametros_periodos WHERE id=$1', [req.params.id]); if (!rows[0]) return res.status(404).json({ error: 'No encontrado' }); res.json(rows[0]); }
  catch (e) { next(e); }
});

// Crear/actualizar una versión. Si no se manda data, toma una foto de los parámetros actuales.
router.post('/periodos', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.vigenciaDesde) return res.status(400).json({ error: 'La vigencia (fecha desde) es obligatoria' });
    const data = (b.data && typeof b.data === 'object') ? b.data : ((await query('SELECT data FROM parametros_liq WHERE id=1')).rows[0]?.data || {});
    const r = await query(
      `INSERT INTO parametros_periodos (vigencia_desde, data, nota, updated_by) VALUES ($1,$2::jsonb,$3,$4)
       ON CONFLICT (vigencia_desde) DO UPDATE SET data=EXCLUDED.data, nota=EXCLUDED.nota, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING id`,
      [b.vigenciaDesde, JSON.stringify(data), b.nota || null, req.user?.dni || '']);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.delete('/periodos/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM parametros_periodos WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
