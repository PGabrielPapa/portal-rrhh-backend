import { Router } from 'express';
import { query, pool } from '../db.js';
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

// PATCH /api/cbus/:id — editar datos / porcentaje (versionado: deja histórico)
// Cada modificación CIERRA la cuenta vigente (pasa al historial con su rango de
// vigencia) e inserta una nueva cuenta activa con los datos nuevos.
router.patch('/:id', async (req, res, next) => {
  try {
    const { banco, alias, titular, porcentaje } = req.body || {};
    const cur = (await query(
      `SELECT cbu, banco, alias, titular, porcentaje::float AS porcentaje
         FROM cbus WHERE id=$1 AND empleado_id=$2 AND activo=true`,
      [req.params.id, req.user.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'CBU no encontrado o inactivo' });

    const nPct = porcentaje !== undefined ? Number(porcentaje) : Number(cur.porcentaje);
    if (!(nPct > 0 && nPct <= 100)) return res.status(400).json({ error: 'El porcentaje debe estar entre 0,01 y 100' });
    const suma = await sumaActivos(req.user.id, Number(req.params.id)); // resto de cuentas activas
    if (suma + nPct > 100.01) return res.status(400).json({ error: `La suma de porcentajes superaría 100% (otras cuentas ${suma}%, disponible ${Math.round((100 - suma) * 100) / 100}%)` });

    const nBanco = banco ?? cur.banco, nAlias = alias ?? cur.alias, nTitular = titular ?? cur.titular;
    // ¿Cambió algo realmente? Si no, no genera versión.
    const sinCambios = nPct === Number(cur.porcentaje) && (nBanco ?? null) === (cur.banco ?? null) && (nAlias ?? null) === (cur.alias ?? null) && (nTitular ?? null) === (cur.titular ?? null);
    if (sinCambios) return res.json({ ok: true, sinCambios: true });

    await query('UPDATE cbus SET activo=false, vigencia_hasta=now() WHERE id=$1 AND empleado_id=$2', [req.params.id, req.user.id]);
    const ins = await query(
      'INSERT INTO cbus (empleado_id, cbu, banco, alias, titular, porcentaje) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, cur.cbu, nBanco, nAlias, nTitular, nPct]);
    await nov(req.user.id, 'edicion', `Modificó la cuenta ****${String(cur.cbu).slice(-4)} (nuevo ${nPct}%)`);
    res.json({ ok: true, id: ins.rows[0].id });
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

// PUT /api/cbus/distribucion — guarda TODA la distribución de cuentas de forma atómica.
// Regla: las cuentas activas SIEMPRE deben sumar 100% (o quedar 0 cuentas). No persiste si no.
router.put('/distribucion', async (req, res, next) => {
  try {
    const cuentas = Array.isArray((req.body || {}).cuentas) ? req.body.cuentas : [];
    const norm = []; let suma = 0;
    for (const c of cuentas) {
      const v = validarCBU(c.cbu);
      if (!v.ok) return res.status(400).json({ error: `CBU inválido: ${v.error}` });
      const pct = Number(c.porcentaje);
      if (!(pct > 0 && pct <= 100)) return res.status(400).json({ error: 'Cada cuenta debe tener un porcentaje entre 0,01 y 100' });
      suma += pct;
      norm.push({ id: c.id ? Number(c.id) : null, cbu: v.cbu, banco: c.banco || v.banco || null, alias: c.alias || null, titular: c.titular || null, pct });
    }
    suma = Math.round(suma * 100) / 100;
    if (norm.length && Math.abs(suma - 100) > 0.01)
      return res.status(400).json({ error: `La distribución debe sumar exactamente 100% (suma actual: ${suma}%).` });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = norm.filter((n) => n.id).map((n) => n.id);
      // Las activas que ya no están en la distribución pasan al historial.
      await client.query(
        `UPDATE cbus SET activo=false, vigencia_hasta=now() WHERE empleado_id=$1 AND activo=true AND ($2::int[] IS NULL OR NOT (id = ANY($2)))`,
        [req.user.id, ids.length ? ids : null]);
      for (const n of norm) {
        if (n.id) await client.query(
          `UPDATE cbus SET cbu=$1, banco=$2, alias=$3, titular=$4, porcentaje=$5, activo=true WHERE id=$6 AND empleado_id=$7`,
          [n.cbu, n.banco, n.alias, n.titular, n.pct, n.id, req.user.id]);
        else await client.query(
          `INSERT INTO cbus (empleado_id, cbu, banco, alias, titular, porcentaje) VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, n.cbu, n.banco, n.alias, n.titular, n.pct]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await nov(req.user.id, 'edicion', `Actualizó la distribución de acreditación (${norm.length} cuenta/s, 100%)`);
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
// GET /api/cbus/incompletos — CHECK: empleados con cuentas activas cuya suma de acreditación es < 100%.
router.get('/incompletos', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.nom, e.leg_num, em.nombre AS empresa,
              COALESCE(SUM(c.porcentaje),0)::float AS suma, COUNT(c.id)::int AS cuentas
         FROM empleados e JOIN empresas em ON em.id=e.empresa_id
         LEFT JOIN cbus c ON c.empleado_id=e.id AND c.activo=true
        WHERE e.activo=true
        GROUP BY e.id, e.nom, e.leg_num, em.nombre
        HAVING COUNT(c.id) > 0 AND COALESCE(SUM(c.porcentaje),0) < 99.99
        ORDER BY em.nombre, e.nom`);
    res.json(rows.map((r) => ({ ...r, suma: Math.round(r.suma * 100) / 100, falta: Math.round((100 - r.suma) * 100) / 100 })));
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
