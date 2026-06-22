import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import multer from 'multer';

const router = Router();
router.use(requireAuth);
const gestor = (r) => ['rrhh', 'admin', 'manager'].includes(r);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const TIPOS_CAP = [
  { codigo: 'INDUCCION', nombre: 'Inducción inicial al puesto', obligatorio: true, vigencia_meses: null },
  { codigo: 'EPP', nombre: 'Uso correcto de EPP', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'CARGAS', nombre: 'Manejo manual de cargas', obligatorio: true, vigencia_meses: 24 },
  { codigo: 'INCENDIOS', nombre: 'Prevención y lucha contra incendios', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'EMERGENCIAS', nombre: 'Plan de emergencias y evacuación', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'PRIMEROS_AUX', nombre: 'Primeros auxilios y RCP', obligatorio: false, vigencia_meses: 24 },
  { codigo: 'ELECTRICO', nombre: 'Riesgo eléctrico', obligatorio: true, vigencia_meses: 24 },
  { codigo: 'ALTURA', nombre: 'Trabajo en altura', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'ESPACIOS', nombre: 'Trabajo en espacios confinados', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'QUIMICOS', nombre: 'Manipulación de productos químicos', obligatorio: true, vigencia_meses: 24 },
  { codigo: 'AUTOELEVADOR', nombre: 'Manejo de autoelevador / montacargas', obligatorio: true, vigencia_meses: 12 },
  { codigo: 'ERGONOMIA', nombre: 'Ergonomía y posturas de trabajo', obligatorio: false, vigencia_meses: 24 },
  { codigo: 'VIAL', nombre: 'Seguridad vial / manejo defensivo', obligatorio: false, vigencia_meses: 24 },
  { codigo: 'SOLDADURA', nombre: 'Soldadura y oxicorte', obligatorio: true, vigencia_meses: 24 },
  { codigo: 'RUIDO', nombre: 'Exposición a ruido', obligatorio: false, vigencia_meses: 24 },
];
const EPP = [
  ['CASCO', 'Casco de seguridad', 'Cabeza'], ['ANTEOJOS', 'Anteojos / antiparras', 'Ojos'], ['TAPONES', 'Tapones auditivos', 'Oídos'],
  ['AURICULARES', 'Protección auditiva tipo copa', 'Oídos'], ['BARBIJO', 'Barbijo / mascarilla', 'Vías resp.'], ['SEMIMASCARA', 'Semimáscara con filtros', 'Vías resp.'],
  ['GUANTES', 'Guantes', 'Manos'], ['GUANTES_DIEL', 'Guantes dieléctricos', 'Manos'], ['BOTINES', 'Calzado de seguridad', 'Pies'], ['BOTAS', 'Botas de goma', 'Pies'],
  ['PANTALON', 'Pantalón de trabajo', 'Cuerpo'], ['CAMISA', 'Camisa de trabajo', 'Cuerpo'], ['REMERA', 'Remera de trabajo', 'Cuerpo'], ['BUZO', 'Buzo / pulóver', 'Cuerpo'],
  ['CAMPERA', 'Campera de trabajo', 'Cuerpo'], ['CHALECO', 'Chaleco refractario', 'Cuerpo'], ['IMPERMEABLE', 'Equipo impermeable', 'Cuerpo'], ['ARNES', 'Arnés de seguridad', 'Altura'],
].map(([codigo, nombre, categoria]) => ({ codigo, nombre, categoria }));

// Talles a cargar por empleado (Res. SRT 299/2011 — constancia de entrega de EPP por talle).
const TALLES = [
  { codigo: 'calzado', nombre: 'Calzado de seguridad' },
  { codigo: 'pantalon', nombre: 'Pantalón' },
  { codigo: 'camisa', nombre: 'Camisa / remera' },
  { codigo: 'campera', nombre: 'Campera / buzo' },
  { codigo: 'casco', nombre: 'Casco' },
  { codigo: 'guantes', nombre: 'Guantes' },
];

// Catálogo editable en DB (se siembra con los defaults la primera vez).
async function ensureCatalogo() {
  const r = await query('SELECT count(*)::int AS n FROM hys_catalogo');
  if (r.rows[0].n > 0) return;
  for (const c of TIPOS_CAP) await query(`INSERT INTO hys_catalogo (tipo,codigo,nombre,extra) VALUES ('capacitacion',$1,$2,$3) ON CONFLICT DO NOTHING`, [c.codigo, c.nombre, JSON.stringify({ obligatorio: c.obligatorio, vigencia_meses: c.vigencia_meses })]);
  for (const c of EPP) await query(`INSERT INTO hys_catalogo (tipo,codigo,nombre,extra) VALUES ('epp',$1,$2,$3) ON CONFLICT DO NOTHING`, [c.codigo, c.nombre, JSON.stringify({ categoria: c.categoria })]);
  for (const c of TALLES) await query(`INSERT INTO hys_catalogo (tipo,codigo,nombre) VALUES ('talle',$1,$2) ON CONFLICT DO NOTHING`, [c.codigo, c.nombre]);
}
async function leerCatalogos() {
  await ensureCatalogo();
  const { rows } = await query('SELECT tipo, codigo, nombre, extra FROM hys_catalogo WHERE activo ORDER BY tipo, nombre');
  const capacitaciones = [], epp = [], talles = [];
  for (const r of rows) {
    if (r.tipo === 'capacitacion') capacitaciones.push({ codigo: r.codigo, nombre: r.nombre, obligatorio: !!(r.extra && r.extra.obligatorio), vigencia_meses: (r.extra && r.extra.vigencia_meses != null) ? r.extra.vigencia_meses : null });
    else if (r.tipo === 'epp') epp.push({ codigo: r.codigo, nombre: r.nombre, categoria: (r.extra && r.extra.categoria) || '' });
    else if (r.tipo === 'talle') talles.push({ codigo: r.codigo, nombre: r.nombre });
  }
  return { capacitaciones, epp, talles };
}
router.get('/catalogos', async (req, res, next) => { try { res.json(await leerCatalogos()); } catch (e) { next(e); } });

// Importar catálogo (Excel/CSV parseado en el front → filas). tipo: capacitacion|epp|talle
router.post('/catalogo/import', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try {
    const { tipo, rows } = req.body || {};
    if (!['capacitacion', 'epp', 'talle'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows requerido' });
    await ensureCatalogo();
    let n = 0;
    for (const r of rows) {
      const nombre = String(r.nombre || r.Nombre || r.descripcion || r.Descripcion || '').trim();
      let codigo = String(r.codigo || r.Codigo || r['código'] || nombre).trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
      if (!codigo || !nombre) continue;
      const extra = tipo === 'capacitacion' ? { obligatorio: /s[ií]|true|1|x/i.test(String(r.obligatorio ?? r.Obligatorio ?? '')), vigencia_meses: Number(r.vigencia_meses || r.vigenciaMeses || r.Vigencia) || null }
        : tipo === 'epp' ? { categoria: r.categoria || r.Categoria || '' } : {};
      await query(`INSERT INTO hys_catalogo (tipo,codigo,nombre,extra,activo) VALUES ($1,$2,$3,$4,true)
        ON CONFLICT (tipo,codigo) DO UPDATE SET nombre=EXCLUDED.nombre, extra=EXCLUDED.extra, activo=true`, [tipo, codigo, nombre, JSON.stringify(extra)]);
      n++;
    }
    res.json({ ok: true, importados: n });
  } catch (e) { next(e); }
});
router.delete('/catalogo/:tipo/:codigo', requireRole('rrhh', 'admin'), async (req, res, next) => {
  try { await query('DELETE FROM hys_catalogo WHERE tipo=$1 AND codigo=$2', [req.params.tipo, req.params.codigo]); res.json({ ok: true }); } catch (e) { next(e); }
});

// ── Manuales / documentos de H&S ──
router.get('/manuales', async (req, res, next) => {
  try {
    if (!gestor(req.user.role)) {
      // Empleado: sólo documentos visibles, con marca de lectura propia.
      const pr = [req.user.id]; let tcond = '';
      if (req.query.tipo) { pr.push(req.query.tipo); tcond = `AND m.tipo=$${pr.length}`; }
      const { rows } = await query(`SELECT m.id, m.tipo, m.titulo, m.categoria, m.descripcion, m.mime, m.filename, m.tamano, m.created_at,
          a.fecha AS leido_at, (a.fecha IS NOT NULL) AS leido
        FROM hys_manuales m LEFT JOIN hys_manual_acuses a ON a.manual_id=m.id AND a.empleado_id=$1
        WHERE m.visible_empleado ${tcond} ORDER BY m.tipo, COALESCE(m.categoria,''), m.titulo`, pr);
      return res.json(rows);
    }
    const pr = []; let tcond = '';
    if (req.query.tipo) { pr.push(req.query.tipo); tcond = `WHERE tipo=$${pr.length}`; }
    const { rows } = await query(`SELECT id, tipo, titulo, categoria, descripcion, mime, filename, tamano, visible_empleado, created_by, created_at,
        (SELECT count(*)::int FROM hys_manual_acuses a WHERE a.manual_id=hys_manuales.id) AS acuses
      FROM hys_manuales ${tcond} ORDER BY tipo, COALESCE(categoria,'') , titulo`, pr);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/manuales', requireRole('rrhh', 'admin', 'manager'), upload.single('archivo'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.titulo) return res.status(400).json({ error: 'Título obligatorio' });
    const f = req.file;
    const tipo = (b.tipo === 'catalogo') ? 'catalogo' : 'manual';
    const ins = await query(`INSERT INTO hys_manuales (tipo,titulo,categoria,descripcion,archivo,mime,filename,tamano,visible_empleado,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [tipo, b.titulo, b.categoria || null, b.descripcion || null, f ? f.buffer.toString('base64') : null, f ? f.mimetype : null, f ? f.originalname : null, f ? f.size : null, /s[ií]|true|1/i.test(String(b.visibleEmpleado ?? '')), req.user.dni]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});
router.get('/manuales/:id/descargar', async (req, res, next) => {
  try {
    const r = await query('SELECT titulo, archivo, mime, filename, visible_empleado FROM hys_manuales WHERE id=$1', [req.params.id]);
    const m = r.rows[0];
    if (!m || !m.archivo) return res.status(404).json({ error: 'No encontrado' });
    if (!gestor(req.user.role) && !m.visible_empleado) return res.status(403).json({ error: 'No disponible' });
    res.setHeader('Content-Type', m.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(m.filename || m.titulo).replace(/[^\w.\- ]/g, '_')}"`);
    res.send(Buffer.from(m.archivo, 'base64'));
  } catch (e) { next(e); }
});
router.patch('/manuales/:id', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    await query(`UPDATE hys_manuales SET titulo=COALESCE($1,titulo), categoria=COALESCE($2,categoria), descripcion=COALESCE($3,descripcion), visible_empleado=COALESCE($4,visible_empleado) WHERE id=$5`,
      [b.titulo ?? null, b.categoria ?? null, b.descripcion ?? null, (b.visibleEmpleado === undefined ? null : !!b.visibleEmpleado), req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/manuales/:id', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try { await query('DELETE FROM hys_manuales WHERE id=$1', [req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});

// Acuse de recibo: el empleado confirma la lectura del documento (visible).
router.post('/manuales/:id/acuse', async (req, res, next) => {
  try {
    const m = (await query('SELECT visible_empleado FROM hys_manuales WHERE id=$1', [req.params.id])).rows[0];
    if (!m) return res.status(404).json({ error: 'No encontrado' });
    if (!gestor(req.user.role) && !m.visible_empleado) return res.status(403).json({ error: 'No disponible' });
    const r = await query('INSERT INTO hys_manual_acuses (manual_id, empleado_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING fecha', [req.params.id, req.user.id]);
    const fecha = r.rows[0] ? r.rows[0].fecha : (await query('SELECT fecha FROM hys_manual_acuses WHERE manual_id=$1 AND empleado_id=$2', [req.params.id, req.user.id])).rows[0]?.fecha;
    res.json({ ok: true, fecha });
  } catch (e) { next(e); }
});
// Acuses de un documento (RR.HH./Admin/Gerente): quiénes lo leyeron.
router.get('/manuales/:id/acuses', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT a.fecha, e.nom, e.leg_num, em.nombre AS empresa
      FROM hys_manual_acuses a JOIN empleados e ON e.id=a.empleado_id JOIN empresas em ON em.id=e.empresa_id
      WHERE a.manual_id=$1 ORDER BY a.fecha DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Datos propios del empleado (panel del empleado) ──
// El empleado puede cargar/editar sus propios talles.
router.put('/mis/talles', async (req, res, next) => {
  try {
    const nuevos = req.body || {};
    const er = await query('SELECT nom, data FROM empleados WHERE id=$1', [req.user.id]);
    const emp = er.rows[0]; const ant = (emp && emp.data ? emp.data.talles : null) || {};
    const cat = await leerCatalogos();
    const nomDe = Object.fromEntries((cat.talles || []).map((t) => [t.codigo, t.nombre]));
    const cambios = [];
    for (const k of new Set([...Object.keys(ant), ...Object.keys(nuevos)])) {
      const a = String(ant[k] ?? '').trim(), n = String(nuevos[k] ?? '').trim();
      if (a !== n) cambios.push(`${nomDe[k] || k}: ${a || '—'} → ${n || '—'}`);
    }
    await query('UPDATE empleados SET data = data || $1::jsonb WHERE id=$2', [JSON.stringify({ talles: nuevos }), req.user.id]);
    if (cambios.length) {
      await query('INSERT INTO hys_talles_historial (empleado_id, anterior, nuevo, cambios, origen, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.user.id, JSON.stringify(ant), JSON.stringify(nuevos), cambios.join(' · '), 'empleado', req.user.dni]);
      // Aviso a RR.HH. (módulo Mensajes — bandeja de mensajes de empleados)
      await query(`INSERT INTO mensajes (empleado_id, remitente_id, titulo, cuerpo, autor, direccion, estado, borrar_al_leer)
        VALUES ($1,$1,$2,$3,$4,'a_rrhh','nuevo',false)`,
        [req.user.id, 'Actualización de talles (H&S)', `${emp ? emp.nom : ''} actualizó sus talles — ${cambios.join(' · ')}`, emp ? emp.nom : '']);
    }
    res.json({ ok: true, cambios: cambios.length });
  } catch (e) { next(e); }
});
// Histórico de cambios de talle (RR.HH./Admin/Gerente)
router.get('/talles-historial/:empleadoId', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, cambios, origen, created_by, created_at FROM hys_talles_historial WHERE empleado_id=$1 ORDER BY created_at DESC', [req.params.empleadoId]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/mis', async (req, res, next) => {
  try {
    const caps = (await query('SELECT * FROM hys_capacitaciones WHERE empleado_id=$1 ORDER BY fecha DESC', [req.user.id])).rows;
    const epp = (await query('SELECT * FROM hys_epp_entregas WHERE empleado_id=$1 ORDER BY fecha DESC', [req.user.id])).rows;
    const d = (await query('SELECT data FROM empleados WHERE id=$1', [req.user.id])).rows[0]?.data || {};
    const tallesHistorial = (await query('SELECT cambios, origen, created_at FROM hys_talles_historial WHERE empleado_id=$1 ORDER BY created_at DESC', [req.user.id])).rows;
    res.json({ capacitaciones: caps, epp, talles: d.talles || {}, tallesHistorial });
  } catch (e) { next(e); }
});

// ── Talles del empleado (guardados en empleado.data.talles) ──
router.get('/talles/:empleadoId', async (req, res, next) => {
  try {
    const r = await query('SELECT data FROM empleados WHERE id=$1', [req.params.empleadoId]);
    res.json((r.rows[0]?.data || {}).talles || {});
  } catch (e) { next(e); }
});
router.put('/talles/:empleadoId', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const talles = req.body || {};
    await query('UPDATE empleados SET data = data || $1::jsonb WHERE id=$2', [JSON.stringify({ talles }), req.params.empleadoId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Dashboard consolidado (KPIs + lista por empresa con alertas) ──
// Vigencia por defecto de EPP (renovación): 12 meses (Res. SRT 299/2011 — entrega periódica).
const EPP_VIGENCIA_MESES = 12;
router.get('/dashboard', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const emps = (await query(`SELECT e.id, e.leg_num, e.nom, e.cuil, e.data, em.nombre AS empresa
      FROM empleados e JOIN empresas em ON em.id=e.empresa_id WHERE COALESCE(e.activo,true)=true ORDER BY em.nombre, e.leg_num`)).rows;
    const caps = (await query('SELECT empleado_id, codigo, nombre, fecha, vigencia_meses FROM hys_capacitaciones')).rows;
    const epps = (await query('SELECT empleado_id, codigo, nombre, talle, fecha FROM hys_epp_entregas')).rows;

    const capByEmp = {}, eppByEmp = {};
    for (const c of caps) (capByEmp[c.empleado_id] ||= []).push(c);
    for (const x of epps) (eppByEmp[x.empleado_id] ||= []).push(x);

    const hoy = new Date(); const en30 = new Date(hoy.getTime() + 30 * 86400000);
    const hace12m = new Date(hoy.getFullYear() - 1, hoy.getMonth(), hoy.getDate());
    const addMeses = (fecha, meses) => { const d = new Date(String(fecha).slice(0, 10) + 'T12:00:00'); d.setMonth(d.getMonth() + meses); return d; };
    const diasHasta = (d) => Math.ceil((d - hoy) / 86400000);

    let total = 0, sinTalles = 0, sinInduccion = 0, porVencer = 0, vencidas = 0, eppPorVencer = 0, eppVencidas = 0;
    const filtroEmpresa = req.query.empresa || null, filtroCentro = req.query.centro || null;
    const q = String(req.query.q || '').toLowerCase(), soloAlertas = String(req.query.soloAlertas) === '1';

    const out = [];
    const alertas = [];   // detalle plano: { ...empleado, tipo, item, fecha, vence, dias, estado }
    for (const e of emps) {
      const d = e.data || {};
      const lugar = d.lugar || d.centro || '';
      if (filtroEmpresa && e.empresa !== filtroEmpresa) continue;
      if (filtroCentro && lugar !== filtroCentro) continue;
      if (q && !(`${e.nom} ${e.leg_num} ${e.cuil || ''}`.toLowerCase().includes(q))) continue;

      const baseEmp = { empleadoId: e.id, empresa: e.empresa, legNum: e.leg_num, nom: e.nom, lugar };

      // Capacitaciones: última por código + vencimiento
      const ec = capByEmp[e.id] || [];
      const ultCap = {};
      for (const c of ec) { const f = String(c.fecha).slice(0, 10); if (!ultCap[c.codigo || c.nombre] || f > ultCap[c.codigo || c.nombre].f) ultCap[c.codigo || c.nombre] = { c, f }; }
      let empPorVencer = false, empVencida = false, ultimaCap = null;
      for (const { c, f } of Object.values(ultCap)) {
        if (!ultimaCap || f > ultimaCap) ultimaCap = f;
        if (!c.vigencia_meses) continue;
        const v = addMeses(c.fecha, c.vigencia_meses);
        if (v < hoy) { empVencida = true; alertas.push({ ...baseEmp, tipo: 'Capacitación', item: c.nombre, fecha: f, vence: v.toISOString().slice(0, 10), dias: diasHasta(v), estado: 'vencida' }); }
        else if (v <= en30) { empPorVencer = true; alertas.push({ ...baseEmp, tipo: 'Capacitación', item: c.nombre, fecha: f, vence: v.toISOString().slice(0, 10), dias: diasHasta(v), estado: 'por_vencer' }); }
      }

      // EPP: última por código + vencimiento (renovación EPP_VIGENCIA_MESES)
      const ex = eppByEmp[e.id] || [];
      const ultEpp = {};
      for (const x of ex) { const f = String(x.fecha).slice(0, 10); const k = x.codigo || x.nombre; if (!ultEpp[k] || f > ultEpp[k].f) ultEpp[k] = { x, f }; }
      let empEppPorVencer = false, empEppVencido = false;
      for (const { x, f } of Object.values(ultEpp)) {
        const v = addMeses(f, EPP_VIGENCIA_MESES);
        if (v < hoy) { empEppVencido = true; alertas.push({ ...baseEmp, tipo: 'EPP', item: x.nombre + (x.talle ? ` (talle ${x.talle})` : ''), fecha: f, vence: v.toISOString().slice(0, 10), dias: diasHasta(v), estado: 'vencida' }); }
        else if (v <= en30) { empEppPorVencer = true; alertas.push({ ...baseEmp, tipo: 'EPP', item: x.nombre + (x.talle ? ` (talle ${x.talle})` : ''), fecha: f, vence: v.toISOString().slice(0, 10), dias: diasHasta(v), estado: 'por_vencer' }); }
      }

      const induccion = ec.filter((c) => (c.codigo === 'INDUCCION') || /inducci[oó]n/i.test(c.nombre)).map((c) => String(c.fecha).slice(0, 10)).sort().pop() || null;
      const talles = d.talles && Object.values(d.talles).some((x) => x != null && String(x).trim() !== '');
      const epp12m = ex.filter((x) => new Date(String(x.fecha).slice(0, 10) + 'T12:00:00') >= hace12m).length;

      total++;
      if (!talles) sinTalles++;
      if (!induccion) sinInduccion++;
      if (empPorVencer) porVencer++;
      if (empVencida) vencidas++;
      if (empEppPorVencer) eppPorVencer++;
      if (empEppVencido) eppVencidas++;

      const al = { sinInduccion: !induccion, sinTalles: !talles, porVencer: empPorVencer, vencida: empVencida, eppPorVencer: empEppPorVencer, eppVencido: empEppVencido };
      const tieneAlerta = !induccion || !talles || empPorVencer || empVencida || empEppPorVencer || empEppVencido;
      if (soloAlertas && !tieneAlerta) continue;

      out.push({ id: e.id, empresa: e.empresa, legNum: e.leg_num, nom: e.nom, cuil: e.cuil, lugar, tarea: d.tarea || '',
        talles: !!talles, induccion, capacit: ec.length, epp12m, ultimaCap, alertas: al, tieneAlerta });
    }

    const empresas = [];
    for (const r of out) { let g = empresas.find((x) => x.empresa === r.empresa); if (!g) { g = { empresa: r.empresa, empleados: [] }; empresas.push(g); } g.empleados.push(r); }
    alertas.sort((a, b) => String(a.vence).localeCompare(String(b.vence)));

    res.json({ kpis: { total, sinTalles, sinInduccion, porVencer, vencidas, eppPorVencer, eppVencidas }, empresas, alertas });
  } catch (e) { next(e); }
});

// Capacitaciones
router.get('/capacitaciones', async (req, res, next) => {
  try {
    if (gestor(req.user.role)) {
      const cond = [], pr = [];
      if (req.query.empleadoId) { pr.push(req.query.empleadoId); cond.push(`c.empleado_id=$${pr.length}`); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(`SELECT c.*, e.nom, e.leg_num, em.nombre AS empresa FROM hys_capacitaciones c JOIN empleados e ON e.id=c.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY c.fecha DESC`, pr);
      return res.json(rows);
    }
    const { rows } = await query('SELECT * FROM hys_capacitaciones WHERE empleado_id=$1 ORDER BY fecha DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/capacitaciones', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.nombre || !b.fecha) return res.status(400).json({ error: 'Empleado, capacitación y fecha son obligatorios' });
    const ins = await query('INSERT INTO hys_capacitaciones (empleado_id, codigo, nombre, fecha, vigencia_meses, dictada_por, observaciones) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.empleadoId, b.codigo || null, b.nombre, b.fecha, b.vigenciaMeses || null, b.dictadaPor || null, b.observaciones || null]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/capacitaciones/:id', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try { const r = await query('DELETE FROM hys_capacitaciones WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); } catch (e) { next(e); }
});

// EPP
router.get('/epp', async (req, res, next) => {
  try {
    if (gestor(req.user.role)) {
      const cond = [], pr = [];
      if (req.query.empleadoId) { pr.push(req.query.empleadoId); cond.push(`x.empleado_id=$${pr.length}`); }
      const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
      const { rows } = await query(`SELECT x.*, e.nom, e.leg_num, em.nombre AS empresa FROM hys_epp_entregas x JOIN empleados e ON e.id=x.empleado_id JOIN empresas em ON em.id=e.empresa_id ${where} ORDER BY x.fecha DESC`, pr);
      return res.json(rows);
    }
    const { rows } = await query('SELECT * FROM hys_epp_entregas WHERE empleado_id=$1 ORDER BY fecha DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { next(e); }
});
router.post('/epp', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.empleadoId || !b.nombre || !b.fecha) return res.status(400).json({ error: 'Empleado, elemento y fecha son obligatorios' });
    const ins = await query('INSERT INTO hys_epp_entregas (empleado_id, codigo, nombre, cantidad, talle, fecha, observaciones) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.empleadoId, b.codigo || null, b.nombre, b.cantidad || 1, b.talle || null, b.fecha, b.observaciones || null]);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/epp/:id', requireRole('rrhh', 'admin', 'manager'), async (req, res, next) => {
  try { const r = await query('DELETE FROM hys_epp_entregas WHERE id=$1 RETURNING id', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'No encontrado' }); res.json({ ok: true }); } catch (e) { next(e); }
});

export default router;
