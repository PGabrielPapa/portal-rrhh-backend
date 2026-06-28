import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const diasEntre = (a, b) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 864e5);

// Alertas de vencimientos: ART, mediciones HyS, período de prueba, contratos a plazo.
router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const horizonte = Number(req.query.dias) || 30; // ventana de aviso (días)
    const hoy = new Date().toISOString().slice(0, 10);
    const limite = new Date(Date.now() + horizonte * 864e5).toISOString().slice(0, 10);
    const out = [];
    const sev = (d) => d < 0 ? 'vencido' : (d <= 7 ? 'urgente' : 'proximo');

    // ART por empresa
    for (const a of (await query(
      `SELECT a.*, em.nombre AS empresa FROM art_contratos a JOIN empresas em ON em.id=a.empresa_id
         WHERE a.activo=true AND a.fecha_fin IS NOT NULL AND a.fecha_fin <= $1`, [limite])).rows) {
      const d = diasEntre(a.fecha_fin, hoy);
      out.push({ tipo: 'ART', titulo: `ART ${a.art_nombre} — ${a.empresa}`, detalle: `Contrato ${a.nro_contrato || ''} vence`, fecha: a.fecha_fin, dias: d, severidad: sev(d) });
    }
    // Mediciones HyS
    for (const m of (await query(
      `SELECT * FROM chs_mediciones WHERE fecha_vencimiento IS NOT NULL AND fecha_vencimiento <= $1`, [limite])).rows) {
      const d = diasEntre(m.fecha_vencimiento, hoy);
      out.push({ tipo: 'Medición HyS', titulo: `${m.tipo || 'Medición'} — ${m.empresa || ''} ${m.lugar || ''}`.trim(), detalle: 'Medición a renovar', fecha: m.fecha_vencimiento, dias: d, severidad: sev(d) });
    }
    // Período de prueba (LCT 92 bis: 3 meses desde el ingreso)
    for (const e of (await query(
      `SELECT id, nom, leg_num, ingreso FROM empleados WHERE activo=true AND ingreso IS NOT NULL
         AND (ingreso + INTERVAL '3 months')::date <= $1 AND (ingreso + INTERVAL '3 months')::date >= $2`, [limite, hoy])).rows) {
      const finPP = new Date(new Date(e.ingreso).getTime()); finPP.setMonth(finPP.getMonth() + 3);
      const f = finPP.toISOString().slice(0, 10); const d = diasEntre(f, hoy);
      out.push({ tipo: 'Período de prueba', titulo: `${e.nom} (leg. ${e.leg_num})`, detalle: 'Fin del período de prueba (definir continuidad)', fecha: f, dias: d, severidad: sev(d), empleadoId: e.id });
    }
    // Contratos a plazo fijo (si el legajo tiene data.fechaFinContrato)
    for (const e of (await query(
      `SELECT id, nom, leg_num, data FROM empleados WHERE activo=true
         AND (data->>'fechaFinContrato') IS NOT NULL AND (data->>'fechaFinContrato') <= $1`, [limite])).rows) {
      const f = e.data.fechaFinContrato; const d = diasEntre(f, hoy);
      out.push({ tipo: 'Contrato a plazo', titulo: `${e.nom} (leg. ${e.leg_num})`, detalle: 'Vencimiento de contrato a plazo fijo', fecha: f, dias: d, severidad: sev(d), empleadoId: e.id });
    }

    out.sort((a, b) => a.dias - b.dias);
    const resumen = { total: out.length, vencidos: out.filter((x) => x.severidad === 'vencido').length, urgentes: out.filter((x) => x.severidad === 'urgente').length };
    res.json({ horizonte, resumen, alertas: out });
  } catch (e) { next(e); }
});

export default router;
