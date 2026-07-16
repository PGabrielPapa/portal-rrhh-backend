import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

// GET /api/compensaciones/bandas — bandas por puesto (incluye puestos sin banda).
router.get('/bandas', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id AS puesto_id, p.nombre AS puesto,
              b.id, b.minimo, b.medio, b.maximo, b.moneda, b.nota, b.activo, b.updated_by, b.updated_at,
              (SELECT COUNT(*)::int FROM empleados e WHERE e.puesto_id=p.id AND e.activo) AS ocupantes
         FROM puestos p LEFT JOIN bandas_salariales b ON b.puesto_id=p.id
        ORDER BY p.nombre`);
    res.json(rows.map((r) => ({
      puestoId: r.puesto_id, puesto: r.puesto, ocupantes: r.ocupantes,
      id: r.id, minimo: r.minimo != null ? Number(r.minimo) : null,
      medio: r.medio != null ? Number(r.medio) : null, maximo: r.maximo != null ? Number(r.maximo) : null,
      moneda: r.moneda || 'ARS', nota: r.nota, activo: r.activo !== false, updatedBy: r.updated_by, updatedAt: r.updated_at,
    })));
  } catch (e) { next(e); }
});

// PUT /api/compensaciones/bandas/:puestoId — crea o actualiza la banda de un puesto.
router.put('/bandas/:puestoId', async (req, res, next) => {
  try {
    const b = req.body || {};
    const min = num(b.minimo), med = num(b.medio), max = num(b.maximo);
    if (min < 0 || med < 0 || max < 0) return res.status(400).json({ error: 'Los valores no pueden ser negativos.' });
    if (max && min && max < min) return res.status(400).json({ error: 'El máximo no puede ser menor que el mínimo.' });
    await query(
      `INSERT INTO bandas_salariales (puesto_id, minimo, medio, maximo, moneda, nota, activo, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (puesto_id) DO UPDATE SET minimo=EXCLUDED.minimo, medio=EXCLUDED.medio, maximo=EXCLUDED.maximo,
         moneda=EXCLUDED.moneda, nota=EXCLUDED.nota, activo=EXCLUDED.activo, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [req.params.puestoId, min, med, max, b.moneda || 'ARS', b.nota || null, b.activo !== false, req.user?.dni || '']);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/compensaciones/bandas/:puestoId
router.delete('/bandas/:puestoId', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM bandas_salariales WHERE puesto_id=$1 RETURNING id', [req.params.puestoId]);
    if (!r.rowCount) return res.status(404).json({ error: 'No hay banda para ese puesto.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/compensaciones/analisis?empresa= — compa-ratio y posición vs banda de cada activo con puesto y banda.
router.get('/analisis', async (req, res, next) => {
  try {
    const empresa = req.query.empresa || null;
    const params = [];
    let filtro = '';
    if (empresa) { params.push(empresa); filtro = ` AND em.nombre = $${params.length}`; }
    const { rows } = await query(
      `SELECT e.leg_num, e.nom, e.bruto, em.nombre AS empresa, p.nombre AS puesto,
              b.minimo, b.medio, b.maximo
         FROM empleados e
         JOIN empresas em ON em.id=e.empresa_id
         JOIN puestos p ON p.id=e.puesto_id
         JOIN bandas_salariales b ON b.puesto_id=e.puesto_id AND b.activo
        WHERE COALESCE(e.activo,true)=true${filtro}
        ORDER BY em.nombre, p.nombre, e.nom`, params);
    const resumen = { dentro: 0, debajo: 0, encima: 0, total: 0 };
    const items = rows.map((r) => {
      const bruto = Number(r.bruto) || 0, min = Number(r.minimo) || 0, med = Number(r.medio) || 0, max = Number(r.maximo) || 0;
      const compaRatio = med > 0 ? r2(bruto / med) : null;   // 1.00 = en el punto medio
      let estado = 'dentro';
      if (min && bruto < min) estado = 'debajo';
      else if (max && bruto > max) estado = 'encima';
      resumen[estado]++; resumen.total++;
      return { legNum: r.leg_num, nom: r.nom, empresa: r.empresa, puesto: r.puesto,
        bruto: r2(bruto), minimo: min, medio: med, maximo: max, compaRatio, estado };
    });
    res.json({ resumen, items });
  } catch (e) { next(e); }
});

export default router;
