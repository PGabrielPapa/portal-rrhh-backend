import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validarAdjunto } from '../lib/adjuntos.js';

const router = Router();
router.use(requireAuth);

export const TIPOS_DOC = [
  ['dni', 'DNI'], ['examen_preocupacional', 'Examen preocupacional'], ['examen_periodico', 'Examen médico periódico'],
  ['licencia_conducir', 'Licencia de conducir'], ['matricula', 'Matrícula profesional'], ['titulo', 'Título / certificado'],
  ['contrato', 'Contrato'], ['arts', 'Constancia ART'], ['otro', 'Otro'],
];
const TIPO_LBL = Object.fromEntries(TIPOS_DOC);
const mapRow = (r) => ({ id: r.id, empleadoId: r.empleado_id, nom: r.nom, legNum: r.leg_num, empresa: r.empresa, tipo: r.tipo, tipoLabel: TIPO_LBL[r.tipo] || r.tipo, descripcion: r.descripcion, fechaEmision: r.fecha_emision, fechaVencimiento: r.fecha_vencimiento, archivoNombre: r.archivo_nombre, obs: r.obs, updatedAt: r.updated_at });

// Documentos con vencimiento próximo/vencido (para el módulo de Alertas).
export async function docsPorVencer(limiteISO) {
  const { rows } = await query(
    `SELECT d.*, e.nom, e.leg_num FROM legajo_docs d JOIN empleados e ON e.id=d.empleado_id
       WHERE e.activo=true AND d.fecha_vencimiento IS NOT NULL AND d.fecha_vencimiento <= $1`, [limiteISO]);
  return rows.map((r) => ({ empleadoId: r.empleado_id, nom: r.nom, legNum: r.leg_num, tipo: r.tipo, tipoLabel: TIPO_LBL[r.tipo] || r.tipo, descripcion: r.descripcion, fechaVencimiento: r.fecha_vencimiento }));
}

router.get('/_tipos', (req, res) => res.json(TIPOS_DOC.map(([k, l]) => ({ tipo: k, label: l }))));

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.empleadoId) { args.push(Number(req.query.empleadoId)); cond.push(`d.empleado_id=$${args.length}`); }
    if (req.query.empresa) { args.push(req.query.empresa); cond.push(`em.nombre=$${args.length}`); }
    if (req.query.porVencer) { const lim = new Date(Date.now() + (Number(req.query.dias) || 60) * 864e5).toISOString().slice(0, 10); args.push(lim); cond.push(`d.fecha_vencimiento IS NOT NULL AND d.fecha_vencimiento <= $${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await query(`SELECT d.id, d.empleado_id, d.tipo, d.descripcion, d.fecha_emision, d.fecha_vencimiento, d.archivo_nombre, d.obs, d.updated_at, e.nom, e.leg_num, em.nombre AS empresa FROM legajo_docs d JOIN empleados e ON e.id=d.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY d.fecha_vencimiento NULLS LAST, e.nom`, args);
    res.json(rows.map(mapRow));
  } catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.tipo) return res.status(400).json({ error: 'Empleado y tipo son obligatorios' });
    if (b.archivoData) { const v = validarAdjunto({ nombre: b.archivoNombre, mime: b.archivoMime, data: b.archivoData }); if (!v.ok) return res.status(400).json({ error: v.error }); }
    const r = await query('INSERT INTO legajo_docs (empleado_id, tipo, descripcion, fecha_emision, fecha_vencimiento, archivo_nombre, archivo_mime, archivo_data, obs, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [b.empleadoId, b.tipo, b.descripcion || null, b.fechaEmision || null, b.fechaVencimiento || null, b.archivoNombre || null, b.archivoMime || null, b.archivoData || null, b.obs || null, req.user?.email || '']);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const r = await query('UPDATE legajo_docs SET tipo=$1, descripcion=$2, fecha_emision=$3, fecha_vencimiento=$4, obs=$5, updated_at=now() WHERE id=$6 RETURNING id',
      [b.tipo, b.descripcion || null, b.fechaEmision || null, b.fechaVencimiento || null, b.obs || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM legajo_docs WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

export default router;
