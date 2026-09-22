// Migración idempotente de la BASE DE PERSONAS.
//
// Problema que corrige: `personas` sólo tenía índice único por CUIL, y ni el DNI
// ni el CUIL se normalizaban al guardar. Como el mismo CUIL convivía escrito de
// dos formas ("20414724990" y "20-41472499-0"), el único no lo detectaba y la
// misma persona terminaba cargada dos veces — una como familiar y otra como
// empleado.
//
// Acá se hace, en este orden:
//   1. número de persona propio (secuencia), que identifica a la persona en la
//      base desde su creación — distinto del LEGAJO, que se asigna recién cuando
//      pasa a ser empleado;
//   2. normalización de DNI y CUIL a sólo dígitos;
//   3. unificación de los duplicados que ya existen, repuntando empleados,
//      períodos y auditoría de login al registro que se conserva;
//   4. índice único por DNI, para que no vuelva a pasar.
import { query } from '../db.js';

const soloDigitos = (v) => String(v || '').replace(/\D/g, '');

// La migración es barata pero corre en cada consulta del listado: se recuerda si
// ya se hizo en este proceso para no repetir el DDL en cada request.
let yaCorrio = false;

export async function migrarPersonas({ forzar = false } = {}) {
  const res = { normalizados: 0, fusionados: 0, numerados: 0, duplicadosDni: [] };
  if (yaCorrio && !forzar) return res;
  yaCorrio = true;

  // ── 1. Número de persona ──────────────────────────────────────────────────
  // Por secuencia y no desde el código: así lo recibe cualquier alta, incluida la
  // que hace el ABM de empleados cuando crea la persona por su cuenta.
  await query('ALTER TABLE personas ADD COLUMN IF NOT EXISTS nro INTEGER');
  await query('CREATE SEQUENCE IF NOT EXISTS personas_nro_seq');
  await query("ALTER TABLE personas ALTER COLUMN nro SET DEFAULT nextval('personas_nro_seq')");

  // ── 2. Normalización ──────────────────────────────────────────────────────
  // El índice único de CUIL se baja primero: al normalizar pueden aparecer
  // colisiones que son justamente los duplicados que vamos a unificar.
  await query('DROP INDEX IF EXISTS uq_personas_cuil');
  const norm = await query(`
    UPDATE personas
       SET dni  = NULLIF(regexp_replace(COALESCE(dni, ''),  '\\D', '', 'g'), ''),
           cuil = NULLIF(regexp_replace(COALESCE(cuil, ''), '\\D', '', 'g'), '')
     WHERE dni  IS DISTINCT FROM NULLIF(regexp_replace(COALESCE(dni, ''),  '\\D', '', 'g'), '')
        OR cuil IS DISTINCT FROM NULLIF(regexp_replace(COALESCE(cuil, ''), '\\D', '', 'g'), '')`);
  res.normalizados = norm.rowCount;

  // ── 3. Unificación de duplicados por DNI ──────────────────────────────────
  const dups = await query(`
    SELECT dni, array_agg(id ORDER BY id) AS ids
      FROM personas
     WHERE dni IS NOT NULL AND dni <> ''
     GROUP BY dni HAVING count(*) > 1`);

  for (const { dni, ids } of dups.rows) {
    // Se conserva el registro que ya está ligado a un empleado; si no hay
    // ninguno, el más antiguo. Es el que tiene la historia colgando.
    const conEmp = (await query(
      'SELECT persona_id FROM empleados WHERE persona_id = ANY($1) ORDER BY id LIMIT 1', [ids])).rows[0];
    const keep = conEmp?.persona_id || ids[0];
    const drop = ids.filter((i) => i !== keep);
    if (!drop.length) continue;

    const ganador = (await query('SELECT * FROM personas WHERE id = $1', [keep])).rows[0];
    const perdedores = (await query('SELECT * FROM personas WHERE id = ANY($1) ORDER BY id', [drop])).rows;

    // Se completa lo que al ganador le falte y se unen tipos y datos: los del
    // ganador tienen prioridad, los del duplicado rellenan huecos.
    let data = {}, tipos = new Set(ganador.tipos || []);
    for (const p of perdedores) {
      Object.assign(data, p.data || {});
      for (const t of (p.tipos || [])) tipos.add(t);
    }
    Object.assign(data, ganador.data || {});
    const relleno = (campo) => ganador[campo] || perdedores.map((p) => p[campo]).find(Boolean) || null;

    await query(
      `UPDATE personas SET cuil = COALESCE(cuil, $1), apellido = COALESCE(apellido, $2),
              nombres = COALESCE(nombres, $3), nom = COALESCE(nom, $4),
              tipos = $5, data = $6, updated_at = now()
        WHERE id = $7`,
      [relleno('cuil'), relleno('apellido'), relleno('nombres'), relleno('nom'),
       [...tipos], JSON.stringify(data), keep]);

    // Todo lo que colgaba del duplicado pasa al que se conserva.
    await query('UPDATE empleados SET persona_id = $1 WHERE persona_id = ANY($2)', [keep, drop]);
    await query('UPDATE periodos  SET persona_id = $1 WHERE persona_id = ANY($2)', [keep, drop]);
    await query('UPDATE login_audit SET persona_id = $1 WHERE persona_id = ANY($2)', [keep, drop]).catch(() => {});
    await query('DELETE FROM personas WHERE id = ANY($1)', [drop]);

    res.fusionados += drop.length;
    res.duplicadosDni.push({ dni, conservado: keep, eliminados: drop });
  }

  // ── 4. Numeración de los que todavía no tienen, e índices ─────────────────
  const num = await query(`
    WITH s AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM personas WHERE nro IS NULL)
    UPDATE personas p SET nro = (SELECT COALESCE(MAX(nro), 0) FROM personas) + s.n
      FROM s WHERE p.id = s.id`);
  res.numerados = num.rowCount;
  await query("SELECT setval('personas_nro_seq', GREATEST((SELECT COALESCE(MAX(nro), 0) FROM personas), 1))");

  await query('CREATE UNIQUE INDEX IF NOT EXISTS uq_personas_nro ON personas(nro)');
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_personas_dni
                 ON personas(dni) WHERE dni IS NOT NULL AND dni <> ''`).catch((e) => { res.errorDni = e.message; });
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_personas_cuil
                 ON personas(cuil) WHERE cuil IS NOT NULL AND cuil <> ''`).catch((e) => { res.errorCuil = e.message; });

  return res;
}

export { soloDigitos };
export default migrarPersonas;
