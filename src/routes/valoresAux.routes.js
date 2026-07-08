import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const TIPOS = ['macro', 'matriz', 'tabla'];
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// Carga todos los valores auxiliares activos en el formato que consume el evaluador.
export async function cargarAux() {
  const out = { matrices: {}, tablas: {}, macros: {} };
  try {
    const { rows } = await query('SELECT tipo, clave, data FROM valores_auxiliares WHERE activo=true');
    for (const r of rows) {
      if (r.tipo === 'macro') out.macros[r.clave] = (r.data && r.data.formula) || '';
      else if (r.tipo === 'matriz') out.matrices[r.clave] = Array.isArray(r.data && r.data.tramos) ? r.data.tramos : [];
      else if (r.tipo === 'tabla') { const o = {}; for (const p of ((r.data && r.data.pares) || [])) o[String(p.clave)] = Number(p.valor) || 0; out.tablas[r.clave] = o; }
    }
  } catch { /* sin auxiliares */ }
  return out;
}

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.tipo) { args.push(req.query.tipo); cond.push(`tipo=$${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await query(`SELECT id, tipo, clave, etiqueta, data, activo FROM valores_auxiliares ${where} ORDER BY tipo, clave`, args);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!TIPOS.includes(b.tipo)) return res.status(400).json({ error: 'Tipo inválido (macro, matriz o tabla)' });
    if (!b.etiqueta || !String(b.etiqueta).trim()) return res.status(400).json({ error: 'La etiqueta es obligatoria' });
    const clave = (b.clave && slug(b.clave)) || slug(b.etiqueta);
    if (!clave) return res.status(400).json({ error: 'Clave inválida' });
    const r = await query('INSERT INTO valores_auxiliares (tipo, clave, etiqueta, data, activo) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [b.tipo, clave, String(b.etiqueta).trim(), JSON.stringify(b.data || {}), b.activo !== false]);
    res.status(201).json({ ok: true, id: r.rows[0].id, clave });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un valor auxiliar con esa clave' });
    next(e);
  }
});

router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.etiqueta || !String(b.etiqueta).trim()) return res.status(400).json({ error: 'La etiqueta es obligatoria' });
    const r = await query('UPDATE valores_auxiliares SET etiqueta=$1, data=$2, activo=$3 WHERE id=$4 RETURNING id',
      [String(b.etiqueta).trim(), JSON.stringify(b.data || {}), b.activo !== false, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM valores_auxiliares WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
