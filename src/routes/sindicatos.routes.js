import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const map = (r) => ({ id: r.id, codigo: r.codigo, nombre: r.nombre, pctEmpleado: Number(r.pct_empleado), pctPatronal: Number(r.pct_patronal), pctAntigPorAnio: Number(r.pct_antig_por_anio), nota: r.nota, tieneAdicionalTitulo: r.tiene_adicional_titulo, presBase: r.pres_base, tituloSecundario: Number(r.titulo_secundario) || 0, tituloUniversitario: Number(r.titulo_universitario) || 0, pctPresentismo: Number(r.pct_presentismo) || 0 });

router.get('/', async (req, res, next) => {
  try { const { rows } = await query('SELECT * FROM sindicatos ORDER BY codigo'); res.json(rows.map(map)); }
  catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.codigo || !b.nombre) return res.status(400).json({ error: 'Código y nombre son obligatorios' });
    const tSec = Number(b.tituloSecundario) || 0, tUni = Number(b.tituloUniversitario) || 0;
    const ins = await query(
      `INSERT INTO sindicatos (codigo, nombre, pct_empleado, pct_patronal, pct_antig_por_anio, nota, tiene_adicional_titulo, pres_base, titulo_secundario, titulo_universitario, pct_presentismo, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre, pct_empleado=EXCLUDED.pct_empleado, pct_patronal=EXCLUDED.pct_patronal,
         pct_antig_por_anio=EXCLUDED.pct_antig_por_anio, nota=EXCLUDED.nota, tiene_adicional_titulo=EXCLUDED.tiene_adicional_titulo, pres_base=EXCLUDED.pres_base, titulo_secundario=EXCLUDED.titulo_secundario, titulo_universitario=EXCLUDED.titulo_universitario, pct_presentismo=EXCLUDED.pct_presentismo, updated_by=EXCLUDED.updated_by, updated_at=now()
       RETURNING *`,
      [String(b.codigo).toUpperCase(), b.nombre, b.pctEmpleado || 0, b.pctPatronal || 0, b.pctAntigPorAnio || 1, b.nota || null, (tSec > 0 || tUni > 0), b.presBase || 'basico', tSec, tUni, Number(b.pctPresentismo) || 0, req.user.dni]
    );
    res.status(201).json(map(ins.rows[0]));
  } catch (e) { next(e); }
});

router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const tSec = Number(b.tituloSecundario) || 0, tUni = Number(b.tituloUniversitario) || 0;
    const r = await query(
      `UPDATE sindicatos SET nombre=$1, pct_empleado=$2, pct_patronal=$3, pct_antig_por_anio=$4, nota=$5, tiene_adicional_titulo=$6, pres_base=$7, titulo_secundario=$8, titulo_universitario=$9, pct_presentismo=$10, updated_by=$11, updated_at=now() WHERE id=$12 RETURNING *`,
      [b.nombre, b.pctEmpleado || 0, b.pctPatronal || 0, b.pctAntigPorAnio || 1, b.nota || null, (tSec > 0 || tUni > 0), b.presBase || 'basico', tSec, tUni, Number(b.pctPresentismo) || 0, req.user.dni, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json(map(r.rows[0]));
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM sindicatos WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// GET /api/sindicatos/por-empresa — qué sindicatos tiene cada empresa según sus empleados activos.
router.get('/por-empresa', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT em.nombre AS empresa,
              UPPER(COALESCE(NULLIF(e.data->>'cod_sindicato',''), 'FC')) AS codigo,
              s.nombre AS sind_nombre, s.pct_empleado, s.pct_patronal,
              count(*)::int AS cant
         FROM empleados e
         JOIN empresas em ON em.id = e.empresa_id
         LEFT JOIN sindicatos s ON UPPER(s.codigo) = UPPER(COALESCE(NULLIF(e.data->>'cod_sindicato',''), 'FC'))
        WHERE e.activo = true
        GROUP BY em.nombre, codigo, s.nombre, s.pct_empleado, s.pct_patronal
        ORDER BY em.nombre, codigo`);
    const porEmpresa = {};
    for (const r of rows) {
      (porEmpresa[r.empresa] ||= { empresa: r.empresa, total: 0, sindicatos: [] });
      const fc = r.codigo === 'FC';
      porEmpresa[r.empresa].sindicatos.push({
        codigo: r.codigo,
        nombre: fc ? 'Fuera de convenio' : (r.sind_nombre || '(sindicato no definido en el catálogo)'),
        definido: fc || !!r.sind_nombre,
        pctEmpleado: r.pct_empleado != null ? Number(r.pct_empleado) : null,
        pctPatronal: r.pct_patronal != null ? Number(r.pct_patronal) : null,
        empleados: r.cant,
      });
      porEmpresa[r.empresa].total += r.cant;
    }
    res.json(Object.values(porEmpresa));
  } catch (e) { next(e); }
});

export default router;
