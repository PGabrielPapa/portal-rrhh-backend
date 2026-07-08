import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const TIPOS_OK = ['texto', 'numero', 'fecha', 'lista'];
const slug = (s) => 'cx_' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// GET /api/campos?entidad=empleado&activos=1
router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const entidad = String(req.query.entidad || 'empleado');
    const cond = ['entidad=$1'], args = [entidad];
    if (req.query.activos === '1') cond.push('activo = true');
    const { rows } = await query(`SELECT id, entidad, clave, etiqueta, tipo, opciones, orden, activo FROM campos_adicionales WHERE ${cond.join(' AND ')} ORDER BY orden, etiqueta`, args);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/campos
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.etiqueta || !String(b.etiqueta).trim()) return res.status(400).json({ error: 'La etiqueta es obligatoria' });
    const tipo = TIPOS_OK.includes(b.tipo) ? b.tipo : 'texto';
    const clave = (b.clave && String(b.clave).startsWith('cx_')) ? b.clave : slug(b.clave || b.etiqueta);
    const opciones = Array.isArray(b.opciones) ? b.opciones.map((x) => String(x).trim()).filter(Boolean) : [];
    const r = await query(
      'INSERT INTO campos_adicionales (entidad, clave, etiqueta, tipo, opciones, orden, activo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.entidad || 'empleado', clave, String(b.etiqueta).trim(), tipo, JSON.stringify(opciones), Number(b.orden) || 0, b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id, clave });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un campo con esa clave' });
    next(e);
  }
});

// PUT /api/campos/:id  (no cambia la clave, para no perder los valores ya cargados)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.etiqueta || !String(b.etiqueta).trim()) return res.status(400).json({ error: 'La etiqueta es obligatoria' });
    const tipo = TIPOS_OK.includes(b.tipo) ? b.tipo : 'texto';
    const opciones = Array.isArray(b.opciones) ? b.opciones.map((x) => String(x).trim()).filter(Boolean) : [];
    const r = await query(
      'UPDATE campos_adicionales SET etiqueta=$1, tipo=$2, opciones=$3, orden=$4, activo=$5 WHERE id=$6 RETURNING id',
      [String(b.etiqueta).trim(), tipo, JSON.stringify(opciones), Number(b.orden) || 0, b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Campo no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/campos/:id  (borra la definición; los valores quedan en data pero ya no se muestran)
router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM campos_adicionales WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Campo no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
