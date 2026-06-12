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
CREATE INDEX IF NOT EXISTS idx_licencias_empleado ON licencias(empleado_id);
CREATE INDEX IF NOT EXISTS idx_licencias_estado ON licencias(estado);
