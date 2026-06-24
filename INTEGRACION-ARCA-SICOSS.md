# Integración: SICOSS + ARCA/obra social + Ganancias RG 4003 + Reportes + Higiene y Seguridad

Resumen de lo agregado en esta sesión, sobre los repos `portal-rrhh-backend` y
`portal-rrhh-frontend`. Todo sigue los patrones existentes (ESM, `query` de
`db.js`, histórico estilo `cambios_domicilio`, merge en `empleado.data`).

## 1) SICOSS posicional real (F.931)

- `backend/src/lib/sicoss.js` (NUEVO): generador del registro **499 caracteres, 60
  campos** (diseño v42). Verifica el layout al cargarse. Importes con punto y 2
  decimales; enteros con ceros; texto sin tildes en mayúsculas.
- `backend/src/routes/reportes.routes.js` (MOD): nuevo endpoint
  `GET /api/reportes/sicoss-archivo?anio=&mes=&empresa=` → descarga el `.txt`
  real. Toma remunerativo/no remunerativo de los recibos del período y los
  códigos SICOSS de `empleado.data`. Topes opcionales por querystring
  (`topePersonal`, `topePatronal`, `topeOtros`).
- `frontend/src/pages/F931.tsx` (MOD): botón **"⬇ Generar archivo SICOSS (.txt)"**
  (el CSV anterior queda como "Resumen de control"). El banner de versión del
  diseño que ya existía se mantiene.

> ⚠ Validar siempre un período de prueba importándolo en **"Declaración en Línea"**
> de ARCA antes de presentar. Cargar los **topes jubilatorios vigentes**.
> Importes que el sistema aún no desglosa (premios, maternidad, etc.) van en 0.

## 2) Tablas de ARCA (desplegables del ABM)

- `backend/src/db/schema.sql` (MOD): tablas `codigos_afip`, `obras_sociales`,
  `arca_tablas_meta`, `cambios_obra_social` (+ columnas extra en
  `sicoss_generaciones`).
- `backend/src/data/codigos_afip.seed.json` (NUEVO): situación de revista (27,
  tabla T03 AFIP), condición, modalidad de contratación (31), zona, actividad.
- `backend/src/data/obras_sociales.seed.json` (NUEVO): padrón **RNOS, 211 obras
  sociales** (código + denominación).
- `backend/src/db/seed.js` (MOD): carga ambas tablas (idempotente).
- `backend/src/routes/arca.routes.js` (NUEVO): `GET /api/arca/codigos[?tipo=]`,
  `GET /api/arca/obras-sociales?q=`, `GET/PATCH /api/arca/meta`.
- `backend/src/app.js` (MOD): registra `/api/arca` y `/api/cambios-obra-social`.
- `frontend/src/lib/arca.ts` (NUEVO): helpers + definición de campos SICOSS del
  legajo.
- `frontend/src/pages/Empleados.tsx` (MOD): el ABM ahora tiene la sección
  **"Datos SICOSS / AFIP"** con desplegables alimentados desde la base, y un
  buscador de obra social (código + nombre) en vez de campos de texto libres.

## 3) Obra social con histórico (Mis Datos + ABM)

- `backend/src/routes/obraSocial.routes.js` (NUEVO): patrón `cambios_domicilio`.
  - Empleado: `POST /api/cambios-obra-social` (solicita; queda pendiente),
    `GET /mias` (histórico propio).
  - RR.HH./Admin: `GET /` (todas, con filtros), `PATCH /:id` (aprobar/rechazar →
    impacta `empleado.data`), `POST /aplicar/:empleadoId` (cambio directo desde
    el ABM, genera histórico), `GET /empleado/:empleadoId`.
- `frontend/src/pages/MisDatos.tsx` (MOD): tarjeta **Obra social** con solicitud
  de cambio (buscador código+nombre) e histórico.
- En el ABM (`Empleados.tsx`), al cambiar la obra social y guardar se genera el
  histórico automáticamente (origen RR.HH.).

## 4) Mantenimiento de tablas vigentes

- Tarea programada **mensual** (1° de cada mes, 9:00) que revisa las fuentes de
  ARCA/RNOS y avisa si hubo cambios. Editable desde "Scheduled" en Cowork.
- Actualización manual: reemplazar los `*.seed.json` y volver a correr el seed;
  registrar nueva versión del diseño SICOSS desde F.931 → "Registrar actualización".

## 5) Impuesto a las Ganancias 4ª (RG 4003) — corrección y simulador

- **Valores oficiales 1er semestre 2026** en `src/data/ganancias.seed.json` (estaban
  ~5x inflados): GNI $5.151.802,50, deducción especial (ap. 2 = 4,8x GNI)
  $24.728.652,02, cónyuge $4.851.964,66, hijo $2.446.863,48, hijo c/disc.
  $4.893.726,96, y escala art. 94 completa. `seed.js` ahora **UPSERTea** la fila
  (antes sólo insertaba si la tabla estaba vacía → no corregía la existente).
- **Motor de cálculo** (`src/lib/liquidacion.js`) reescrito conforme RG 4003 Anexo II:
  A) habitual; B) no habituales (ajustes/gratificaciones) imputadas en forma
  proporcional del mes de pago a diciembre; **C) SAC = 1/12 de (A+B) por mes** con
  1/12 de las deducciones (el SAC realmente abonado se reconcilia en la anual).
  Escala prorrateada por mes. Helper compartido `calcularGananciasAcum`.
- **F.1357** (`src/routes/ganancias.routes.js`) recalculado siempre (ya no toma el
  bloque del recibo guardado → dejaba gravadas y deducciones personales en 0).
- **Verificación previa a la liquidación** (`GET /ganancias/verificacion`): chequea
  deducciones (art. 30) **y** escala (art. 94) vigentes del semestre; banner
  `GananciasCheck` en la pantalla de Liquidación (individual y masiva).
- **Simulador de Ganancias** (panel RR.HH.): `POST /ganancias/simular` con 3 modos
  (mensual / anual / liquidación final) + pantalla `SimuladorGanancias.tsx`.
- **Tarea programada** mensual (día 25) que verifica las tablas de Ganancias contra ARCA.

## 6) Generador de reportes (multi-dataset, backend-driven)

- `GET /reportes/datasets` y `GET /reportes/dataset/:key?anio=&mes=&empresa=`
  devuelven `{ campos, rows }` por dataset. El frontend `GeneradorReportes.tsx`
  es genérico (campos y datos vienen del backend).
- **23 reportes**: empleados (con domicilio completo + SICOSS + obra social),
  familiares, empresas, nómina (todos los conceptos), costos laborales,
  liquidaciones, conceptos, CBUs, elementos, beneficios, ART, licencias,
  sanciones, adelantos, dotación/antigüedad, dotación por empresa, períodos de
  prueba, cumpleaños del mes, aniversarios de ingreso, masa salarial por convenio,
  licencias vigentes, vencimientos de ART y CBU incompletos, **+ Fichadas (período)**.
- **Filtro de período en todos los datasets**: obligatorio en nómina/costos/liquidaciones/
  fichadas/cumpleaños/aniversarios; opcional ("Filtrar por período") en el resto, con
  criterio "a esa fecha" (vigentes/plantel) o "del mes" (movimientos) según corresponda.
- **Campos calculados (fórmulas)**: el usuario define columnas nuevas con ecuaciones sobre
  los campos (ej. `bruto - neto`, `costoTotal / empleados`, `(bruto-neto)/bruto*100`),
  evaluadas con un parser seguro (sin `eval`); se guardan por reporte y se exportan en el CSV.

## 7) Higiene y Seguridad (RR.HH. + módulo del empleado)

- `backend/src/db/schema.sql` (MOD): tablas `hys_catalogo`, `hys_manuales` (con `tipo`
  manual|catalogo) y `hys_manual_acuses` (acuse de lectura).
- `backend/src/routes/hys.routes.js` (MOD): dashboard consolidado (KPIs + lista por empresa
  con alertas), talles por empleado, **catálogo editable en DB + importación Excel/CSV**,
  **manuales y catálogos como documentos** (subir PDF/Word/etc., listar, descargar, visibilidad),
  **vencimiento de capacitaciones y EPP (12m)** con detalle de alertas, **acuse de recibo** del
  empleado y endpoint propio `GET /hys/mis`.
- `frontend/src/pages/Hys.tsx` (MOD): dashboard (KPIs cap. + EPP), pestaña **🔔 Alertas**
  (vencimientos de cap. y EPP, con CSV), **📋 Catálogos** (import de datos + documentos) y
  **📁 Manuales** (subir/ver/descargar/publicar), con conteo y detalle de **acuses**.
- `frontend/src/pages/MisHys.tsx` (NUEVO): módulo del empleado — sus capacitaciones, EPP y
  talles + catálogos/manuales publicados (ver/descargar) con **confirmación de lectura**.
- Vigencia de EPP por defecto 12 meses (configurable por tipo más adelante). Los archivos se
  guardan en la base (base64) vía `multer`.

## 8) Libro de Sueldos Digital (LSD) — exportación del .txt para ARCA

- `backend/src/lib/lsd.js` (NUEVO): generador posicional del archivo de importación
  del **Libro de Sueldos Digital** (interfaz "Liquidación de SyJ - DJ F931").
  Multi-registro, una línea por registro (CRLF):
  - `01` Datos referenciales del envío — **35** caracteres (1 por CUIT empleador).
  - `02` Datos referenciales del trabajador — **115** caracteres.
  - `03` Detalle de conceptos liquidados — **51** caracteres (1 por concepto).
  - `04` Datos del trabajador para la DJ F931 — **370** caracteres.
  Importes **sin separador** (13 enteros + 2 decimales = 15 dígitos; los 2 últimos
  son centavos). El módulo **autoverifica** posiciones/longitudes al cargarse.
  Incluye `CONCEPTOS_LSD` (clasificador concepto -> código del empleador, C/D) y
  arma el reg `04` con los mismos datos del F.931/SICOSS (bases imponibles).
- `backend/src/routes/reportes.routes.js` (MOD): endpoint
  `GET /api/reportes/lsd-archivo?anio=&mes=&empresa=&nroLiq=&tipoLiq=&fechaPago=&fechaRubrica=`
  -> descarga el `.txt` (agrupa por CUIT de empresa: una cabecera `01` por empleador).
  Más diseño versionado: `GET/PATCH /api/reportes/lsd-diseno` (verificación previa).
- `backend/src/db/schema.sql` (MOD): tablas `lsd_diseno` (diseño vigente versionado)
  y `lsd_generaciones` (log de generaciones).
- `frontend/src/pages/LibroSueldos.tsx` (MOD): botón **"⬇ Generar Libro de Sueldos
  Digital (.txt)"**, banner de versión del diseño (link a ARCA + "Registrar
  actualización") y verificación previa a generar.
- **Tarea programada mensual** (día 3) que verifica en ARCA si cambió el diseño LSD
  y avisa para adecuar `lsd.js`. Editable desde "Scheduled" en Cowork.

> Diseño tomado de ARCA -> LSD -> Ayuda -> Diseños ("Diseño de interfaz - liquidación"
> y "- conceptos"). **Importante:** los códigos de concepto del reg `03` deben estar
> dados de alta y relacionados al código ARCA en el servicio LSD (interfaz de
> conceptos). Forma de pago por defecto `1` (efectivo). **Validar** importando un
> período de prueba en el servicio LSD antes de presentar; período y N° de
> liquidación del `.txt` deben coincidir con los del servicio.

## 9) Recibos (gestión) — reorganización + acciones

- `frontend/src/pages/RecibosGestion.tsx` (MOD): vista en **árbol Empresa → Empleado
  (alfabético) → recibos (período + tipo)**, colapsable. Totalizadores de neto por
  empresa y total general. Filtros: empresa, mes, año, tipo, buscador, y toggles
  **"Pendientes de pago"** y **"No vistos"**.
- **Borrado de recibos** (para re-liquidar): individual (✕), por **empresa + período**,
  por **empresa + período + tipo**, y **período global** (todas las empresas). Backend
  `DELETE /api/recibos/:id` y `POST /api/recibos/eliminar-lote { anio, mes, empresa?, tipo? }`.
  Al borrar se limpian las `anticipo_cuotas` y se **reconcilia la corrida** (recalcula
  totales o la elimina si queda vacía).
- **Cierre de período**: usa `cierres_periodo`. Admin **cierra/reabre** por empresa+período
  desde Recibos; con período cerrado se **bloquea** borrar y re-liquidar (409) hasta reabrir.
- **Auditoría de borrados**: cada eliminación queda en `audit_log` (visible en Auditoría).
- **Marcar como pagado**: `PATCH /api/recibos/:id/pagar`; columnas `pagado/pagado_at/pagado_por`
  (`schema.sql`). Badge + filtro de pendientes.
- **Avisar al empleado**: `POST /api/recibos/:id/avisar` (manda mensaje al empleado);
  `/recibos/gestion` devuelve `visto` (desde `recibo_vistas`) para el filtro "no vistos".
- **Impresión masiva** por empresa (`frontend/src/lib/reciboPrint.ts` → `imprimirVarios`)
  y **export CSV** de la grilla.
- **Re-liquidar (atajo)**: botón ↻ navega a Liquidación → Individual con empleado/período/tipo
  precargados (`frontend/src/pages/Liquidacion.tsx` lee `reLeg/reEmp/anio/mes/tipo`).

## 10) Liquidación — fixes y rediseño de la corrida

- `frontend/src/pages/Liquidacion.tsx` (MOD): en Individual, **Enter** selecciona el empleado
  del buscador (antes el botón quedaba deshabilitado y "no dejaba calcular") + ayuda visible.
- Planilla de **Corrida** rediseñada: lista de corridas como tarjetas arriba, planilla a ancho
  completo, **buscador por legajo/nombre**, expandir/contraer todos, **subtotales por empresa**
  y **totalizadores** (neto, contribuciones, costo total). Feedback al aprobar/publicar y
  guía del flujo borrador → aprobar → publicar.

## 11) Mensajes — respuesta de RR.HH.

- `backend/src/routes/mensajes.routes.js` (MOD): `POST /api/mensajes/:id/responder` — RR.HH.
  responde al empleado (mensaje `a_empleado`) y el original pasa a estado **`respondido`**.
- `frontend/src/pages/MensajesRRHH.tsx` (MOD): botón **Responder** con caja de texto, badges
  Nuevo/Leído/Respondido y filtro "Respondidos".

## 12) Históricos editables (Ganancias y Reglamento)

- `backend/src/db/schema.sql` (MOD): tablas `ganancias_periodos_hist` y `reglamento_hist`.
- `backend/src/routes/ganancias.routes.js` (MOD): snapshot de la versión previa en cada
  alta/edición + `GET /ganancias/periodos/:id/historial`.
- `backend/src/routes/reglamento.routes.js` (MOD): snapshot en cada guardado +
  `GET /reglamento/historial`.
- `frontend/src/pages/GananciasParams.tsx` (MOD): filas expandibles con **todos** los
  parámetros + escala; botón **🕘 Histórico** con "Cargar en editor" para re-liquidar.
- `frontend/src/pages/Reglamento.tsx` (MOD): botón **🕘 Histórico** con versiones y
  "Cargar en editor" (restaurar).

## 13) Integración ProSoft (pendiente) — ver `PROSOFT-API.md`

- Mapeo completo de la API de control horario "Gestión de Personal Pro-Soft"
  (login por cookie, `/api/resumen/GetValue` con polling, etc.) documentado en
  `backend/PROSOFT-API.md` para retomar la descarga de fichadas más adelante.

## 14) Auditoría de seguridad y bugs (correcciones)

- **Backend (seguridad):** scope por equipo para gerentes en `licencias.routes.js`
  (descarga de comprobante), `anticipos.routes.js` (detalle de cuotas) y `hys.routes.js`
  (capacitaciones / EPP / historial de talles); IDOR corregido en `GET /hys/talles/:id`
  (exige ser el propio empleado o gestor); orden de rutas en `fichadas.routes.js`
  (`/importaciones/log` antes de `/:anio/:mes`).
- **Frontend (UX/robustez):** `Empleados.tsx` — el campo `F` se movió a nivel de módulo
  (el ABM perdía el foco a cada tecla); **confirmaciones** en borrados destructivos
  (Ganancias, corrida, sindicatos, ART, plan de cuentas, escalas/convenios, H&S,
  reapertura de período) y en la publicación de recibos; `try/catch` con aviso en los
  borrados de H&S.
- Verificado sin hallazgos: sin inyección SQL (todo parametrizado), endpoints/métodos/shapes
  front↔back consistentes, handlers con try/catch.

## Archivos a commitear

**Backend** — nuevos: `src/lib/sicoss.js`, `src/lib/lsd.js`, `src/routes/arca.routes.js`,
`src/routes/obraSocial.routes.js`, `src/data/codigos_afip.seed.json`,
`src/data/obras_sociales.seed.json`, `INTEGRACION-ARCA-SICOSS.md`.
Modificados: `src/app.js`, `src/db/schema.sql`, `src/db/seed.js`,
`src/routes/reportes.routes.js`, `src/routes/ganancias.routes.js`,
`src/routes/liquidacion.routes.js`, `src/lib/liquidacion.js`,
`src/data/ganancias.seed.json`, `src/routes/hys.routes.js`.

**Frontend** — nuevos: `src/lib/arca.ts`, `src/components/GananciasCheck.tsx`,
`src/pages/SimuladorGanancias.tsx`, `src/pages/MisHys.tsx`. Modificados: `src/pages/F931.tsx`,
`src/pages/MisDatos.tsx`, `src/pages/Empleados.tsx`, `src/pages/Liquidacion.tsx`,
`src/pages/GeneradorReportes.tsx`, `src/pages/Hys.tsx`, `src/pages/LibroSueldos.tsx`, `src/lib/sections.ts`,
`src/components/SectionView.tsx`, `src/lib/meta.ts`.

**Sesión recibos/históricos/auditoría (secciones 9–14)** — Backend nuevos: `PROSOFT-API.md`.
Backend modificados: `src/db/schema.sql`, `src/routes/recibos.routes.js`, `src/routes/mensajes.routes.js`,
`src/routes/ganancias.routes.js`, `src/routes/reglamento.routes.js`, `src/routes/cierres.routes.js` (usado),
`src/routes/licencias.routes.js`, `src/routes/anticipos.routes.js`, `src/routes/fichadas.routes.js`,
`src/routes/hys.routes.js`. Frontend modificados: `src/pages/RecibosGestion.tsx`, `src/pages/Liquidacion.tsx`,
`src/pages/GananciasParams.tsx`, `src/pages/Reglamento.tsx`, `src/pages/MensajesRRHH.tsx`,
`src/pages/Empleados.tsx`, `src/pages/Asiento.tsx`, `src/pages/Sindicatos.tsx`, `src/pages/ArtEmpresas.tsx`,
`src/pages/CierrePeriodos.tsx`, `src/pages/Escalas.tsx`, `src/lib/reciboPrint.ts`.

### Comandos (desde Windows, donde el EOL no genera ruido)

```bash
# Backend
cd portal-rrhh-backend
git add src/lib/sicoss.js src/lib/lsd.js src/lib/liquidacion.js \
        src/routes/arca.routes.js src/routes/obraSocial.routes.js \
        src/routes/reportes.routes.js src/routes/ganancias.routes.js src/routes/liquidacion.routes.js src/routes/hys.routes.js \
        src/data/codigos_afip.seed.json src/data/obras_sociales.seed.json src/data/ganancias.seed.json \
        src/app.js src/db/schema.sql src/db/seed.js \
        INTEGRACION-ARCA-SICOSS.md
git commit -m "feat(rrhh): SICOSS v42, tablas ARCA + obra social con historico, Ganancias RG 4003 (F.1357, SAC 1/12, simulador), generador de reportes (datasets + periodo + campos calculados), Higiene y Seguridad (catalogos, manuales, alertas, acuses) y Libro de Sueldos Digital (.txt LSD)"
git push

# Frontend
cd ../portal-rrhh-frontend
git add src/lib/arca.ts src/components/GananciasCheck.tsx src/pages/SimuladorGanancias.tsx src/pages/MisHys.tsx \
        src/pages/F931.tsx src/pages/MisDatos.tsx src/pages/Empleados.tsx \
        src/pages/Liquidacion.tsx src/pages/GeneradorReportes.tsx src/pages/Hys.tsx src/pages/LibroSueldos.tsx \
        src/lib/sections.ts src/components/SectionView.tsx src/lib/meta.ts
git commit -m "feat(rrhh): SICOSS .txt + ARCA + obra social, Ganancias (verificacion + simulador), reportes (genericos + periodo + campos calculados), Higiene y Seguridad (RRHH + modulo empleado con acuses) y Libro de Sueldos Digital (.txt LSD)"
git push
```

> En el deploy, el contenedor corre `migrate` (aplica las tablas nuevas) y `seed`
> (carga códigos AFIP + padrón RNOS) automáticamente; todo es idempotente.

## Verificación realizada

- `node --check` OK en todos los archivos backend tocados.
- `tsc --noEmit` OK en el frontend.
- Smoke test del generador: registro de 499 caracteres, posiciones y formatos
  correctos.
- Smoke test del generador LSD: registros 01/02/03/04 de 35/115/51/370
  caracteres exactos; importes sin separador; layout autoverificado.
- Auditoría de seguridad/bugs (sección 14): backend `node --check` OK; frontend `tsc` OK.
- No se pudo correr Postgres en este entorno (sin permisos); el SQL replica
  patrones ya en producción (`CREATE TABLE/INDEX IF NOT EXISTS`, `ALTER ADD
  COLUMN IF NOT EXISTS`). Conviene una corrida de `migrate`+`seed` en staging.

## Fuentes oficiales

- Situación de revista (T03): https://biblioteca.afip.gob.ar/pdfp/rg_3757_tabla_sit_rev.pdf
- Modalidad de contratación (T03): https://biblioteca.afip.gob.ar/pdfp/rg_3757_tabla_mod_cont.pdf
- Diseño SICOSS v42 (499): https://blogdelcontador.com.ar/news-26983-sicoss-version-42-diseno-de-registro
- Layout SICOSS por posición: https://documentacion.siu.edu.ar/wiki/SIU-Mapuche/Version3.28.2/Documentacion_de_las_operaciones/comunicacion/afip/sicoss
- Padrón RNOS (obras sociales): https://www.sssalud.gob.ar/?page=listRnosc&tipo=7
- Diseños LSD (ARCA): https://www.afip.gob.ar/LibrodeSueldosDigital/ayuda/disenios.asp
