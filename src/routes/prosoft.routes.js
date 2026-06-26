// Conexión directa con Pro-Soft (Gestión de Personal): trae las fichadas por API
// en lugar de subir el Excel. Reutiliza el mismo cruce/cálculo/persistencia.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { prosoftConfigOk, importarMes, importarRango } from '../lib/prosoft.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const router = Router();
router.use(requireAuth);

// GET /api/prosoft/estado — ¿está configurada la conexión?
router.get('/estado', requireRole('rrhh', 'admin'), (req, res) => {
  res.json({ configurado: prosoftConfigOk(), auto: false });
});

// POST /api/prosoft/importar?confirmar=true|false
//   body: { anio, mes, desde?, hasta? }  (anio/mes = período de liquidación a etiquetar;
//   desde/hasta = rango real a traer, puede cruzar meses; si falta, el mes calendario).
router.post('/importar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    if (!prosoftConfigOk()) {
      return res.status(400).json({ error: 'La conexión con Pro-Soft no está configurada (faltan PROSOFT_USER / PROSOFT_PASS en el servidor).' });
    }
    const anio = Number(req.body.anio), mes = Number(req.body.mes);
    const desde = req.body.desde || null, hasta = req.body.hasta || null;
    const confirmar = String(req.query.confirmar || req.body.confirmar || '') === 'true';
    if (!anio || !mes || mes < 1 || mes > 12) return res.status(400).json({ error: 'Indicá un período (mes y año) válido.' });
    if ((desde && !ISO.test(desde)) || (hasta && !ISO.test(hasta))) return res.status(400).json({ error: 'Fechas inválidas (usá AAAA-MM-DD).' });
    if (desde && hasta && hasta < desde) return res.status(400).json({ error: 'La fecha "hasta" debe ser posterior a "desde".' });

    const r = (desde && hasta)
      ? await importarRango(desde, hasta, anio, mes, { confirmar, importadoPor: req.user.dni || null })
      : await importarMes(anio, mes, { confirmar, importadoPor: req.user.dni || null });
    res.json({ confirmado: confirmar, periodo: r.periodo, resumen: r.resumen, matcheados: r.matcheados, sinMatch: r.sinMatch });
  } catch (e) { next(e); }
});

export default router;
