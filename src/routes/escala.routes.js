import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function mapVersion(r) {
  return {
    id: r.id, vigencia: r.vigencia, mesLabel: r.mes_label, origen: r.origen,
    porcentaje: r.porcentaje != null ? Number(r.porcentaje) : null,
    alcance: r.alcance, comentario: r.comentario, creadoPor: r.creado_por, createdAt: r.created_at,
    ...r.data,
  };
}

// GET /api/escala — todas las versiones (asc por vigencia)
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM escala_versiones ORDER BY vigencia ASC, created_at ASC');
    res.json(rows.map(mapVersion));
  } catch (e) { next(e); }
});

// GET /api/escala/activa?fecha=YYYY-MM-DD — versión vigente a la fecha (la última con vigencia <= fecha)
router.get('/activa', async (req, res, next) => {
  try {
    const fecha = (req.query.fecha && String(req.query.fecha)) || new Date().toISOString().slice(0, 10);
    const { rows } = await query(
      'SELECT * FROM escala_versiones WHERE vigencia <= $1 ORDER BY vigencia DESC, created_at DESC LIMIT 1',
      [fecha]
    );
    if (!rows[0]) {
      const fb = await query('SELECT * FROM escala_versiones ORDER BY vigencia ASC LIMIT 1');
      if (!fb.rows[0]) return res.status(404).json({ error: 'No hay escala cargada' });
      return res.json(mapVersion(fb.rows[0]));
    }
    res.json(mapVersion(rows[0]));
  } catch (e) { next(e); }
});

// POST /api/escala/incremento — aplica un % y crea una nueva versión (rrhh/admin)
// body: { porcentaje, vigencia, alcance?: 'todas'|'categorias'|'regionales', comentario? }
router.post('/incremento', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { porcentaje, vigencia, alcance = 'todas', comentario } = req.body || {};
    const pct = Number(porcentaje);
    if (!(pct > 0)) return res.status(400).json({ error: 'El porcentaje debe ser mayor a 0' });
    if (!vigencia) return res.status(400).json({ error: 'La vigencia es obligatoria' });

    const act = await query('SELECT * FROM escala_versiones WHERE vigencia <= $1 ORDER BY vigencia DESC, created_at DESC LIMIT 1', [vigencia]);
    const base = act.rows[0] || (await query('SELECT * FROM escala_versiones ORDER BY vigencia ASC LIMIT 1')).rows[0];
    if (!base) return res.status(404).json({ error: 'No hay escala base para incrementar' });
    const d = base.data;
    const factor = 1 + pct / 100;
    const aplica = (v) => round2(Number(v) * factor);

    const categorias = (d.categorias || []).map((c) => ({
      ...c,
      tramos: (alcance === 'regionales') ? { ...c.tramos } : Object.fromEntries(Object.entries(c.tramos).map(([k, v]) => [k, aplica(v)])),
    }));
    const regionales = (d.regionales || []).map((r) => ({
      ...r, monto: (alcance === 'categorias') ? r.monto : aplica(r.monto),
    }));
    const montos_titulo = Object.fromEntries(Object.entries(d.montos_titulo || {}).map(([k, v]) => [k, v ? aplica(v) : v]));

    const mesLabel = new Date(vigencia + 'T12:00:00').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    const ins = await query(
      `INSERT INTO escala_versiones (vigencia, mes_label, origen, porcentaje, alcance, comentario, data, creado_por)
       VALUES ($1,$2,'incremento',$3,$4,$5,$6,$7) RETURNING *`,
      [vigencia, mesLabel.charAt(0).toUpperCase() + mesLabel.slice(1), pct, alcance, comentario || null,
       JSON.stringify({ tramos: d.tramos, categorias, regionales, montos_titulo }), req.user.dni]
    );
    res.status(201).json(mapVersion(ins.rows[0]));
  } catch (e) { next(e); }
});

// DELETE /api/escala/:id — eliminar una versión (no la inicial) (rrhh/admin)
router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query("DELETE FROM escala_versiones WHERE id=$1 AND origen <> 'inicial' RETURNING id", [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ error: 'No existe o es la escala inicial (no se puede borrar)' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
