import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const aniosDesde = (f) => f ? (Date.now() - new Date(f).getTime()) / (365.25 * 864e5) : 0;
// Días de vacaciones por antigüedad (LCT art. 150).
function diasVac(antig) { if (antig >= 20) return 35; if (antig >= 10) return 28; if (antig >= 5) return 21; return 14; }

// Provisión mensual devengada de SAC y vacaciones por empleado (para el asiento contable).
router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const d = new Date();
    const anio = Number(req.query.anio) || d.getFullYear();
    const mes = Number(req.query.mes) || (d.getMonth() + 1);
    const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
    const contribPct = req.query.contribPct != null ? Number(req.query.contribPct) : 27;
    const cond = ['e.activo=true']; const args = [];
    if (empresaId) { args.push(empresaId); cond.push(`e.empresa_id=$${args.length}`); }
    const emps = (await query(`SELECT e.id, e.nom, e.leg_num, e.bruto, e.ingreso, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')} ORDER BY e.nom`, args)).rows;

    const filas = emps.map((e) => {
      const bruto = Number(e.bruto || 0);
      const antig = aniosDesde(e.ingreso);
      const dv = diasVac(antig);
      // SAC devengado mensual = 1/12 del mejor sueldo (aprox. bruto/12).
      const sacMes = r2(bruto / 12);
      // Vacaciones devengadas mensual = (días × valor día) / 12. Valor día vacaciones = bruto/25 (LCT art. 155).
      const vacAnual = r2(dv * (bruto / 25));
      const vacMes = r2(vacAnual / 12);
      const sacSobreVac = r2(vacMes / 12); // SAC sobre vacaciones
      const subtotal = r2(sacMes + vacMes + sacSobreVac);
      const conCargas = r2(subtotal * (1 + contribPct / 100));
      return { empleadoId: e.id, legNum: e.leg_num, nom: e.nom, empresa: e.empresa, bruto, antiguedad: r2(antig), diasVac: dv, sacMes, vacMes, sacSobreVac, subtotal, conCargas };
    });
    const tot = filas.reduce((a, f) => ({ sacMes: a.sacMes + f.sacMes, vacMes: a.vacMes + f.vacMes, sacSobreVac: a.sacSobreVac + f.sacSobreVac, subtotal: a.subtotal + f.subtotal, conCargas: a.conCargas + f.conCargas }), { sacMes: 0, vacMes: 0, sacSobreVac: 0, subtotal: 0, conCargas: 0 });
    res.json({ periodo: { anio, mes }, contribPct, filas, totales: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, r2(v)])) });
  } catch (e) { next(e); }
});

export default router;
