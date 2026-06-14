import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const gestor = (r) => ['rrhh', 'admin', 'manager'].includes(r);

const TIPOS_CAP = [
  { codigo: 'INDUCCION', nombre: 'Inducción inicial al puesto', obligatorio: true, vigencia_meses: null },
  { codigo: 'EPP', nombre: 'Uso correcto de EPP', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'CARGAS', nombre: 'Manejo manual de cargas', obligatorio: true, vigencia_meses: 24 },
  { codigo: 'INCENDIOS', nombre: 'Prevención y lucha contra incendios', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'EMERGENCIAS', nombre: 'Plan de emergencias y evacuación', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'PRIMEROS_AUX', nombre: 'Primeros auxilios y RCP', obligatorio: false, vigencia_meses: 24 },
  { codigo: 'ELECTRICO', nombre: 'Riesgo eléctrico', obligatorio: true, vigencia_meses: 24 },
  { codigo: 'ALTURA', nombre: 'Trabajo en altura', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'ESPACIOS', nombre: 'Trabajo en espacios confinados', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'QUIMICOS', nombre: 'Manipulación de productos químicos', obligatorio: true, vigencia_meses: 24 },
  { codigo: 'AUTOELEVADOR', nombre: 'Manejo de autoelevador / montacargas', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'ERGONOMIA', nombre: 'Ergonomía y posturas de trabajo', obligatorio: false, vigencia_meses: 24 },
  { codigo: 'VIAL', nombre: 'Seguridad vial / manejo defensivo', obligatorio: false, vigencia_meses: 24 },
  { codigo: 'SOLDADURA', nombre: 'Soldadura y oxicorte', obligatorio: true, vigencia_meses: 24 },
  { codigo: 'RUIDO', nombre: 'Exposición a ruido', obligatorio: false, vigencia_meses: 24 },
];
const EPP = [
  ['CASCO', 'Casco de seguridad', 'Cabeza'], ['ANTEOJOS', 'Anteojos / antiparras', 'Ojos'], ['TAPONES', 'Tapones auditivos', 'Oídos'],
  ['AURICULARES', 'Protección auditiva tipo copa', 'Oídos'], ['BARBIJO', 'Barbijo / mascarilla', 'Vías resp.'], ['SEMIMASCARA', 'Semimáscara con filtros', 'Vías resp.'],
  ['GUANTES', 'Guantes', 'Manos'], ['GUANTES_DIEL', 'Guantes dieléctricos', 'Manos'], ['BOTINES', 'Calzado de seguridad', 'Pies'], ['BOTAS', 'Botas de goma', 'Pies'],
  ['PANTALON', 'Pantalón de trabajo', 'Cuerpo'], ['CAMISA', 'Camisa de trabajo', 'Cuerpo'], ['REMERA', 'Remera de trabajo', 'Cuerpo'], ['BUZO', 'Buzo / pulóver', 'Cuerpo'],
  ['CAMPERA', 'Campera de trabajo', 'Cuerpo'], ['CHALECO', 'Chaleco refractario', 'Cuerpo'], ['IMPERMEABLE', 'Equipo impermeable', 'Cuerpo'], ['ARNES', 'Arnés de seguridad', 'Altura'],
].map(([codigo, nombre, categoria]) => ({ codigo, nombre, categoria }));

router.get('/catalogos', (req, res) => res.json({ capacitaciones: TIPOS_CAP, epp: EPP }));

// Capacitaciones
router.get('/capacitaciones', async (req, res, next) => {
  try {
    if (gestor(req.user.role)) {
      const cond = [], pr = [];
      if (req.query.empleadoId) { pr.push(req.query.empleadoId); cond.push(`c.empleado_id=$${pr.length}`); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(`SELECT c.*, e.nom, e.leg_num, em.nombre AS empresa FROM hys_capacitaciones c JOIN empleados e ON e.id=c.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY c.fecha DESC`, pr);
      return res.json(rows);
    }
    const { rows } = await query('SELECT * FROM hys_capacitaciones WHERE empleado_id=$1 ORDER BY fecha DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/capacitaciones', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.nombre || !b.fecha) return res.status(400).json({ error: 'Empleado, capacitación y fecha son obligatorios' });
    const ins = await query('INSERT INTO hys_capacitaciones (empleado_id, codigo, nombre, fecha, vigencia_meses, dictada_por, observaciones) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.empleadoId, b.codigo || null, b.nombre, b.fecha, b.vigenciaMeses || null, b.dictadaPor || null, b.observaciones || null]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/capacitaciones/:id', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try { const r = await query('DELETE FROM hys_capacitaciones WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); } catch (e) { next(e); }
});

// EPP
router.get('/epp', async (req, res, next) => {
  try {
    if (gestor(req.user.role)) {
      const cond = [], pr = [];
      if (req.query.empleadoId) { pr.push(req.query.empleadoId); cond.push(`x.empleado_id=$${pr.length}`); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(`SELECT x.*, e.nom, e.leg_num, em.nombre AS empresa FROM hys_epp_entregas x JOIN empleados e ON e.id=x.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY x.fecha DESC`, pr);
      return res.json(rows);
    }
    const { rows } = await query('SELECT * FROM hys_epp_entregas WHERE empleado_id=$1 ORDER BY fecha DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/epp', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.nombre || !b.fecha) return res.status(400).json({ error: 'Empleado, elemento y fecha son obligatorios' });
    const ins = await query('INSERT INTO hys_epp_entregas (empleado_id, codigo, nombre, cantidad, talle, fecha, observaciones) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.empleadoId, b.codigo || null, b.nombre, b.cantidad || 1, b.talle || null, b.fecha, b.observaciones || null]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/epp/:id', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try { const r = await query('DELETE FROM hys_epp_entregas WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); } catch (e) { next(e); }
});

export default router;
