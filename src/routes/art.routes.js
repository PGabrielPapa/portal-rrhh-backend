import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const ARTS_CATALOGO = [
  { codigo: 'EXPERTA', nombre: 'Experta ART S.A.', cuit: '30-64517756-9' },
  { codigo: 'GALENO', nombre: 'Galeno ART S.A.', cuit: '30-70740467-5' },
  { codigo: 'PREVENCIÓN', nombre: 'Prevención ART S.A.', cuit: '30-64317274-0' },
  { codigo: 'SWISS', nombre: 'Swiss Medical ART S.A.', cuit: '30-70707410-3' },
  { codigo: 'PROVINCIA', nombre: 'Provincia ART S.A.', cuit: '30-69834259-8' },
  { codigo: 'SANCOR', nombre: 'Sancor ART S.A.', cuit: '30-66765900-5' },
  { codigo: 'FEDERACIÓN', nombre: 'Federación ART S.A.', cuit: '30-63671018-8' },
  { codigo: 'MAPFRE', nombre: 'Mapfre Argentina ART S.A.', cuit: '30-69816362-0' },
  { codigo: 'LIBERTY', nombre: 'Liberty ART S.A.', cuit: '30-70745316-3' },
  { codigo: 'HORIZONTE', nombre: 'Horizonte ART S.A.', cuit: '30-71100279-2' },
  { codigo: 'OTRA', nombre: 'Otra ART (no listada)', cuit: '' },
];

const map = (r) => ({
  id: r.id, empresaId: r.empresa_id, empresa: r.empresa_nombre, artCodigo: r.art_codigo, artNombre: r.art_nombre,
  nroContrato: r.nro_contrato, fechaInicio: r.fecha_inicio, fechaFin: r.fecha_fin, activo: r.activo,
  alicuotas: (r.alicuotas || []).slice().sort((a, b) => String(a.desde).localeCompare(String(b.desde))),
});

router.get('/catalogo', (req, res) => res.json(ARTS_CATALOGO));

// GET /api/art?empresaId=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    const cond = empresaId ? 'WHERE a.empresa_id = $1' : '';
    const { rows } = await query(
      `SELECT a.*, em.nombre AS empresa_nombre FROM art_contratos a JOIN empresas em ON em.id=a.empresa_id ${cond} ORDER BY em.nombre, a.activo DESC, a.fecha_inicio DESC`,
      empresaId ? [empresaId] : []
    );
    res.json(rows.map(map));
  } catch (e) { next(e); }
});

// POST /api/art  (rrhh/admin)
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { empresaId, artCodigo, nroContrato, fechaInicio, fechaFin, alicuotaInicial } = req.body || {};
    if (!empresaId || !artCodigo) return res.status(400).json({ error: 'Empresa y ART son obligatorios' });
    const cat = ARTS_CATALOGO.find((a) => a.codigo === artCodigo);
    const alic = [];
    if (alicuotaInicial != null && Number(alicuotaInicial) > 0) alic.push({ desde: fechaInicio || new Date().toISOString().slice(0, 10), pct: Number(alicuotaInicial), nota: 'Inicio contrato' });
    const ins = await query(
      `INSERT INTO art_contratos (empresa_id, art_codigo, art_nombre, nro_contrato, fecha_inicio, fecha_fin, alicuotas)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [empresaId, artCodigo, cat?.nombre || artCodigo, nroContrato || null, fechaInicio || null, fechaFin || null, JSON.stringify(alic)]
    );
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

// PUT /api/art/:id — editar datos del contrato (rrhh/admin)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { nroContrato, fechaInicio, fechaFin, activo } = req.body || {};
    const r = await query(
      `UPDATE art_contratos SET nro_contrato=$1, fecha_inicio=$2, fecha_fin=$3, activo=COALESCE($4,activo) WHERE id=$5 RETURNING id`,
      [nroContrato || null, fechaInicio || null, fechaFin || null, activo, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Contrato no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/art/:id/alicuota — agregar una alícuota al histórico (rrhh/admin)
router.post('/:id/alicuota', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { desde, pct, nota } = req.body || {};
    if (!desde || !(Number(pct) > 0)) return res.status(400).json({ error: 'Fecha desde y alícuota (%) son obligatorias' });
    const cur = await query('SELECT alicuotas FROM art_contratos WHERE id=$1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Contrato no encontrado' });
    const alic = cur.rows[0].alicuotas || [];
    alic.push({ desde, pct: Number(pct), nota: nota || '' });
    await query('UPDATE art_contratos SET alicuotas=$1 WHERE id=$2', [JSON.stringify(alic), req.params.id]);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/art/:id  (rrhh/admin)
router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM art_contratos WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Contrato no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
