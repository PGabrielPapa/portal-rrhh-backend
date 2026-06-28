import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Tablero de RR.HH.: headcount, masa salarial, costo laboral, altas/bajas, distribución, ausentismo.
router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const d = new Date();
    const anio = Number(req.query.anio) || d.getFullYear();
    const mes = Number(req.query.mes) || (d.getMonth() + 1);
    const contribPct = req.query.contribPct != null ? Number(req.query.contribPct) : 27; // % contribuciones patronales (estimación)
    const ini = `${anio}-${String(mes).padStart(2, '0')}-01`;
    const fin = `${anio}-${String(mes).padStart(2, '0')}-${new Date(anio, mes, 0).getDate()}`;

    // Plantel activo + masa salarial + por empresa
    const emp = (await query(
      `SELECT e.id, e.bruto, e.neto, e.ingreso, e.activo, em.nombre AS empresa, e.data
         FROM empleados e JOIN empresas em ON em.id=e.empresa_id`)).rows;
    const activos = emp.filter((x) => x.activo);
    const masaBruta = r2(activos.reduce((a, x) => a + Number(x.bruto || 0), 0));
    const costoLaboral = r2(masaBruta * (1 + contribPct / 100));
    const sueldoProm = activos.length ? r2(masaBruta / activos.length) : 0;

    const porEmpresa = {};
    for (const x of activos) {
      const k = x.empresa || '—';
      porEmpresa[k] = porEmpresa[k] || { empresa: k, headcount: 0, masaBruta: 0 };
      porEmpresa[k].headcount++; porEmpresa[k].masaBruta = r2(porEmpresa[k].masaBruta + Number(x.bruto || 0));
    }
    // Distribución por género
    const genero = {};
    for (const x of activos) { const g = (x.data?.sexo || x.data?.genero || 'Sin dato'); genero[g] = (genero[g] || 0) + 1; }
    // Antigüedad promedio (años)
    const hoyMs = Date.now();
    const antigs = activos.filter((x) => x.ingreso).map((x) => (hoyMs - new Date(x.ingreso).getTime()) / (365.25 * 864e5));
    const antiguedadProm = antigs.length ? r2(antigs.reduce((a, b) => a + b, 0) / antigs.length) : 0;

    // Altas y bajas del mes
    const altas = emp.filter((x) => x.ingreso && x.ingreso >= ini && x.ingreso <= fin).length;
    const bajas = (await query(`SELECT COUNT(*)::int AS n FROM recibos WHERE tipo='final' AND anio=$1 AND mes=$2`, [anio, mes])).rows[0].n;

    // Ausentismo del mes (días de licencia aprobada que caen en el mes)
    const ausen = (await query(
      `SELECT COALESCE(SUM(dias),0)::int AS dias, COUNT(*)::int AS casos FROM licencias
         WHERE estado='aprobada' AND desde <= $2 AND hasta >= $1`, [ini, fin])).rows[0];

    // Evolución masa salarial (neto liquidado por mes del año)
    const evo = (await query(
      `SELECT mes, COALESCE(SUM(neto),0) AS neto FROM recibos WHERE anio=$1 AND tipo IN ('mensual','quincenal_1','quincenal_2') GROUP BY mes ORDER BY mes`, [anio])).rows
      .map((x) => ({ mes: x.mes, neto: Number(x.neto) }));

    res.json({
      periodo: { anio, mes },
      headcount: activos.length, totalEmpleados: emp.length,
      masaBruta, costoLaboral, contribPct, sueldoProm, antiguedadProm, altas, bajas,
      ausentismo: { dias: ausen.dias, casos: ausen.casos },
      porEmpresa: Object.values(porEmpresa).sort((a, b) => b.headcount - a.headcount),
      genero, evolucion: evo,
    });
  } catch (e) { next(e); }
});

export default router;
