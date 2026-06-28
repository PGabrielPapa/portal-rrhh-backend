import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { idsEquipoDe } from '../lib/equipo.js';

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


// ── Tablero del GERENTE: vista de su equipo (organigrama). ──
// manager: su equipo. rrhh/admin: su propio equipo (para previsualizar).
router.get('/gerente', requireRole('manager', 'rrhh', 'admin'), async (req, res, next) => {
  try {
    const d = new Date();
    const anio = Number(req.query.anio) || d.getFullYear();
    const mes = Number(req.query.mes) || (d.getMonth() + 1);
    const contribPct = req.query.contribPct != null ? Number(req.query.contribPct) : 27;
    const pad = (n) => String(n).padStart(2, '0');
    const ini = `${anio}-${pad(mes)}-01`;
    const fin = `${anio}-${pad(mes)}-${new Date(anio, mes, 0).getDate()}`;
    const hoyStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hoy0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const hoyMs = hoy0.getTime();

    const ids = [...await idsEquipoDe(req.user.id)];
    if (!ids.length) {
      return res.json({ periodo: { anio, mes }, sinEquipo: true });
    }

    // Equipo (datos base)
    const team = (await query(
      `SELECT e.id, e.nom, e.leg_num, e.bruto, e.ingreso, em.nombre AS empresa, e.data
         FROM empleados e JOIN empresas em ON em.id=e.empresa_id
        WHERE e.id = ANY($1) AND e.activo=true ORDER BY e.nom`, [ids])).rows;

    // ── KPIs ──
    const dotacion = team.length;
    const masaBruta = r2(team.reduce((a, x) => a + Number(x.bruto || 0), 0));
    const costoLaboral = r2(masaBruta * (1 + contribPct / 100));
    const antigs = team.filter((x) => x.ingreso).map((x) => (hoyMs - new Date(String(x.ingreso).slice(0, 10) + 'T00:00:00').getTime()) / (365.25 * 864e5));
    const antiguedadProm = antigs.length ? r2(antigs.reduce((a, b) => a + b, 0) / antigs.length) : 0;
    const parseFecha = (str) => {
      const m = String(str || '').trim().match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
      if (!m) return null;
      const dd = Number(m[1]), mm = Number(m[2]);
      const yy = m[3] ? Number(m[3].length === 2 ? '19' + m[3] : m[3]) : null;
      if (!(dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12)) return null;
      return { dd, mm, yy };
    };
    const edades = [];
    for (const x of team) {
      const fn = parseFecha(x.data?.fecha_nac);
      if (fn?.yy) edades.push(d.getFullYear() - fn.yy);
    }
    const edadProm = edades.length ? Math.round(edades.reduce((a, b) => a + b, 0) / edades.length) : 0;

    // ── Pendientes (cada uno defensivo) ──
    let adelantos = 0, fichadas = 0, licencias = 0, prueba = [], anualAbierto = false;
    try { adelantos = (await query(`SELECT COUNT(*)::int n FROM anticipos WHERE estado='pendiente' AND empleado_id = ANY($1)`, [ids])).rows[0].n; } catch (e) {}
    try { fichadas = (await query(`SELECT COUNT(*)::int n FROM fichadas_periodo WHERE estado='aprob_rrhh' AND anio=$1 AND mes=$2 AND empleado_id = ANY($3)`, [anio, mes, ids])).rows[0].n; } catch (e) {}
    try { licencias = (await query(`SELECT COUNT(*)::int n FROM licencias WHERE estado='pendiente' AND empleado_id = ANY($1)`, [ids])).rows[0].n; } catch (e) {}
    try {
      anualAbierto = !!(await query("SELECT 1 FROM evaluacion_periodos WHERE tipo='anual' AND abierto=true LIMIT 1")).rows[0];
      const evs = (await query(`SELECT empleado_id, periodo FROM evaluaciones WHERE empleado_id = ANY($1) AND tipo ILIKE '%prueba%'`, [ids])).rows;
      const hitos = [60, 120, 170];
      for (const e of team) {
        if (!e.ingreso) continue;
        const dias = Math.floor((hoyMs - new Date(String(e.ingreso).slice(0, 10) + 'T00:00:00').getTime()) / 864e5);
        for (const h of hitos) {
          if (dias >= h && dias < h + 60) {
            const done = evs.some((v) => v.empleado_id === e.id && String(v.periodo || '').includes(String(h)));
            if (!done) prueba.push({ nom: e.nom, dias, hito: h });
          }
        }
      }
      prueba.sort((a, b) => b.dias - a.dias);
    } catch (e) {}
    const evaluaciones = prueba.length + (anualAbierto ? team.length : 0);

    // ── Asistencia ──
    let ausentesHoy = [], ausentismoDias = 0;
    try {
      ausentesHoy = (await query(
        `SELECT e.nom, l.tipo, l.desde, l.hasta FROM licencias l JOIN empleados e ON e.id=l.empleado_id
          WHERE l.estado='aprobada' AND l.empleado_id = ANY($1) AND l.desde <= $2 AND l.hasta >= $2 ORDER BY e.nom`, [ids, hoyStr])).rows;
    } catch (e) {}
    try {
      ausentismoDias = (await query(
        `SELECT COALESCE(SUM(dias),0)::int d FROM licencias
          WHERE estado='aprobada' AND empleado_id = ANY($1) AND desde <= $2 AND hasta >= $3`, [ids, fin, ini])).rows[0].d;
    } catch (e) {}

    // ── Puntualidad y horas extra (fichadas del mes) ──
    let tardanzasCasos = 0, tardanzasMin = 0, extraMin = 0, rankingExtra = [], rankingTarde = [], detalleTarde = [];
    try {
      const fp = (await query(
        `SELECT f.empleado_id, e.nom, f.data FROM fichadas_periodo f JOIN empleados e ON e.id=f.empleado_id
          WHERE f.anio=$1 AND f.mes=$2 AND f.empleado_id = ANY($3) AND f.estado IN ('aprob_rrhh','autorizada','observada')`, [anio, mes, ids])).rows;
      for (const r of fp) {
        const dd = r.data || {};
        const tMin = Number(dd.tardanzasMin || 0);
        if (tMin > 0) { tardanzasCasos++; tardanzasMin += tMin; rankingTarde.push({ nom: r.nom, min: tMin }); }
        const dias = Array.isArray(dd.dias) ? dd.dias : [];
        let extraBruta = 0, deficit = 0;
        for (const x of dias) {
          const lm = Number(x.tardeMin || 0);
          if (lm > 0) detalleTarde.push({ nom: r.nom, fecha: x.fecha || null, dia: x.dia || null, entrada: x.entrada || null, min: lm });
          const ss = typeof x.saldoMin === 'number' ? x.saldoMin : null;
          if (ss == null) continue;
          if (ss >= 30) extraBruta += ss; else if (ss < 0) deficit += -ss;
        }
        const ext = Math.max(0, extraBruta - deficit);
        if (ext > 0) { extraMin += ext; rankingExtra.push({ nom: r.nom, min: ext }); }
      }
      rankingExtra.sort((a, b) => b.min - a.min); rankingExtra = rankingExtra.slice(0, 5);
      rankingTarde.sort((a, b) => b.min - a.min); rankingTarde = rankingTarde.slice(0, 5);
      detalleTarde.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || (b.min - a.min));
      detalleTarde = detalleTarde.slice(0, 200);
    } catch (e) {}

    // ── Avisos: cumpleaños y aniversarios (próximos 30 días) ──
    const cumple = [], aniversarios = [];
    for (const r of team) {
      const fn = parseFecha(r.data?.fecha_nac);
      if (fn) {
        let prox = new Date(d.getFullYear(), fn.mm - 1, fn.dd);
        const esHoy = (fn.dd === d.getDate() && fn.mm === d.getMonth() + 1);
        if (prox < hoy0 && !esHoy) prox = new Date(d.getFullYear() + 1, fn.mm - 1, fn.dd);
        const dias = Math.round((prox - hoy0) / 864e5);
        if (dias <= 30) cumple.push({ nom: r.nom, fecha: `${pad(fn.dd)}/${pad(fn.mm)}`, dias, edad: fn.yy ? prox.getFullYear() - fn.yy : null });
      }
      if (r.ingreso) {
        const ing = new Date(String(r.ingreso).slice(0, 10) + 'T00:00:00');
        let prox = new Date(d.getFullYear(), ing.getMonth(), ing.getDate());
        const esHoy = (ing.getDate() === d.getDate() && ing.getMonth() === d.getMonth());
        if (prox < hoy0 && !esHoy) prox = new Date(d.getFullYear() + 1, ing.getMonth(), ing.getDate());
        const dias = Math.round((prox - hoy0) / 864e5);
        const anios = prox.getFullYear() - ing.getFullYear();
        if (dias <= 30 && anios >= 1) aniversarios.push({ nom: r.nom, fecha: `${pad(ing.getDate())}/${pad(ing.getMonth() + 1)}`, dias, anios });
      }
    }
    cumple.sort((a, b) => a.dias - b.dias);
    aniversarios.sort((a, b) => a.dias - b.dias);

    // ── Evolución del costo laboral (neto liquidado del equipo, últimos 6 meses) ──
    let evolucion = [];
    try {
      const evo = (await query(
        `SELECT anio, mes, COALESCE(SUM(neto),0)::float neto FROM recibos
          WHERE empleado_id = ANY($1) AND tipo IN ('mensual','quincenal_1','quincenal_2') GROUP BY anio, mes`, [ids])).rows;
      const seq = [];
      for (let i = 5; i >= 0; i--) { let m = mes - i, y = anio; while (m <= 0) { m += 12; y--; } seq.push({ anio: y, mes: m }); }
      evolucion = seq.map((s) => { const ff = evo.find((x) => x.anio === s.anio && x.mes === s.mes); return { anio: s.anio, mes: s.mes, neto: ff ? Number(ff.neto) : 0 }; });
    } catch (e) {}

    res.json({
      periodo: { anio, mes }, sinEquipo: false,
      kpi: { dotacion, masaBruta, costoLaboral, contribPct, antiguedadProm, edadProm },
      pendientes: { adelantos, fichadas, licencias, evaluaciones, anualAbierto },
      asistencia: { ausentesHoy, ausentismoDias },
      puntualidad: { tardanzasCasos, tardanzasMin, ranking: rankingTarde, detalle: detalleTarde },
      extra: { totalMin: extraMin, ranking: rankingExtra },
      avisos: { cumple, aniversarios, prueba },
      evolucion,
    });
  } catch (e) { next(e); }
});

export default router;
