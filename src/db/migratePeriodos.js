// Migración idempotente de PERÍODOS LABORALES.
//
// Un legajo es la persona dentro del grupo y no cambia nunca; lo que cambia son
// sus períodos: cada relación laboral con una empresa, con su alta, su baja y su
// causa. Sirve para dos casos:
//
//   · cesión del contrato (arts. 225/229 LCT): se cierra el período en la empresa
//     cedente sin liquidación final y se abre uno nuevo en la cesionaria, con el
//     MISMO legajo y con la antigüedad original reconocida;
//   · reingreso: la persona egresó y vuelve — mismo legajo, período nuevo.
//
// La tabla `periodos` ya existía (la escribía sólo el flujo de Personas). Acá se
// completa con los campos que faltaban, se le da un período a cada legajo ya
// cargado y se ancla cada recibo al período al que corresponde, para que el
// F.931, el libro de sueldos y el asiento sigan saliendo por la empresa correcta
// aunque el trabajador haya cambiado de empresa después.
import { query } from '../db.js';

export async function migrarPeriodos() {
  const res = { columnas: false, periodosCreados: 0, recibosVinculados: 0 };

  // ── 1. Estructura ─────────────────────────────────────────────────────────
  // El período nace de un empleado; la persona es opcional (los legajos viejos
  // no tienen ficha de persona).
  await query('ALTER TABLE periodos ALTER COLUMN persona_id DROP NOT NULL').catch(() => {});
  await query(`ALTER TABLE periodos
    ADD COLUMN IF NOT EXISTS nro                   INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS motivo_alta           TEXT,          -- ingreso | cesion | reingreso
    ADD COLUMN IF NOT EXISTS empresa_origen_id     INTEGER REFERENCES empresas(id),
    ADD COLUMN IF NOT EXISTS antiguedad_reconocida DATE,          -- ingreso original que reconoce la cesionaria
    ADD COLUMN IF NOT EXISTS observacion           TEXT`);
  await query('CREATE INDEX IF NOT EXISTS idx_periodos_empleado ON periodos(empleado_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_periodos_empresa  ON periodos(empresa_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_periodos_legajo   ON periodos(legajo)');
  // Un solo período vigente por legajo Y EMPRESA.
  //
  // Antes era uno solo por legajo, sin excepción. Eso impedía el caso real del
  // director con cargo simultáneo en dos empresas del grupo: dos relaciones
  // laborales abiertas a la vez, cada una con su alta ante ARCA, su recibo y su
  // F.931 (régimen de actividades simultáneas, RG 2252). Lo que se sigue
  // prohibiendo es tener dos relaciones abiertas en la MISMA empresa: para eso
  // hay que cerrar la anterior primero.
  //
  // Ojo: esto NO es una cesión. En la cesión hay una sola relación que pasa de
  // una empresa a otra y el mes del corte se parte por días/30; acá hay dos
  // relaciones vivas y cada empresa liquida su mes completo.
  await query('DROP INDEX IF EXISTS uq_periodo_vigente');
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_periodo_vigente_empresa
                 ON periodos(empleado_id, empresa_id) WHERE vigente = true`).catch((e) => { res.errorIndice = e.message; });

  // ── Designaciones por relación (sólo importan si hay simultaneidad) ────────
  // Con dos empleadores a la vez, varias obligaciones se cumplen UNA sola vez, y
  // cada una elige empresa por un criterio DISTINTO — no se derivan entre sí:
  //   · SCVO (Dto. 1567/74, regl. art. 3) → la de MAYOR JORNADA mensual
  //   · Asignaciones familiares (Ley 24.714 art. 21) → la de MAYOR ANTIGÜEDAD
  //   · Obra social (Dto. 292/95 art. 9) → la que ELIGE el trabajador
  //   · Ganancias (RG 4003 art. 3) → la que pagó MAYOR remuneración el año anterior
  // Por eso son cuatro campos independientes. Arrancan en true para que un legajo
  // con una sola relación se comporte exactamente igual que hasta ahora.
  await query(`ALTER TABLE periodos
    ADD COLUMN IF NOT EXISTS scvo               BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS asig_fam           BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS os_unificada       BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS retiene_ganancias  BOOLEAN NOT NULL DEFAULT true`);

  await query('ALTER TABLE recibos ADD COLUMN IF NOT EXISTS periodo_id INTEGER REFERENCES periodos(id) ON DELETE SET NULL');
  await query('CREATE INDEX IF NOT EXISTS idx_recibos_periodo ON recibos(periodo_id)');
  res.columnas = true;

  // ── 2. Cada recibo nuevo se ancla solo a su período ───────────────────────
  // Se hace por trigger para no tener que tocar los cuatro puntos donde la
  // liquidación inserta recibos (corrida, individual, final, ajustes).
  await query(`
    CREATE OR REPLACE FUNCTION recibos_set_periodo() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.periodo_id IS NULL THEN
        SELECT p.id INTO NEW.periodo_id
          FROM periodos p
         WHERE p.empleado_id = NEW.empleado_id
           AND (p.fecha_ingreso IS NULL OR p.fecha_ingreso <= (make_date(NEW.anio, NEW.mes, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date)
           AND (p.fecha_egreso  IS NULL OR p.fecha_egreso  >= make_date(NEW.anio, NEW.mes, 1))
         ORDER BY p.fecha_ingreso DESC NULLS LAST
         LIMIT 1;
      END IF;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql`);
  await query('DROP TRIGGER IF EXISTS trg_recibos_periodo ON recibos');
  await query(`CREATE TRIGGER trg_recibos_periodo BEFORE INSERT ON recibos
               FOR EACH ROW EXECUTE FUNCTION recibos_set_periodo()`);

  // ── 3. Un período inicial para cada legajo que todavía no tenga ninguno ────
  const ins = await query(`
    INSERT INTO periodos (persona_id, empleado_id, empresa_id, legajo, fecha_ingreso,
                          fecha_egreso, causa_egreso, vigente, nro, motivo_alta, created_by)
    SELECT e.persona_id, e.id, e.empresa_id, e.leg_num, e.ingreso,
           b.fecha_baja, b.causa,
           (e.activo AND b.fecha_baja IS NULL),
           1, 'ingreso', 'migracion'
      FROM empleados e
      LEFT JOIN LATERAL (
        SELECT fecha_baja, causa FROM bajas WHERE empleado_id = e.id ORDER BY fecha_baja DESC LIMIT 1
      ) b ON true
     WHERE NOT EXISTS (SELECT 1 FROM periodos p WHERE p.empleado_id = e.id)
    RETURNING id`);
  res.periodosCreados = ins.rowCount;

  // ── 4. Recibos ya emitidos → su período ───────────────────────────────────
  const upd = await query(`
    UPDATE recibos r SET periodo_id = (
      SELECT p.id FROM periodos p
       WHERE p.empleado_id = r.empleado_id
         AND (p.fecha_ingreso IS NULL OR p.fecha_ingreso <= (make_date(r.anio, r.mes, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date)
         AND (p.fecha_egreso  IS NULL OR p.fecha_egreso  >= make_date(r.anio, r.mes, 1))
       ORDER BY p.fecha_ingreso DESC NULLS LAST LIMIT 1)
     WHERE r.periodo_id IS NULL`);
  res.recibosVinculados = upd.rowCount;

  return res;
}

export default migrarPeriodos;
