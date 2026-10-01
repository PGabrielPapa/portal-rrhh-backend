import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const aniosAl = (ing, anio) => { if (!ing) return 0; const d = new Date(ing); let a = anio - d.getFullYear(); const finAnio = new Date(anio, 11, 31); if (finAnio < new Date(d.getFullYear() + a, d.getMonth(), d.getDate())) a--; return Math.max(0, a); };
// Días por antigüedad al 31/12 del año (LCT art. 150).
export function diasVacacionesPorAntiguedad(anios) { if (anios >= 20) return 35; if (anios >= 10) return 28; if (anios >= 5) return 21; return 14; }

const mapRow = (r) => ({ id: r.id, empleadoId: r.empleado_id, nom: r.nom, legNum: r.leg_num, empresa: r.empresa, anio: r.anio, desde: r.desde, hasta: r.hasta, dias: r.dias, estado: r.estado, obs: r.obs });

// Saldos por empleado para un año: corresponden (antigüedad) − tomadas (registros).
router.get('/saldos', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.query.anio) || new Date().getFullYear();
    const cond = ['e.activo=true']; const args = [];
    if (req.query.empresa) { args.push(req.query.empresa); cond.push(`em.nombre=$${args.length}`); }
    const emps = (await query(`SELECT e.id, e.nom, e.leg_num, e.ingreso, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE ${cond.join(' AND ')} ORDER BY e.nom`, args)).rows;
    const tomadasRows = (await query('SELECT empleado_id, COALESCE(SUM(dias),0) AS d FROM vacaciones WHERE anio=$1 GROUP BY empleado_id', [anio])).rows;
    const tomadas = new Map(tomadasRows.map((x) => [x.empleado_id, Number(x.d)]));
    // Arrastre histórico (días pendientes de años anteriores), si se cargó.
    const iniRows = (await query('SELECT empleado_id, dias FROM vacaciones_saldo_inicial').catch(() => ({ rows: [] }))).rows;
    const inicial = new Map(iniRows.map((x) => [x.empleado_id, Number(x.dias)]));
    const filas = emps.map((e) => {
      const ant = aniosAl(e.ingreso, anio);
      const corresponden = e.ingreso ? diasVacacionesPorAntiguedad(ant) : 0;
      const t = tomadas.get(e.id) || 0;
      const ini = inicial.get(e.id) || 0;
      return { empleadoId: e.id, nom: e.nom, legNum: e.leg_num, empresa: e.empresa, ingreso: e.ingreso, antiguedad: ant, saldoInicial: ini, corresponden, tomadas: t, saldo: ini + corresponden - t };
    });
    res.json({ anio, filas });
  } catch (e) { next(e); }
});

router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.anio) { args.push(Number(req.query.anio)); cond.push(`v.anio=$${args.length}`); }
    if (req.query.empleadoId) { args.push(Number(req.query.empleadoId)); cond.push(`v.empleado_id=$${args.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await query(`SELECT v.*, e.nom, e.leg_num, em.nombre AS empresa FROM vacaciones v JOIN empleados e ON e.id=v.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY v.desde DESC NULLS LAST, e.nom`, args);
    res.json(rows.map(mapRow));
  } catch (e) { next(e); }
});

router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.anio) return res.status(400).json({ error: 'Empleado y año son obligatorios' });
    let dias = Number(b.dias) || 0;
    if (!dias && b.desde && b.hasta) dias = Math.floor((new Date(b.hasta) - new Date(b.desde)) / 864e5) + 1; // días corridos
    const r = await query('INSERT INTO vacaciones (empleado_id, anio, desde, hasta, dias, estado, obs, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [b.empleadoId, Number(b.anio), b.desde || null, b.hasta || null, dias, b.estado || 'programada', b.obs || null, req.user?.email || '']);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { next(e); }
});

router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    let dias = Number(b.dias) || 0;
    if (!dias && b.desde && b.hasta) dias = Math.floor((new Date(b.hasta) - new Date(b.desde)) / 864e5) + 1;
    const r = await query('UPDATE vacaciones SET anio=$1, desde=$2, hasta=$3, dias=$4, estado=$5, obs=$6 WHERE id=$7 RETURNING id',
      [Number(b.anio), b.desde || null, b.hasta || null, dias, b.estado || 'programada', b.obs || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const r = await query('DELETE FROM vacaciones WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ── Saldo inicial (arrastre histórico) ────────────────────────────────────
// Editar el saldo inicial de UN empleado a mano.
router.put('/saldo-inicial', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId) return res.status(400).json({ error: 'empleadoId es obligatorio' });
    await query(`INSERT INTO vacaciones_saldo_inicial (empleado_id, dias, obs, actualizado_por)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (empleado_id) DO UPDATE SET dias=EXCLUDED.dias, obs=EXCLUDED.obs, actualizado_por=EXCLUDED.actualizado_por, actualizado_en=now()`,
      [b.empleadoId, Number(b.dias) || 0, b.obs || null, req.user?.email || '']);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Importación masiva desde el Excel histórico.
// body: { filas: [{ legNum, empresa, dias }] }  →  matchea por legajo + empresa
// (normalizando el nombre de empresa) y hace upsert. Devuelve el detalle.
router.post('/saldo-inicial/import', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const filas = Array.isArray((req.body || {}).filas) ? req.body.filas : [];
    if (!filas.length) return res.status(400).json({ error: 'No hay filas para importar' });
    const emps = (await query(`SELECT e.id, e.leg_num, em.nombre AS empresa FROM empleados e JOIN empresas em ON em.id=e.empresa_id`)).rows;
    const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Legajo sin ceros a la izquierda: en el sistema vienen "000125" y en el Excel "125".
    const nLeg = (s) => { const t = String(s ?? '').trim(); const d = t.replace(/^0+(?=\d)/, ''); return d; };
    // Índices: por legajo+empresa (exacto) y por legajo solo (para desambiguar).
    const porLegEmp = new Map(); const porLeg = new Map();
    for (const e of emps) {
      const lk = nLeg(e.leg_num);
      porLegEmp.set(`${lk}|${norm(e.empresa)}`, e.id);
      if (!porLeg.has(lk)) porLeg.set(lk, []);
      porLeg.get(lk).push(e.id);
    }
    let actualizados = 0; const noEncontrados = [];
    for (const f of filas) {
      const leg = nLeg(f.legNum);
      if (!leg) continue;
      const dias = Number(f.dias) || 0;
      let id = porLegEmp.get(`${leg}|${norm(f.empresa)}`);
      if (!id) { const cand = porLeg.get(leg) || []; if (cand.length === 1) id = cand[0]; }  // legajo único: alcanza
      if (!id) { noEncontrados.push({ legNum: leg, empresa: f.empresa, dias }); continue; }
      await query(`INSERT INTO vacaciones_saldo_inicial (empleado_id, dias, obs, actualizado_por)
                   VALUES ($1,$2,$3,$4)
                   ON CONFLICT (empleado_id) DO UPDATE SET dias=EXCLUDED.dias, obs=EXCLUDED.obs, actualizado_por=EXCLUDED.actualizado_por, actualizado_en=now()`,
        [id, dias, 'Importado del Excel histórico', req.user?.email || '']);
      actualizados++;
    }
    res.json({ ok: true, actualizados, noEncontrados });
  } catch (e) { next(e); }
});

export default router;
