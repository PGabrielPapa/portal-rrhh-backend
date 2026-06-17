-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  Esquema Portal RR.HH. — v1 (empresas + empleados + auth)         ║
-- ╚══════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS empresas (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  cuit        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS empleados (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  leg_num         TEXT NOT NULL,                 -- número de legajo (visible)
  dni             TEXT NOT NULL,
  cuil            TEXT,
  nom             TEXT NOT NULL,
  email           TEXT,
  cat             TEXT,
  tramo           TEXT,
  ingreso         DATE,
  bruto           NUMERIC(14,2) NOT NULL DEFAULT 0,
  neto            NUMERIC(14,2) NOT NULL DEFAULT 0,
  activo          BOOLEAN NOT NULL DEFAULT true,
  es_alta         BOOLEAN NOT NULL DEFAULT false,
  -- Autenticación
  password_hash   TEXT,
  role            TEXT NOT NULL DEFAULT 'employee',   -- employee | manager | rrhh | admin
  must_change_pwd BOOLEAN NOT NULL DEFAULT false,
  disabled        BOOLEAN NOT NULL DEFAULT false,
  -- Registro original completo (domicilio, convenio, etc.)
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Legajo único POR empresa (NO global) + DNI único para login.
  CONSTRAINT uq_empleado_empresa_leg UNIQUE (empresa_id, leg_num),
  CONSTRAINT uq_empleado_dni UNIQUE (dni)
);

CREATE INDEX IF NOT EXISTS idx_empleados_empresa ON empleados(empresa_id);
CREATE INDEX IF NOT EXISTS idx_empleados_dni     ON empleados(dni);
CREATE INDEX IF NOT EXISTS idx_empleados_nom     ON empleados(nom);

-- trigger para updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_empleados_updated ON empleados;
CREATE TRIGGER trg_empleados_updated BEFORE UPDATE ON empleados
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Mensajes (RR.HH. → empleado, o broadcast) ──
CREATE TABLE IF NOT EXISTS mensajes (
  id          SERIAL PRIMARY KEY,
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE CASCADE,  -- NULL = para todos
  titulo      TEXT NOT NULL,
  cuerpo      TEXT NOT NULL,
  autor       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Mensajería bidireccional: empleado -> RR.HH. (a_rrhh) y RR.HH. -> empleado/broadcast (a_empleado)
ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS direccion      TEXT NOT NULL DEFAULT 'a_empleado';
ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS remitente_id   INTEGER REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS estado         TEXT NOT NULL DEFAULT 'nuevo';
ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS borrar_al_leer BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_mensajes_empleado ON mensajes(empleado_id);

-- ── CBUs del empleado ──
CREATE TABLE IF NOT EXISTS cbus (
  id          SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  cbu         TEXT NOT NULL,
  banco       TEXT,
  alias       TEXT,
  titular     TEXT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Porcentaje del neto que se acredita en cada cuenta (la suma de las activas debe dar 100%)
ALTER TABLE cbus ADD COLUMN IF NOT EXISTS porcentaje NUMERIC(5,2) NOT NULL DEFAULT 100;
-- Historial de vigencia: vigencia_hasta NULL = cuenta activa.
ALTER TABLE cbus ADD COLUMN IF NOT EXISTS vigencia_desde TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE cbus ADD COLUMN IF NOT EXISTS vigencia_hasta TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_cbus_empleado ON cbus(empleado_id);

-- ── Adelantos / anticipos ──
CREATE TABLE IF NOT EXISTS anticipos (
  id           SERIAL PRIMARY KEY,
  empleado_id  INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  monto        NUMERIC(14,2) NOT NULL,
  motivo       TEXT,
  cuotas       INTEGER NOT NULL DEFAULT 1,
  estado       TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente | aprobado | rechazado
  resuelto_por TEXT,
  resuelto_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Período (YYYY-MM) de la primera cuota de descuento del anticipo.
ALTER TABLE anticipos ADD COLUMN IF NOT EXISTS cuota_desde TEXT;
ALTER TABLE anticipos ADD COLUMN IF NOT EXISTS recomendacion TEXT;       -- favorable | desfavorable (visto bueno del gerente)
ALTER TABLE anticipos ADD COLUMN IF NOT EXISTS recomendado_por TEXT;
ALTER TABLE anticipos ADD COLUMN IF NOT EXISTS recomendado_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_anticipos_empleado ON anticipos(empleado_id);
CREATE INDEX IF NOT EXISTS idx_anticipos_estado ON anticipos(estado);

-- ── Parámetros de liquidación (fila única id=1) ──
CREATE TABLE IF NOT EXISTS parametros_liq (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT parametros_singleton CHECK (id = 1)
);

-- ── Catálogo de conceptos de liquidación ──
CREATE TABLE IF NOT EXISTS conceptos (
  id          SERIAL PRIMARY KEY,
  codigo      TEXT NOT NULL UNIQUE,
  descripcion TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'remunerativo',  -- remunerativo|no_remunerativo|descuento|aporte|contribucion
  formula     TEXT,
  base_legal  TEXT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conceptos_tipo ON conceptos(tipo);
DROP TRIGGER IF EXISTS trg_conceptos_updated ON conceptos;
CREATE TRIGGER trg_conceptos_updated BEFORE UPDATE ON conceptos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Recibos liquidados (guardados) ──
CREATE TABLE IF NOT EXISTS recibos (
  id          SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  anio        INTEGER NOT NULL,
  mes         INTEGER NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'mensual',
  neto        NUMERIC(14,2) NOT NULL DEFAULT 0,
  data        JSONB NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_recibo UNIQUE (empleado_id, anio, mes, tipo)
);
ALTER TABLE recibos ADD COLUMN IF NOT EXISTS corrida_id INTEGER;
ALTER TABLE recibos ADD COLUMN IF NOT EXISTS publicado  BOOLEAN NOT NULL DEFAULT false;

-- ── Corridas de liquidación (planilla por período/tipo con estados) ──
CREATE TABLE IF NOT EXISTS corridas (
  id          SERIAL PRIMARY KEY,
  anio        INTEGER NOT NULL,
  mes         INTEGER NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'mensual',
  empresa     TEXT,                              -- NULL = todas
  estado      TEXT NOT NULL DEFAULT 'borrador',  -- borrador | aprobada | publicada
  total_neto  NUMERIC(16,2) NOT NULL DEFAULT 0,
  cant        INTEGER NOT NULL DEFAULT 0,
  creado_por  TEXT,
  aprobado_por TEXT,
  aprobado_at  TIMESTAMPTZ,
  publicado_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recibos_corrida ON recibos(corrida_id);
CREATE INDEX IF NOT EXISTS idx_recibos_empleado ON recibos(empleado_id);

-- ── Licencias (solicitud + aprobación) ──
CREATE TABLE IF NOT EXISTS licencias (
  id           SERIAL PRIMARY KEY,
  empleado_id  INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,
  desde        DATE NOT NULL,
  hasta        DATE NOT NULL,
  dias         INTEGER NOT NULL DEFAULT 1,
  motivo       TEXT,
  estado       TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | aprobada | rechazada
  resuelto_por TEXT,
  resuelto_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Comprobante adjunto para justificar licencias (imprevisibles, etc.)
ALTER TABLE licencias ADD COLUMN IF NOT EXISTS comprobante_nombre TEXT;
ALTER TABLE licencias ADD COLUMN IF NOT EXISTS comprobante_mime   TEXT;
ALTER TABLE licencias ADD COLUMN IF NOT EXISTS comprobante_data   TEXT;
ALTER TABLE licencias ADD COLUMN IF NOT EXISTS justificacion      BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_licencias_empleado ON licencias(empleado_id);
CREATE INDEX IF NOT EXISTS idx_licencias_estado ON licencias(estado);

-- ── Sanciones disciplinarias ──
CREATE TABLE IF NOT EXISTS sanciones (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  fecha DATE NOT NULL,
  dias INTEGER NOT NULL DEFAULT 0,
  descripcion TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sanciones_empleado ON sanciones(empleado_id);

-- ── Evaluaciones de desempeño ──
CREATE TABLE IF NOT EXISTS evaluaciones (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  periodo TEXT NOT NULL,
  tipo TEXT,
  calificacion TEXT,
  comentarios TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS datos JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE evaluaciones ADD COLUMN IF NOT EXISTS promedio NUMERIC(4,2);
CREATE INDEX IF NOT EXISTS idx_evaluaciones_empleado ON evaluaciones(empleado_id);

-- Sanciones: campos agregados (falta cometida + estado del flujo)
ALTER TABLE sanciones ADD COLUMN IF NOT EXISTS falta TEXT;
ALTER TABLE sanciones ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'aplicada';
ALTER TABLE sanciones ADD COLUMN IF NOT EXISTS resuelto_por TEXT;

ALTER TABLE sanciones ADD COLUMN IF NOT EXISTS fecha_notificacion DATE;
ALTER TABLE sanciones ADD COLUMN IF NOT EXISTS fecha_cumplimiento DATE;

-- ── Certificados de trabajo (solicitud → generación RR.HH.) ──
CREATE TABLE IF NOT EXISTS certificados (
  id           SERIAL PRIMARY KEY,
  empleado_id  INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  destinatario TEXT,
  campos       JSONB NOT NULL DEFAULT '{}'::jsonb,
  estado       TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | generado | rechazado
  motivo       TEXT,
  generado_por TEXT,
  generado_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_certificados_empleado ON certificados(empleado_id);

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS logo TEXT;

-- ── Auditoría (acciones administrativas) ──
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  actor_dni  TEXT,
  accion     TEXT NOT NULL,
  detalle    TEXT,
  target     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS firma TEXT;

-- ── Elementos de trabajo (activos entregados) ──
CREATE TABLE IF NOT EXISTS elementos_trabajo (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  descripcion TEXT,
  identificador TEXT,
  estado TEXT NOT NULL DEFAULT 'entregado',
  fecha_entrega DATE,
  fecha_devolucion DATE,
  observaciones TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_elem_empleado ON elementos_trabajo(empleado_id);

-- ── Beneficios por empleado ──
CREATE TABLE IF NOT EXISTS beneficios (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  modalidad TEXT,
  monto NUMERIC(14,2) DEFAULT 0,
  proveedor TEXT,
  vigencia_desde DATE,
  vigencia_hasta DATE,
  detalle TEXT,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_benef_empleado ON beneficios(empleado_id);

-- ── Cambios de domicilio (informados por el empleado → aprueba RR.HH.) ──
CREATE TABLE IF NOT EXISTS cambios_domicilio (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  calle TEXT, nro TEXT, piso TEXT, depto TEXT, loc TEXT, prov TEXT, cp TEXT,
  dom_anterior TEXT, dom_nuevo TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  resuelto_por TEXT, resuelto_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_camdom_empleado ON cambios_domicilio(empleado_id);

-- ── Grupo familiar declarado por el empleado ──
CREATE TABLE IF NOT EXISTS familiares (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  nombre TEXT NOT NULL,
  dni TEXT,
  cuil TEXT,
  fecha_nac DATE,
  fecha_vinculo DATE,
  discapacidad BOOLEAN NOT NULL DEFAULT false,
  vigencia_desde DATE NOT NULL DEFAULT CURRENT_DATE,
  vigencia_hasta DATE,
  motivo_cierre TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_familiares_empleado ON familiares(empleado_id);
ALTER TABLE familiares ADD COLUMN IF NOT EXISTS apellido TEXT;
ALTER TABLE familiares ADD COLUMN IF NOT EXISTS genero TEXT;

-- ── Escalas salariales / convenios (versiones por paritaria) ──
CREATE TABLE IF NOT EXISTS escala_versiones (
  id          SERIAL PRIMARY KEY,
  vigencia    DATE NOT NULL,
  mes_label   TEXT,
  origen      TEXT NOT NULL DEFAULT 'inicial',   -- inicial | incremento
  porcentaje  NUMERIC(6,2),
  alcance     TEXT NOT NULL DEFAULT 'todas',
  comentario  TEXT,
  data        JSONB NOT NULL,                    -- { tramos, categorias, regionales, montos_titulo }
  creado_por  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escala_vigencia ON escala_versiones(vigencia);

-- ── Convenios / escalas por sindicato (SEC, UOM, UOCRA, UECARA, ASIMRA, UOYEP…) ──
CREATE TABLE IF NOT EXISTS convenios (
  id         SERIAL PRIMARY KEY,
  codigo     TEXT NOT NULL UNIQUE,
  nombre     TEXT NOT NULL,
  cct        TEXT,
  vigencia   DATE,
  data       JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Versiones por sindicato (histórico de paritarias / ediciones)
CREATE TABLE IF NOT EXISTS convenio_versiones (
  id          SERIAL PRIMARY KEY,
  codigo      TEXT NOT NULL,
  vigencia    DATE NOT NULL,
  mes_label   TEXT,
  origen      TEXT NOT NULL DEFAULT 'inicial',   -- inicial | porcentaje | monto | edicion
  porcentaje  NUMERIC(8,2),
  monto       NUMERIC(14,2),
  comentario  TEXT,
  data        JSONB NOT NULL,                    -- snapshot { tablas, adicionales, noRemunerativos }
  creado_por  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_ver_codigo ON convenio_versiones(codigo, vigencia);

-- ── ART por empresa (contratos + histórico de alícuotas) ──
CREATE TABLE IF NOT EXISTS art_contratos (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  art_codigo   TEXT NOT NULL,
  art_nombre   TEXT NOT NULL,
  nro_contrato TEXT,
  fecha_inicio DATE,
  fecha_fin    DATE,
  activo       BOOLEAN NOT NULL DEFAULT true,
  alicuotas    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ desde, pct, nota }]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_art_empresa ON art_contratos(empresa_id);

-- ── Cuotas de anticipos efectivamente aplicadas en cada liquidación (auditoría) ──
CREATE TABLE IF NOT EXISTS anticipo_cuotas (
  id          SERIAL PRIMARY KEY,
  anticipo_id INTEGER NOT NULL REFERENCES anticipos(id) ON DELETE CASCADE,
  recibo_id   INTEGER,
  corrida_id  INTEGER,
  anio        INTEGER NOT NULL,
  mes         INTEGER NOT NULL,
  nro         INTEGER,
  monto       NUMERIC(14,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_anticipo_cuota UNIQUE (anticipo_id, anio, mes)
);
CREATE INDEX IF NOT EXISTS idx_anticipo_cuotas_ant ON anticipo_cuotas(anticipo_id);
-- ── Logs de visualización de recibos por el empleado ──
CREATE TABLE IF NOT EXISTS recibo_vistas (
  id          SERIAL PRIMARY KEY,
  recibo_id   INTEGER NOT NULL REFERENCES recibos(id) ON DELETE CASCADE,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recibo_vistas ON recibo_vistas(recibo_id);
-- ── Parámetros del Impuesto a las Ganancias por período (editables por RR.HH.) ──
CREATE TABLE IF NOT EXISTS ganancias_periodos (
  id                   SERIAL PRIMARY KEY,
  periodo              TEXT NOT NULL UNIQUE,
  vigencia_desde       DATE NOT NULL,
  rg                   TEXT,
  mni_anual            NUMERIC(16,2) NOT NULL DEFAULT 0,
  ded_esp_anual        NUMERIC(16,2) NOT NULL DEFAULT 0,
  ded_esp2_anual       NUMERIC(16,2) NOT NULL DEFAULT 0,
  carga_conyuge_anual  NUMERIC(16,2) NOT NULL DEFAULT 0,
  carga_hijo_anual     NUMERIC(16,2) NOT NULL DEFAULT 0,
  carga_hijo_inc_anual NUMERIC(16,2) NOT NULL DEFAULT 0,
  escala               JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ desde, hasta, fijo, alicuota }]
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ── Catálogo de sindicatos (parámetros de aportes) ──
CREATE TABLE IF NOT EXISTS sindicatos (
  id                    SERIAL PRIMARY KEY,
  codigo                TEXT NOT NULL UNIQUE,
  nombre                TEXT NOT NULL,
  pct_empleado          NUMERIC(6,2) NOT NULL DEFAULT 0,
  pct_patronal          NUMERIC(6,2) NOT NULL DEFAULT 0,
  pct_antig_por_anio    NUMERIC(6,2) NOT NULL DEFAULT 1,
  nota                  TEXT,
  tiene_adicional_titulo BOOLEAN NOT NULL DEFAULT false,
  pres_base             TEXT NOT NULL DEFAULT 'basico',
  updated_by            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ── Higiene y Seguridad: capacitaciones y entregas de EPP ──
CREATE TABLE IF NOT EXISTS hys_capacitaciones (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  codigo TEXT, nombre TEXT NOT NULL, fecha DATE NOT NULL, vigencia_meses INTEGER,
  dictada_por TEXT, observaciones TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hys_cap_emp ON hys_capacitaciones(empleado_id);
CREATE TABLE IF NOT EXISTS hys_epp_entregas (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  codigo TEXT, nombre TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 1, talle TEXT,
  fecha DATE NOT NULL, observaciones TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hys_epp_emp ON hys_epp_entregas(empleado_id);
-- ── Reglamento interno (vacaciones por antigüedad + licencias especiales) ──
CREATE TABLE IF NOT EXISTS reglamento (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reglamento_singleton CHECK (id = 1)
);
-- ── Cierre de períodos (bloqueo de liquidación por empresa + período) ──
CREATE TABLE IF NOT EXISTS cierres_periodo (
  id SERIAL PRIMARY KEY,
  empresa TEXT NOT NULL,
  anio INTEGER NOT NULL,
  mes INTEGER NOT NULL,
  cerrado_por TEXT,
  cerrado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cierre UNIQUE (empresa, anio, mes)
);
-- ── Novedades de CBU (avisos a RR.HH. cuando el empleado modifica sus cuentas) ──
CREATE TABLE IF NOT EXISTS cbu_novedades (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  accion TEXT NOT NULL, detalle TEXT, leida BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cbu_nov_leida ON cbu_novedades(leida);
-- ── Diseños de registro de bancos (versionados) + log de generaciones ──
CREATE TABLE IF NOT EXISTS banco_disenos (
  codigo          TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  formato         TEXT NOT NULL DEFAULT 'CSV',     -- CSV | TXT
  version         INTEGER NOT NULL DEFAULT 1,
  descripcion     TEXT,
  actualizado_por TEXT,
  actualizado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS banco_generaciones (
  id             SERIAL PRIMARY KEY,
  banco          TEXT NOT NULL,
  version_diseno INTEGER NOT NULL,
  corrida_id     INTEGER,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_banco_gen ON banco_generaciones(banco, created_at DESC);

-- ── Plan de cuentas contables del asiento de sueldos (configurable) ──
CREATE TABLE IF NOT EXISTS plan_cuentas (
  id          SERIAL PRIMARY KEY,
  numero      TEXT NOT NULL,
  nombre      TEXT NOT NULL,
  naturaleza  TEXT NOT NULL DEFAULT 'debe',          -- debe | haber
  componentes JSONB NOT NULL DEFAULT '[]'::jsonb,     -- ['remun','contrib',...]
  orden       INTEGER NOT NULL DEFAULT 0,
  activo      BOOLEAN NOT NULL DEFAULT true
);

-- ── Fichadas importadas desde Pro-Soft (Reporte Marcas Extendido) ──
-- Novedades de asistencia consolidadas por empleado y período. El cruce con
-- Pro-Soft es por legajo (allá sin ceros a la izquierda; acá leg_num zero-pad).
-- En esta etapa las horas extra son INFORMATIVAS (no entran a la liquidación).
CREATE TABLE IF NOT EXISTS fichadas_periodo (
  id            SERIAL PRIMARY KEY,
  empleado_id   INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  anio          INTEGER NOT NULL,
  mes           INTEGER NOT NULL,
  -- { diasTrabajados, horasExtra50Min, horasExtra100Min, tardanzasMin,
  --   hsNetasMin, diasARevisar:[{fecha,motivo}], legajoProsoft, empresaProsoft }
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  origen        TEXT NOT NULL DEFAULT 'prosoft-extendido',
  importado_por TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_fichadas_emp_periodo UNIQUE (empleado_id, anio, mes)
);
CREATE INDEX IF NOT EXISTS idx_fichadas_periodo ON fichadas_periodo(anio, mes);

DROP TRIGGER IF EXISTS trg_fichadas_updated ON fichadas_periodo;
CREATE TRIGGER trg_fichadas_updated BEFORE UPDATE ON fichadas_periodo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Log de cada importación (auditoría): cuántos cruzaron, sin match, a revisar.
CREATE TABLE IF NOT EXISTS fichadas_importaciones (
  id            SERIAL PRIMARY KEY,
  anio          INTEGER NOT NULL,
  mes           INTEGER NOT NULL,
  archivo       TEXT,
  filas         INTEGER NOT NULL DEFAULT 0,
  legajos       INTEGER NOT NULL DEFAULT 0,
  matcheados    INTEGER NOT NULL DEFAULT 0,
  sin_match     INTEGER NOT NULL DEFAULT 0,
  importado_por TEXT,
  detalle       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fichadas_imp ON fichadas_importaciones(anio, mes, created_at DESC);

-- ── DDJJ sindical: diseños de registro versionados por sindicato + jurisdicción ──
CREATE TABLE IF NOT EXISTS ddjj_disenos (
  id SERIAL PRIMARY KEY,
  sindicato TEXT NOT NULL,
  jurisdiccion TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  descripcion TEXT,
  actualizado_por TEXT,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sindicato, jurisdiccion)
);
CREATE TABLE IF NOT EXISTS ddjj_generaciones (
  id SERIAL PRIMARY KEY,
  sindicato TEXT NOT NULL, jurisdiccion TEXT NOT NULL,
  version_diseno INTEGER NOT NULL, anio INTEGER, mes INTEGER,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ddjj_gen ON ddjj_generaciones(sindicato, jurisdiccion, created_at DESC);
