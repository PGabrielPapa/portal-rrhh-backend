# Relaciones laborales simultáneas en dos empresas del grupo

Qué dice la normativa y qué hay que decidir, para el caso del director con cargo en más de una empresa del grupo. Estado: **investigación cerrada. Modelo y pantalla implementados y verificados; los criterios de la sección 2 quedan a confirmar con Contabilidad.**

Fecha del relevamiento: septiembre de 2026.

---

## 0. Lo primero: esto no es una cesión

Son dos cosas distintas y el sistema tiene que distinguirlas, porque el tratamiento es opuesto:

| | Cesión de contrato (Sbrocco, Tormakh) | Relaciones simultáneas (director) |
|---|---|---|
| Relaciones abiertas | Una sola, que pasa de una empresa a otra | Dos a la vez, en empresas distintas |
| El mes de la cesión | Se **parte**: días/30 en cada empresa | **No se parte**: cada empresa liquida su mes completo |
| Recibos | Dos en el mes del corte, uno por empresa | Dos todos los meses |
| Base legal | Arts. 225/229 LCT | RG 2252 (actividades simultáneas) |

El prorrateo días/30 que ya está implementado **no aplica** al caso del director.

---

## 1. Lo que la norma resuelve de forma expresa

### 1.1 Seguro de Vida Obligatorio — lo paga UNA sola empresa

Es el hallazgo más concreto y el más fácil de estar liquidando mal. El Reglamento del Dto. 1567/74, art. 3, es textual:

> "Los trabajadores en relación de dependencia que presten servicios para más de un empleador, **sólo tendrán derecho a una sola prestación del seguro**. La contratación del seguro queda a cargo y es obligación del **empleador ante el que el trabajador cumpla la mayor jornada mensual laboral**, y en caso de igualdad, quedará a opción del trabajador."

El criterio es **jornada**, no remuneración ni antigüedad. Conviene dejar la comparación de jornadas documentada en el legajo, porque es el hecho que determina cuál empresa asume la obligación.

**A verificar:** si hoy las dos empresas están pagando el per cápita del SCVO por esta persona, una de las dos lo está pagando de más.

### 1.2 Asignaciones familiares — las habilita UN solo empleo

Ley 24.714, art. 21:

> "Cuando el trabajador se desempeñare en más de un empleo tendrá derecho a la percepción de las prestaciones de la presente ley en el que acredite **mayor antigüedad**, a excepción de la asignación por maternidad, que será percibida en cada uno de ellos."

Otro criterio distinto: acá es **antigüedad**. Bajo SUAF no hay nada que declarar en el F.931 — ANSES liquida y paga directo, y resuelve la duplicación consultando sus propias bases.

**Punto de atención:** para el IGF se **suman** las dos remuneraciones (Dto. 1667/2012 y Dto. 1245/96 art. 4, "uno o más empleos"). Si la suma supera **$3.157.449** (Res. ANSES 260/2026, vigente desde 09/2026), **todo el grupo familiar queda excluido** del cobro, aunque cada sueldo por separado esté por debajo.

### 1.3 Obra social — una sola, y la unificación es obligatoria

Decreto 292/95, art. 9: el trabajador en pluriempleo **está obligado** a concentrar aportes y contribuciones en un solo agente y comunicar la opción a sus empleadores, dentro de los **60 días**. Si no lo hace, se unifica de oficio en la obra social que haya recibido la cotización mayor.

Procedimiento ante los empleadores (RG DGI 4072/95): nota escrita a todos los empleadores salvo al que ya aporta a la obra social elegida, con CUIL, apellido y nombres, y código y denominación de la obra social, acompañando certificado del empleador principal. Los empleadores deben archivar la nota, consignar ese código de obra social en la declaración jurada y reflejarlo en el recibo.

En el F.931 **las dos empresas declaran el mismo código de obra social**. No hay campo que marque al trabajador como unificado.

La **contribución patronal del 6%** la paga **cada empresa sobre su remuneración íntegra, sin tope** (RG 2252 Anexo I; Guía 18 LSD, base REM8). La prestación es una sola pero la financian las dos.

### 1.4 ART — cada empresa la suya

La afiliación es por empleador (Ley 24.557 art. 27) y la base REM9 no tiene tope. Cada empresa declara a la persona en su propio contrato y paga cuota sobre su propia remuneración. Es además lo necesario: un accidente en una empresa tiene que estar cubierto por la ART de esa empresa.

### 1.5 Ganancias — retiene una sola, sobre la suma de las dos

RG 4003, art. 3: cuando se perciben rentas de varios sujetos, **sólo actúa como agente de retención el que abone las de mayor importe**. Y se determina en dos momentos, no todos los meses:

- **Al inicio de cada año fiscal**, comparando lo que abonó cada pagador **durante todo el año anterior** (no los sueldos corrientes de enero).
- **Al inicio de una nueva relación laboral**.

El agente retiene sobre la **suma de ambos empleos**: una sola base acumulada y una sola escala. El formulario F.1359 v2.0 tiene campos propios para eso — "Otros Empleos - Remuneración Bruta", "Otros Empleos - SAC", "Otros Empleos - Ajustes" — y ARCA valida aritméticamente la suma.

**La empresa que no es agente de retención no retiene ni informa nada** bajo esta RG. El canal de información es el trabajador, por SiRADIG: mensualmente tiene que declarar el bruto y las deducciones del otro empleo. Sin eso, la retención sale mal.

Tres cosas para tener presentes:

- **El tope del art. 7**: la retención mensual no puede superar la alícuota máxima aplicada sobre el pago que hace el agente. Con el impuesto calculado sobre dos sueldos y cobrado de uno solo, ese tope puede impedir retener todo mes a mes, y el remanente se regulariza en la liquidación anual (donde el tope no rige salvo nota del trabajador). Tiene efecto financiero sobre el recibo.
- **El formulario cambió**: F.1357 quedó para los períodos 2018-2023; 2024 va por F.1359 v1.0 y **2025 en adelante por F.1359 v2.0**.
- **Laguna**: si dentro del mismo año fiscal una empresa pasa a pagar más que la otra, sin que haya inicio de una nueva relación laboral, la RG no prevé el cambio de agente hasta enero siguiente. No hay dictamen que lo aclare.

---

## 2. Lo que la norma NO resuelve

### 2.1 Detracción art. 22 Ley 27.541 — vacío normativo

Ni la Ley 27.541, ni el Decreto 99/2019, ni la RG 4661 mencionan el pluriempleo. La detracción se computa "por cada uno de los trabajadores **que integren la nómina del empleador**" (RG 4661 art. 1 inc. b), lo que apunta a que cada empresa la compute entera en su propio F.931. No hay ningún dictamen, consulta vinculante ni criterio publicado de ARCA sobre el punto.

**Pero hay un cambio de 2026 que importa más que el pluriempleo en sí.** El art. 27 de la **Ley 27.802** (B.O. 6/3/2026) sustituyó el art. 92 ter LCT y cambió la definición de tiempo parcial: antes era una jornada inferior a **dos tercios** de la habitual de la actividad; ahora basta con que sea **inferior a la jornada legal o convencional**.

El art. 22 de la Ley 27.541 remite a "los contratos a tiempo parciales a los que refiere el artículo 92 ter", así que ese universo se amplió con él. Una persona con dos relaciones simultáneas difícilmente cumpla jornada completa en las dos — con lo cual es probable que **ambos contratos sean hoy de tiempo parcial**, y que la detracción corresponda **proporcional en cada empresa**, con el tope de dos tercios del Decreto 99/2019 art. 3.

El Decreto 99/2019 no fue actualizado tras el cambio del 92 ter, y ARCA no publicó ninguna adecuación. Es un punto genuinamente abierto.

**Lo que hay que definir y documentar, por cada una de las dos relaciones:** cuál es la jornada legal o convencional de la actividad de esa empresa, y cuál la jornada efectivamente pactada. Si la segunda es menor, el contrato es a tiempo parcial y la detracción va proporcional.

Importe vigente de la detracción: **$7.003,68**, sin actualización desde 2019. Detracción adicional del art. 23 para empleadores de hasta 25 empleados: **$10.000 mensuales por empleador** — si las dos empresas califican, cada una computa los suyos, con independencia de este caso.

### 2.2 FFEP — sin norma expresa

El FFEP es una suma fija por trabajador incluida en cada contrato de afiliación a ART, así que lo razonable es que **cada empresa pague el per cápita completo** ($1.905 desde 08/2026, Disp. SRT 8/2026). No hay norma que lo diga, y **no se puede extender por analogía la regla de pago único del SCVO**: esa regla es excepcional y está en su propio reglamento.

### 2.3 Qué queda sin fuente

- Ningún dictamen ni consulta vinculante sobre detracción con actividades simultáneas.
- Ninguna adecuación de ARCA al nuevo art. 92 ter, posterior al 6/3/2026.
- Ninguna norma sobre FFEP ni sobre ART en pluriempleo.
- Ninguna instrucción sobre cómo señalar en el F.931 que la persona cobra asignaciones por el otro empleador (bajo SUAF, probablemente porque no hay nada que informar).

---

## 3. El tope de aportes, y por qué acá puede no aplicar

El régimen general de actividades simultáneas (RG 2252) parte de que **el tope del art. 9 de la Ley 24.241 es uno solo para el trabajador y se reparte entre los empleadores**: el trabajador presenta el Anexo III en cada empresa declarando sobre qué importe debe abstenerse de retener, y la fórmula es `base de aportes = tope máximo − lo declarado en el Anexo III`. Si una empresa ya agotó el tope, la otra informa **REM1, REM4 y REM5 en cero**.

Las contribuciones patronales, en cambio, **no se topean ni se coordinan**: cada empresa declara REM2, REM3, REM8, REM9 y REM10 según su propia liquidación, completas.

Tope vigente 09/2026: máximo **$4.691.748,47**, mínimo **$144.363,55** (Res. ANSES 257/2026).

**Ahora bien:** si el director está exento de aportes personales, todo este mecanismo no lo alcanza — no hay aportes que topear ni que repartir, y no hace falta el Anexo III. Lo que sigue aplicando es todo lo de la sección 1 (SCVO, asignaciones, obra social, ART, Ganancias) y la detracción de la sección 2.1.

**Esto hay que confirmarlo antes de construir nada**, porque define si el sistema necesita o no la carga del Anexo III.

---

## 4. Riesgo laboral a tener en cuenta

Las dos empresas son del mismo grupo. Los **arts. 26 y 31 de la LCT** (empleador plural, conjunto económico con solidaridad) pueden llevar a que, ante un reclamo, se considere una **única relación laboral con empleador plural** en lugar de dos relaciones independientes. Eso alteraría retroactivamente la antigüedad, la base de cálculo de indemnizaciones y el encuadre.

La estructura de actividades simultáneas es correcta desde lo previsional, pero conviene tener sustento fáctico de dos relaciones genuinamente diferenciadas: tareas distintas, jornadas distintas, dirección distinta.

---

## 5. Los tres criterios no coinciden entre sí

Es el error más fácil de cometer, porque cada subsistema resuelve el pluriempleo con una regla distinta:

| Subsistema | Cuántos | Criterio |
|---|---|---|
| Obra social | Una sola | **Elección del trabajador** (Dto. 292/95 art. 9) |
| Seguro de Vida Obligatorio | Un empleador | **Mayor jornada mensual** (Regl. Dto. 1567/74 art. 3) |
| Asignaciones familiares | Un empleo | **Mayor antigüedad** (Ley 24.714 art. 21) |
| Ganancias | Un agente | **Mayor remuneración del año anterior** (RG 4003 art. 3) |
| ART y FFEP | Los dos | Afiliación por empleador |
| Contribuciones patronales | Los dos, íntegras | Sin tope, sin coordinación |

Puede perfectamente pasar que la obra social se unifique en una empresa, el SCVO lo contrate la otra por tener mayor jornada, las asignaciones corran por la primera por antigüedad, y Ganancias las retenga la segunda por pagar más. **No hay ninguna regla que los alinee**, así que en el sistema cada uno tiene que ser un dato propio del legajo, no derivarse de los otros.

---

## 6. Qué habría que construir

Con el alcance acordado — modelo y pantalla primero, aportes después:

1. ~~Permitir dos relaciones abiertas en empresas distintas~~ → **hecho**: el índice único pasó de un período vigente por legajo a uno por legajo y empresa.
2. ~~Distinguir simultaneidad de cesión en la corrida~~ → **hecho**: la simultaneidad da 30 días en cada empresa y no dispara el prorrateo; la cesión sigue partiendo el mes.
3. ~~Marcar cuál empresa corresponde para SCVO, asignaciones, obra social y Ganancias~~ → **hecho**: cuatro campos independientes del período, editables desde la pantalla. El SCVO y Ganancias ya salen sólo por la empresa designada.
4. **Pendiente, y sólo si hace falta**: carga del Anexo III y reparto del tope de aportes. Como el director está exento de aportes personales, hoy no aplica; haría falta si más adelante hay un caso simultáneo que sí aporte.

El detalle de lo implementado y su verificación está en `Periodos_y_legajo.md`, sección 9.

---

## Fuentes

Normativa: [Ley 27.541 texto actualizado](https://servicios.infoleg.gob.ar/infolegInternet/anexos/330000-334999/333564/texact.htm) · [Decreto 99/2019](https://servicios.infoleg.gob.ar/infolegInternet/anexos/330000-334999/333618/texact.htm) · [RG 4661/2020](https://servicios.infoleg.gob.ar/infolegInternet/anexos/330000-334999/333829/texact.htm) · [RG 2252/2007](https://servicios.infoleg.gob.ar/infolegInternet/anexos/125000-129999/127869/norma.htm) · [Ley 24.241 art. 9](https://servicios.infoleg.gob.ar/infolegInternet/anexos/0-4999/639/texact.htm) · [LCT art. 92 ter, texto según Ley 27.802](https://servicios.infoleg.gob.ar/infolegInternet/anexos/25000-29999/25552/texact.htm) · [RG 4003/2017 texto consolidado](https://biblioteca.afip.gob.ar/dcp/REAG01004003_2017_03_02) · [RG ARCA 5683/2025](https://www.consejosalta.org.ar/wp-content/uploads/ARCA-5683.pdf) · [Decreto 292/1995 arts. 8 y 9](https://servicios.infoleg.gob.ar/infolegInternet/anexos/25000-29999/25621/texact.htm) · [Res. SSSalud 362/2009](https://servicios.infoleg.gob.ar/infolegInternet/anexos/150000-154999/151666/norma.htm) · [RG DGI 4072/1995](https://e-legis-ar.msal.gov.ar/htdocs/legisalud/migration/pdf/6861.pdf) · [Reglamento SCVO Dto. 1567/74, art. 3](https://servicios.infoleg.gob.ar/infolegInternet/anexos/55000-59999/58948/norma.htm) · [Decreto 590/1997 (FFEP)](https://servicios.infoleg.gob.ar/infolegInternet/anexos/40000-44999/44300/texact.htm) · [Ley 24.714 art. 21](https://www.argentina.gob.ar/normativa/nacional/ley-24714-39880/actualizacion) · [Decreto 1245/1996](https://servicios.infoleg.gob.ar/infolegInternet/anexos/40000-44999/40271/norma.htm) · [Res. ANSES 260/2026](https://www.argentina.gob.ar/normativa/nacional/norma-429461/texto) · [Decreto 814/2001](https://servicios.infoleg.gob.ar/infolegInternet/anexos/65000-69999/67425/texact.htm) · [Ley 24.557 art. 27](https://leyes-ar.com/ley_sobre_riesgos_del_trabajo/27.htm)

Documentación oficial ARCA: [Guía N.º 11 LSD — Actividades simultáneas](https://www.afip.gob.ar/LibrodeSueldosDigital/documentos/nuevos/G11_Actividades_Simultaneas_LSD.pdf) · [Guía N.º 18 LSD — Bases imponibles](https://www.afip.gob.ar/LibrodeSueldosDigital/documentos/nuevos/G18-Armado-bases-imponibles-LSD.pdf) · [Guía N.º 31 LSD — Topes a las bases de aportes](https://www.afip.gob.ar/librodesueldosdigital/documentos/nuevos/g31-topes-lsd.pdf) · [Manual F.1359 v2.0, mayo 2026](https://ftp.afip.gov.ar/572web/documentos/F1359-Version-00200-Manual-001-a%C3%B1o2026.pdf) · [Topes previsionales vigentes](https://www.arca.gob.ar/declaracionenlinea/actualizacion-versiones/version47-8-actualizacion.asp)

No se pudo acceder a las fichas del CPCECABA (Trivia), restringidas a matriculados, ni al ABC de consultas frecuentes de ARCA.
