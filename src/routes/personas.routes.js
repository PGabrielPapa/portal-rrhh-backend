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
    const dni = String(b.dni || '').trim();
    if (!dni) return res.status(400).json({ error: 'El DNI es obligatorio' });
    const cuil = String(b.cuil || '').trim() || null;
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
      await query('UPDATE personas SET acceso_comite=$1, password_hash=$2, must_change_pwd=false, disabled=false WHERE id=$3', [acceso, hash, per.id]);
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

export default router;
