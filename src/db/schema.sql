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
