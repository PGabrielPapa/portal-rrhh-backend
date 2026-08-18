# Auditoría integral del Portal RR.HH. — correcciones aplicadas

_Fecha: 12/07/2026. Alcance: backend (92 archivos, ~14.3k líneas) + frontend (129 archivos, ~16.5k líneas) + base de datos._

## Estado general

El sistema está sólido: todas las rutas del backend están montadas y protegidas con autenticación y roles, el contrato de API frontend↔backend es 100% consistente (sin llamadas a endpoints inexistentes), no hay SQL injection explotable ni código muerto en el frontend. Se corrigió un bug **crítico** y varios de severidad media/baja.

Verificación final: los 92 archivos JS compilan, la app monta las 57 rutas sin error, los 40 tests pasan (24 liquidación + 16 fórmulas) y el frontend type-checkea limpio.

## Correcciones aplicadas

### Crítico
- **`schema.sql` estaba truncado**: la tabla `campos_adicionales` no cerraba (`);` faltante y sin las columnas `orden`/`activo` que usa el código). Al aplicarse todo el schema de una vez en el arranque, esto **impedía crear cualquier tabla en una base nueva**. Se cerró la tabla, se agregaron `orden`, `activo`, `created_at` y la restricción `UNIQUE(entidad, clave)` (el alta ya esperaba el error de duplicado).

### Media
- **`cbu.js`**: la limpieza de CBU usaba `/\\D/` (doble escape) que no eliminaba nada, rechazando CBUs con espacios o guiones. Corregido a `/\D/g`.
- **`siradig.routes.js`**: `GET /_config` estaba declarado después de `GET /:id`, que lo capturaba (500 al intentar castear "_config" a entero). Se movió antes.
- **`liquidacion.js`**: el SCVO y el FFEP (per cápita mensuales) se cobraban completos en **cada** quincena, es decir doble por mes. Ahora se prorratean ×0,5 en quincenas.
- **`sicoss.js`**: el campo "Remuneración Total" del F.931 salía topeado; debe ser el bruto sin tope (`rem + noRem`). Corregido.
- **`lsd.js`**: los importes negativos (p. ej. devolución de Ganancias) conservaban el indicador D/C original; ahora un monto negativo invierte débito/crédito manteniendo el código de concepto.
- **Desempeño / Talento / Formación**: los gerentes tenían acceso a datos de toda la empresa. Desempeño ahora filtra por equipo (mismo criterio que Evaluaciones); Talento y Formación se alinearon a rrhh/admin (que es lo que muestra el menú).

### Baja / limpieza
- **`liquidacion.js`**: `round2` redondeaba mal el medio centavo negativo (ahora es simétrico); el cálculo de antigüedad se ancló a mediodía para evitar corrimientos por zona horaria.
- **`dashboard.routes.js`**: 8 `catch {}` vacíos que tragaban errores ahora registran un aviso.
- **`lib/audit.js`** (nuevo): se unificó la función `logAudit` que estaba duplicada idéntica en `empleados` y `recibos`.

### Dependencias
- Faltaban instalar `pdfkit` y `nodemailer` (declaradas pero ausentes en `node_modules`) — el backend no arrancaba sin ellas. Se instalaron.

## Segunda ronda (pendientes que estaban documentados — ya resueltos)

- **`reportes.routes.js`**: se parametrizaron las 12 fechas que se armaban por interpolación en el SQL (ahora usan `$1` con array de parámetros). No era explotable, pero queda prolijo y seguro.
- **Migraciones (`npm run migrate`)**: ese camino aplicaba solo el schema y omitía FKs, correlativo y siembra de puestos (que sí corrían al iniciar el server). Ahora `migrate.js` ejecuta también esas migraciones idempotentes, dejando la base completa por cualquier vía.
- **Ganancias sobre pagos no habituales (RG 4003 ap. B)**: al revisarlo a fondo, **no había bug real**. El acumulador se reconstruye mes a mes desde los recibos usando `factorNoHabitual(mesPago, mesActual)`, así que el prorrateo crece correctamente hasta imputar el 100% en diciembre. El auditor lo marcó viendo `liquidacion.js` en aislamiento. Se agregaron **4 tests** que fijan este comportamiento (total: 28 + 16 = 44 tests OK).

## Verificación final

Todo el backend compila, la app monta las 57 rutas, 44 tests pasan (28 liquidación/Ganancias + 16 fórmulas) y el frontend type-checkea limpio.
