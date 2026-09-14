# Reporte "Asiento de sueldos (libro completo)"

Análisis del Excel mensual `2026-08 Asiento Leiten.xlsx` y réplica del reporte dentro del Portal RR.HH.

Estado: **implementado** — el libro, la carga de centros por legajo, la persistencia de bases imponibles y las tablas auxiliares. Falta correr la migración, compilar el frontend, resolver los 33 legajos en conflicto y confirmar los valores de los conceptos por gremio.

---

## 1. Qué es el archivo original

Es el libro con el que Contabilidad arma el **asiento contable de sueldos** del mes. No es un reporte de liquidación: es la traducción de la liquidación al plan de cuentas. Nace de una exportación del sistema anterior y después se completa a mano con tablas auxiliares.

Período analizado: **agosto 2026**. 90 legajos liquidados, 115 en el padrón, 7 centros de costos (`com`, `cos`, `adm`, `ser`, `pro`, `des`, `pv`) y 11 centros de operaciones (Buenos Aires, Córdoba, Mendoza, Corrientes, Neuquén, Santa Fe, Rosario, Servicios Generales, Salta, San Juan, Cocchiararo).

Cierre del asiento: **238.948.352,79** de débitos contra igual importe de créditos, de los cuales 159.232.400 son el neto a pagar (cuenta 173), 48.346.095,03 las contribuciones patronales y 980.192,14 los ajustes por indemnizaciones y embargos.

---

## 2. Las 14 hojas, una por una

| # | Hoja | Qué contiene | Filas |
|---|---|---|---|
| 1 | **AP LIQUI** | Apertura por legajo de `OTRAS_DED` (embargos) e `INDEMNIZ_Y` (indemnizaciones), con su total al costado. Es lo que el asiento reclasifica. | 115 |
| 2 | **ASTO SUELDO** | El asiento propiamente dicho: cuenta contable × centro de costos × centro de operaciones, con débitos y créditos, columnas de ajuste manual y una columna final "ASIENTO PARA IMPORTAR". | 157 |
| 3 | **Remun** | Detalle por legajo de haberes y descuentos en 34 columnas con los códigos del sistema anterior (R_ASIGNADA, COMP.FUNCION, HS_EXT_Y_A, PRESENTISM, VACACION, LICENCIAS, SAC, APO_JUB, LEY_19032, O_SOCIAL, ANSSAL, SINDICATO, FAECYS, IMP_GCIAS, NETO…). Es la fuente del asiento. | 90 |
| 4 | **CATEGORIAS** | Maestro de categorías de convenio: código, descripción, importe, adicionales, horas normales y mínimas, aplicación de tope. | 42 |
| 5 | **Contribuciones** | 98 columnas por legajo: novedades del mes (plus, vacaciones, días), bases imponibles (Rem. 1 a 11, base SAC, base vacaciones, base OS, bases mínimas), alícuotas (% SIJP, 19.032, FNE, AFAM, ANSSAL, ART fijo y variable, La Estrella) y las contribuciones calculadas. | 90 |
| 6 | **TABLA PLAN CTAS** | Mapeo concepto de nómina → cuenta contable, con el importe del mes. A la derecha, el resumen por cuenta. | 30 |
| 7 | **TABLA ALICUOTAS** | Alícuotas patronales vigentes: jubilación 12,71 %, Ley 19.032 1,62 %, asignaciones familiares 5,56 %, FNE 1,11 %, ANSSAL 6 %, LRT fijo 0,60 y variable 0,463 %. | 12 |
| 8 | **RETENCIONES SUSS SUFRIDAS** | Sólo encabezados. Es un dato de Contabilidad (retenciones sufridas en pagos), no de RR.HH. | 0 |
| 9 | **TABLA OS** | Padrón de obras sociales con % y monto fijo de aporte y de retención, domicilio y teléfono. | 64 |
| 10 | **DETALLE GANANCIAS** | Retención del impuesto por legajo, con CUIT. Varias filas traen `#N/A` (legajos sin CUIT enlazado). | 16 |
| 11 | **Detalle Liq OS** | Por legajo: haberes, SAC, aporte de obra social, adherentes, adicional, código de OS, **código e importe de plan** y antigüedad. | 103 |
| 12 | **Tabla Aportes ROS-CORD-MEND** | Aportes sindicales agrupados por seccional (Rosario, Córdoba, Mendoza) para la DDJJ de cada una. | 4 |
| 13 | **Tabla Aportes Personal UOM** | Lo mismo para el personal UOM, con base de cálculo y los conceptos propios (cuota 227/01, seguro de vida colectivo, no remunerativos). | 7 |
| 14 | **ANTICIPOS SUELDOS** | Adelantos descontados en el mes, por legajo. | 13 |

---

## 3. Qué se implementó

Nueva sección **Liquidación → Reportes → "Asiento de sueldos (libro completo)"**.

- Se elige período y empresa, se ve en pantalla hoja por hoja (mismas columnas y mismo orden que el Excel) y se baja el libro `.xlsx` con las 14 hojas.
- El asiento se arma por **cuenta × centro de costos × centro de operaciones** y muestra un semáforo de cuadratura (débitos vs. créditos). En la prueba con datos simulados cierra en cero.
- El **plan de cuentas es editable desde la pantalla**: cada columna de nómina se mapea a una cuenta, con apertura opcional por centro de costos. Viene sembrado con el plan que usa hoy Contabilidad (413001/02/03/14/15/20 para sueldos, 413004/05/06/16/17/21 para cargas sociales, 173, 174, 189/192, 190, 191, 68, 178, 239, 266, 288, 307 a 311, 412028, 421002, 423005, RECLAS1).
- Una tabla **"Datos a cargar o generar"** se calcula en cada consulta y avisa, con nombre y apellido, qué legajos o qué parámetros impiden emitir el reporte completo.

Archivos:

| Archivo | Cambio |
|---|---|
| `portal-rrhh-backend/src/db/migrateAsiento.js` | nuevo — crea `asiento_cuentas` y siembra el plan de LEITEN |
| `portal-rrhh-backend/src/lib/asientoSueldos.js` | nuevo — motor de las 14 hojas |
| `portal-rrhh-backend/src/routes/asientoSueldos.routes.js` | nuevo — API y exportación .xlsx |
| `portal-rrhh-backend/src/app.js` | +2 — monta `/api/asiento-sueldos` |
| `portal-rrhh-backend/src/db/migrate.js` | +6 — corre la migración nueva |
| `portal-rrhh-frontend/src/pages/AsientoSueldos.tsx` | nuevo — pantalla |
| `portal-rrhh-frontend/src/lib/sections.ts`, `lib/meta.ts`, `components/SectionView.tsx` | +1 cada uno — menú y ruteo |

Endpoints: `GET /api/asiento-sueldos`, `GET /api/asiento-sueldos/xlsx`, y el ABM `…/cuentas`. Todo restringido a rol **rrhh / admin**.

### 3.1 Centros de costos y operaciones por legajo

Segunda pantalla, **Liquidación → "Centros de costos y operaciones"**: grilla con los 117 legajos, desplegables de centro de costos (limitados a los que tienen cuenta en el plan) y de centro de operaciones, filtro "sólo sin asignar", guardado masivo, exportación a Excel e **importación desde Excel** para la carga inicial. Se guardan en `empleados.data.centroCosto` / `.centroOperacion`.

`portal-rrhh-frontend/src/pages/CentrosLegajo.tsx` (nuevo) y los endpoints `GET/PUT /api/asiento-sueldos/centros` y `POST /api/asiento-sueldos/centros-operacion`.

> **Hallazgo importante.** El Excel original **se contradice a sí mismo**: para los 75 legajos que aparecen en `AP LIQUI` y en `Remun` a la vez, el centro de costos difiere en 16 casos y el centro de operaciones en 26. Además conviven dos vocabularios (`com/cos/pv/adm/mkt/ser` en AP LIQUI contra `COM/PRO/ADM/SER` en Remun) y la columna de centro de costos de `ASTO SUELDO` está desalineada respecto de las cuentas (413014 "Post Venta" aparece etiquetada `ser`, 413015 "Marketing" como `pro`). Por eso la asignación **no se cargó a ciegas**: se generó `Centros_por_legajo.xlsx` con la propuesta (se prioriza `Remun`, que es la hoja que alimenta el asiento) y las 33 filas en conflicto marcadas en amarillo para decidir. También se corrigió el typo `adn` → `adm` del legajo 131.

### 3.2 Bases imponibles en el recibo

`portal-rrhh-backend/src/lib/liquidacion.js` ahora guarda en cada recibo un bloque `bases` con `remImp1` a `remImp11`, base de aportes y de contribuciones de seguridad social, base de obra social, base de ART, detracción aplicada, topes vigentes, SAC, vacaciones y horas extra. Usa los mismos nombres que `lib/sicoss.js` para que el F.931 y el asiento no se contradigan.

Aplica **desde la próxima liquidación**. Para los períodos ya liquidados hay un botón **"↻ Reconstruir bases del período"** en la pantalla del asiento (aparece sólo cuando faltan): completa el bloque `bases` de esos recibos a partir de los totales que ya tienen y de los topes y la detracción vigentes de ese mes. **No recalcula la liquidación** — ningún importe del recibo se toca — y lo reconstruido queda marcado con `reconstruido: true` y su nota. La única aproximación es la base de obra social de jornada parcial, que se iguala a la base SIPA.

Endpoint: `POST /api/asiento-sueldos/backfill-bases` con `{ anio, mes, empresa }`; sin período procesa todos, `rehacer: true` pisa los ya reconstruidos y `dryRun: true` sólo cuenta.

### 3.3 Tablas auxiliares del asiento

Tercera pantalla, **Liquidación → "Tablas auxiliares del asiento"**, con tres solapas editables en línea:

- **Obras sociales (TABLA OS)** — nueva tabla `obras_sociales_aportes` con `POR_APORTE`, `IMP_APORTE`, `POR_RETEN`, `IMP_RETEN`, domicilio y teléfono, **sembrada con las 64 obras sociales del Excel**. Usa el código que lleva el legajo (OSECAC, UOM, OSDE…), que no es el código RNOS del padrón `obras_sociales` — ese desajuste ya existía en el sistema y esta tabla lo puentea.
- **Categorías** — nueva tabla `categoria_params` con `HS_NORMAL`, `HS_MIN_IMP`, `DI_MIN_IMP` y `APLICATOPE`, sembrada con las 42 categorías del Excel. El básico sigue saliendo de la escala vigente.
- (Los **conceptos por gremio** empezaron acá pero se movieron a *Tablas y configuración → Sindicatos*, ver 3.5.)

Los importes sembrados salen del Excel de agosto 2026 (seguro de vida UOM 377,62; contribución extraordinaria UOM 300; aporte solidario 2.000) y quedan marcados **"sin confirmar"**: la pantalla los muestra en amarillo y el reporte los lista en "Datos a cargar" hasta que se validen contra el convenio. Los conceptos ya se imputan en el asiento (gasto en la cuenta de cargas sociales del centro de costos, crédito en la cuenta de cada entidad); **falta engancharlos al motor de liquidación**, que es el paso que necesita los valores confirmados.

`portal-rrhh-backend/src/db/migrateAsientoAux.js` (nuevo, con los 115 registros sembrados), `portal-rrhh-frontend/src/pages/TablasAuxiliares.tsx` (nuevo) y los endpoints `GET /api/asiento-sueldos/auxiliares` + `PUT …/auxiliares/:tabla/:clave`.

Además: la pantalla de centros ahora también carga **COD_PLAN e IMP_PLAN** (plan de obra social por legajo) y marca los legajos **sin CUIL**, que en el Excel aparecen como `#N/A` en DETALLE GANANCIAS. Y si una columna con importe no tiene cuenta asignada, el asiento la reporta en vez de descuadrar en silencio.

### 3.4 Conceptos del gremio en el motor de liquidación

`lib/liquidacion.js` ahora aplica los conceptos de `conceptos_sindicales` dentro del cálculo: los de tipo **aporte** salen como descuento del recibo y los de **contribución** entran en el costo del empleador, con la cuenta contable que ya tienen asignada.

Tres recaudos:

- **Sólo se aplican los marcados "confirmado"** (`liquidacion.routes.js` los filtra en la consulta). Hasta que valides los valores contra el convenio, la liquidación no cambia en nada: hoy los nueve conceptos están sin confirmar, así que el efecto es cero.
- Se aplican **sólo al gremio que corresponde** (por `cod_sindicato` del legajo) y sólo en liquidaciones mensuales o de quincena.
- Los importes fijos son **per cápita mensuales**: en quincena se prorratean al 50 %, igual que el SCVO, para que 1ª + 2ª no cobren dos veces.

Verificación: la suite del repo (`npm test`, 31 casos del motor) pasa sin cambios, y una prueba puntual confirma que un legajo UOM con dos conceptos confirmados descuenta el aporte solidario (2.000), suma el seguro de vida a las contribuciones (377,62), ignora el concepto de otro gremio y prorratea a 1.000 en la quincena.

### 3.5 Los conceptos por gremio viven en Sindicatos

La tabla `conceptos_sindicales` (nueve conceptos: INACAP 288, La Estrella 191, aporte extraordinario OSECAC 239, los cinco de UOM 307 a 311 y el aporte solidario adicional) se administra desde **Tablas y configuración → Sindicatos**, en el bloque desplegable *"Aportes y contribuciones especiales del gremio"*, junto al resto de los parámetros del convenio. La fila de cada sindicato muestra cuántos conceptos tiene.

Es la misma tabla que consumen el asiento y el motor de liquidación — no hay copia ni sincronización. Desde ahí se edita todo en línea, se agregan conceptos nuevos, se elige el gremio (o "todos"), y se tilda **confirmado**, que es lo que habilita a que el concepto se liquide.

`sindicatos.routes.js` expone `GET/POST/PUT/DELETE /api/sindicatos/conceptos`. La solapa que tenía *Tablas auxiliares del asiento* se quitó: esa pantalla queda sólo con obras sociales y categorías, y remite a Sindicatos.

---

## 4. Qué hay que cargar o generar para que el reporte salga completo

Ordenado por lo que bloquea.

### Bloqueante

1. **Centro de costos por legajo.** ~~No existe en el modelo~~ → **pantalla lista** (3.1). Queda **decidir los 33 legajos en conflicto** de `Centros_por_legajo.xlsx` e importarlo.
2. **Centro de operaciones por legajo.** Ídem: la pantalla ya lo resuelve; hay que confirmar los casos en conflicto (sobre todo Buenos Aires vs. Servicios Generales y Cocchiararo vs. Buenos Aires).
3. **Confirmar los números de cuenta.** El plan sembrado replica el Excel, pero hay tres cuentas a confirmar con Contabilidad: la de Marketing/Servicios (413015/413017), la de la detracción art. 23 Ley 27.541 (en el Excel figura como `XXXX-XXXX`) y la de contribución OSECAC.

### Alto

4. **Bases imponibles en el recibo.** **Resuelto** (3.2): se persisten en `recibos.data.bases` desde la próxima liquidación. Los períodos anteriores quedan sin ese bloque.
5. **Conceptos de aportes y contribuciones especiales.** **Maestro creado y enganchado al motor** (3.3 y 3.4). Queda una sola cosa: **confirmar alícuotas e importes** contra cada convenio y tildar "confirmado" — recién ahí empiezan a liquidarse.

### Medio

6. **Maestro de obras sociales.** **Resuelto** (3.3): tabla nueva con las 64 obras sociales y sus porcentajes. Falta completar domicilio y teléfono, que el Excel trae vacíos.
7. **Plan de obra social del empleado.** **Campo disponible** (3.3): se carga en la pantalla de centros, por legajo o por Excel. Falta cargar los valores reales.
8. **Alícuotas patronales y ART.** Verificar que Parámetros de liquidación tenga cargados SIJP, 19.032, FNE, asignaciones familiares y ANSSAL, y que cada empresa tenga su contrato de ART vigente con alícuota variable **y suma fija** (el Excel usa 0,60 fijo + 0,463 % variable).
9. **Categorías de convenio.** **Resuelto** (3.3): las 42 categorías sembradas con sus horas y mínimos, editables.
10. **CUIT de todos los legajos.** **Control agregado**: la pantalla de centros marca los legajos sin CUIL y el reporte los lista. Falta completarlos.

### Bajo

11. **Retenciones SUSS sufridas.** No sale de RR.HH.: la informa Contabilidad. Queda como hoja de carga manual (o se importa el archivo que hoy usan).
12. **Ajustes manuales del asiento.** El Excel tiene columnas "OTROS AJUSTES" y "ASIENTO DEFINITIVO" para retoques a mano. Si quieren conservarlas, hay que agregar una tabla de ajustes por período y cuenta.

---

## 5. Pasos para ponerlo en marcha

```powershell
# 1 — base de datos (crea asiento_cuentas y siembra el plan)
cd C:\Users\Usuario\Desktop\RRHH-Portal-New\portal-rrhh-backend
docker compose exec api npm run migrate

# 2 — frontend
cd C:\Users\Usuario\Desktop\RRHH-Portal-New\portal-rrhh-frontend
npm run check
npm run build
```

Después, en el portal: **Liquidación → Asiento de sueldos (libro completo)**, elegir agosto 2026 y contrastar contra el Excel. Mientras no estén cargados el centro de costos y el centro de operaciones, el asiento va a salir agrupado en blanco: es lo esperado y la propia pantalla lo indica.
