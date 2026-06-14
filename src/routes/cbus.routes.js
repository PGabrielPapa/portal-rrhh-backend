import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validarCBU, bancoDesdeCBU } from '../lib/cbu.js';

const router = Router();
router.use(requireAuth);

async function sumaActivos(empleadoId, excluirId) {
  const r = await query(
    `SELECT COALESCE(SUM(porcentaje),0)::float AS s FROM cbus WHERE empleado_id=$1 AND activo=true AND ($2::int IS NULL OR id <> $2)`,
    [empleadoId, excluirId ?? null]
  );
  return r.rows[0].s;
}

const COLS = 'id, cbu, banco, alias, titular, porcentaje::float AS porcentaje, activo, vigencia_desde, vigencia_hasta, created_at';
async function nov(empleadoId, accion, detalle) { try { await query('INSERT INTO cbu_novedades (empleado_id, accion, detalle) VALUES ($1,$2,$3)', [empleadoId, accion, detalle || null]); } catch { /* */ } }

// GET /api/cbus — cuentas activas + historial + resumen de distribución
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${COLS} FROM cbus WHERE empleado_id = $1 ORDER BY activo DESC, vigencia_desde DESC`,
      [req.user.id]
    );
    const items = rows.filter((c) => c.activo);
    const historial = rows.filter((c) => !c.activo);
    const suma = items.reduce((a, c) => a + Number(c.porcentaje || 0), 0);
    res.json({ items, historial, sumaActivos: Math.round(suma * 100) / 100 });
  } catch (e) { next(e); }
});

// POST /api/cbus — agregar cuenta (valida DV del CBU y autodetecta banco)
router.post('/', async (req, res, next) => {
  try {
    const { cbu, banco, alias, titular, porcentaje } = req.body || {};
    const v = validarCBU(cbu);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const pct = Number(porcentaje);
    if (!(pct > 0 && pct <= 100)) return res.status(400).json({ error: 'El porcentaje debe estar entre 0,01 y 100' });
    const suma = await sumaActivos(req.user.id, null);
    if (suma + pct > 100.01) return res.status(400).json({ error: `La suma de porcentajes superaría 100% (ya asignado ${suma}%, disponible ${Math.round((100 - suma) * 100) / 100}%)` });
    const ins = await query(
      'INSERT INTO cbus (empleado_id, cbu, banco, alias, titular, porcentaje) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, v.cbu, banco || v.banco, alias || null, titular || null, pct]
    );
    await nov(req.user.id, 'alta', `Nueva cuenta ${(banco || v.banco) || ''} ****${v.cbu.slice(-4)} (${pct}%)`);
    res.status(201).json({ ok: true, id: ins.rows[0].id, banco: banco || v.banco });
  } catch (e) { next(e); }
});

// PATCH /api/cbus/:id — editar datos / porcentaje (solo propios y activos)
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
         WHERE id=$5 AND empleado_id=$6 AND activo=true RETURNING id`,
      [banco ?? null, alias ?? null, titular ?? null, pct ?? null, req.params.id, req.user.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'CBU no encontrado o inactivo' });
    await nov(req.user.id, 'edicion', 'Modificó datos/porcentaje de una cuenta');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PATCH /api/cbus/:id/activo — activar/desactivar; cierra o reabre la vigencia (historial)
router.patch('/:id/activo', async (req, res, next) => {
  try {
    const activo = !!(req.body || {}).activo;
    if (activo) {
      const cur = await query('SELECT porcentaje::float AS p FROM cbus WHERE id=$1 AND empleado_id=$2', [req.params.id, req.user.id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'CBU no encontrado' });
      const suma = await sumaActivos(req.user.id, Number(req.params.id));
      if (suma + Number(cur.rows[0].p) > 100.01) return res.status(400).json({ error: `Al activarla la suma superaría 100% (ya asignado ${suma}%)` });
      const r = await query('UPDATE cbus SET activo=true, vigencia_desde=now(), vigencia_hasta=NULL WHERE id=$1 AND empleado_id=$2', [req.params.id, req.user.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'CBU no encontrado' });
    } else {
      const r = await query('UPDATE cbus SET activo=false, vigencia_hasta=now() WHERE id=$1 AND empleado_id=$2', [req.params.id, req.user.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'CBU no encontrado' });
    }
    await nov(req.user.id, activo ? 'activacion' : 'desactivacion', `${activo ? 'Activó' : 'Desactivó'} una cuenta`);
    res.json({ ok: true, activo });
  } catch (e) { next(e); }
});

// DELETE /api/cbus/:id — quitar definitivamente (también del historial)
router.delete('/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM cbus WHERE id=$1 AND empleado_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'CBU no encontrado' });
    await nov(req.user.id, 'baja', 'Quitó una cuenta');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Novedades de CBU (RR.HH.) ──
router.get('/novedades', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const soloNoLeidas = req.query.noLeidas === '1';
    const { rows } = await query(`SELECT n.*, e.nom, e.leg_num, em.nombre AS empresa FROM cbu_novedades n JOIN empleados e ON e.id=n.empleado_id JOIN empresas em ON em.id=e.empresa_id ${soloNoLeidas ? 'WHERE n.leida=false' : ''} ORDER BY n.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) { next(e); }
});
router.patch('/novedades/:id/leida', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try { await query('UPDATE cbu_novedades SET leida=true WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});
router.post('/novedades/leer-todas', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try { await query('UPDATE cbu_novedades SET leida=true WHERE leida=false'); res.json({ ok: true }); } catch (e) { next(e); }
});

// GET /api/cbus/banco/:cbu — autodetección de banco por CBU (para la UI)
router.get('/banco/:cbu', (req, res) => {
  res.json({ banco: bancoDesdeCBU(req.params.cbu) });
});

export default router;
