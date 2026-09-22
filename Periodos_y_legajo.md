# Legajo único, personas sin duplicados y períodos laborales

Numeración automática del legajo y de la persona, períodos por relación laboral, cesión de contratos entre empresas del grupo y unicidad del DNI en la base de personas.

Estado: **implementado y probado contra PostgreSQL 16**, reportes incluidos. Falta correr la migración y compilar el frontend.

---

## 1. Las cuatro definiciones

| Decisión | Qué se implementó |
|---|---|
| **Numeración del legajo** | Correlativo **único para todo el grupo** (LEITEN, SINIS, LEITEN SALTA, BARTON REBAR). Antes era por empresa. Formato de 6 dígitos con ceros a la izquierda, como hasta ahora. |
| **Cesión de contrato** | Sin solución de continuidad (arts. 225/229 LCT): se cierra el período en la cedente con causa "cesión" y **no se liquida final**. La cesionaria continúa la relación. |
| **Histórico de recibos** | Cada recibo queda anclado a su período, y por lo tanto a la empresa que efectivamente lo liquidó. |
| **Modelo** | Un solo registro por persona. El legajo no se duplica: cambia de empresa y los períodos guardan la historia. |

---

## 2. Cómo queda el legajo

El número identifica a la persona **dentro del grupo** y no cambia nunca. Lo que cambia son sus períodos: cada relación laboral con una empresa, con su alta, su baja y su causa.

- **Alta de una persona** → el sistema asigna el próximo número libre del grupo (`nextLegajo` ahora mira todas las empresas y también los legajos de períodos históricos, para no reutilizar un número que ya tuvo alguien) y abre el período 1 con motivo "ingreso".
- **Baja** → el endpoint de cese ya cerraba el período vigente; ahora además queda la causa registrada en él.
- **Cesión** → cierra el período en la cedente y abre otro en la cesionaria, mismo legajo.
- **Reingreso** → mismo legajo, período nuevo, con la opción de reconocer o no la antigüedad anterior.

### La antigüedad en la cesión

`empleados.ingreso` **no se toca**: sigue siendo el ingreso original al grupo, y es el campo sobre el que el motor calcula la antigüedad. El período nuevo guarda por separado su `fecha_ingreso` — la fecha de alta ante ARCA en la empresa cesionaria — y además `antiguedad_reconocida` con el ingreso original, que es lo que la cesionaria reconoce.

En el **reingreso** es al revés: si RR.HH. elige *no* reconocer la antigüedad anterior, `empleados.ingreso` pasa a ser la fecha del reingreso y la relación arranca de cero.

---

## 3. La pantalla

**RR.HH. → Personal y legajos → "Períodos y cesiones"**.

Izquierda, el padrón con el legajo, la empresa actual y cuántos períodos tiene cada uno (con una marca ↔ si hubo cesión). Al elegir uno, a la derecha aparece su línea de períodos: empresa, motivo del alta, ingreso, egreso, causa, antigüedad reconocida y cuántos recibos tiene cada período.

Dos botones según el estado:

- **↔ Ceder contrato** (si hay período vigente): empresa cesionaria, fecha de egreso en la cedente y fecha de alta en la cesionaria — que se propone como el día siguiente, pero es editable — y una observación.
- **↩ Registrar reingreso** (si no hay período vigente): empresa, fecha y si se reconoce la antigüedad anterior.

Arriba se muestra el próximo número de legajo a asignar.

---

## 4. Qué cambió por dentro

| Archivo | Cambio |
|---|---|
| `src/db/migratePeriodos.js` | nuevo — completa la tabla `periodos`, agrega `recibos.periodo_id`, crea el trigger y hace el backfill |
| `src/routes/periodos.routes.js` | nuevo — API de períodos, cesión y reingreso |
| `src/routes/empleados.routes.js` | `nextLegajo` pasa a ser único de grupo; el período del alta se marca como "ingreso" |
| `src/lib/asientoSueldos.js` | la empresa del asiento sale del período del recibo, no del legajo |
| `src/app.js`, `src/db/migrate.js` | montaje y migración |
| `portal-rrhh-frontend/src/pages/Periodos.tsx` | nueva pantalla |
| `sections.ts`, `meta.ts`, `SectionView.tsx` | menú y ruteo |

### El anclaje de los recibos

`recibos` tiene ahora `periodo_id`, y un **trigger** (`trg_recibos_periodo`) lo completa solo en cada alta, buscando el período que cubre ese mes. Se hizo así para no tocar los cuatro puntos donde la liquidación inserta recibos (corrida, individual, final y ajustes): cualquier camino de alta, presente o futuro, queda cubierto.

La migración también hace el backfill de los recibos ya emitidos.

### 4.1 Los reportes resuelven la empresa por el período

Las doce consultas que resolvían la empresa del recibo a través del legajo pasaron a hacerlo por el período:

```sql
FROM recibos r JOIN empleados e ON e.id = r.empleado_id
LEFT JOIN periodos perx ON perx.id = r.periodo_id
JOIN empresas em ON em.id = COALESCE(perx.empresa_id, e.empresa_id)
```

Alcanza a `reportes.routes.js` (el helper que alimenta libro de sueldos, F.931, SICOSS, DDJJ sindical y el generador de reportes), `liquidacion.routes.js` (previa, corrida y reporte de corrida), `recibos.routes.js` (gestión, borrado masivo y envío por mail), `ganancias.routes.js` y `sicore.routes.js`. El `COALESCE` deja intacto el comportamiento de cualquier recibo que todavía no tenga período.

---

## 5. Verificación

Se levantó un PostgreSQL 16 real con un esquema equivalente y se corrió el módulo de verdad (no una copia):

- Migración: crea un período por legajo respetando bajas previas (el egresado queda con su período cerrado y la causa correcta), vincula todos los recibos y es **idempotente** — la segunda corrida no hace nada.
- Cesión de un legajo de LEITEN a BARTON REBAR: período 1 cerrado el 31/08 con causa "cesión", período 2 abierto el 01/09 en la cesionaria con el mismo legajo `000045` y antigüedad reconocida 01/03/2019. `empleados.ingreso` quedó intacto.
- Anclaje: un recibo de 09/2026 cargado después de la cesión se ancló al período de BARTON REBAR, y uno de 08/2026 al de LEITEN. Es exactamente lo que hace falta para que el F.931, el libro de sueldos y el asiento de meses anteriores sigan saliendo por la empresa correcta.
- Reingreso sin reconocer antigüedad: período nuevo y `ingreso` actualizado a la fecha de reingreso.
- Controles: cesión a la misma empresa, reingreso con período vigente y egreso anterior al ingreso se rechazan con un mensaje claro; el índice único impide dos períodos vigentes en el mismo legajo.
- Reportes por empresa: con el legajo ya cedido, la consulta nueva devuelve el recibo de 08/2026 bajo LEITEN y el de 09/2026 bajo BARTON REBAR. La consulta vieja, para el mismo caso, devolvía **cero filas** al pedir agosto de LEITEN — el trabajador ya "pertenecía" a la otra empresa.

---

## 6. Base de personas: número propio y DNI único

Se detectó que la misma persona podía cargarse dos veces. La causa: `personas` tenía índice único por **CUIL** pero no por DNI, y ninguno de los dos documentos se normalizaba al guardar. Con el mismo CUIL escrito de dos formas — `20414724990` y `20-41472499-0` — el único no lo reconocía, y la búsqueda que hace el ABM de empleados para reutilizar la ficha tampoco: comparaba el texto tal cual. Así, la misma persona quedaba una vez como *familiar* y otra como *empleado*.

`src/db/migratePersonas.js` (nuevo) lo corrige en cuatro pasos:

1. **Número de persona propio.** Cada persona recibe un correlativo único al crearse, sea familiar, postulante, prestador o empleado. Se asigna por **secuencia de la base**, no desde el código, para que lo reciba cualquier alta — incluida la que hace el ABM de empleados cuando crea la persona por su cuenta. Es distinto del **legajo**, que se sigue asignando recién cuando la persona pasa a ser empleada: un familiar no consume números de legajo.
2. **Normalización** de DNI y CUIL a sólo dígitos, en la base y en todo lo que se guarde de ahora en más.
3. **Unificación de los duplicados que ya existen**: se conserva la ficha ligada al empleado (o la más antigua), se le suman los tipos y los datos de la otra, y se repuntan `empleados`, `periodos` y la auditoría de login antes de borrarla.
4. **Índice único por DNI**, para que no vuelva a pasar.

En el ABM, el alta y la edición avisan antes de guardar: *"Ya existe una persona con ese documento: PAPA, LUCIANO (N° 2). Editá esa ficha en vez de crear otra."* La búsqueda de persona del alta de empleados ahora compara por dígitos, así que reutiliza la ficha en lugar de crear una nueva. El listado muestra la columna **N°**.

**Verificado** contra PostgreSQL 16 reproduciendo el caso de la pantalla: cinco fichas con dos pares duplicados quedaron en tres, con los tipos unidos (`empleado` + `familiar`), los datos combinados, empleados y períodos repuntados, la numeración 1-2-3 asignada, el alta siguiente tomando el 4 sola, el DNI duplicado rechazado por la base y la migración idempotente en la segunda corrida.

### 6.1 Simplificación Registral sobre los períodos

`GET /api/reportes/simplificacion` leía las altas de `empleados.ingreso` y las bajas de la tabla `bajas`. Con ese criterio una cesión **no generaba ni alta ni baja**: el ingreso del legajo sigue siendo el original y la cesión no registra una baja formal.

Ahora se arma sobre los períodos: altas = períodos con `fecha_ingreso` en el mes, bajas = períodos con `fecha_egreso` en el mes, cada uno con la empresa y el CUIT del período. Se agregan tres columnas: **motivo** (ingreso / cesión / reingreso), **antigüedad reconocida** y **empresa cedente**.

La antigüedad reconocida se informa aparte a propósito: en una cesión la fecha de ingreso a declarar ante ARCA puede no ser la del alta en la cesionaria, y esa decisión es de RR.HH., no del sistema.

También cubre el **cargo simultáneo**: el alta en la segunda empresa se declara, y no genera baja, porque la relación anterior sigue abierta. Con el criterio viejo tampoco aparecía.

Las tres fechas del reporte —alta, baja y antigüedad reconocida— salen de la base como **texto `YYYY-MM-DD`**, no como fecha. Una columna `DATE` que viaja como objeto se serializa en UTC y el navegador puede mostrarla **un día corrida** según la zona horaria del servidor; en un reporte que se declara ante ARCA eso no es aceptable.

Verificado contra PostgreSQL 16 con los tres casos a la vez: la cesión sale como baja en LEITEN el 15/09 y alta en BARTON REBAR el 16/09 con antigüedad 01/03/2019 y la empresa cedente; el cargo simultáneo sale como alta en SINIS sin baja asociada; el ingreso común sale igual que siempre. Filtrando por LEITEN, la empresa ve su baja por cesión y su ingreso, y ninguno de los de las otras empresas — el filtro resuelve por el período, no por el legajo.

---

## 7. Pendiente / a decidir

1. ~~Los demás reportes filtran por la empresa del legajo~~ → **resuelto**, ver 4.1.
2. ~~Alta y baja ante ARCA~~ → **resuelto**: Simplificación Registral ahora se arma sobre los períodos (ver 7.1). La presentación ante ARCA sigue siendo manual: el sistema entrega el listado y el CSV, no transmite.
3. ~~Cesión a mitad de mes~~ → **resuelto**: criterio días trabajados / 30, ver 8.
4. ~~Un legajo sólo podía tener una relación abierta~~ → **resuelto**, ver 9.
5. **Sbrocco y Tormakh.** Cuando estén las fechas y las empresas, se cargan desde la pantalla. Si sus cesiones ya ocurrieron y hay recibos anteriores en el sistema, conviene registrarlas con las fechas reales para que el backfill de recibos los reparta bien.

---

## 8. Cesión a mitad de mes: días trabajados / 30

Cuando el egreso en la cedente no cae a fin de mes, ese mes tiene **dos liquidaciones, una por empresa**. El criterio es el que fijó RR.HH.: el mes se toma siempre de **30 días** y cada empresa paga los días que efectivamente tuvo al trabajador, contando tanto el día de alta como el de egreso.

Con una cesión el 15 de agosto:

| | Período | Días | Proporción |
|---|---|---|---|
| Cedente | 01 → 15/08 | 15 | 15/30 |
| Cesionaria | 16 → 31/08 | 15 | 15/30 |
| | | **30** | **un mes entero** |

Cortando cualquier día del mes la suma da siempre 30: el trabajador cobra el mes completo, sin doble pago ni bache, y cada empresa soporta su parte. Egresar el **último día del mes** cuenta como mes entero aunque el mes tenga 28 o 29 días —es el caso normal de una cesión pactada a fin de mes—, así que ahí no se prorratea nada.

### Qué se prorratea y qué no

Se prorratean los haberes (básico, antigüedad, presentismo, adicionales, no remunerativos) y también dos importes que son **per cápita mensuales** y si no se dividieran se cobrarían enteros en cada una de las dos empresas:

- la **detracción del art. 22 Ley 27.541** sobre la base de contribuciones;
- los **conceptos sindicales de importe fijo** (La Estrella, INACAP, el extraordinario de OSECAC).

El **SCVO** (Dto. 1567/74) y el **FFEP** quedan afuera a propósito: cada empleador los declara por entero en su propio F.931 por el trabajador que tuvo de alta en el mes.

Los descuentos que son **del mes y no de la empresa** —cuotas de anticipos, embargos, recupero del ajuste de neto negativo— van una sola vez, en el recibo del período con el que el trabajador cierra el mes.

### Cómo se comporta la corrida

La empresa que liquida sale del **período**, no del legajo. Antes, después de una cesión el legajo ya "pertenecía" a la cesionaria y la cedente no podía liquidar su parte del mes: no aparecía en su corrida. Ahora:

- La corrida de la **cedente** lo incluye con 15 días; la de la **cesionaria**, con los otros 15.
- Cada recibo queda anclado a **su** período, así que el F.931, el libro de sueldos y el asiento de ese mes salen por la empresa correcta.
- El **correlativo** del recibo sale de la posición del período dentro del mes completo, no de los que entran en esa corrida. Por eso la corrida de la cesionaria no pisa el recibo que dejó la de la cedente, se corran en el orden que se corran, y re-liquidar una de las dos no toca la otra.
- Con un solo período en el mes —el 99% de los casos— el correlativo y el recibo quedan exactamente como antes.

En la **previa editable** aparece una columna **Días**: `30` en gris para el mes completo, `15/30` resaltado para el parcial, con el motivo en el tooltip y la empresa al lado del nombre. Las horas extra se cargan por fila, así que cada empresa carga las suyas.

El recibo guarda además `detalle.mesParcial = { dias, base: 30, factor }`, para que el libro de sueldos y el asiento puedan explicar por qué ese mes salió por menos de un mes entero.

### Verificación

- **El motor**: 15 + 15 días reproducen exactamente el bruto y el neto del mes entero (diferencia 0,00). La suma de los 31 casos del test del motor sigue dando **31 OK, 0 fallidos** — el mes completo no cambió en nada.
- **El cálculo de días**: 16 casos (alta el 1, el 10, el 31; egreso el 10, el 27 y el 28 de febrero; alta y egreso en el mismo mes; período que no toca el mes; fecha como texto y como fecha) y el invariante cortando los 29 días posibles: cedente + cesionaria = 30 siempre.
- **Contra PostgreSQL 16 real**, con el legajo 45 cedido de LEITEN a BARTON REBAR el 15/08: la corrida de LEITEN lo trae con 15 días y correlativo 1, la de BARTON con 15 días y correlativo 2; los dos recibos conviven, cada uno bajo su empresa; re-liquidar LEITEN no toca el de BARTON; en septiembre sale sólo por BARTON y en julio sólo por LEITEN.
- El concepto sindical fijo de $3.000 quedó en $1.500 + $1.500 en vez de cobrarse dos veces.

---

## 9. Cargos simultáneos en dos empresas del grupo

El caso del director con cargo en más de una empresa. **No es una cesión** y el tratamiento es el opuesto:

| | Cesión (Sbrocco, Tormakh) | Cargos simultáneos (director) |
|---|---|---|
| Relaciones abiertas | Una, que pasa de una empresa a otra | Dos a la vez, en empresas distintas |
| El mes | Se **parte**: días/30 en cada empresa | **No se parte**: cada una liquida su mes completo |
| Recibos | Dos sólo en el mes del corte | Dos todos los meses |
| Base | Arts. 225/229 LCT | RG 2252, actividades simultáneas |

### Lo que cambió en el modelo

El índice único pasó de **un período vigente por legajo** a **uno por legajo y empresa**. Sigue estando prohibido tener dos relaciones abiertas en la misma empresa: para eso hay que cerrar la anterior.

### Las cuatro designaciones

Con dos empleadores hay obligaciones que se cumplen **una sola vez**, y cada una elige empresa por un criterio **distinto**. No se derivan entre sí, así que son cuatro campos independientes del período:

| Sigla | Obligación | Quién la asume |
|---|---|---|
| **SCVO** | Seguro de Vida Obligatorio | La de **mayor jornada mensual** (Regl. Dto. 1567/74, art. 3) |
| **AAFF** | Asignaciones familiares | El empleo de **mayor antigüedad** (Ley 24.714, art. 21) |
| **OS** | Obra social unificada | La que **elige el trabajador** (Dto. 292/95, art. 9) |
| **GAN** | Retención de Ganancias | La que pagó **mayor remuneración el año fiscal anterior** (RG 4003, art. 3) |

Perfectamente pueden caer en empresas diferentes. En un legajo con una sola relación las cuatro arrancan en `true` y **nada cambia respecto de antes**.

Lo que hoy hace el sistema con ellas: el **SCVO** sólo se carga en la empresa designada, y **Ganancias** sólo se calcula ahí. **AAFF** y **OS** quedan registradas como dato del legajo — las asignaciones las paga ANSES directo bajo SUAF y no hay nada que declarar en el F.931, y la obra social se informa con el mismo código en las dos empresas.

Lo que **sí** paga cada empresa por separado, íntegro y sin tope: contribuciones patronales, ART, FFEP y la contribución del 6% de obra social.

### La pantalla

En el padrón de la izquierda, un legajo con cargos simultáneos queda marcado con **⇉** y muestra las dos empresas donde presta servicios, para poder encontrarlo de un vistazo (la marca **↔** sigue siendo la de cesión).

En **Períodos y cesiones**, con un legajo que tenga relación vigente aparece **"+ Cargo simultáneo"** al lado de "Ceder contrato". Abre una relación en otra empresa **sin cerrar la vigente**; las cuatro designaciones arrancan apagadas en la relación nueva, o sea que por defecto siguen donde estaban.

Cuando el legajo tiene dos relaciones abiertas, la grilla suma una columna **Obligaciones** con las cuatro siglas: tocar una la mueve a esa empresa y la apaga en la otra, porque es excluyente. Abajo queda la referencia con el criterio legal de cada una.

La cesión, cuando hay más de una relación vigente, ahora pide **cuál empresa cede** — antes tomaba la primera que encontraba, que con simultaneidad es ambiguo.

### Verificación

Contra **PostgreSQL 16 real**, corriendo el módulo de migración de verdad:

- El índice viejo se reemplaza por el nuevo; la segunda corrida no hace nada (idempotente).
- Las cuatro designaciones se crean con default `true`, así que un legajo con una sola relación queda idéntico.
- Dos relaciones abiertas en empresas distintas: **permitido**. Una tercera en otra empresa: permitido. Dos abiertas en la **misma** empresa: **rechazado por la base**.
- Corrida de 09/2026 con el director en LEITEN y SINIS: **dos recibos, los dos por 30 días**, con correlativos distintos y marcados como simultáneos. El SCVO y Ganancias salen sólo por la empresa designada.
- Contraste en la misma corrida con un legajo cedido el 15/09: ese **sí** se parte 15 + 15 y **no** se marca como simultáneo. Los dos mecanismos quedan bien separados.
- Motor: el recibo de la empresa no designada sale **sin SCVO**; el FFEP se mantiene en las dos (va con el contrato de ART de cada una). Con el legajo marcado `data.sinAportes` no se retienen aportes personales en ninguna.
- La suite del motor sigue en **31 OK, 0 fallidos** y el frontend compila sin errores de tipos.

### Lo que falta definir

En `Pluriempleo_criterios.md` está el detalle. Lo abierto: la **detracción del art. 22** (vacío normativo, y el cambio del art. 92 ter por la Ley 27.802 de marzo de 2026 probablemente la vuelva proporcional en cada empresa), y el sustento fáctico de dos relaciones diferenciadas por los **arts. 26 y 31 LCT**.
