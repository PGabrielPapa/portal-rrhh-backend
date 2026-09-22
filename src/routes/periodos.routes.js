// Períodos laborales del legajo.
//
// El número de legajo identifica a la persona en el GRUPO y no cambia nunca.
// Cada relación laboral con una empresa es un período, con su alta, su baja y su
// causa. Dos operaciones lo mueven:
//
//   · POST /ceder     — cesión del contrato (arts. 225/229 LCT). Cierra el
//     período en la cedente SIN liquidación final y abre uno en la cesionaria
//     con el mismo legajo. La antigüedad NO se toca: `empleados.ingreso` sigue
//     siendo el ingreso original al grupo, que es sobre el que liquida el motor,
//     y el período nuevo guarda la fecha de alta ante ARCA en la nueva empresa.
//   · POST /reingreso — la persona egresó y vuelve. Mismo legajo, período nuevo,
//     y la antigüedad se reconoce o se reinicia según lo que indique RR.HH.
//   · POST /simultaneo — relación laboral en OTRA empresa del grupo sin cerrar la
//     vigente (director con cargo en más de una empresa). Quedan dos relaciones
//     abiertas a la vez y cada empresa liquida su mes completo: NO es una cesión
//     y no corresponde prorrateo por días. Régimen de actividades simultáneas,
//     RG 2252.
import { Router } from 'express';
import { query, pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { migrarPeriodos } from '../db/migratePeriodos.js';

const router = Router();
router.use(requireAuth, requireRole('rrhh', 'admin'));

// El legajo es único para todo el grupo: se mira el máximo entre los legajos
// cargados y los de los períodos históricos, sin filtrar por empresa.
export async function siguienteLegajo(cli = pool) {
  const r = await cli.query(`
    SELECT COALESCE(MAX(n), 0) + 1 AS n FROM (
      SELECT NULLIF(regexp_replace(leg_num, '\\D', '', 'g'), '')::bigint AS n FROM empleados
      UNION ALL
      SELECT NULLIF(regexp_replace(legajo,  '\\D', '', 'g'), '')::bigint AS n FROM periodos WHERE legajo IS NOT NULL
    ) t`);
  return String(r.rows[0].n).padStart(6, '0');
}

const mapPeriodo = (r) => ({
  id: r.id, nro: r.nro, empleadoId: r.empleado_id, legajo: r.legajo,
  empresaId: r.empresa_id, empresa: r.empresa || null,
  empresaOrigenId: r.empresa_origen_id, empresaOrigen: r.empresa_origen || null,
  fechaIngreso: r.fecha_ingreso, fechaEgreso: r.fecha_egreso, causaEgreso: r.causa_egreso,
  motivoAlta: r.motivo_alta, antiguedadReconocida: r.antiguedad_reconocida,
  vigente: r.vigente === true, observacion: r.observacion,
  funcion: r.funcion, catConvenio: r.cat_convenio, codConvenio: r.cod_convenio, codSindicato: r.cod_sindicato,
  // Designaciones: cuáles obligaciones "de una sola vez" recaen en ESTA empresa
  // cuando el legajo tiene relaciones simultáneas. Cada una responde a un criterio
  // distinto (jornada, antigüedad, elección del trabajador, remuneración), así que
  // no se derivan entre sí ni de la empresa principal.
  scvo: r.scvo !== false, asigFam: r.asig_fam !== false,
  osUnificada: r.os_unificada !== false, retieneGanancias: r.retiene_ganancias !== false,
  recibos: r.n_recibos != null ? Number(r.n_recibos) : undefined,
});

const SQL_PERIODOS = `
  SELECT p.*, em.nombre AS empresa, eo.nombre AS empresa_origen,
         (SELECT count(*)::int FROM recibos r WHERE r.periodo_id = p.id) AS n_recibos
    FROM periodos p
    LEFT JOIN empresas em ON em.id = p.empresa_id
    LEFT JOIN empresas eo ON eo.id = p.empresa_origen_id`;

router.get('/proximo-legajo', async (_req, res, next) => {
  try { res.json({ legajo: await siguienteLegajo() }); } catch (e) { next(e); }
});

// Padrón con la cantidad de períodos de cada legajo (pantalla de períodos).
router.get('/resumen', async (_req, res, next) => {
  try {
    await migrarPeriodos();
    const { rows } = await query(`
      SELECT e.id, e.leg_num, e.nom, e.activo, e.ingreso, em.nombre AS empresa,
             (SELECT count(*)::int FROM periodos p WHERE p.empleado_id = e.id) AS periodos,
             (SELECT count(*)::int FROM periodos p WHERE p.empleado_id = e.id AND p.motivo_alta = 'cesion') AS cesiones,
             -- Relaciones abiertas a la vez: >1 = cargos simultáneos en empresas distintas.
             (SELECT count(*)::int FROM periodos p WHERE p.empleado_id = e.id AND p.vigente) AS vigentes,
             (SELECT string_agg(em2.nombre, ' + ' ORDER BY em2.nombre)
                FROM periodos p JOIN empresas em2 ON em2.id = p.empresa_id
               WHERE p.empleado_id = e.id AND p.vigente) AS empresas_vigentes
        FROM empleados e JOIN empresas em ON em.id = e.empresa_id
       ORDER BY NULLIF(regexp_replace(e.leg_num, '\\D', '', 'g'), '')::bigint NULLS LAST, e.nom`);
    const empresas = (await query('SELECT id, nombre FROM empresas ORDER BY nombre')).rows;
    res.json({ legajos: rows, empresas });
  } catch (e) { next(e); }
});

router.get('/empleado/:id', async (req, res, next) => {
  try {
    await migrarPeriodos();
    const { rows } = await query(`${SQL_PERIODOS} WHERE p.empleado_id = $1 ORDER BY p.nro, p.fecha_ingreso`, [req.params.id]);
    res.json(rows.map(mapPeriodo));
  } catch (e) { next(e); }
});

const soloFecha = (v) => (v ? String(v).slice(0, 10) : null);
// undefined = no se toca el campo; cualquier otra cosa se interpreta como booleano.
const bool = (v) => (v === undefined || v === null || v === '' ? undefined : (v === true || v === 'true' || v === 1 || v === '1'));
const masUnDia = (iso) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

async function resolverEmpresaId(cli, valor) {
  if (!valor) return null;
  if (/^\d+$/.test(String(valor))) return Number(valor);
  const r = await cli.query('SELECT id FROM empresas WHERE nombre = $1 OR slug = $1', [String(valor)]);
  return r.rows[0]?.id || null;
}

// POST /api/periodos/ceder — cesión del contrato a otra empresa del grupo.
router.post('/ceder', async (req, res, next) => {
  const b = req.body || {};
  const fechaEgreso = soloFecha(b.fechaEgreso);
  const fechaIngreso = soloFecha(b.fechaIngreso) || (fechaEgreso ? masUnDia(fechaEgreso) : null);
  if (!b.empleadoId || !b.empresaDestino || !fechaEgreso) {
    return res.status(400).json({ error: 'Indicá el legajo, la empresa cesionaria y la fecha de egreso en la cedente' });
  }
  const cli = await pool.connect();
  try {
    await migrarPeriodos();
    await cli.query('BEGIN');
    const emp = (await cli.query('SELECT id, leg_num, nom, empresa_id, ingreso, data FROM empleados WHERE id = $1 FOR UPDATE', [b.empleadoId])).rows[0];
    if (!emp) { await cli.query('ROLLBACK'); return res.status(404).json({ error: 'Legajo no encontrado' }); }

    const destinoId = await resolverEmpresaId(cli, b.empresaDestino);
    if (!destinoId) { await cli.query('ROLLBACK'); return res.status(400).json({ error: 'Empresa cesionaria no encontrada' }); }

    // Con relaciones simultáneas puede haber más de un período vigente: hay que
    // decir cuál se cede (por id o por la empresa cedente), o el sistema no puede
    // adivinarlo.
    const vigentes = (await cli.query('SELECT * FROM periodos WHERE empleado_id = $1 AND vigente = true ORDER BY nro FOR UPDATE', [emp.id])).rows;
    if (!vigentes.length) { await cli.query('ROLLBACK'); return res.status(400).json({ error: 'El legajo no tiene un período vigente: registrá primero el ingreso' }); }
    let vig = vigentes[0];
    if (b.periodoId) {
      vig = vigentes.find((x) => String(x.id) === String(b.periodoId));
      if (!vig) { await cli.query('ROLLBACK'); return res.status(400).json({ error: 'El período indicado no está vigente en este legajo' }); }
    } else if (b.empresaOrigen) {
      const origenId = await resolverEmpresaId(cli, b.empresaOrigen);
      vig = vigentes.find((x) => x.empresa_id === origenId);
      if (!vig) { await cli.query('ROLLBACK'); return res.status(400).json({ error: 'El legajo no tiene una relación vigente en la empresa cedente indicada' }); }
    } else if (vigentes.length > 1) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ error: 'El legajo tiene más de una relación vigente (cargos simultáneos). Indicá cuál se cede con `empresaOrigen` o `periodoId`.' });
    }
    if (vig.fecha_ingreso && fechaEgreso < String(vig.fecha_ingreso).slice(0, 10)) {
      await cli.query('ROLLBACK'); return res.status(400).json({ error: 'La fecha de egreso es anterior al ingreso del período vigente' });
    }

    if (destinoId === vig.empresa_id) { await cli.query('ROLLBACK'); return res.status(400).json({ error: 'La empresa cesionaria es la misma que la cedente' }); }
    if (vigentes.some((x) => x.empresa_id === destinoId)) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ error: 'El legajo ya tiene una relación vigente en la empresa cesionaria' });
    }

    // Antigüedad original del grupo: el ingreso del primer período, o el del legajo.
    const primero = (await cli.query('SELECT fecha_ingreso FROM periodos WHERE empleado_id = $1 ORDER BY nro, fecha_ingreso LIMIT 1', [emp.id])).rows[0];
    const antiguedad = soloFecha(primero?.fecha_ingreso) || soloFecha(emp.ingreso);

    // 1. Se cierra el período en la cedente. Sin liquidación final: la cesionaria
    //    continúa la relación y asume el pasivo (arts. 225/229 LCT).
    await cli.query(
      `UPDATE periodos SET vigente = false, fecha_egreso = $1, causa_egreso = 'cesion',
              observacion = COALESCE(observacion, '') || $2, updated_at = now()
        WHERE id = $3`,
      [fechaEgreso, `Contrato cedido a empresa id ${destinoId}. ${b.observacion || ''}`.trim(), vig.id]);

    // 2. Período nuevo en la cesionaria, con el MISMO legajo.
    const nro = (await cli.query('SELECT COALESCE(MAX(nro),0)+1 AS n FROM periodos WHERE empleado_id = $1', [emp.id])).rows[0].n;
    const nuevo = await cli.query(
      `INSERT INTO periodos (persona_id, empleado_id, empresa_id, legajo, fecha_ingreso, vigente, nro,
                             motivo_alta, empresa_origen_id, antiguedad_reconocida, observacion,
                             funcion, cat_escala, tramo_escala, cat_convenio, cod_convenio, cod_sindicato, created_by)
       SELECT p.persona_id, p.empleado_id, $1, p.legajo, $2, true, $3, 'cesion', p.empresa_id, $4, $5,
              p.funcion, p.cat_escala, p.tramo_escala, p.cat_convenio, p.cod_convenio, p.cod_sindicato, $6
         FROM periodos p WHERE p.id = $7 RETURNING id`,
      [destinoId, fechaIngreso, nro, antiguedad, b.observacion || null, req.user.dni, vig.id]);

    // 3. El legajo pasa a la cesionaria. `ingreso` NO se toca: es la antigüedad
    //    reconocida y es lo que usa el motor de liquidación.
    await cli.query(
      `UPDATE empleados SET empresa_id = $1, activo = true,
              data = data || jsonb_build_object('antiguedadReconocida', $2::text), updated_at = now()
        WHERE id = $3`, [destinoId, antiguedad, emp.id]);

    await cli.query('COMMIT');

    // Traza del cambio de empresa. Fuera de la transacción: que falle el historial
    // no puede tirar abajo una cesión ya confirmada.
    query(`INSERT INTO legajo_cambios (empleado_id, campo, etiqueta, valor_anterior, valor_nuevo, created_by)
           VALUES ($1,'empresa_id','Empresa (cesión de contrato)',
                   (SELECT nombre FROM empresas WHERE id=$2), (SELECT nombre FROM empresas WHERE id=$3), $4)`,
      [emp.id, emp.empresa_id, destinoId, req.user.dni]).catch(() => {});

    res.status(201).json({ ok: true, periodoCerrado: vig.id, periodoNuevo: nuevo.rows[0].id, antiguedadReconocida: antiguedad });
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); next(e); }
  finally { cli.release(); }
});

// POST /api/periodos/reingreso — la persona egresó y vuelve, con el mismo legajo.
router.post('/reingreso', async (req, res, next) => {
  const b = req.body || {};
  const fechaIngreso = soloFecha(b.fechaIngreso);
  if (!b.empleadoId || !fechaIngreso) return res.status(400).json({ error: 'Indicá el legajo y la fecha de reingreso' });
  const cli = await pool.connect();
  try {
    await migrarPeriodos();
    await cli.query('BEGIN');
    const emp = (await cli.query('SELECT id, empresa_id, ingreso FROM empleados WHERE id = $1 FOR UPDATE', [b.empleadoId])).rows[0];
    if (!emp) { await cli.query('ROLLBACK'); return res.status(404).json({ error: 'Legajo no encontrado' }); }

    const vig = (await cli.query('SELECT id FROM periodos WHERE empleado_id = $1 AND vigente = true', [emp.id])).rows[0];
    if (vig) { await cli.query('ROLLBACK'); return res.status(400).json({ error: 'El legajo tiene un período vigente: registrá primero la baja' }); }

    const empresaId = (await resolverEmpresaId(cli, b.empresaId || b.empresa)) || emp.empresa_id;
    const reconoce = b.reconoceAntiguedad === true;
    const primero = (await cli.query('SELECT fecha_ingreso FROM periodos WHERE empleado_id = $1 ORDER BY nro, fecha_ingreso LIMIT 1', [emp.id])).rows[0];
    const antiguedad = reconoce ? (soloFecha(primero?.fecha_ingreso) || soloFecha(emp.ingreso)) : null;

    const nro = (await cli.query('SELECT COALESCE(MAX(nro),0)+1 AS n FROM periodos WHERE empleado_id = $1', [emp.id])).rows[0].n;
    const nuevo = await cli.query(
      `INSERT INTO periodos (persona_id, empleado_id, empresa_id, legajo, fecha_ingreso, vigente, nro,
                             motivo_alta, antiguedad_reconocida, observacion, created_by)
       SELECT e.persona_id, e.id, $1, e.leg_num, $2, true, $3, 'reingreso', $4, $5, $6
         FROM empleados e WHERE e.id = $7 RETURNING id`,
      [empresaId, fechaIngreso, nro, antiguedad, b.observacion || null, req.user.dni, emp.id]);

    // Si NO se reconoce la antigüedad anterior, la relación arranca de cero y el
    // motor debe liquidar desde esta fecha.
    await cli.query(
      `UPDATE empleados SET activo = true, empresa_id = $1,
              ingreso = COALESCE($2::date, ingreso),
              data = data || jsonb_build_object('antiguedadReconocida', $3::text), updated_at = now()
        WHERE id = $4`,
      [empresaId, reconoce ? null : fechaIngreso, antiguedad, emp.id]);

    await cli.query('COMMIT');
    res.status(201).json({ ok: true, periodoNuevo: nuevo.rows[0].id, reconoceAntiguedad: reconoce });
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); next(e); }
  finally { cli.release(); }
});

// PUT /api/periodos/:id — corrección manual de un período (fechas, causa, datos del convenio).
router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const campos = {
      fecha_ingreso: soloFecha(b.fechaIngreso), fecha_egreso: soloFecha(b.fechaEgreso),
      causa_egreso: b.causaEgreso, motivo_alta: b.motivoAlta, observacion: b.observacion,
      funcion: b.funcion, cat_convenio: b.catConvenio, cod_convenio: b.codConvenio, cod_sindicato: b.codSindicato,
      antiguedad_reconocida: soloFecha(b.antiguedadReconocida),
      scvo: bool(b.scvo), asig_fam: bool(b.asigFam),
      os_unificada: bool(b.osUnificada), retiene_ganancias: bool(b.retieneGanancias),
    };
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(campos)) { if (v === undefined) continue; vals.push(v); sets.push(`${k} = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'No hay campos para actualizar' });
    vals.push(req.params.id);
    const r = await query(`UPDATE periodos SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING id`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'Período no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/periodos/simultaneo — relación laboral en otra empresa del grupo,
// SIN cerrar la vigente. Es el caso del director con cargo en más de una empresa:
// dos altas ante ARCA, dos recibos y dos F.931, cada empresa por su mes completo.
// No es una cesión: no se cierra nada, no hay prorrateo por días y la antigüedad
// del grupo no se toca.
router.post('/simultaneo', async (req, res, next) => {
  const b = req.body || {};
  const fechaIngreso = soloFecha(b.fechaIngreso);
  if (!b.empleadoId || !b.empresa || !fechaIngreso) {
    return res.status(400).json({ error: 'Indicá el legajo, la empresa y la fecha de alta de la nueva relación' });
  }
  const cli = await pool.connect();
  try {
    await migrarPeriodos();
    await cli.query('BEGIN');
    const emp = (await cli.query('SELECT id, leg_num, nom, empresa_id, ingreso FROM empleados WHERE id = $1 FOR UPDATE', [b.empleadoId])).rows[0];
    if (!emp) { await cli.query('ROLLBACK'); return res.status(404).json({ error: 'Legajo no encontrado' }); }

    const empresaId = await resolverEmpresaId(cli, b.empresa);
    if (!empresaId) { await cli.query('ROLLBACK'); return res.status(400).json({ error: 'Empresa no encontrada' }); }

    const vigentes = (await cli.query('SELECT * FROM periodos WHERE empleado_id = $1 AND vigente = true ORDER BY nro FOR UPDATE', [emp.id])).rows;
    if (!vigentes.length) {
      await cli.query('ROLLBACK');
      return res.status(400).json({ error: 'El legajo no tiene ninguna relación vigente. Para una relación única usá el alta normal; esto es para agregar una SEGUNDA en simultáneo.' });
    }
    if (vigentes.some((x) => x.empresa_id === empresaId)) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ error: 'El legajo ya tiene una relación vigente en esa empresa. Para reemplazarla hay que cerrarla primero.' });
    }

    const base = vigentes[0];
    const nro = (await cli.query('SELECT COALESCE(MAX(nro),0)+1 AS n FROM periodos WHERE empleado_id = $1', [emp.id])).rows[0].n;

    // Las designaciones arrancan TODAS en false en la relación nueva: por defecto
    // las obligaciones de una sola vez siguen recayendo en la relación que ya
    // existía, y RR.HH. las mueve a mano donde corresponda — el criterio de cada
    // una es distinto (jornada para el SCVO, antigüedad para las asignaciones,
    // elección del trabajador para la obra social, remuneración para Ganancias).
    const nuevo = await cli.query(
      `INSERT INTO periodos (persona_id, empleado_id, empresa_id, legajo, fecha_ingreso, vigente, nro,
                             motivo_alta, antiguedad_reconocida, observacion,
                             funcion, cat_escala, tramo_escala, cat_convenio, cod_convenio, cod_sindicato,
                             scvo, asig_fam, os_unificada, retiene_ganancias, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6,'simultaneo',$7,$8,$9,$10,$11,$12,$13,$14,false,false,false,false,$15)
       RETURNING id`,
      [base.persona_id, emp.id, empresaId, emp.leg_num, fechaIngreso, nro,
       soloFecha(b.antiguedadReconocida) || null, b.observacion || null,
       b.funcion || null, b.catEscala || null, b.tramoEscala || null,
       b.catConvenio || null, b.codConvenio || null, b.codSindicato || null, req.user.dni]);

    await cli.query('COMMIT');

    query(`INSERT INTO legajo_cambios (empleado_id, campo, etiqueta, valor_anterior, valor_nuevo, created_by)
           VALUES ($1,'periodos','Alta de relación simultánea', NULL, (SELECT nombre FROM empresas WHERE id=$2), $3)`,
      [emp.id, empresaId, req.user.dni]).catch(() => {});

    res.status(201).json({ ok: true, periodoNuevo: nuevo.rows[0].id, vigentes: vigentes.length + 1 });
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); next(e); }
  finally { cli.release(); }
});

export default router;
