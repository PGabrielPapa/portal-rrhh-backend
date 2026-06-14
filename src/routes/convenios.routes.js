import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hoyISO = () => new Date().toISOString().slice(0, 10);
const mesLabelDe = (vig) => {
  const l = new Date(vig + 'T12:00:00').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  return l.charAt(0).toUpperCase() + l.slice(1);
};

const mapVer = (cat, v) => ({
  id: v.id, codigo: cat.codigo, nombre: cat.nombre, cct: cat.cct,
  vigencia: v.vigencia, mesLabel: v.mes_label, origen: v.origen,
  porcentaje: v.porcentaje != null ? Number(v.porcentaje) : null,
  monto: v.monto != null ? Number(v.monto) : null,
  comentario: v.comentario, creadoPor: v.creado_por, createdAt: v.created_at,
  ...v.data,
});

async function catalogo(codigo) {
  const r = await query('SELECT codigo, nombre, cct FROM convenios WHERE codigo=$1', [codigo]);
  return r.rows[0];
}
async function versionActiva(codigo, fecha) {
  const r = await query(
    'SELECT * FROM convenio_versiones WHERE codigo=$1 AND vigencia <= $2 ORDER BY vigencia DESC, created_at DESC LIMIT 1',
    [codigo, fecha || hoyISO()]
  );
  if (r.rows[0]) return r.rows[0];
  const fb = await query('SELECT * FROM convenio_versiones WHERE codigo=$1 ORDER BY vigencia ASC LIMIT 1', [codigo]);
  return fb.rows[0] || null;
}

// Aplica incremento (pct o monto) a todos los básicos/valorHora de las tablas y a los NR.
function aplicarIncremento(data, tipo, valor, alcance) {
  const v = Number(valor);
  const ajustar = (x) => x == null ? x : (tipo === 'porcentaje' ? round2(x * (1 + v / 100)) : round2(x + v));
  const tablas = (data.tablas || []).map((t) => ({
    ...t,
    cats: t.cats.map((c) => ({
      ...c,
      ...(c.valorHora != null ? { valorHora: ajustar(c.valorHora) } : {}),
      ...(c.basico != null ? { basico: ajustar(c.basico) } : {}),
    })),
  }));
  let noRem = data.noRemunerativos || [];
  if (alcance === 'todo' || alcance === 'nr') {
    noRem = noRem.map((n) => ({ ...n, monto: n.monto != null ? ajustar(n.monto) : n.monto }));
  }
  // alcance 'basicos' = solo tablas; 'nr' = solo NR; 'todo' = ambos
  const tablasFinal = (alcance === 'nr') ? (data.tablas || []) : tablas;
  return { ...data, tablas: tablasFinal, noRemunerativos: noRem };
}

// GET /api/convenios — lista con la versión activa de cada uno
router.get('/', async (req, res, next) => {
  try {
    const cats = (await query('SELECT codigo, nombre, cct FROM convenios ORDER BY codigo')).rows;
    const out = [];
    for (const cat of cats) {
      const va = await versionActiva(cat.codigo);
      if (va) out.push(mapVer(cat, va));
    }
    res.json(out);
  } catch (e) { next(e); }
});

// GET /api/convenios/:codigo — versión activa (opcional ?fecha=)
router.get('/:codigo', async (req, res, next) => {
  try {
    const codigo = String(req.params.codigo).toUpperCase();
    const cat = await catalogo(codigo);
    if (!cat) return res.status(404).json({ error: 'Convenio no encontrado' });
    const va = await versionActiva(codigo, req.query.fecha && String(req.query.fecha));
    if (!va) return res.status(404).json({ error: 'Sin versiones' });
    res.json(mapVer(cat, va));
  } catch (e) { next(e); }
});

// GET /api/convenios/:codigo/versiones — histórico
router.get('/:codigo/versiones', async (req, res, next) => {
  try {
    const codigo = String(req.params.codigo).toUpperCase();
    const cat = await catalogo(codigo);
    if (!cat) return res.status(404).json({ error: 'Convenio no encontrado' });
    const r = await query('SELECT * FROM convenio_versiones WHERE codigo=$1 ORDER BY vigencia ASC, created_at ASC', [codigo]);
    res.json(r.rows.map((v) => mapVer(cat, v)));
  } catch (e) { next(e); }
});

// POST /api/convenios/:codigo/incremento  { tipo:'porcentaje'|'monto', valor, vigencia, alcance?:'todo'|'basicos'|'nr', comentario? }
router.post('/:codigo/incremento', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const codigo = String(req.params.codigo).toUpperCase();
    const { tipo, valor, vigencia, alcance = 'todo', comentario } = req.body || {};
    if (!['porcentaje', 'monto'].includes(tipo)) return res.status(400).json({ error: 'tipo debe ser porcentaje o monto' });
    if (!(Number(valor) > 0)) return res.status(400).json({ error: 'El valor debe ser mayor a 0' });
    if (!vigencia) return res.status(400).json({ error: 'La vigencia es obligatoria' });
    const cat = await catalogo(codigo);
    if (!cat) return res.status(404).json({ error: 'Convenio no encontrado' });
    const base = await versionActiva(codigo, vigencia);
    if (!base) return res.status(404).json({ error: 'No hay versión base' });
    const data = aplicarIncremento(base.data, tipo, valor, alcance);
    const ins = await query(
      `INSERT INTO convenio_versiones (codigo, vigencia, mes_label, origen, porcentaje, monto, comentario, data, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [codigo, vigencia, mesLabelDe(vigencia), tipo,
       tipo === 'porcentaje' ? Number(valor) : null, tipo === 'monto' ? Number(valor) : null,
       comentario || null, JSON.stringify(data), req.user.dni]
    );
    res.status(201).json(mapVer(cat, ins.rows[0]));
  } catch (e) { next(e); }
});

// POST /api/convenios/:codigo/version  { vigencia, data, comentario? }  — guarda una edición manual como nueva versión
router.post('/:codigo/version', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const codigo = String(req.params.codigo).toUpperCase();
    const { vigencia, data, comentario } = req.body || {};
    if (!vigencia || !data) return res.status(400).json({ error: 'vigencia y data son obligatorios' });
    const cat = await catalogo(codigo);
    if (!cat) return res.status(404).json({ error: 'Convenio no encontrado' });
    const ins = await query(
      `INSERT INTO convenio_versiones (codigo, vigencia, mes_label, origen, comentario, data, creado_por)
       VALUES ($1,$2,$3,'edicion',$4,$5,$6) RETURNING *`,
      [codigo, vigencia, mesLabelDe(vigencia), comentario || null, JSON.stringify(data), req.user.dni]
    );
    res.status(201).json(mapVer(cat, ins.rows[0]));
  } catch (e) { next(e); }
});

// DELETE /api/convenios/:codigo/versiones/:id — borra una versión (no la inicial)
router.delete('/:codigo/versiones/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query("DELETE FROM convenio_versiones WHERE id=$1 AND codigo=$2 AND origen <> 'inicial' RETURNING id",
      [req.params.id, String(req.params.codigo).toUpperCase()]);
    if (!r.rowCount) return res.status(409).json({ error: 'No existe o es la versión inicial' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
