import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { CONCEPTOS, TABLA4_DEFAULT, MAPA_TIPOS_DEFAULT } from '../lib/siradigTopes.js';

const router = Router();
router.use(requireAuth);

// Etiqueta de cada código tipo del XML, derivada de la tabla oficial (MAPA_TIPOS_DEFAULT -> CONCEPTOS).
export const SIRADIG_TIPOS = Object.fromEntries(
  Object.entries(MAPA_TIPOS_DEFAULT).map(([k, c]) => [k, (CONCEPTOS[c] && CONCEPTOS[c].label) || c])
);
const tipoLabel = (t) => SIRADIG_TIPOS[Number(t)] || SIRADIG_TIPOS[String(t)] || `Deducción tipo ${t}`;

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };

function mapRow(r) {
  return {
    id: r.id, cuil: r.cuil, empleadoId: r.empleado_id, empleadoNom: r.empleado_nom || null,
    legNum: r.leg_num || null, nom: r.nom, anio: r.anio,
    nroPresentacion: r.nro_presentacion, fechaPresentacion: r.fecha_presentacion, version: r.version,
    empleadoData: r.empleado_data || {}, cargasFamilia: r.cargas_familia || [], deducciones: r.deducciones || [],
    total: Number(r.total), totalPorMes: r.total_por_mes || {}, archivoNombre: r.archivo_nombre,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// Catálogo de tipos (para el front)
router.get('/_tipos', (req, res) => res.json(SIRADIG_TIPOS));

// Importar presentaciones SiRADIG ya parseadas del XML por el front.
// body: { presentaciones: [ { cuil, anio, nroPresentacion, fechaPresentacion, version, empleado, cargasFamilia, deducciones, archivoNombre } ] }
router.post('/import', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const lista = Array.isArray(req.body?.presentaciones) ? req.body.presentaciones : [];
    if (!lista.length) return res.status(400).json({ error: 'No se recibieron presentaciones. Subí el/los XML o el .zip de ARCA.' });
    const creador = req.user?.email || req.user?.nom || String(req.user?.id || '');
    const out = { ok: true, importadas: 0, actualizadas: 0, omitidas: 0, conEmpleado: 0, sinEmpleado: 0, detalle: [] };

    for (const p of lista) {
      const cuil = onlyDigits(p.cuil);
      const anio = Number(p.anio);
      if (cuil.length < 10 || !anio) { out.omitidas++; continue; }
      const nroPres = Number(p.nroPresentacion) || 0;
      const deducciones = Array.isArray(p.deducciones) ? p.deducciones : [];
      const cargas = Array.isArray(p.cargasFamilia) ? p.cargasFamilia : [];

      // total y total por mes (expandiendo mesDesde..mesHasta de cada deducción)
      let total = 0; const porMes = {};
      for (const d of deducciones) {
        total += num(d.montoTotal);
        for (const per of (d.periodos || [])) {
          const md = Number(per.mesDesde) || 0, mh = Number(per.mesHasta) || md, mm = num(per.montoMensual);
          for (let m = md; m <= mh && m >= 1 && m <= 12; m++) porMes[m] = (porMes[m] || 0) + mm;
        }
      }
      total = Math.round(total * 100) / 100;

      const nom = [p.empleado?.apellido, p.empleado?.nombre].filter(Boolean).join(', ').trim().toUpperCase() || null;
      // normalizar tipos con label
      const dedNorm = deducciones.map((d) => ({ ...d, tipoLabel: d.tipoLabel || tipoLabel(d.tipo) }));

      const em = await query("SELECT id, nom, leg_num FROM empleados WHERE regexp_replace(cuil, '\\D', '', 'g') = $1 ORDER BY activo DESC, id DESC LIMIT 1", [cuil]);
      const empId = em.rows[0]?.id || null;

      // Upsert "último presentado": solo pisa si nroPresentacion >= al guardado.
      const r = await query(
        `INSERT INTO siradig_presentaciones
           (cuil, empleado_id, nom, anio, nro_presentacion, fecha_presentacion, version, empleado_data, cargas_familia, deducciones, total, total_por_mes, archivo_nombre, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14)
         ON CONFLICT (cuil, anio) DO UPDATE SET
           empleado_id=EXCLUDED.empleado_id, nom=COALESCE(EXCLUDED.nom, siradig_presentaciones.nom),
           nro_presentacion=EXCLUDED.nro_presentacion, fecha_presentacion=EXCLUDED.fecha_presentacion, version=EXCLUDED.version,
           empleado_data=EXCLUDED.empleado_data, cargas_familia=EXCLUDED.cargas_familia, deducciones=EXCLUDED.deducciones,
           total=EXCLUDED.total, total_por_mes=EXCLUDED.total_por_mes, archivo_nombre=EXCLUDED.archivo_nombre,
           created_by=EXCLUDED.created_by, updated_at=now()
         WHERE EXCLUDED.nro_presentacion >= siradig_presentaciones.nro_presentacion
         RETURNING (xmax = 0) AS inserted`,
        [cuil, empId, nom, anio, nroPres, p.fechaPresentacion || null, p.version || null,
         JSON.stringify(p.empleado || {}), JSON.stringify(cargas), JSON.stringify(dedNorm), total, JSON.stringify(porMes), p.archivoNombre || null, creador]);

      if (!r.rowCount) { out.omitidas++; /* ya había una presentación igual o más nueva */ }
      else if (r.rows[0].inserted) out.importadas++;
      else out.actualizadas++;
      if (r.rowCount) { if (empId) out.conEmpleado++; else out.sinEmpleado++; }
      out.detalle.push({ cuil, nom: em.rows[0]?.nom || nom, empleadoId: empId, anio, nroPresentacion: nroPres, total, deducciones: deducciones.length, cargas: cargas.length, guardado: !!r.rowCount });
    }
    res.json(out);
  } catch (e) { next(e); }
});

// Listado (filtros: anio, q)
router.get('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const cond = [], args = [];
    if (req.query.anio) { args.push(Number(req.query.anio)); cond.push(`s.anio=$${args.length}`); }
    if (req.query.q) { args.push('%' + String(req.query.q).toLowerCase() + '%'); cond.push(`(LOWER(COALESCE(s.nom,'')) LIKE $${args.length} OR s.cuil LIKE $${args.length} OR LOWER(COALESCE(e.nom,'')) LIKE $${args.length})`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await query(
      `SELECT s.*, e.nom AS empleado_nom, e.leg_num
         FROM siradig_presentaciones s LEFT JOIN empleados e ON e.id = s.empleado_id
         ${where} ORDER BY s.anio DESC, COALESCE(e.nom, s.nom)`, args);
    res.json(rows.map(mapRow));
  } catch (e) { next(e); }
});

router.get('/_anios', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { const { rows } = await query('SELECT DISTINCT anio FROM siradig_presentaciones ORDER BY anio DESC'); res.json(rows.map(r => r.anio)); }
  catch (e) { next(e); }
});

// Deducciones de un empleado para aplicar en Ganancias (usado por el módulo de liquidación)
router.get('/empleado/:empleadoId', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const anio = Number(req.query.anio) || new Date().getFullYear();
    const { rows } = await query(
      `SELECT s.*, e.nom AS empleado_nom, e.leg_num FROM siradig_presentaciones s
         LEFT JOIN empleados e ON e.id=s.empleado_id WHERE s.empleado_id=$1 AND s.anio=$2`, [req.params.empleadoId, anio]);
    if (!rows[0]) return res.json(null);
    res.json(mapRow(rows[0]));
  } catch (e) { next(e); }
});

// ── Configuración: mapeo código tipo->concepto + topes (guardado en parametros_liq.data) ──
router.get('/_config', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const data = (await query('SELECT data FROM parametros_liq WHERE id=1')).rows[0]?.data || {};
    res.json({
      mapaTipos: { ...MAPA_TIPOS_DEFAULT, ...(data.siradigTipos || {}) },
      topes: { ...TABLA4_DEFAULT, ...(data.topesSiradig || {}) },
      conceptos: CONCEPTOS,
      tabla4Default: TABLA4_DEFAULT,
    });
  } catch (e) { next(e); }
});

router.get('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.*, e.nom AS empleado_nom, e.leg_num FROM siradig_presentaciones s
         LEFT JOIN empleados e ON e.id=s.empleado_id WHERE s.id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(mapRow(rows[0]));
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM siradig_presentaciones WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.put('/_config', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const cur = (await query('SELECT data FROM parametros_liq WHERE id=1')).rows[0]?.data || {};
    const next = { ...cur };
    if (b.mapaTipos && typeof b.mapaTipos === 'object') {
      // normalizar: clave numérica -> concepto (string) | vacío = sin clasificar
      const m = {}; for (const [k, v] of Object.entries(b.mapaTipos)) { if (v) m[String(k).replace(/\D/g, '')] = String(v); }
      next.siradigTipos = m;
    }
    if (b.topes && typeof b.topes === 'object') {
      const t = {}; for (const [k, v] of Object.entries(b.topes)) { t[k] = (k === 'modo') ? String(v) : Number(v) || 0; }
      next.topesSiradig = t;
    }
    await query('INSERT INTO parametros_liq (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data=$1::jsonb', [JSON.stringify(next)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
