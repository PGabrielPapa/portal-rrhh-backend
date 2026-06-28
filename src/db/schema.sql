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
ALTER TABLE recibos ADD COLUMN IF NOT EXISTS pagado     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recibos ADD COLUMN IF NOT EXISTS pagado_at  TIMESTAMPTZ;
ALTER TABLE recibos ADD COLUMN IF NOT EXISTS pagado_por TEXT;

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

-- ── Bajas de empleados (datos del cese para la liquidación final) ──
CREATE TABLE IF NOT EXISTS bajas (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  fecha_baja DATE NOT NULL,
  causa TEXT NOT NULL,
  fecha_notificacion DATE,
  preaviso_override TEXT,
  gratificacion NUMERIC(14,2) NOT NULL DEFAULT 0,
  gratif_cuotas JSONB NOT NULL DEFAULT '[]'::jsonb,
  observaciones TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bajas_empleado ON bajas(empleado_id);

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
ALTER TABLE sanciones ADD COLUMN IF NOT EXISTS notif_nombre TEXT;
ALTER TABLE sanciones ADD COLUMN IF NOT EXISTS notif_mime   TEXT;
ALTER TABLE sanciones ADD COLUMN IF NOT EXISTS notif_data   TEXT;

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
ALTER TABLE elementos_trabajo ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;

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

-- ── Cambios de datos personales/contacto autogestionados por el empleado ──
-- (impacto directo, con histórico y conocimiento de RR.HH. vía audit_log + ABM)
CREATE TABLE IF NOT EXISTS cambios_perfil (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  campo TEXT NOT NULL,
  etiqueta TEXT,
  valor_anterior TEXT,
  valor_nuevo TEXT,
  origen TEXT NOT NULL DEFAULT 'empleado',
  actor_dni TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_camperfil_empleado ON cambios_perfil(empleado_id, created_at DESC);

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  Comité de Higiene y Seguridad (REG-002-CHS)                       ║
-- ╚══════════════════════════════════════════════════════════════════╝
-- Minutas de las reuniones del Comité de HyS.
CREATE TABLE IF NOT EXISTS chs_minutas (
  id            SERIAL PRIMARY KEY,
  comite        TEXT,
  fecha         DATE,
  participantes TEXT,
  temas         TEXT,
  decisiones    TEXT,
  observaciones TEXT,
  acciones      JSONB NOT NULL DEFAULT '[]'::jsonb,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chs_minutas_fecha ON chs_minutas(fecha DESC);

-- Política de HyS: versiones (control de versiones + vigencia + archivo firmado).
CREATE TABLE IF NOT EXISTS chs_politica (
  id SERIAL PRIMARY KEY,
  version TEXT, vigencia DATE, comentario TEXT, vigente BOOLEAN NOT NULL DEFAULT false,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Registro de difusión de la política al personal.
CREATE TABLE IF NOT EXISTS chs_difusion (
  id SERIAL PRIMARY KEY,
  fecha DATE, alcance TEXT, observacion TEXT,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Siniestros (ART y Medicina Laboral): accidentes, in itinere, enfermedades profesionales, incidentes.
CREATE TABLE IF NOT EXISTS chs_siniestros (
  id SERIAL PRIMARY KEY,
  tipo TEXT,
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  fecha DATE, lugar TEXT,
  descripcion TEXT, causas TEXT, acciones TEXT,
  estado TEXT NOT NULL DEFAULT 'Abierto',
  art_nro TEXT, dias_baja INTEGER,
  seguimientos JSONB NOT NULL DEFAULT '[]'::jsonb,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chs_sin_fecha ON chs_siniestros(fecha DESC);

-- Mediciones de HyS (obligatorias): tipo, responsable, realización, vencimiento, resultado, informe.
CREATE TABLE IF NOT EXISTS chs_mediciones (
  id SERIAL PRIMARY KEY,
  tipo TEXT, empresa TEXT, lugar TEXT, empresa_responsable TEXT,
  fecha_realizacion DATE, fecha_vencimiento DATE,
  resultado TEXT,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chs_med_venc ON chs_mediciones(fecha_vencimiento);

-- Auditorías e inspecciones (con acciones correctivas y cierre).
CREATE TABLE IF NOT EXISTS chs_auditorias (
  id SERIAL PRIMARY KEY,
  fecha DATE, tipo TEXT, responsable TEXT, sector TEXT,
  observaciones TEXT, no_conformidades TEXT,
  acciones JSONB NOT NULL DEFAULT '[]'::jsonb,
  estado TEXT NOT NULL DEFAULT 'Abierta',
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chs_aud_fecha ON chs_auditorias(fecha DESC);

-- No conformidades y oportunidades de mejora.
CREATE TABLE IF NOT EXISTS chs_noconf (
  id SERIAL PRIMARY KEY,
  fecha DATE, sector TEXT, descripcion TEXT,
  clasificacion TEXT, prioridad TEXT,
  accion TEXT, responsable TEXT, fecha_cierre DATE,
  estado TEXT NOT NULL DEFAULT 'Abierta',
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chs_nc_fecha ON chs_noconf(fecha DESC);

-- Cartelería de seguridad (con evidencia fotográfica).
CREATE TABLE IF NOT EXISTS chs_carteleria (
  id SERIAL PRIMARY KEY,
  tipo TEXT, ubicacion TEXT, fecha_instalacion DATE, estado_conservacion TEXT, fecha_revision DATE,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Evidencias de mejoras implementadas (con evidencia fotográfica o documental).
CREATE TABLE IF NOT EXISTS chs_evidencias (
  id SERIAL PRIMARY KEY,
  descripcion TEXT, motivo TEXT, fecha DATE, responsable TEXT, estado TEXT NOT NULL DEFAULT 'Implementada', resultado TEXT,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chs_evi_fecha ON chs_evidencias(fecha DESC);

-- Plan Anual de Capacitaciones (PAC) — seguimiento del cumplimiento.
CREATE TABLE IF NOT EXISTS chs_capacitaciones (
  id SERIAL PRIMARY KEY,
  capacitacion TEXT, empresa TEXT, sector TEXT, fecha DATE, temario TEXT,
  asistentes TEXT, evaluacion TEXT, estado TEXT NOT NULL DEFAULT 'Pendiente',
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chs_cap_fecha ON chs_capacitaciones(fecha DESC);

-- EPP: matriz por puesto.
CREATE TABLE IF NOT EXISTS chs_epp_matriz (
  id SERIAL PRIMARY KEY,
  puesto TEXT, elementos TEXT, observaciones TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EPP: registro de entregas (con constancia firmada).
CREATE TABLE IF NOT EXISTS chs_epp_entregas (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  puesto TEXT, elementos TEXT, fecha_entrega DATE, fecha_reposicion DATE, observaciones TEXT,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chs_eppent_fecha ON chs_epp_entregas(fecha_entrega DESC);

-- Matriz de riesgos por proceso/tarea.
CREATE TABLE IF NOT EXISTS chs_riesgos (
  id SERIAL PRIMARY KEY,
  proceso TEXT, sector TEXT, descripcion TEXT, riesgos TEXT, medidas TEXT, epp_obligatorio TEXT,
  responsable_revision TEXT, fecha_revision DATE,
  archivo_nombre TEXT, archivo_mime TEXT, archivo_data TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
-- ── Histórico de cambios de parámetros de Ganancias (para re-liquidar) ──
CREATE TABLE IF NOT EXISTS ganancias_periodos_hist (
  id                   SERIAL PRIMARY KEY,
  periodo_id           INTEGER,
  periodo              TEXT,
  vigencia_desde       DATE,
  rg                   TEXT,
  mni_anual            NUMERIC(16,2),
  ded_esp_anual        NUMERIC(16,2),
  ded_esp2_anual       NUMERIC(16,2),
  carga_conyuge_anual  NUMERIC(16,2),
  carga_hijo_anual     NUMERIC(16,2),
  carga_hijo_inc_anual NUMERIC(16,2),
  escala               JSONB,
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ,
  snapshot_by          TEXT,
  snapshot_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gan_hist_periodo ON ganancias_periodos_hist(periodo_id);
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
  titulo_secundario     NUMERIC(12,2) NOT NULL DEFAULT 0,
  titulo_universitario  NUMERIC(12,2) NOT NULL DEFAULT 0,
  pres_base             TEXT NOT NULL DEFAULT 'basico',
  updated_by            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS titulo_secundario    NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS titulo_universitario NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE sindicatos ADD COLUMN IF NOT EXISTS pct_presentismo      NUMERIC(6,2) NOT NULL DEFAULT 0;
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
-- ── Histórico de cambios del reglamento / licencias ──
CREATE TABLE IF NOT EXISTS reglamento_hist (
  id          SERIAL PRIMARY KEY,
  data        JSONB,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ,
  snapshot_by TEXT,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- ── Circuito de aprobación (doble control) de novedades de fichadas ──
-- Flujo: pendiente → (RR.HH. acepta) aprob_rrhh → (responsable directo / CEO-admin acepta) autorizada.
-- Rechazo en cualquier etapa → observada (con comentario). Solo 'autorizada' es liquidable.
ALTER TABLE fichadas_periodo ADD COLUMN IF NOT EXISTS estado   TEXT NOT NULL DEFAULT 'pendiente';
ALTER TABLE fichadas_periodo ADD COLUMN IF NOT EXISTS rrhh_por TEXT;          -- DNI/usuario RR.HH. que aceptó
ALTER TABLE fichadas_periodo ADD COLUMN IF NOT EXISTS rrhh_at  TIMESTAMPTZ;
ALTER TABLE fichadas_periodo ADD COLUMN IF NOT EXISTS rrhh_obs TEXT;          -- observación si RR.HH. rechaza
ALTER TABLE fichadas_periodo ADD COLUMN IF NOT EXISTS ger_por  TEXT;          -- responsable directo / CEO que aceptó
ALTER TABLE fichadas_periodo ADD COLUMN IF NOT EXISTS ger_at   TIMESTAMPTZ;
ALTER TABLE fichadas_periodo ADD COLUMN IF NOT EXISTS ger_obs  TEXT;          -- observación si el gerente rechaza
CREATE INDEX IF NOT EXISTS idx_fichadas_estado ON fichadas_periodo(anio, mes, estado);

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

-- ── Períodos de evaluación de desempeño (los abre RR.HH., típicamente en octubre) ──
CREATE TABLE IF NOT EXISTS evaluacion_periodos (
  id SERIAL PRIMARY KEY,
  anio INTEGER NOT NULL UNIQUE,
  tipo TEXT NOT NULL DEFAULT 'anual',
  abierto BOOLEAN NOT NULL DEFAULT true,
  abierto_por TEXT, abierto_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_por TEXT, cerrado_at TIMESTAMPTZ
);

-- ── F.931 / SICOSS: diseño de registro versionado (ARCA) + log de generaciones ──
CREATE TABLE IF NOT EXISTS sicoss_diseno (
  id INTEGER PRIMARY KEY DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  descripcion TEXT,
  url_arca TEXT,
  actualizado_por TEXT,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sicoss_unica CHECK (id = 1)
);
CREATE TABLE IF NOT EXISTS sicoss_generaciones (
  id SERIAL PRIMARY KEY, version_diseno INTEGER NOT NULL, anio INTEGER, mes INTEGER,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sicoss_generaciones ADD COLUMN IF NOT EXISTS empresa TEXT;
ALTER TABLE sicoss_generaciones ADD COLUMN IF NOT EXISTS cantidad INTEGER;
ALTER TABLE sicoss_generaciones ADD COLUMN IF NOT EXISTS archivo BOOLEAN NOT NULL DEFAULT false;

-- ── Libro de Sueldos Digital (LSD): diseño de registro versionado (ARCA) + log ──
CREATE TABLE IF NOT EXISTS lsd_diseno (
  id INTEGER PRIMARY KEY DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  descripcion TEXT,
  url_arca TEXT,
  actualizado_por TEXT,
  actualizado_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lsd_unica CHECK (id = 1)
);
CREATE TABLE IF NOT EXISTS lsd_generaciones (
  id SERIAL PRIMARY KEY, version_diseno INTEGER NOT NULL, anio INTEGER, mes INTEGER,
  empresa TEXT, cantidad INTEGER, archivo BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tablas de codigos de ARCA/AFIP (desplegables del ABM y SICOSS)
-- tipo: situacion | condicion | actividad | modalidad | zona
CREATE TABLE IF NOT EXISTS codigos_afip (
  tipo   TEXT NOT NULL,
  codigo INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (tipo, codigo)
);
CREATE INDEX IF NOT EXISTS idx_codigos_afip_tipo ON codigos_afip(tipo);

-- Padron de obras sociales (RNOS).
CREATE TABLE IF NOT EXISTS obras_sociales (
  codigo        TEXT PRIMARY KEY,
  codigo_sicoss TEXT,
  nombre        TEXT NOT NULL,
  activo        BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS arca_tablas_meta (
  id INTEGER PRIMARY KEY DEFAULT 1,
  ultimo_chequeo_at TIMESTAMPTZ,
  detalle TEXT,
  CONSTRAINT arca_meta_unica CHECK (id = 1)
);

-- Cambios de obra social del empleado (con historico, patron cambios_domicilio)
CREATE TABLE IF NOT EXISTS cambios_obra_social (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  os_codigo TEXT, os_nombre TEXT,
  os_anterior_codigo TEXT, os_anterior_nombre TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  origen TEXT NOT NULL DEFAULT 'empleado',
  resuelto_por TEXT, resuelto_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_camos_empleado ON cambios_obra_social(empleado_id);

-- ── Higiene y Seguridad: catálogo editable + manuales/documentos ──
-- tipo: capacitacion | epp | talle.  extra: { obligatorio, vigencia_meses, categoria }
CREATE TABLE IF NOT EXISTS hys_catalogo (
  tipo   TEXT NOT NULL,
  codigo TEXT NOT NULL,
  nombre TEXT NOT NULL,
  extra  JSONB NOT NULL DEFAULT '{}'::jsonb,
  activo BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (tipo, codigo)
);
CREATE TABLE IF NOT EXISTS hys_manuales (
  id SERIAL PRIMARY KEY,
  titulo TEXT NOT NULL,
  categoria TEXT,
  descripcion TEXT,
  archivo TEXT,                                  -- contenido base64
  mime TEXT,
  filename TEXT,
  tamano INTEGER,
  visible_empleado BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- tipo de documento: 'manual' | 'catalogo'
ALTER TABLE hys_manuales ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'manual';
-- Acuse de recibo / confirmación de lectura por empleado (constancia H&S).
CREATE TABLE IF NOT EXISTS hys_manual_acuses (
  manual_id   INTEGER NOT NULL REFERENCES hys_manuales(id) ON DELETE CASCADE,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manual_id, empleado_id)
);
-- Histórico de cambios de talles del empleado.
CREATE TABLE IF NOT EXISTS hys_talles_historial (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  anterior JSONB, nuevo JSONB, cambios TEXT,
  origen TEXT NOT NULL DEFAULT 'empleado',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hys_talles_hist_emp ON hys_talles_historial(empleado_id);

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  Modelo en capas: Personas (capa 1) → Períodos de prestación      ║
-- ║  (capa 2). Aditivo: empleados sigue operando; persona_id la liga. ║
-- ╚══════════════════════════════════════════════════════════════════╝
-- Capa 1: Personas (familiares, prestadores, postulantes, empleados, etc.).
CREATE TABLE IF NOT EXISTS personas (
  id SERIAL PRIMARY KEY,
  cuil TEXT,
  dni TEXT NOT NULL,
  apellido TEXT, nombres TEXT, nom TEXT,
  tipos TEXT[] NOT NULL DEFAULT '{}',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_personas_cuil ON personas(cuil) WHERE cuil IS NOT NULL AND cuil <> '';
CREATE INDEX IF NOT EXISTS idx_personas_dni ON personas(dni);

-- Liga empleados (capa operativa) con su persona.
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS persona_id INTEGER REFERENCES personas(id);
CREATE INDEX IF NOT EXISTS idx_empleados_persona ON empleados(persona_id);

-- Capa 2: Períodos de prestación laboral (reingresos, cambios de empresa/legajo).
CREATE TABLE IF NOT EXISTS periodos (
  id SERIAL PRIMARY KEY,
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  empresa_id INTEGER REFERENCES empresas(id),
  legajo TEXT,
  fecha_ingreso DATE, fecha_egreso DATE, causa_egreso TEXT,
  funcion TEXT, cat_escala TEXT, tramo_escala TEXT, cat_convenio TEXT, cod_convenio TEXT, cod_sindicato TEXT,
  vigente BOOLEAN NOT NULL DEFAULT true,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_periodos_persona ON periodos(persona_id);
CREATE INDEX IF NOT EXISTS idx_periodos_empleado ON periodos(empleado_id);

-- Histórico de cambios dentro de un período (función, categoría escala/convenio, etc.).
CREATE TABLE IF NOT EXISTS periodo_cambios (
  id SERIAL PRIMARY KEY,
  periodo_id INTEGER NOT NULL REFERENCES periodos(id) ON DELETE CASCADE,
  campo TEXT NOT NULL, etiqueta TEXT,
  valor_anterior TEXT, valor_nuevo TEXT,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  motivo TEXT, created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_percambios_periodo ON periodo_cambios(periodo_id, created_at DESC);

-- Acceso al Comité de HyS a nivel Persona (login por DNI sin ser empleado).
ALTER TABLE personas ADD COLUMN IF NOT EXISTS acceso_comite   TEXT;    -- null | 'dashboard' | 'full'
ALTER TABLE personas ADD COLUMN IF NOT EXISTS password_hash   TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS must_change_pwd BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS disabled        BOOLEAN NOT NULL DEFAULT false;

-- Reingresos / cambios de empresa: una persona (DNI) puede tener varios períodos
-- (varias filas en empleados). Se relaja el DNI único; el legajo sigue único por empresa.
ALTER TABLE empleados DROP CONSTRAINT IF EXISTS uq_empleado_dni;

-- El DNI de persona pasa a ser opcional (familiares/postulantes pueden no tenerlo; el CUIL sigue siendo la identidad única).
ALTER TABLE personas ALTER COLUMN dni DROP NOT NULL;

-- ── SIRADIG (F.572 web): deducciones declaradas por el trabajador para Ganancias ──
-- Una fila por CUIL + año = la ULTIMA presentación (mayor nroPresentacion). Estructura fiel al XML de ARCA.
CREATE TABLE IF NOT EXISTS siradig_presentaciones (
  id SERIAL PRIMARY KEY,
  cuil TEXT NOT NULL,
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  nom TEXT,
  anio INTEGER NOT NULL,
  nro_presentacion INTEGER NOT NULL DEFAULT 0,
  fecha_presentacion DATE,
  version TEXT,
  empleado_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  cargas_familia JSONB NOT NULL DEFAULT '[]'::jsonb,
  deducciones JSONB NOT NULL DEFAULT '[]'::jsonb,
  total NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_por_mes JSONB NOT NULL DEFAULT '{}'::jsonb,
  archivo_nombre TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_siradig UNIQUE (cuil, anio)
);
CREATE INDEX IF NOT EXISTS idx_siradig_periodo ON siradig_presentaciones(anio);
CREATE INDEX IF NOT EXISTS idx_siradig_emp ON siradig_presentaciones(empleado_id);

-- ── Carga inicial de acumulados de Ganancias (arranque a mitad de año, estilo Tango "Carga Inicial") ──
-- Acumulados del período fiscal NO surgidos del sistema (liquidados antes de implementar, u otro empleador).
CREATE TABLE IF NOT EXISTS ganancias_apertura (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  anio INTEGER NOT NULL,
  hasta_mes INTEGER NOT NULL DEFAULT 0,   -- acumulado hasta este mes inclusive (informativo)
  gravado NUMERIC(16,2) NOT NULL DEFAULT 0,      -- remuneración gravada acumulada
  aportes NUMERIC(16,2) NOT NULL DEFAULT 0,      -- aportes (jub + obra social + sindical) acumulados
  retenido NUMERIC(16,2) NOT NULL DEFAULT 0,     -- retención de Ganancias acumulada
  sac_gravado NUMERIC(16,2) NOT NULL DEFAULT 0,  -- SAC gravado percibido (para liquidación anualizada)
  sac_aportes NUMERIC(16,2) NOT NULL DEFAULT 0,
  origen TEXT DEFAULT 'CARGA_INICIAL',           -- CARGA_INICIAL | OTRO_EMPLEADOR
  obs TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_gan_apertura UNIQUE (empleado_id, anio)
);
CREATE INDEX IF NOT EXISTS idx_gan_apertura ON ganancias_apertura(anio);

-- ── Acumuladores configurables (inspirado en Tango Sueldos) ──
CREATE TABLE IF NOT EXISTS acumuladores (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'MENSUAL',          -- MENSUAL | ANUAL_FISCAL | RANGO
  afecta_ganancias BOOLEAN NOT NULL DEFAULT false,
  activo BOOLEAN NOT NULL DEFAULT true,
  orden INTEGER NOT NULL DEFAULT 0,
  reglas JSONB NOT NULL DEFAULT '[]'::jsonb,      -- [{seccion,tipoLinea,patron,signo}]
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Embargos y cuota alimentaria (ABM; el motor aplica topes de embargabilidad) ──
CREATE TABLE IF NOT EXISTS embargos (
  id SERIAL PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL DEFAULT 'judicial',     -- judicial | alimentos
  modo TEXT NOT NULL DEFAULT 'monto',        -- monto | porcentaje (solo alimentos)
  monto NUMERIC(14,2) NOT NULL DEFAULT 0,
  porcentaje NUMERIC(6,2) NOT NULL DEFAULT 0,
  caratula TEXT, juzgado TEXT, expediente TEXT, oficio TEXT,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,    -- monto total a embargar (0 = sin límite)
  retenido NUMERIC(14,2) NOT NULL DEFAULT 0, -- acumulado retenido
  desde DATE, hasta DATE, activo BOOLEAN NOT NULL DEFAULT true, obs TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_embargos_emp ON embargos(empleado_id);

-- ── Recibo digital: acuse de recibo del empleado (Ley 27.555) ──
ALTER TABLE recibos ADD COLUMN IF NOT EXISTS acuse_at  TIMESTAMPTZ;
ALTER TABLE recibos ADD COLUMN IF NOT EXISTS acuse_ip  TEXT;
ALTER TABLE recibos ADD COLUMN IF NOT EXISTS acuse_nombre TEXT;

-- ── Valores legales versionados por vigencia (se verifican/actualizan antes de cada corrida) ──
CREATE TABLE IF NOT EXISTS valores_legales (
  id SERIAL PRIMARY KEY,
  vigencia_desde DATE NOT NULL UNIQUE,
  tope_sipa_max NUMERIC(16,2) NOT NULL DEFAULT 0,   -- base imponible máxima SIPA (art. 9 Ley 24.241)
  tope_sipa_min NUMERIC(16,2) NOT NULL DEFAULT 0,   -- base imponible mínima SIPA
  smvm NUMERIC(16,2) NOT NULL DEFAULT 0,            -- Salario Mínimo Vital y Móvil
  scvo_percapita NUMERIC(12,2) NOT NULL DEFAULT 0,  -- Seguro de Vida Obligatorio (Dto. 1567/74) prima individual
  scvo_suma_asegurada NUMERIC(16,2) NOT NULL DEFAULT 0,
  ffep NUMERIC(12,2) NOT NULL DEFAULT 0,            -- Fondo Fiduciario de Enfermedades Profesionales (suma fija)
  fuente TEXT, nota TEXT,
  updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_valores_legales_vig ON valores_legales(vigencia_desde DESC);
