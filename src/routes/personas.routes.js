// Capa 1: Personas (familiares, prestadores, postulantes, empleados…) + Capa 2: Períodos.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('rrhh', 'admin'));

const mapPersona = (r) => ({
  id: r.id, cuil: r.cuil, dni: r.dni, apellido: r.apellido, nombres: r.nombres, nom: r.nom,
  tipos: r.tipos || [], data: r.data || {}, empleadoActivo: !!r.empleado_activo, nPeriodos: r.n_periodos != null ? Number(r.n_periodos) : undefined,
  accesoComite: r.acceso_comite || null, tieneClave: !!r.password_hash,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const mapPeriodo = (r) => ({
  id: r.id, personaId: r.persona_id, empleadoId: r.empleado_id, empresaId: r.empresa_id, empresa: r.empresa,
  legajo: r.legajo, fechaIngreso: r.fecha_ingreso, fechaEgreso: r.fecha_egreso, causaEgreso: r.causa_egreso,
  funcion: r.funcion, catEscala: r.cat_escala, tramoEscala: r.tramo_escala, catConvenio: r.cat_convenio,
  codConvenio: r.cod_convenio, codSindicato: r.cod_sindicato, vigente: r.vigente, createdAt: r.created_at,
});

const nomDe = (b) => [String(b.apellido || '').trim(), String(b.nombres || '').trim()].filter(Boolean).join(', ').toUpperCase() || (b.nom || null);

router.get('/', async (req, res, next) => {
  try {
    const { tipo, q } = req.query; const cond = [], p = [];
    if (tipo) { p.push(tipo); cond.push(`$${p.length} = ANY(p.tipos)`); }
    if (q) { p.push(`%${String(q).toLowerCase()}%`); const i = p.length; cond.push(`(lower(p.nom) LIKE $${i} OR p.dni LIKE $${i} OR COALESCE(p.cuil,'') LIKE $${i})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT p.*, EXISTS(SELECT 1 FROM empleados e WHERE e.persona_id=p.id AND e.activo) AS empleado_activo,
              (SELECT count(*)::int FROM periodos pe WHERE pe.persona_id=p.id) AS n_periodos
         FROM personas p ${where} ORDER BY p.nom ASC NULLS LAST, p.id DESC LIMIT 500`, p);
    res.json(rows.map(mapPersona));
  } catch (e) { next(e); }
});

router.get('/_empresas', async (req, res, next) => {
  try { const { rows } = await query('SELECT nombre FROM empresas ORDER BY nombre'); res.json(rows.map((r) => r.nombre)); }
  catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const pr = await query('SELECT * FROM personas WHERE id=$1', [req.params.id]);
    if (!pr.rows[0]) return res.status(404).json({ error: 'Persona no encontrada' });
    const per = await query(
      `SELECT pe.*, em.nombre AS empresa FROM periodos pe LEFT JOIN empresas em ON em.id=pe.empresa_id
        WHERE pe.persona_id=$1 ORDER BY pe.vigente DESC, pe.fecha_ingreso DESC NULLS LAST, pe.id DESC`, [req.params.id]);
    res.json({ ...mapPersona(pr.rows[0]), periodos: per.rows.map(mapPeriodo) });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const dni = String(b.dni || '').trim() || null;
    const cuil = String(b.cuil || '').trim() || null;
    if (!dni && !cuil && !b.apellido && !b.nombres && !b.nom) return res.status(400).json({ error: 'Cargá al menos un nombre o documento' });
    const tipos = Array.isArray(b.tipos) ? b.tipos : (b.tipo ? [b.tipo] : []);
    const core = ['dni', 'cuil', 'apellido', 'nombres', 'nom', 'tipos', 'tipo'];
    const data = {}; for (const k of Object.keys(b)) if (!core.includes(k)) data[k] = b[k];
    const { rows } = await query(
      `INSERT INTO personas (cuil, dni, apellido, nombres, nom, tipos, data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cuil, dni, b.apellido || null, b.nombres || null, nomDe(b), tipos, JSON.stringify(data), req.user.dni]);
    res.status(201).json(mapPersona(rows[0]));
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'Ya existe una persona con ese CUIL' });
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const cur = (await query('SELECT data FROM personas WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Persona no encontrada' });
    const tipos = Array.isArray(b.tipos) ? b.tipos : undefined;
    const core = ['dni', 'cuil', 'apellido', 'nombres', 'nom', 'tipos', 'tipo', 'id'];
    const data = {}; for (const k of Object.keys(b)) if (!core.includes(k)) data[k] = b[k];
    const sets = ['dni=$1', 'cuil=$2', 'apellido=$3', 'nombres=$4', 'nom=$5', 'updated_at=now()'];
    const params = [String(b.dni || '').trim(), String(b.cuil || '').trim() || null, b.apellido || null, b.nombres || null, nomDe(b)];
    if (tipos) { params.push(tipos); sets.push(`tipos=$${params.length}`); }
    if (Object.keys(data).length) { params.push(JSON.stringify(data)); sets.push(`data = data || $${params.length}::jsonb`); }
    params.push(req.params.id);
    const r = await query(`UPDATE personas SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    res.json(mapPersona(r.rows[0]));
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'Ya existe una persona con ese CUIL' });
    next(e);
  }
});

// Habilitar/cambiar/quitar acceso al Comité de HyS para una persona (login por DNI).
router.post('/:id/acceso-comite', async (req, res, next) => {
  try {
    const acceso = (req.body && req.body.acceso) || null; // 'dashboard' | 'full' | null
    if (acceso && !['dashboard', 'full'].includes(acceso)) return res.status(400).json({ error: 'Acceso inválido' });
    const per = (await query('SELECT id, dni, password_hash FROM personas WHERE id=$1', [req.params.id])).rows[0];
    if (!per) return res.status(404).json({ error: 'Persona no encontrada' });
    let claveInicial;
    if (acceso && !per.password_hash) {
      if (!per.dni) return res.status(400).json({ error: 'La persona necesita DNI para habilitar el acceso' });
      const hash = await bcrypt.hash(String(per.dni), config.bcryptRounds);
      await query('UPDATE personas SET acceso_comite=$1, password_hash=$2, must_change_pwd=true, disabled=false WHERE id=$3', [acceso, hash, per.id]);
      claveInicial = String(per.dni);
    } else {
      await query('UPDATE personas SET acceso_comite=$1 WHERE id=$2', [acceso, per.id]);
    }
    res.json({ ok: true, acceso, claveInicial });
  } catch (e) { next(e); }
});

// Histórico de cambios de un período (función/categoría).
router.get('/periodos/:id/cambios', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, campo, etiqueta, valor_anterior, valor_nuevo, fecha, motivo, created_by, created_at FROM periodo_cambios WHERE periodo_id=$1 ORDER BY created_at DESC', [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Ascender una persona a empleado: crea el empleado (legajo automático) + período vigente.
router.post('/:id/ascender', async (req, res, next) => {
  try {
    const empresa = String((req.body && req.body.empresa) || '').trim();
    if (!empresa) return res.status(400).json({ error: 'La empresa es obligatoria' });
    const per = (await query('SELECT * FROM personas WHERE id=$1', [req.params.id])).rows[0];
    if (!per) return res.status(404).json({ error: 'Persona no encontrada' });
    if (!per.dni) return res.status(400).json({ error: 'La persona necesita DNI para darse de alta como empleado' });
    const er = await query('SELECT id FROM empresas WHERE nombre=$1', [empresa]);
    if (!er.rows[0]) return res.status(400).json({ error: 'Empresa no encontrada' });
    const empresaId = er.rows[0].id;
    const lg = await query("SELECT COALESCE(MAX(NULLIF(regexp_replace(leg_num,'\\D','','g'),'')::int),0)+1 AS n FROM empleados WHERE empresa_id=$1", [empresaId]);
    const legajo = String(lg.rows[0].n).padStart(6, '0');
    const nom = per.nom || [per.apellido, per.nombres].filter(Boolean).join(', ').toUpperCase();
    const ins = await query(
      `INSERT INTO empleados (empresa_id, leg_num, dni, cuil, nom, es_alta, role, persona_id, data)
       VALUES ($1,$2,$3,$4,$5,true,'employee',$6,$7) RETURNING id`,
      [empresaId, legajo, per.dni, per.cuil || null, nom, per.id, JSON.stringify(per.data || {})]);
    const empId = ins.rows[0].id;
    await query("UPDATE personas SET tipos = ARRAY(SELECT DISTINCT unnest(tipos || ARRAY['empleado'])) WHERE id=$1", [per.id]);
    await query('INSERT INTO periodos (persona_id, empleado_id, empresa_id, legajo, fecha_ingreso, vigente) VALUES ($1,$2,$3,$4,CURRENT_DATE,true)', [per.id, empId, empresaId, legajo]);
    res.status(201).json({ ok: true, empleadoId: empId, legajo, empresa });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'Ya existe un empleado con ese DNI (la persona ya es empleado).' });
    next(e);
  }
});

// Editar un período (función/categoría/fechas). Registra cada cambio en periodo_cambios
// y, si es el período vigente ligado a un empleado, sincroniza categoría/función al empleado.
router.put('/periodos/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const cur = (await query('SELECT * FROM periodos WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Período no encontrado' });
    const sv = (v) => v == null ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
    const campos = [
      ['funcion', 'Función', b.funcion], ['cat_escala', 'Categoría escala', b.catEscala], ['tramo_escala', 'Tramo escala', b.tramoEscala],
      ['cat_convenio', 'Categoría convenio', b.catConvenio], ['cod_convenio', 'Convenio', b.codConvenio], ['cod_sindicato', 'Sindicato', b.codSindicato],
      ['fecha_ingreso', 'Fecha de ingreso', b.fechaIngreso], ['fecha_egreso', 'Fecha de egreso', b.fechaEgreso], ['causa_egreso', 'Causa de egreso', b.causaEgreso],
    ];
    const sets = ['updated_at=now()']; const params = []; const cambios = [];
    for (const [col, lbl, val] of campos) {
      if (val === undefined) continue;
      const nuevo = (val === null || String(val).trim() === '') ? null : String(val).trim();
      params.push(nuevo); sets.push(`${col}=$${params.length}`);
      if (sv(nuevo) !== sv(cur[col])) cambios.push({ col, lbl, ant: sv(cur[col]), nuevo: sv(nuevo) });
    }
    if (b.vigente !== undefined) { params.push(!!b.vigente); sets.push(`vigente=$${params.length}`); }
    params.push(req.params.id);
    await query(`UPDATE periodos SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    for (const c of cambios) {
      await query('INSERT INTO periodo_cambios (periodo_id, campo, etiqueta, valor_anterior, valor_nuevo, motivo, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [cur.id, c.col, c.lbl, c.ant || null, c.nuevo || null, b.motivo || null, req.user.dni]);
    }
    const vigente = b.vigente === undefined ? cur.vigente : !!b.vigente;
    if (cur.empleado_id && vigente) {
      const sets2 = []; const p2 = [];
      if (b.catEscala !== undefined) { p2.push(b.catEscala || null); sets2.push(`cat=$${p2.length}`); }
      if (b.tramoEscala !== undefined) { p2.push(b.tramoEscala || null); sets2.push(`tramo=$${p2.length}`); }
      const dp = {};
      if (b.funcion !== undefined) dp.tarea = b.funcion || null;
      if (b.catConvenio !== undefined) dp.categoria_convenio = b.catConvenio || null;
      if (b.codConvenio !== undefined) dp.cod_convenio = b.codConvenio || null;
      if (b.codSindicato !== undefined) dp.cod_sindicato = b.codSindicato || null;
      if (Object.keys(dp).length) { p2.push(JSON.stringify(dp)); sets2.push(`data = data || $${p2.length}::jsonb`); }
      if (sets2.length) { p2.push(cur.empleado_id); await query(`UPDATE empleados SET ${sets2.join(', ')} WHERE id=$${p2.length}`, p2); }
    }
    res.json({ ok: true, cambios: cambios.length });
  } catch (e) { next(e); }
});

export default router;
