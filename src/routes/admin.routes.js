import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { empSlug } from '../lib/identity.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { valoresLegalesVigentes } from './valoresLegales.routes.js';
import { ganTablaParaFecha } from '../lib/gananciasParams.js';
import { escalaUnificadaVigente, conveniosVigentes } from '../lib/escalasAuto.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const ROLES = ['employee', 'manager', 'rrhh', 'admin'];
async function audit(actor, accion, detalle, target) {
  try { await query('INSERT INTO audit_log (actor_dni, accion, detalle, target) VALUES ($1,$2,$3,$4)', [actor, accion, detalle || null, target || null]); } catch { /* noop */ }
}

// GET /api/admin/usuarios?q=&empresa=&role=
router.get('/usuarios', async (req, res, next) => {
  try {
    const { q, empresa, role } = req.query; const cond = [], params = [];
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (role) { params.push(role); cond.push(`e.role = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i} OR e.dni LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT e.id, e.leg_num, e.dni, e.nom, e.role, e.disabled, e.must_change_pwd, COALESCE((e.data->>'comite_hys')::boolean, false) AS comite_hys, COALESCE(e.data->'modulosOcultos','[]'::jsonb) AS modulos_ocultos, COALESCE(e.totp_enabled,false) AS twofa, em.nombre AS empresa
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id ${where} ORDER BY e.nom`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// PATCH /api/admin/usuarios/:id  { role?, disabled? }
router.patch('/usuarios/:id', async (req, res, next) => {
  try {
    const { role, disabled } = req.body || {};
    const id = Number(req.params.id);
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
      if (id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'No podés quitarte el rol admin a vos mismo' });
      await query('UPDATE empleados SET role = $1 WHERE id = $2', [role, id]);
      await audit(req.user.dni, 'cambio_rol', `rol → ${role}`, String(id));
    }
    if (disabled !== undefined) {
      if (id === req.user.id && disabled) return res.status(400).json({ error: 'No podés desactivarte a vos mismo' });
      await query('UPDATE empleados SET disabled = $1 WHERE id = $2', [!!disabled, id]);
      await audit(req.user.dni, disabled ? 'usuario_desactivado' : 'usuario_activado', null, String(id));
    }
    if (req.body && req.body.comiteHys !== undefined) {
      await query("UPDATE empleados SET data = data || jsonb_build_object('comite_hys', $1::boolean) WHERE id = $2", [!!req.body.comiteHys, id]);
      await audit(req.user.dni, req.body.comiteHys ? 'comite_hys_alta' : 'comite_hys_baja', 'Integrante Comité HyS', String(id));
    }
    if (req.body && Array.isArray(req.body.modulosOcultos)) {
      const mods = req.body.modulosOcultos.map(String);
      await query("UPDATE empleados SET data = data || jsonb_build_object('modulosOcultos', $1::jsonb) WHERE id = $2", [JSON.stringify(mods), id]);
      await audit(req.user.dni, 'modulos_ocultos', `${mods.length} módulo(s) ocultos`, String(id));
    }
    if (req.body && req.body.reset2fa) {
      await query('UPDATE empleados SET totp_secret=NULL, totp_enabled=false WHERE id=$1', [id]);
      await audit(req.user.dni, 'reset_2fa', '2FA restablecido', String(id));
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/admin/usuarios/:id/blanquear — resetea la clave al DNI (cambio forzado)
router.post('/usuarios/:id/blanquear', async (req, res, next) => {
  try {
    const r = await query('SELECT dni FROM empleados WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    const hash = await bcrypt.hash(String(r.rows[0].dni), config.bcryptRounds);
    await query('UPDATE empleados SET password_hash = $1, must_change_pwd = true WHERE id = $2', [hash, req.params.id]);
    await audit(req.user.dni, 'blanqueo_password', 'clave reseteada al DNI', String(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/admin/auditoria?q=
router.get('/auditoria', async (req, res, next) => {
  try {
    const { q } = req.query; const cond = [], params = [];
    if (q) { params.push(`%${String(q).toLowerCase()}%`); const i = params.length; cond.push(`(lower(accion) LIKE $${i} OR lower(coalesce(detalle,'')) LIKE $${i} OR actor_dni LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/admin/empresas — listado de empresas (con logo y datos)
router.get('/empresas', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, nombre, slug, cuit, logo, firma, data FROM empresas ORDER BY nombre');
    const links = (await query(
      `SELECT ec.empresa_id, c.id, c.codigo, c.denominacion
         FROM empresa_centros ec JOIN centros_operaciones c ON c.id = ec.centro_id
        ORDER BY c.denominacion`)).rows;
    for (const e of rows) e.centros = links.filter((l) => l.empresa_id === e.id).map((l) => ({ id: l.id, codigo: l.codigo, denominacion: l.denominacion }));
    res.json(rows);
  } catch (e) { next(e); }
});

// PATCH /api/admin/empresas/:id  { cuit?, data?, logo? }
router.patch('/empresas/:id', async (req, res, next) => {
  try {
    const { cuit, data, logo } = req.body || {};
    const sets = [], params = [];
    if (cuit !== undefined) { params.push(cuit); sets.push(`cuit = $${params.length}`); }
    if (data !== undefined) { params.push(JSON.stringify(data)); sets.push(`data = $${params.length}`); }
    if (logo !== undefined) { params.push(logo || null); sets.push(`logo = $${params.length}`); }
    if (req.body.firma !== undefined) { params.push(req.body.firma || null); sets.push(`firma = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(req.params.id);
    await query(`UPDATE empresas SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    await audit(req.user.dni, 'empresa_editada', cuit ? `CUIT: ${cuit}` : (logo !== undefined ? 'logo actualizado' : 'datos'), String(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/admin/empresas — alta de empresa
router.post('/empresas', async (req, res, next) => {
  try {
    const { nombre, cuit, data, logo, firma } = req.body || {};
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const r = await query(
      'INSERT INTO empresas (nombre, slug, cuit, data, logo, firma) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(nombre).trim(), empSlug(nombre), cuit || null, JSON.stringify(data || {}), logo || null, firma || null]);
    await audit(req.user.dni, 'empresa_alta', String(nombre), String(r.rows[0].id));
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una empresa con ese nombre' }); next(e); }
});

// DELETE /api/admin/empresas/:id — eliminar (solo si no tiene empleados)
router.delete('/empresas/:id', async (req, res, next) => {
  try {
    const c = await query('SELECT count(*)::int AS n FROM empleados WHERE empresa_id = $1', [req.params.id]);
    if (c.rows[0].n > 0) return res.status(409).json({ error: `No se puede eliminar: la empresa tiene ${c.rows[0].n} empleado(s). Reasignalos o dalos de baja primero.` });
    const r = await query('DELETE FROM empresas WHERE id = $1 RETURNING nombre', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Empresa no encontrada' });
    await audit(req.user.dni, 'empresa_baja', r.rows[0].nombre, String(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Centros de operaciones (ABM) ──
// GET /api/admin/centros — listado con la cantidad de empresas vinculadas.
router.get('/centros', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, COALESCE(cnt.n, 0)::int AS empresas
         FROM centros_operaciones c
         LEFT JOIN (SELECT centro_id, COUNT(*) AS n FROM empresa_centros GROUP BY centro_id) cnt ON cnt.centro_id = c.id
        ORDER BY c.denominacion`);
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/admin/centros — alta de centro.
router.post('/centros', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.codigo || !String(b.codigo).trim()) return res.status(400).json({ error: 'El código es obligatorio' });
    if (!b.denominacion || !String(b.denominacion).trim()) return res.status(400).json({ error: 'La denominación es obligatoria' });
    const r = await query(
      `INSERT INTO centros_operaciones (codigo, denominacion, calle, numero, localidad, provincia, cp)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [String(b.codigo).trim(), String(b.denominacion).trim(), b.calle || null, b.numero || null, b.localidad || null, b.provincia || null, b.cp || null]);
    await audit(req.user.dni, 'centro_alta', String(b.codigo), String(r.rows[0].id));
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un centro con ese código' }); next(e); }
});

// PATCH /api/admin/centros/:id — edición.
router.patch('/centros/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const campos = ['codigo', 'denominacion', 'calle', 'numero', 'localidad', 'provincia', 'cp'];
    const sets = [], params = [];
    for (const c of campos) if (b[c] !== undefined) { params.push(b[c] === '' ? null : b[c]); sets.push(`${c} = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(req.params.id);
    await query(`UPDATE centros_operaciones SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    await audit(req.user.dni, 'centro_editado', b.codigo || '', String(req.params.id));
    res.json({ ok: true });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un centro con ese código' }); next(e); }
});

// DELETE /api/admin/centros/:id — baja (desvincula de las empresas por cascade).
router.delete('/centros/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM centros_operaciones WHERE id = $1 RETURNING codigo', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Centro no encontrado' });
    await audit(req.user.dni, 'centro_baja', r.rows[0].codigo, String(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PUT /api/admin/empresas/:id/centros  { centroIds: [] } — define los centros vinculados a una empresa.
router.put('/empresas/:id/centros', async (req, res, next) => {
  try {
    const empresaId = Number(req.params.id);
    const ids = Array.isArray(req.body?.centroIds) ? req.body.centroIds.map(Number).filter(Boolean) : [];
    await query('DELETE FROM empresa_centros WHERE empresa_id = $1', [empresaId]);
    for (const cid of ids) await query('INSERT INTO empresa_centros (empresa_id, centro_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [empresaId, cid]);
    await audit(req.user.dni, 'empresa_centros', `${ids.length} centro(s)`, String(empresaId));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PUT /api/admin/centros/:id/empresas  { empresaIds: [] } — vincula un centro a una o varias empresas.
router.put('/centros/:id/empresas', async (req, res, next) => {
  try {
    const centroId = Number(req.params.id);
    const ids = Array.isArray(req.body?.empresaIds) ? req.body.empresaIds.map(Number).filter(Boolean) : [];
    await query('DELETE FROM empresa_centros WHERE centro_id = $1', [centroId]);
    for (const eid of ids) await query('INSERT INTO empresa_centros (empresa_id, centro_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [eid, centroId]);
    await audit(req.user.dni, 'centro_empresas', `${ids.length} empresa(s)`, String(centroId));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/admin/estado-sistema — panel de salud + automatizaciones (para "Estado del sistema").
router.get('/estado-sistema', async (req, res, next) => {
  const hoy = new Date().toISOString().slice(0, 10);
  const out = { ts: new Date().toISOString(), db: {}, backup: {}, automatizaciones: {} };
  // Base de datos
  try { const t0 = Date.now(); await query('SELECT 1'); out.db = { ok: true, ms: Date.now() - t0 }; }
  catch (e) { out.db = { ok: false, error: e.message }; }
  // Último respaldo
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^portal_rrhh_.*\.sql$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtime })).sort((a, b) => b.t - a.t) : [];
    out.backup = files.length
      ? { ok: true, ultimo: files[0].f, fecha: files[0].t, cantidad: files.length, auto: String(process.env.BACKUP_AUTO || 'true') !== 'false' }
      : { ok: false, mensaje: 'Sin respaldos todavía', auto: String(process.env.BACKUP_AUTO || 'true') !== 'false' };
  } catch (e) { out.backup = { ok: false, error: e.message }; }
  // Valores legales vigentes
  try { const v = await valoresLegalesVigentes(hoy); out.automatizaciones.valoresLegales = v ? { ok: true, vigenciaDesde: v.vigencia_desde } : { ok: false, mensaje: 'Sin valores cargados' }; }
  catch (e) { out.automatizaciones.valoresLegales = { ok: false, error: e.message }; }
  // Tabla de Ganancias vigente
  try { const g = await ganTablaParaFecha(hoy); out.automatizaciones.ganancias = g ? { ok: true, periodo: g.periodo || null } : { ok: false, mensaje: 'Sin tabla vigente' }; }
  catch (e) { out.automatizaciones.ganancias = { ok: false, error: e.message }; }
  // Escala unificada + convenios vigentes
  try {
    const esc = await escalaUnificadaVigente(hoy);
    const convs = await conveniosVigentes(hoy);
    out.automatizaciones.escala = esc ? { ok: true, vigencia: esc.vigencia, mesLabel: esc.mes_label, convenios: convs.length } : { ok: false, mensaje: 'Sin escala unificada cargada' };
  } catch (e) { out.automatizaciones.escala = { ok: false, error: e.message }; }
  res.json(out);
});

export default router;
