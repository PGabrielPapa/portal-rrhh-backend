import { Router } from 'express';
import { query, pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { makeUid, dniFromCuil, empSlug } from '../lib/identity.js';
import { idsEquipoDe, idsDirectosDe } from '../lib/equipo.js';

const router = Router();
router.use(requireAuth);

function logAudit(actor, accion, detalle, target) { query('INSERT INTO audit_log (actor_dni, accion, detalle, target) VALUES ($1,$2,$3,$4)', [actor, accion, detalle || null, target || null]).catch(() => {}); }
// Campos que el empleado puede autogestionar desde "Mis datos" (impacto directo + histórico).
const SELF_FIELDS = { estado_civil: 'Estado civil', email_personal: 'Mail personal', tel_personal: 'Teléfono personal', contacto_nombre: 'Contacto de emergencia — nombre', contacto_tel: 'Contacto de emergencia — teléfono', contacto_vinculo: 'Contacto de emergencia — vínculo' };

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
    puestoId: r.puesto_id,
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

// PATCH /api/empleados/mi-perfil — autogestión del propio empleado (impacto directo).
// Sólo campos de SELF_FIELDS. Cada cambio queda en cambios_perfil (histórico) y en audit_log (conocimiento RR.HH.).
router.patch('/mi-perfil', async (req, res, next) => {
  try {
    const b = req.body || {};
    const curRow = (await query(`${SELECT} WHERE e.id = $1`, [req.user.id])).rows[0];
    if (!curRow) return res.status(404).json({ error: 'Empleado no encontrado' });
    const data = curRow.data || {};
    const patch = {}; const cambios = [];
    for (const [k, label] of Object.entries(SELF_FIELDS)) {
      if (b[k] === undefined) continue;
      const nuevo = b[k] == null ? '' : String(b[k]).trim();
      const ant = data[k] == null ? '' : String(data[k]);
      if (nuevo === ant) continue;
      patch[k] = nuevo; cambios.push({ campo: k, label, ant, nuevo });
    }
    if (!cambios.length) return res.json(mapRow(curRow));
    await query('UPDATE empleados SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify(patch), req.user.id]);
    for (const c of cambios) {
      await query('INSERT INTO cambios_perfil (empleado_id, campo, etiqueta, valor_anterior, valor_nuevo, origen, actor_dni) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [req.user.id, c.campo, c.label, c.ant || null, c.nuevo || null, 'empleado', req.user.dni]);
      logAudit(req.user.dni, 'autoedicion_perfil', `${curRow.nom} — ${c.label}: "${c.ant}" → "${c.nuevo}"`, String(req.user.id));
    }
    const out = (await query(`${SELECT} WHERE e.id = $1`, [req.user.id])).rows[0];
    res.json(mapRow(out));
  } catch (e) { next(e); }
});

// GET /api/empleados/mi-perfil/cambios — histórico de autogestión del propio empleado.
router.get('/mi-perfil/cambios', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, campo, etiqueta, valor_anterior, valor_nuevo, origen, created_at FROM cambios_perfil WHERE empleado_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
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
// GET /api/empleados/:id/lugares — histórico de lugar de trabajo (legajo).
router.get('/:id/lugares', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT h.id, h.lugar, h.desde, h.hasta, h.motivo, h.created_by, h.created_at, c.codigo AS centro_codigo
         FROM lugar_trabajo_hist h LEFT JOIN centros_operaciones c ON c.id = h.centro_id
        WHERE h.empleado_id = $1 ORDER BY (h.hasta IS NULL) DESC, h.desde DESC NULLS LAST, h.id DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/empleados/centros — lista de centros de operaciones (para el desplegable de lugar de trabajo).
router.get('/centros', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, codigo, denominacion FROM centros_operaciones ORDER BY denominacion');
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/empleados/:id/cambios — histórico general de cambios del legajo.
router.get('/:id/cambios', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, campo, etiqueta, valor_anterior, valor_nuevo, created_by, created_at
         FROM legajo_cambios WHERE empleado_id = $1 ORDER BY created_at DESC, id DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

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

// Próximo legajo por empresa: máximo numérico existente + 1, con padding a 6 dígitos.
async function nextLegajo(client, empresaId) {
  const r = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(leg_num, '\\D', '', 'g'), '')::int), 0) + 1 AS n
       FROM empleados WHERE empresa_id = $1`, [empresaId]);
  return String(r.rows[0].n).padStart(6, '0');
}

// GET /api/empleados/proximo-legajo?empresa=NOMBRE — legajo a asignar en la próxima alta.
router.get('/proximo-legajo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const empresa = String(req.query.empresa || '').trim();
    const er = await query('SELECT id FROM empresas WHERE nombre = $1', [empresa]);
    if (!er.rows[0]) return res.status(400).json({ error: 'Empresa no encontrada' });
    res.json({ legNum: await nextLegajo(pool, er.rows[0].id), empresa });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`${SELECT} WHERE e.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(mapRow(rows[0]));
  } catch (e) { next(e); }
});

// GET /api/empleados/:id/cambios-perfil — histórico de autogestión (para RR.HH./gerencia).
router.get('/:id/cambios-perfil', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, campo, etiqueta, valor_anterior, valor_nuevo, origen, actor_dni, created_at FROM cambios_perfil WHERE empleado_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json(rows);
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
  if (!empresa || !dni || !b.nom) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: empresa, DNI (o CUIL) y nombre' });
  }
  const client = await pool.connect();
  try {
    const empresaId = await resolveEmpresaId(client, empresa);
    if (!empresaId) return res.status(400).json({ error: `Empresa no encontrada: ${empresa}` });
    // El legajo lo asigna el sistema (siguiente por empresa), para evitar repeticiones.
    const legAsignado = await nextLegajo(client, empresaId);
    const core = ['empresa','legNum','leg','dni','cuil','nom','email','cat','tramo','ingreso','bruto','neto','role','puestoId','esAdmin'];
    const data = {}; for (const k of Object.keys(b)) if (!core.includes(k)) data[k] = b[k];
    const { rows } = await client.query(
      `INSERT INTO empleados (empresa_id, leg_num, dni, cuil, nom, email, cat, tramo, ingreso, bruto, neto, es_alta, role, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13) RETURNING id`,
      [empresaId, legAsignado, dni, cuil || null, String(b.nom).toUpperCase(), b.email || null,
       b.cat || null, b.tramo || null, b.ingreso || null, b.bruto || 0, b.neto || 0,
       ((b.esAdmin && ['admin', 'rrhh'].includes(req.user.role)) ? 'admin' : (b.role || 'employee')), JSON.stringify(data)]
    );
    if (b.puestoId) { try { await client.query('UPDATE empleados SET puesto_id=$1 WHERE id=$2', [b.puestoId, rows[0].id]); } catch (e) { /* puesto opcional */ } }
    // Capa Personas/Períodos: ligar el empleado a una persona y abrir su período (no rompe el alta si falla).
    try {
      const empId = rows[0].id;
      const cuilN = (cuil || '').trim() || null;
      const apellido = data.apellido || (String(b.nom || '').split(',')[0] || '').trim();
      const nombres = data.nombres || (String(b.nom || '').split(',').slice(1).join(',') || '').trim();
      let pid = null;
      if (cuilN) { const x = await client.query('SELECT id FROM personas WHERE cuil=$1', [cuilN]); if (x.rows[0]) pid = x.rows[0].id; }
      if (!pid) { const x = await client.query("SELECT id FROM personas WHERE dni=$1 AND (cuil IS NULL OR cuil='')", [dni]); if (x.rows[0]) pid = x.rows[0].id; }
      if (!pid) { const x = await client.query("INSERT INTO personas (cuil,dni,apellido,nombres,nom,tipos,data) VALUES ($1,$2,$3,$4,$5,ARRAY['empleado'],$6) RETURNING id", [cuilN, dni, apellido || null, nombres || null, String(b.nom).toUpperCase(), JSON.stringify(data)]); pid = x.rows[0].id; }
      else { await client.query("UPDATE personas SET tipos = ARRAY(SELECT DISTINCT unnest(tipos || ARRAY['empleado'])) WHERE id=$1", [pid]); }
      await client.query('UPDATE empleados SET persona_id=$1 WHERE id=$2', [pid, empId]);
      await client.query('INSERT INTO periodos (persona_id, empleado_id, empresa_id, legajo, fecha_ingreso, funcion, cat_escala, tramo_escala, cat_convenio, cod_convenio, cod_sindicato, vigente) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)',
        [pid, empId, empresaId, legAsignado, b.ingreso || null, data.tarea || null, b.cat || null, b.tramo || null, data.categoria_convenio || null, data.cod_convenio || null, data.cod_sindicato || null]);
    } catch (e) { /* el empleado se creó igual */ }
    const out = await client.query(`${SELECT} WHERE e.id = $1`, [rows[0].id]);
    res.status(201).json(mapRow(out.rows[0]));
  } catch (e) { next(e); } finally { client.release(); }
});

// PUT /api/empleados/:id  (rrhh/admin)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const before = (await query('SELECT nom, email, cuil, ingreso, bruto, neto, cat, tramo, role, activo, data FROM empleados WHERE id=$1', [req.params.id])).rows[0] || {};
    // Tilde "Administrador": marca -> role admin; desmarca -> employee solo si era admin (no pisa manager/rrhh).
    if (b.esAdmin !== undefined && ['admin', 'rrhh'].includes(req.user.role)) {
      if (!b.esAdmin && Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'No podés quitarte el rol admin a vos mismo' });
      const nuevoRol = b.esAdmin ? 'admin' : (before.role === 'admin' ? 'employee' : before.role);
      if (nuevoRol && nuevoRol !== before.role) await query('UPDATE empleados SET role=$1 WHERE id=$2', [nuevoRol, req.params.id]);
    }
    // Columnas núcleo editables (identidad empresa+legajo+dni NO se cambia acá).
    const fields = { nom: b.nom, email: b.email, cat: b.cat, tramo: b.tramo, cuil: b.cuil,
      ingreso: b.ingreso, bruto: b.bruto, neto: b.neto, puesto_id: b.puestoId };
    const sets = [], params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) { params.push(k === 'nom' ? String(v).toUpperCase() : (v === '' ? null : v)); sets.push(`${k} = $${params.length}`); }
    }
    // Resto de campos (domicilio, tarea, sindicato, básico, etc.) → se mergean en data jsonb.
    const exclude = ['empresa', 'legNum', 'leg', 'dni', 'cuil', 'nom', 'email', 'cat', 'tramo', 'ingreso', 'bruto', 'neto', 'role', 'id', 'uid', 'empresaId', 'activo', 'esAlta', 'puestoId', 'puesto_id', 'puesto'];
    const data = {}; for (const k of Object.keys(b)) if (!exclude.includes(k)) data[k] = b[k];
    if (Object.keys(data).length) { params.push(JSON.stringify(data)); sets.push(`data = data || $${params.length}::jsonb`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(req.params.id);
    await query(`UPDATE empleados SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const out = await query(`${SELECT} WHERE e.id = $1`, [req.params.id]);
    if (!out.rows[0]) return res.status(404).json({ error: 'Empleado no encontrado' });
    // Sincronizar período vigente + histórico de función/categoría (solo lo que cambió en esta edición).
    try {
      const aft = out.rows[0]; const bd = before.data || {}; const ad = aft.data || {};
      // Histórico de lugar de trabajo: si cambió, cierro el período abierto y abro uno nuevo.
      try {
        const aLug = bd.lugar == null ? '' : String(bd.lugar).trim();
        const nLug = ad.lugar == null ? '' : String(ad.lugar).trim();
        if (nLug && nLug !== aLug) {
          const hoy = new Date().toISOString().slice(0, 10);
          await query('UPDATE lugar_trabajo_hist SET hasta=$1 WHERE empleado_id=$2 AND hasta IS NULL', [hoy, req.params.id]);
          const cen = (await query('SELECT id FROM centros_operaciones WHERE denominacion=$1 LIMIT 1', [nLug])).rows[0];
          await query('INSERT INTO lugar_trabajo_hist (empleado_id, centro_id, lugar, desde, created_by) VALUES ($1,$2,$3,$4,$5)', [req.params.id, cen?.id || null, nLug, hoy, req.user.dni]);
        }
      } catch (e) { /* no romper el guardado */ }
      const sv = (v) => v == null ? '' : String(v);
      // Histórico general del legajo: registra CUALQUIER cambio de un empleado ACTIVO.
      if (aft.activo) try {
        const svd = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : sv(v);
        const LABELS = { nom: 'Nombre', email: 'E-mail (sistema)', cuil: 'CUIL', ingreso: 'Fecha de ingreso', bruto: 'Bruto', neto: 'Neto', cat: 'Categoría escala', tramo: 'Tramo escala', role: 'Rol',
          tarea: 'Función / Tarea', desc_categoria: 'Descripción de categoría', condicion: 'Condición', categoria_convenio: 'Categoría de convenio', cod_convenio: 'CCT / Convenio', cod_sindicato: 'Afiliación sindical',
          estado_civil: 'Estado civil', sexo: 'Sexo', fecha_nac: 'Fecha de nacimiento', nacionalidad: 'Nacionalidad',
          email_laboral: 'Mail laboral', email_personal: 'Mail personal', tel_laboral: 'Teléfono laboral', tel_personal: 'Teléfono personal',
          contacto_nombre: 'Contacto emergencia — nombre', contacto_tel: 'Contacto emergencia — teléfono', contacto_vinculo: 'Contacto emergencia — vínculo',
          basico: 'Básico', sueldo: 'Sueldo', complemento: 'Complemento', norem: 'No remunerativo', antiguedad_monto: 'Adicional antigüedad',
          os_codigo: 'Obra social (cód.)', os_nombre: 'Obra social', cod_os: 'Obra social (cód.)', desc_os: 'Obra social', adicionalPresentismo: 'Adicional presentismo' };
        const dom = (d) => [d.dom_calle, d.dom_nro, d.dom_piso ? 'Piso ' + d.dom_piso : '', d.dom_depto ? 'Dto ' + d.dom_depto : '', d.dom_torre, d.dom_bloque, d.dom_loc, d.dom_prov, d.dom_cp].filter(Boolean).join(' ');
        const cambios = [];
        for (const k of ['nom', 'email', 'cuil', 'ingreso', 'bruto', 'neto', 'cat', 'tramo', 'role']) {
          if (svd(before[k]) !== svd(aft[k])) cambios.push([LABELS[k] || k, svd(before[k]), svd(aft[k])]);
        }
        if (dom(bd) !== dom(ad)) cambios.push(['Domicilio', dom(bd), dom(ad)]);
        const omit = new Set(['lugar', 'foto', 'modulosOcultos', 'comite_hys', 'centroCodigo', 'centroId']);
        for (const k of new Set([...Object.keys(bd), ...Object.keys(ad)])) {
          if (k.startsWith('dom_') || omit.has(k)) continue;
          if (bd[k] !== null && typeof bd[k] === 'object') continue;
          if (ad[k] !== null && typeof ad[k] === 'object') continue;
          if (sv(bd[k]) !== sv(ad[k])) cambios.push([LABELS[k] || k, sv(bd[k]), sv(ad[k])]);
        }
        for (const [etq, antv, newv] of cambios) {
          await query('INSERT INTO legajo_cambios (empleado_id, campo, etiqueta, valor_anterior, valor_nuevo, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [req.params.id, etq, etq, antv || null, newv || null, req.user.dni]);
        }
      } catch (e) { /* no romper el guardado */ }
      const map = [
        ['funcion', 'Función', sv(bd.tarea), sv(ad.tarea)],
        ['cat_escala', 'Categoría escala', sv(before.cat), sv(aft.cat)],
        ['tramo_escala', 'Tramo escala', sv(before.tramo), sv(aft.tramo)],
        ['cat_convenio', 'Categoría convenio', sv(bd.categoria_convenio), sv(ad.categoria_convenio)],
        ['cod_convenio', 'Convenio', sv(bd.cod_convenio), sv(ad.cod_convenio)],
        ['cod_sindicato', 'Sindicato', sv(bd.cod_sindicato), sv(ad.cod_sindicato)],
      ].filter((x) => x[2] !== x[3]);
      if (map.length) {
        const per = (await query('SELECT id FROM periodos WHERE empleado_id=$1 AND vigente=true ORDER BY id DESC LIMIT 1', [req.params.id])).rows[0];
        if (per) {
          const sets2 = [], p2 = [];
          for (const [col, lbl, antv, newv] of map) {
            await query('INSERT INTO periodo_cambios (periodo_id, campo, etiqueta, valor_anterior, valor_nuevo, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [per.id, col, lbl, antv || null, newv || null, req.user.dni]);
            p2.push(newv || null); sets2.push(`${col}=$${p2.length}`);
          }
          p2.push(per.id); await query(`UPDATE periodos SET ${sets2.join(', ')}, updated_at=now() WHERE id=$${p2.length}`, p2);
        }
      }
    } catch (e) { /* no romper el guardado */ }
    res.json(mapRow(out.rows[0]));
  } catch (e) { next(e); }
});

// PATCH /api/empleados/:id/activo  (rrhh/admin) — baja/alta lógica
router.patch('/:id/activo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const activo = !!(req.body || {}).activo;
    await query('UPDATE empleados SET activo = $1 WHERE id = $2', [activo, req.params.id]);
    try { await query('UPDATE periodos SET vigente=$1, updated_at=now() WHERE empleado_id=$2', [activo, req.params.id]); } catch (e) { /* período opcional */ }
    res.json({ ok: true, activo });
  } catch (e) { next(e); }
});

// POST /api/empleados/:id/baja (rrhh/admin) — registra el cese y deja inactivo al empleado
router.post('/:id/baja', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.fechaBaja || !b.causa) return res.status(400).json({ error: 'Fecha de baja y causa son obligatorias' });
    await query(
      `INSERT INTO bajas (empleado_id, fecha_baja, causa, fecha_notificacion, preaviso_override, gratificacion, gratif_cuotas, observaciones, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [req.params.id, b.fechaBaja, b.causa, b.fechaNotificacion || null, b.preavisoOverride || null,
       Number(b.gratificacion) || 0, JSON.stringify(b.gratifCuotas || []), b.observaciones || null, req.user.dni]);
    await query('UPDATE empleados SET activo = false WHERE id = $1', [req.params.id]);
    try { await query('UPDATE periodos SET vigente=false, fecha_egreso=$1, causa_egreso=$2, updated_at=now() WHERE empleado_id=$3 AND vigente=true', [b.fechaBaja, b.causa, req.params.id]); } catch (e) { /* período opcional */ }
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/empleados/:id/baja — datos del cese (último), para prefill de la liquidación final
router.get('/:id/baja', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM bajas WHERE empleado_id=$1 ORDER BY created_at DESC LIMIT 1', [req.params.id]);
    res.json(rows[0] || null);
  } catch (e) { next(e); }
});

// PUT /api/empleados/:id/baja — editar el cese (p.ej. actualizar cuotas de la gratificación)
router.put('/:id/baja', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const cur = (await query('SELECT id FROM bajas WHERE empleado_id=$1 ORDER BY created_at DESC LIMIT 1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'No hay baja registrada' });
    await query(
      `UPDATE bajas SET fecha_baja=$1, causa=$2, fecha_notificacion=$3, preaviso_override=$4, gratificacion=$5, gratif_cuotas=$6, observaciones=$7 WHERE id=$8`,
      [b.fechaBaja, b.causa, b.fechaNotificacion || null, b.preavisoOverride || null,
       Number(b.gratificacion) || 0, JSON.stringify(b.gratifCuotas || []), b.observaciones || null, cur.id]);
    res.json({ ok: true });
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
    // Cruce tolerante por nombre: ignora mayúsculas, puntos y espacios
    // ("IDEE S.R.L." == "IDEE SRL" == "idee s.r.l.").
    const empresaId = Object.fromEntries(empresasDb.rows.map((r) => [empSlug(r.nombre), r.id]));
    const empresasNombres = empresasDb.rows.map((r) => r.nombre).join(', ');

    let ok = 0, dup = 0, err = 0; const errores = [];
    for (const r of rows) {
      const legNum = String(r['Legajo'] || '').trim().padStart(6, '0');
      const empresa = String(r['Empresa'] || '').trim();
      const cuil = String(r['CUIL'] || '').trim();
      let dni = String(r['DNI'] || '').trim();
      if (!dni && cuil) dni = dniFromCuil(cuil);
      const apellido = String(r['Apellido'] || '').trim();
      const nombres = String(r['Nombres'] || '').trim();
      const nom = (apellido || nombres) ? [apellido, nombres].filter(Boolean).join(', ').toUpperCase() : String(r['Apellido y Nombre'] || '').trim().toUpperCase();
      const ing = String(r['Fecha Ingreso'] || '').trim();
      if (!legNum || !dni || !cuil || !nom || !empresa) { errores.push(`Legajo ${legNum || '?'}: faltan campos obligatorios`); err++; continue; }
      const eid = empresaId[empSlug(empresa)];
      if (!eid) { errores.push(`Legajo ${legNum}: empresa "${empresa}" no existe en el portal (empresas: ${empresasNombres})`); err++; continue; }
      const uid = makeUid(empresa, legNum);
      if (uidSet.has(uid)) { errores.push(`Legajo ${legNum} en ${empresa}: ya existe`); dup++; continue; }
      if (dniSet.has(dni)) { errores.push(`DNI ${dni} (${nom}): ya existe`); dup++; continue; }
      const ingISO = (() => { const m = ing.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}$/.test(ing) ? ing : null); })();
      // Tolerante a variantes de nombres de columna (plantilla propia o export Pro-Soft/IDEE).
      const cat = String(r['Categoría'] || r['Categoría Unif.'] || r['Desc. Categoría'] || '').toUpperCase() || null;
      const tramo = (r['Tramo'] || '').toUpperCase() || null;
      const data = {
        apellido: apellido || null, nombres: nombres || null,
        fecha_nac: r['Fecha Nacimiento'] || r['Fecha Nac.'] || '', sexo: r['Sexo'] || '', estado_civil: r['Estado Civil'] || '', nacionalidad: r['Nacionalidad'] || '',
        lugar: r['Ubicación'] || r['Lugar'] || '', tarea: r['Tarea'] || r['Función'] || r['Funcion'] || '', desc_categoria: r['Descripción de categoría'] || '',
        cod_convenio: r['Convenio'] || r['CCT'] || r['Código de convenio'] || '', categoria_convenio: r['Categoría de convenio'] || '', cod_sindicato: r['Sindicato'] || r['Código de sindicato'] || '',
        condicion: r['Condición'] || '', nivelTitulo: r['Nivel de título'] || r['Nivel Título'] || '',
        email_laboral: r['Mail laboral'] || '', email_personal: r['Mail personal'] || '',
        tel_laboral: r['Teléfono laboral'] || '', tel_personal: r['Teléfono personal'] || '',
        contacto_nombre: r['Contacto emergencia nombre'] || '', contacto_tel: r['Contacto emergencia teléfono'] || '', contacto_vinculo: r['Contacto emergencia vínculo'] || '',
        dom_calle: r['Domicilio Calle'] || r['Calle'] || '', dom_nro: r['Número'] || '', dom_piso: r['Piso'] || '', dom_depto: r['Depto'] || '',
        dom_loc: r['Localidad'] || '', dom_prov: r['Provincia'] || '', dom_cp: r['Código Postal'] || '',
      };
      const osCod = String(r['Obra Social'] || r['Obra Social (RNOS)'] || '').trim();
      if (osCod) { data.os_codigo = osCod; data.codigoObraSocial = osCod.replace(/\D/g, '').slice(-6); }
      const insE = await client.query(
        `INSERT INTO empleados (empresa_id, leg_num, dni, cuil, nom, email, cat, tramo, ingreso, bruto, neto, es_alta, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) RETURNING id`,
        [eid, legNum, dni, cuil, nom, r['E-mail'] || r['E-mail (sistema)'] || null, cat, tramo, ingISO,
         parseFloat(r['Sueldo Bruto'] || r['Sueldo']) || 0,
         parseFloat(r['Sueldo Neto'] || r['Sueldo']) || 0, JSON.stringify(data)]
      );
      // Capa Personas/Períodos (idempotente por CUIL/DNI).
      try {
        const empId = insE.rows[0].id;
        let pid = null;
        if (cuil) { const x = await client.query('SELECT id FROM personas WHERE cuil=$1', [cuil]); if (x.rows[0]) pid = x.rows[0].id; }
        if (!pid) { const x = await client.query("SELECT id FROM personas WHERE dni=$1 AND (cuil IS NULL OR cuil='')", [dni]); if (x.rows[0]) pid = x.rows[0].id; }
        if (!pid) { const x = await client.query("INSERT INTO personas (cuil,dni,apellido,nombres,nom,tipos,data) VALUES ($1,$2,$3,$4,$5,ARRAY['empleado'],$6) RETURNING id", [cuil || null, dni, apellido || null, nombres || null, nom, JSON.stringify(data)]); pid = x.rows[0].id; }
        else { await client.query("UPDATE personas SET tipos = ARRAY(SELECT DISTINCT unnest(tipos || ARRAY['empleado'])) WHERE id=$1", [pid]); }
        await client.query('UPDATE empleados SET persona_id=$1 WHERE id=$2', [pid, empId]);
        await client.query('INSERT INTO periodos (persona_id, empleado_id, empresa_id, legajo, fecha_ingreso, funcion, cat_escala, tramo_escala, cat_convenio, cod_convenio, cod_sindicato, vigente) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)', [pid, empId, eid, legNum, ingISO, data.tarea || null, cat, tramo, data.categoria_convenio || null, data.cod_convenio || null, data.cod_sindicato || null]);
      } catch (e) { /* el empleado se importó igual */ }
      uidSet.add(uid); dniSet.add(dni); ok++;
    }
    await client.query('COMMIT');
    res.json({ ok, dup, err, errores, mensaje: ok > 0
      ? `Importación realizada con éxito — ${ok} empleado(s) cargado(s)${dup || err ? ` (${dup} duplicado(s), ${err} con error)` : ''}`
      : `No se importó ningún empleado${dup ? `: ${dup} ya existían` : ''}${err ? `: ${err} con error` : ''}` });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

export default router;
