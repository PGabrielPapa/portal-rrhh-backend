import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Código automático correlativo (P001, P002…) cuando no se informa uno.
async function nextCodigo() {
  const { rows } = await query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(codigo,'\\D','','g'),'')::int),0)+1 AS n FROM puestos`);
  return 'P' + String(rows[0].n).padStart(3, '0');
}

// GET /api/puestos — lista para el ABM y los desplegables (todos los roles).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id, p.codigo, p.nombre, p.area, p.reporta_a, p.go_to_hr, p.orden, p.perfil,
              r.nombre AS reporta_nombre,
              (SELECT count(*)::int FROM empleados e WHERE e.puesto_id = p.id AND e.activo) AS ocupantes
         FROM puestos p LEFT JOIN puestos r ON r.id = p.reporta_a
        ORDER BY p.nombre`);
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/puestos/sin-asignar — empleados activos sin puesto (caen al fallback por nombre).
router.get('/sin-asignar', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.nom, e.leg_num, em.nombre AS empresa
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id
        WHERE e.activo = true AND e.puesto_id IS NULL
        ORDER BY em.nombre, e.nom`);
    res.json(rows.map((r) => ({ id: r.id, nom: r.nom, legNum: r.leg_num, empresa: r.empresa })));
  } catch (e) { next(e); }
});

// GET /api/puestos/organigrama?empresa= — árbol armado por PUESTO.
router.get('/organigrama', async (req, res, next) => {
  try {
    const filtro = String(req.query.empresa || '').trim().toUpperCase();
    const puestos = (await query('SELECT id, codigo, nombre, area, reporta_a, go_to_hr FROM puestos')).rows;
    const emps = (await query(
      `SELECT e.id, e.nom, e.leg_num, e.cat, e.tramo, e.puesto_id, em.nombre AS empresa, e.data
         FROM empleados e JOIN empresas em ON em.id = e.empresa_id
        WHERE e.activo = true`)).rows;

    const empresas = [...new Set(emps.map((e) => e.empresa).filter(Boolean))].sort();
    const ocupanteDTO = (e) => {
      const d = e.data || {};
      // No se exponen categoría ni tramo (insinúan banda salarial); el organigrama es visible a todos.
      return { id: e.id, nom: e.nom, legNum: e.leg_num, empresa: e.empresa,
        lugar: d.lugar || '', tarea: d.tarea || d.desc_categoria || '', foto: d.foto || '' };
    };
    const pasa = (e) => !filtro || String(e.empresa || '').toUpperCase() === filtro;

    const nodo = {};
    for (const p of puestos) nodo[p.id] = { id: p.id, codigo: p.codigo, nombre: p.nombre, area: p.area || '', goToHr: p.go_to_hr, ocupantes: [], hijos: [], totalRecursivo: 0 };

    // Ocupantes por puesto + acumular no asignados.
    const sinPuesto = [];
    for (const e of emps) {
      if (!pasa(e)) continue;
      if (e.puesto_id != null && nodo[e.puesto_id]) nodo[e.puesto_id].ocupantes.push(ocupanteDTO(e));
      else sinPuesto.push(ocupanteDTO(e));
    }

    // Jerarquía por reporta_a.
    const raices = [];
    for (const p of puestos) {
      if (p.reporta_a != null && nodo[p.reporta_a]) nodo[p.reporta_a].hijos.push(nodo[p.id]);
      else raices.push(nodo[p.id]);
    }

    // Total recursivo de personas (con guarda de ciclos).
    const totalDe = (n, vis) => {
      if (vis.has(n.id)) return 0;
      vis.add(n.id);
      let t = n.ocupantes.length;
      for (const h of n.hijos) t += totalDe(h, vis);
      n.totalRecursivo = t;
      return t;
    };
    for (const r of raices) totalDe(r, new Set());
    const ordenar = (n) => { n.hijos.sort((a, b) => b.totalRecursivo - a.totalRecursivo); n.hijos.forEach(ordenar); };
    raices.forEach(ordenar);
    raices.sort((a, b) => b.totalRecursivo - a.totalRecursivo);

    if (sinPuesto.length) raices.push({ id: 0, codigo: '—', nombre: 'Sin puesto asignado', area: 'Pendiente de asignación en el legajo', goToHr: true, ocupantes: sinPuesto, hijos: [], totalRecursivo: sinPuesto.length });

    const totalEmpleados = emps.filter(pasa).length;
    res.json({ raices, empresas, totalEmpleados, totalPuestos: puestos.length });
  } catch (e) { next(e); }
});

// POST /api/puestos (rrhh/admin)
router.post('/', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre del puesto es obligatorio' });
    const cod = (b.codigo && String(b.codigo).trim()) || await nextCodigo();
    const r = await query(
      'INSERT INTO puestos (codigo, nombre, area, reporta_a, go_to_hr) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [cod, String(b.nombre).trim(), b.area || null, b.reportaA || null, !!b.goToHr]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un puesto con ese código' });
    next(e);
  }
});

// PUT /api/puestos/:id (rrhh/admin)
router.put('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: 'El nombre del puesto es obligatorio' });
    if (String(b.reportaA) === String(req.params.id)) return res.status(400).json({ error: 'Un puesto no puede reportarse a sí mismo' });
    if (b.reportaA) {
      // Evitar ciclos: reportaA no puede ser el propio puesto ni un descendiente suyo.
      const parent = {}; for (const p of (await query('SELECT id, reporta_a FROM puestos')).rows) parent[p.id] = p.reporta_a;
      let cur = Number(b.reportaA), guard = 0;
      while (cur != null && guard++ < 1000) { if (String(cur) === String(req.params.id)) return res.status(400).json({ error: 'Ese puesto no puede reportar a uno que depende de él (se generaría un ciclo).' }); cur = parent[cur]; }
    }
    const r = await query(
      'UPDATE puestos SET codigo=$1, nombre=$2, area=$3, reporta_a=$4, go_to_hr=$5 WHERE id=$6 RETURNING id',
      [b.codigo || null, String(b.nombre).trim(), b.area || null, b.reportaA || null, !!b.goToHr, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Puesto no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un puesto con ese código' });
    next(e);
  }
});

// DELETE /api/puestos/:id (rrhh/admin) — los hijos y ocupantes quedan sin puesto (FK ON DELETE SET NULL).
router.delete('/:id', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const r = await query('DELETE FROM puestos WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Puesto no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/puestos/:id/perfil — descripción del puesto.
router.get('/:id/perfil', async (req, res, next) => {
  try {
    const r = (await query('SELECT perfil FROM puestos WHERE id=$1', [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Puesto no encontrado' });
    res.json(r.perfil || {});
  } catch (e) { next(e); }
});

// PUT /api/puestos/:id/perfil (rrhh/admin) — guarda la descripción del puesto.
router.put('/:id/perfil', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const perfil = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const r = await query('UPDATE puestos SET perfil=$1::jsonb WHERE id=$2 RETURNING id', [JSON.stringify(perfil), req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Puesto no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
