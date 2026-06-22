// src/routes/arca.routes.js
// Tablas de referencia de ARCA/AFIP para los desplegables del ABM y de Mis Datos:
// códigos (situación de revista, condición, actividad, modalidad, zona) y padrón
// de obras sociales (RNOS). Datos de referencia → sólo requieren autenticación.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /api/arca/codigos            → todos los tipos agrupados
// GET /api/arca/codigos?tipo=zona  → sólo ese tipo
router.get('/codigos', async (req, res, next) => {
  try {
    const { tipo } = req.query;
    if (tipo) {
      const { rows } = await query('SELECT codigo, nombre FROM codigos_afip WHERE tipo=$1 AND activo ORDER BY codigo', [tipo]);
      return res.json(rows);
    }
    const { rows } = await query('SELECT tipo, codigo, nombre FROM codigos_afip WHERE activo ORDER BY tipo, codigo');
    const out = {};
    for (const r of rows) (out[r.tipo] ||= []).push({ codigo: r.codigo, nombre: r.nombre });
    res.json(out);
  } catch (e) { next(e); }
});

// GET /api/arca/obras-sociales?q=texto  → padrón RNOS (código + nombre)
router.get('/obras-sociales', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const params = [];
    let where = 'WHERE activo';
    if (q) { params.push(`%${q}%`); where += ` AND (lower(nombre) LIKE $1 OR codigo LIKE $1)`; }
    const { rows } = await query(
      `SELECT codigo, codigo_sicoss, nombre FROM obras_sociales ${where} ORDER BY nombre`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/arca/meta  → última verificación de tablas vigentes
router.get('/meta', async (req, res, next) => {
  try {
    const r = await query('SELECT ultimo_chequeo_at, detalle FROM arca_tablas_meta WHERE id=1');
    res.json(r.rows[0] || { ultimo_chequeo_at: null, detalle: null });
  } catch (e) { next(e); }
});

// PATCH /api/arca/meta  → registrar verificación manual (RR.HH./Admin)
router.patch('/meta', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const detalle = (req.body || {}).detalle || 'verificación manual';
    await query(
      `INSERT INTO arca_tablas_meta (id, ultimo_chequeo_at, detalle) VALUES (1, now(), $1)
       ON CONFLICT (id) DO UPDATE SET ultimo_chequeo_at=now(), detalle=EXCLUDED.detalle`, [detalle]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
