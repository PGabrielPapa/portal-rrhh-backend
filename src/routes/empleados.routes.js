import { Router } from 'express';
import { query, pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { makeUid, dniFromCuil } from '../lib/identity.js';
import { idsEquipoDe, idsDirectosDe } from '../lib/equipo.js';

const router = Router();
router.use(requireAuth);

// Mapea una fila (con empresa_nombre/slug) al DTO que consume el front.
function mapRow(r) {
  const uid = makeUid(r.empresa_nombre, r.leg_num);
  return {
    id: r.id,
    uid,                       // identidad única (empresa+legajo)
    legNum: r.leg_num,         // número de legajo visible
    leg: uid,                  // compat con el front actual
    dni: r.dni,
    cuil: r.cuil,
    nom: r.nom,
    email: r.email,
    empresa: r.empresa_nombre,
    empresaId: r.empresa_id,
    cat: r.cat,
    tramo: r.tramo,
    ingreso: r.ingreso,
    bruto: Number(r.bruto),
    neto: Number(r.neto),
    role: r.role,
    activo: r.activo,
    esAlta: r.es_alta,
    ...r.data,
  };
}

const SELECT = `
  SELECT e.*, em.nombre AS empresa_nombre, em.slug AS empresa_slug
    FROM empleados e JOIN empresas em ON em.id = e.empresa_id`;

// GET /api/empleados?empresa=&q=&activos=
router.get('/', async (req, res, next) => {
  try {
    const { empresa, q, activos } = req.query;
    const cond = [], params = [];
    if (empresa) { params.push(empresa); cond.push(`em.nombre = $${params.length}`); }
    if (activos === 'true') cond.push('e.activo = true');
    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      const i = params.length;
      cond.push(`(lower(e.nom) LIKE $${i} OR e.leg_num LIKE $${i} OR e.dni LIKE $${i})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(`${SELECT} ${where} ORDER BY e.nom`, params);
    res.json(rows.map(mapRow));
  } catch (e) { next(e); }
});

// GET /api/empleados/mi-perfil — datos del propio usuario autenticado.
// (Debe ir ANTES de /:id para que "mi-perfil" no caiga en el parámetro :id.)
router.get('/mi-perfil', async (req, res, next) => {
  try {
    const { rows } = await query(`${SELECT} WHERE e.id = $1`, [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(mapRow(rows[0]));
  } catch (e) { next(e); }
});

// GET /api/empleados/equipo — empleados a cargo del gerente según el organigrama
// (RR.HH./admin reciben todos los activos). Debe ir ANTES de /:id.
router.get('/equipo', async (req, res, next) => {
  try {
    // SIEMPRE el equipo del usuario actual (aunque sea rrhh/admin): es la vista "mi equipo".
    // ?directos=1 → solo reportes directos; por defecto, todo el subárbol.
    const soloDirectos = req.query.directos === '1';
    const ids = [...await (soloDirectos ? idsDirectosDe(req.user.id) : idsEquipoDe(req.user.id))];
    if (!ids.length) return res.json([]);
    const { rows } = await query(`${SELECT} WHERE e.id = ANY($1) AND e.activo = true ORDER BY e.nom`, [ids]);
    res.json(rows.map(mapRow));
  } catch (e) { next(e); }
});

// GET /api/empleados/:id
// GET /api/empleados/cumpleanios — próximos cumpleaños de compañeros (cualquier rol)
router.get('/cumpleanios', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.nom, em.nombre AS empresa, e.data FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE e.activo=true`);
    const hoy = new Date(); const y = hoy.getFullYear();
    const hoy0 = new Date(y, hoy.getMonth(), hoy.getDate());
    const out = [];
    for (const r of rows) {
      if (r.id === req.user.id) continue;
      // En IDEE solo se muestran cumpleaños del personal mensualizado.
      if (/\bIDEE\b/i.test(r.empresa) && !/mensual/i.test(String(r.data?.condicion || ''))) continue;
      const fn = String(r.data?.fecha_nac || '').trim();
      const m = fn.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
      if (!m) continue;
      const dd = Number(m[1]), mm = Number(m[2]), anioNac = m[3] ? Number(m[3].length === 2 ? '19' + m[3] : m[3]) : null;
      if (!(dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12)) continue;
      let prox = new Date(y, mm - 1, dd);
      const esHoy = (dd === hoy.getDate() && mm === hoy.getMonth() + 1);
      if (prox < hoy0 && !esHoy) prox = new Date(y + 1, mm - 1, dd);
      const diasHasta = Math.round((prox - hoy0) / 86400000);
      const edad = anioNac ? (prox.getFullYear() - anioNac) : null;
      out.push({ nom: r.nom, empresa: r.empresa, lugar: r.data?.lugar || '', fecha: `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}`, diasHasta, edad });
    }
    out.sort((a, b) => a.diasHasta - b.diasHasta);
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`${SELECT} WHERE e.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(mapRow(rows[0]));
  } catch (e) { next(e); }
});

async function resolveEmpresaId(client, nombre) {
  const r = await client.query('SELECT id FROM empresas WHERE nombre = $1', [nombre]);
  return r.rows[0]?.id || null;
}

// POST /api/empleados   (rrhh/admin) — alta individual
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  const b = req.body || {};
  const empresa = (b.empresa || '').trim();
  const legNum = String(b.legNum || b.leg || '').trim();
  let dni = String(b.dni || '').trim();
  const cuil = String(b.cuil || '').trim();
  if (!dni && cuil) dni = dniFromCuil(cuil);
  if (!empresa || !legNum || !dni || !b.nom) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: empresa, legajo, DNI (o CUIL) y nombre' });
  }
  const client = await pool.connect();
  try {
    const empresaId = await resolveEmpresaId(client, empresa);
    if (!empresaId) return res.status(400).json({ error: `Empresa no encontrada: ${empresa}` });
    const core = ['empresa','legNum','leg','dni','cuil','nom','email','cat','tramo','ingreso','bruto','neto','role'];
    const data = {}; for (const k of Object.keys(b)) if (!core.includes(k)) data[k] = b[k];
    const { rows } = await client.query(
      `INSERT INTO empleados (empresa_id, leg_num, dni, cuil, nom, email, cat, tramo, ingreso, bruto, neto, es_alta, role, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13) RETURNING id`,
      [empresaId, legNum, dni, cuil || null, String(b.nom).toUpperCase(), b.email || null,
       b.cat || null, b.tramo || null, b.ingreso || null, b.bruto || 0, b.neto || 0,
       b.role || 'employee', JSON.stringify(data)]
    );
    const out = await client.query(`${SELECT} WHERE e.id = $1`, [rows[0].id]);
    res.status(201).json(mapRow(out.rows[0]));
  } catch (e) { next(e); } finally { client.release(); }
});

// PUT /api/empleados/:id  (rrhh/admin)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    // Columnas núcleo editables (identidad empresa+legajo+dni NO se cambia acá).
    const fields = { nom: b.nom, email: b.email, cat: b.cat, tramo: b.tramo, cuil: b.cuil,
      ingreso: b.ingreso, bruto: b.bruto, neto: b.neto };
    const sets = [], params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) { params.push(k === 'nom' ? String(v).toUpperCase() : (v === '' ? null : v)); sets.push(`${k} = $${params.length}`); }
    }
    // Resto de campos (domicilio, tarea, sindicato, básico, etc.) → se mergean en data jsonb.
    const exclude = ['empresa', 'legNum', 'leg', 'dni', 'cuil', 'nom', 'email', 'cat', 'tramo', 'ingreso', 'bruto', 'neto', 'role', 'id', 'uid', 'empresaId', 'activo', 'esAlta'];
    const data = {}; for (const k of Object.keys(b)) if (!exclude.includes(k)) data[k] = b[k];
    if (Object.keys(data).length) { params.push(JSON.stringify(data)); sets.push(`data = data || $${params.length}::jsonb`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(req.params.id);
    await query(`UPDATE empleados SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const out = await query(`${SELECT} WHERE e.id = $1`, [req.params.id]);
    if (!out.rows[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(mapRow(out.rows[0]));
  } catch (e) { next(e); }
});

// PATCH /api/empleados/:id/activo  (rrhh/admin) — baja/alta lógica
router.patch('/:id/activo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const activo = !!(req.body || {}).activo;
    await query('UPDATE empleados SET activo = $1 WHERE id = $2', [activo, req.params.id]);
    res.json({ ok: true, activo });
  } catch (e) { next(e); }
});

// POST /api/empleados/import  (rrhh/admin) — alta masiva
// body: { rows: [{ Legajo, DNI, CUIL, "Apellido y Nombre", Empresa, "Fecha Ingreso", ... }] }
router.post('/import', requireRole('rrhh', 'admin'), async (req, res, next) => {
  const rows = (req.body && req.body.rows) || [];
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No se recibieron filas' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // identidad existente (empresa+legajo) y DNIs
    const ex = await client.query(
      `SELECT em.nombre AS emp, e.leg_num, e.dni FROM empleados e JOIN empresas em ON em.id = e.empresa_id`
    );
    const uidSet = new Set(ex.rows.map((r) => makeUid(r.emp, r.leg_num)));
    const dniSet = new Set(ex.rows.map((r) => r.dni));
    const empresasDb = await client.query('SELECT id, nombre FROM empresas');
    const empresaId = Object.fromEntries(empresasDb.rows.map((r) => [r.nombre, r.id]));

    let ok = 0, dup = 0, err = 0; const errores = [];
    for (const r of rows) {
      const legNum = String(r['Legajo'] || '').trim().padStart(6, '0');
      const empresa = String(r['Empresa'] || '').trim();
      const cuil = String(r['CUIL'] || '').trim();
      let dni = String(r['DNI'] || '').trim();
      if (!dni && cuil) dni = dniFromCuil(cuil);
      const nom = String(r['Apellido y Nombre'] || '').trim().toUpperCase();
      const ing = String(r['Fecha Ingreso'] || '').trim();
      if (!legNum || !dni || !cuil || !nom || !empresa) { errores.push(`Legajo ${legNum || '?'}: faltan campos obligatorios`); err++; continue; }
      const eid = empresaId[empresa];
      if (!eid) { errores.push(`Legajo ${legNum}: empresa desconocida "${empresa}"`); err++; continue; }
      const uid = makeUid(empresa, legNum);
      if (uidSet.has(uid)) { errores.push(`Legajo ${legNum} en ${empresa}: ya existe`); dup++; continue; }
      if (dniSet.has(dni)) { errores.push(`DNI ${dni} (${nom}): ya existe`); dup++; continue; }
      const ingISO = (() => { const m = ing.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}$/.test(ing) ? ing : null); })();
      const data = { ubicacion: r['Ubicación'] || '', dom_calle: r['Domicilio Calle'] || '', dom_loc: r['Localidad'] || '', dom_prov: r['Provincia'] || '', dom_cp: r['Código Postal'] || '' };
      await client.query(
        `INSERT INTO empleados (empresa_id, leg_num, dni, cuil, nom, email, cat, tramo, ingreso, bruto, neto, es_alta, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12)`,
        [eid, legNum, dni, cuil, nom, r['E-mail'] || null, (r['Categoría'] || '').toUpperCase() || null,
         (r['Tramo'] || '').toUpperCase() || null, ingISO, parseFloat(r['Sueldo Bruto']) || 0,
         parseFloat(r['Sueldo Neto']) || 0, JSON.stringify(data)]
      );
      uidSet.add(uid); dniSet.add(dni); ok++;
    }
    await client.query('COMMIT');
    res.json({ ok, dup, err, errores, mensaje: ok > 0
      ? `Importación realizada con éxito — ${ok} empleado(s) cargado(s)${dup || err ? ` (${dup} duplicado(s), ${err} con error)` : ''}`
      : `No se importó ningún empleado${dup ? `: ${dup} ya existían` : ''}${err ? `: ${err} con error` : ''}` });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

export default router;
