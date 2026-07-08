import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET: lo puede leer cualquier usuario autenticado (para pintar su recibo).
router.get('/', async (req, res, next) => {
  try {
    const r = (await query('SELECT encabezado, leyenda_pie, logo, mostrar_logo FROM modelo_recibo WHERE id=1')).rows[0];
    res.json(r || { encabezado: '', leyenda_pie: '', logo: '', mostrar_logo: true });
  } catch (e) { next(e); }
});

// PUT: solo RR.HH./admin.
router.put('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    await query(
      `INSERT INTO modelo_recibo (id, encabezado, leyenda_pie, logo, mostrar_logo, updated_at)
       VALUES (1,$1,$2,$3,$4,now())
       ON CONFLICT (id) DO UPDATE SET encabezado=EXCLUDED.encabezado, leyenda_pie=EXCLUDED.leyenda_pie, logo=EXCLUDED.logo, mostrar_logo=EXCLUDED.mostrar_logo, updated_at=now()`,
      [b.encabezado || null, b.leyendaPie || null, b.logo || null, b.mostrarLogo !== false]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
