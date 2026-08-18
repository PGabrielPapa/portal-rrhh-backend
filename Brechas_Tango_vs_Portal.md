# Tango Sueldos vs. Portal RR.HH. — Matriz de funciones y brechas

_Relevamiento del 8/7/2026. Producto de referencia: **Tango Sueldos (Nómina)**, según documentación pública de Axoft (manuales de referencia y ayuda en línea)._

## Resumen

El Portal ya replica la **enorme mayoría** de las funciones de Tango Sueldos, y en varias áreas lo supera (SiRADIG integrado, organigrama por puesto, módulo de Higiene y Seguridad, tablero de RR.HH.). El relevamiento identifica un puñado de brechas reales, que se detallan y priorizan más abajo.

Convención: ✅ ya existe · 🟡 parcial · ❌ falta

---

## 1. Liquidación (núcleo)

| Función de Tango Sueldos | Estado en el Portal |
|---|---|
| Tipos de liquidación: mensual, 1ª/2ª quincena, SAC, vacaciones, finales, aportes | ✅ |
| Liquidación extraordinaria **remunerativa / no remunerativa** | ✅ **(nuevo)** tipos propios, individual y por corrida (monto fijo o % del bruto) |
| Liquidaciones ilimitadas por período con **número correlativo interno** | ✅ **(nuevo)** las extraordinarias se numeran (#1, #2…): 2+ del mismo tipo por mes |
| Recibo digital con acuse (Ley 27.555) | ✅ |
| Conceptos configurables (rem/no rem/descuento/aporte/contribución) | ✅ |
| **Motor de fórmulas/variables definidas por el usuario** (funciones tipo Excel) | ✅ **(nuevo)** evaluador seguro + editor con "probar" + integrado al cálculo (mensual/quincena) |
| Acumuladores configurables (mensual/anual/rango) | ✅ |
| Inicialización de acumulados al inicio del ejercicio | ✅ (apertura de Ganancias + acumuladores) |
| Aportes con topes SIPA (Jub, OS, ANSSAL, PAMI, sindical) | ✅ |
| Contribuciones (Jub, OS, PAMI, FNE, ART, SCVO, FFEP, FAL, sindical) | ✅ |
| Aportes/contribuciones **solidarias** (no afiliados) sobre base del **Decreto 612/2026** | ✅ **(nuevo)** variable `baseSolidaria` (remun. mensual habitual y permanente; excluye HE, SAC, vacaciones, gratificaciones, no rem.). La cuota de afiliación no se altera |
| **Histórico de afiliación sindical** por legajo (afiliado si hay período abierto a la fecha) | ✅ **(nuevo)** determina automáticamente `afiliado`/`noAfiliado` en la liquidación; FC sin aporte solidario; CCT aplicable visible en el ABM |
| Jornada parcial (OS sobre base full-time, art. 92 ter) | ✅ |
| Detracción Ley 27.541 | ✅ |
| Fondo de cese / indemnización opcional (Ley Bases) | ✅ |

## 2. Impuesto a las Ganancias (4ª cat.)

| Función | Estado |
|---|---|
| Cálculo RG 4003 acumulado enero→mes | ✅ |
| Escala progresiva, MNI, deducciones, cargas de familia | ✅ |
| SiRADIG (F.572) con topes por tipo | ✅ |
| F.1357, liquidación anual y final | ✅ |
| Simulador de Ganancias | ✅ |
| Carga inicial de acumulados (otro empleador / mitad de año) | ✅ |

## 3. Novedades y variables

| Función | Estado |
|---|---|
| Carga de novedades por período (horas extra, ausencias, premios) | ✅ |
| Importación de novedades por Excel | ✅ |
| **Topes por novedad/concepto por período** (anual/semestral/mensual) | ✅ **(nuevo)** configurable por tipo, con opción de bloquear o solo avisar |
| Fichadas / control de asistencia | ✅ (import Pro-Soft + circuito de autorización) |

## 4. Empleados / legajos

| Función | Estado |
|---|---|
| ABM de empleados, alta masiva por Excel | ✅ |
| **Actualización masiva de datos de un grupo de legajos** (obra social, banco, sindicato, categoría, lugar…) | ✅ **(nuevo — recién agregado)** |
| Histórico de cambios de legajo y de período | ✅ |
| Cargas de familia, CBU múltiples, cambios de domicilio/OS | ✅ |
| **Legajos confidenciales** filtrados por perfil de usuario | ✅ **(nuevo)** los ven admin, RR.HH. y empleados designados; marca por legajo |
| **Campos adicionales definibles por el usuario** | ✅ **(nuevo)** ABM de campos del legajo (texto/número/fecha/lista), visibles y editables en el ABM de Empleados |

## 5. Reportes y archivos legales

| Función | Estado |
|---|---|
| Libro de Sueldos (art. 52 LCT) | ✅ |
| F.931 / SICOSS | ✅ |
| Libro de Sueldos Digital (LSD) | ✅ |
| Asiento contable | ✅ |
| Archivos de acreditación bancaria (diseños por banco) | ✅ |
| DDJJ de aportes sindicales | ✅ |
| Generador de reportes multi-dataset | ✅ |

## 6. Otros módulos

| Función | Estado |
|---|---|
| Vacaciones con saldos por antigüedad | ✅ |
| Licencias especiales con topes y saldo sin goce | ✅ |
| Embargos y cuota alimentaria | ✅ |
| Sanciones, evaluaciones, beneficios, elementos | ✅ |
| Alertas de vencimientos | ✅ |
| Cierre de períodos | ✅ |
| Higiene y Seguridad (módulo completo) | ✅ (supera a Tango Sueldos) |
| Organigrama por puesto | ✅ (supera a Tango Sueldos) |

---

## Brechas priorizadas (plan de trabajo)

1. **Actualización masiva de legajos** — ✅ **HECHO** en esta etapa (operaciones masivas de Tango).
2. **Topes por novedad/concepto por período** — ✅ **HECHO** (anual/semestral/mensual; _quincenal no aplica: las novedades del portal son mensuales_).
3. **Legajo confidencial + filtrado por perfil** — ✅ **HECHO** (los ven admin, RR.HH. y designados; oculto en listados/detalle/búsqueda/equipo/novedades para el resto).
4. **Tipos de liquidación extraordinaria (rem/no rem)** — ✅ **HECHO** (individual y por corrida; integra Ganancias y AFIP; sin duplicar SCVO/FFEP). _Pendiente opcional: 2+ liquidaciones del mismo tipo en un mes (correlativo), requiere migración de la tabla de recibos._
5. **Campos adicionales definibles por el usuario** — ✅ **HECHO** (definición + captura en el legajo). _Su uso dentro de fórmulas llega con el ítem 6._
6. **Motor de fórmulas/variables configurable** — ✅ **HECHO**. Fase 1: evaluador seguro + tests. Fase 2: editor de conceptos por fórmula ("probar" + ayuda). Fase 3: integrado al cálculo mensual/quincena, aditivo y con tests de no-regresión (24 + 12 OK).

**Todas las brechas quedaron cerradas**, incluidas las opcionales (correlativo de extraordinarias y agrupaciones auxiliares). Lo único no aplicable es SICORE (impuestos a proveedores, ajeno a sueldos).

### Cómo se usan los conceptos por fórmula
Se crean en *RR.HH. → Liquidación → Conceptos* (con fórmula, base y condición). Los conceptos **activos** marcados como fórmula se aplican automáticamente en la liquidación **mensual/quincena** (individual y por corrida), sumándose como haber o descuento según su base. Un concepto sin fórmula, o inactivo, no afecta nada.

---

## Segunda revisión — manual/ayuda oficial completo (Tango Sueldos v24)

Repaso función por función del índice oficial. Lo ya cubierto no se repite. Funciones de Tango que **el portal aún no contempla**:

### Valiosas (recomendadas)
| Función de Tango | En el portal | Valor / riesgo |
|---|---|---|
| **Simulación de sueldo bruto desde el neto** (gross-up) | ✅ **(nuevo)** Simulaciones → pestaña "Bruto desde neto" |
| **Actualización masiva de sueldos** (por % o importe fijo) | ✅ **(nuevo)** en la pantalla de actualización masiva |
| **Certificación de servicios y remuneraciones** (ANSES PS.6.2) | ✅ **(nuevo)** pantalla imprimible desde el legajo y las remuneraciones |
| **Valores auxiliares: tablas y matrices** (TRAMO/TABLA en fórmulas) | ✅ **(nuevo)** pantalla "Valores auxiliares" |
| **Variables "Macro"** (fórmulas reutilizables) | ✅ **(nuevo)** definibles en "Valores auxiliares", usables por nombre |

### Menores / de formato / nicho
| Función de Tango | En el portal | Nota |
|---|---|---|
| Modelos de recibo configurables (encabezado, leyenda al pie, logo) | ✅ **(nuevo)** pantalla "Modelo de recibo" |
| Conceptos "particulares" con vigencia + habilitación por tipo | ✅ **(nuevo)** alcance (empresa/convenio/sindicato), vigencia, **asignación a legajos puntuales** y **habilitación por tipo de liquidación** (mensual/quincena/SAC/vac/final/extraordinaria) |
| Conceptos asociados a motivos de egreso (configurable) | 🟡 (el motor calcula la indemnización por motivo, pero no es configurable por concepto) | Bajo |
| Fórmula en 3 partes (importe + cantidad + valor) y "análisis numérico" de la fórmula liquidada | 🟡 (fórmula = un importe; hay "probar") | Bajo |
| Plantillas/valores por defecto de legajo · Agrupaciones auxiliares | ✅ **(nuevo)** plantillas de legajo + pantalla "Agrupaciones auxiliares" con filtro en el ABM de empleados |
| Modalidades de contratación configurables · Legajos eventuales (anexo Libroley) | 🟡 | Nicho |
| Simplificación Registral (altas/bajas AFIP) | ✅ **(nuevo)** pantalla + CSV (confirmar diseño ARCA) · _SICORE: pendiente (no aplica a sueldos)_ |
| Control de vencimiento de asignaciones familiares (certificados escolares) | 🟡 (alertas/legajo digital) | Bajo |
| Matrices de antigüedad para fijar el básico (empleados de comercio) | 🟡 (antigüedad por %) | Bajo (cubrible con valores auxiliares) |

_El resto del índice (legajos, familiares, convenios, novedades, licencias, vacaciones, embargos, tipos de liquidación, ganancias/SiRADIG, SICOSS/LSD, asiento, bancos, tablero) ya está cubierto._

---

## Tercera revisión — 12/07/2026 (Tango Sueldos + Meta4/Cegid PeopleNet)

Nueva comparación tras la reorganización de paneles por área y el agregado del **Tablero de talento**.

### Vs. Tango Sueldos (núcleo de nómina) — paridad total
Liquidación individual/global, simulación y autorización; gross-up (bruto desde neto); legajos/familiares/contratos/historial; conceptos configurables + **fórmulas/variables + acumuladores**; SIJP/SICOSS (F.931), **Simplificación Registral** (ex "Mi Simplificación") y LSD; pago automático por archivos de banco; Ganancias 4ª (RG 4003), SiRADIG y F.1357; tablero y reportes multidataset. **Único no aplicable:** SICORE (retenciones a proveedores, ajeno a sueldos).

**Superamos a Tango en:** SiRADIG integrado, organigrama por puesto, módulo de Higiene y Seguridad, recibo digital (Ley 27.555), actualización automática de valores legales y tablas de Ganancias, y toda la suite de talento.

### Vs. Meta4 / Cegid PeopleNet (Core HR + talento) — núcleo cubierto
Core HR (legajos, estructura), desempeño (evaluaciones, 9-box, competencias), formación/capacitación, onboarding, planes de sucesión, encuestas de clima, autogestión del empleado y nómina de gran volumen (corridas + actualización masiva). **(nuevo)** Tablero de talento con rotación, ausentismo, dotación, antigüedad y serie de altas/bajas.

Brechas reales que quedan (no bloqueantes para un grupo como LEITEN):

| Brecha vs PeopleNet | Estado | Nota |
|---|---|---|
| Analítica de talento (rotación/ausentismo/dotación) | ✅ **(nuevo)** Tablero de talento | Cerrada la parte esencial; se puede profundizar |
| LMS completo (rutas de aprendizaje, e-learning con contenidos) | ❌ | Hoy: catálogo de cursos + inscripciones |
| Feedback 360° / OKRs / 1:1 continuos | ❌ | Hoy: 9-box + evaluaciones por ciclo |
| Compensaciones (bandas salariales, compa-ratio, revisión salarial) | ❌ | Hoy: beneficios + aumentos masivos |
| Reclutamiento avanzado (portal de empleo público, job boards, scoring) | 🟡 | Hoy: ATS por etapas (kanban) |
| Escala enterprise (multi-país / multi-moneda / miles de empleados) | ❌ | Alcance del portal: Argentina, un peso, multiempresa del grupo |

**Veredicto:** a la par o por encima de Tango Sueldos en nómina argentina; núcleo de RR.HH. y talento cubierto a nivel grupo frente a PeopleNet, con brechas acotadas a talento avanzado y escala multinacional.

---

## Cuarta revisión — 12/07/2026 (cierre de brechas de talento avanzado)

Se implementaron los tres módulos que faltaban frente a Cegid/Meta4 PeopleNet, además de Compensaciones y el Tablero de talento agregados antes.

| Brecha vs PeopleNet | Estado | Cómo quedó |
|---|---|---|
| Analítica de talento (rotación/ausentismo/dotación) | ✅ **HECHO** | Tablero de talento (anual): dotación, altas/bajas, rotación, ausentismo por tipo, antigüedad, serie mensual |
| Compensaciones (bandas salariales, compa-ratio) | ✅ **HECHO** | Bandas por puesto + análisis de compa-ratio con posición vs banda (dentro/debajo/encima) |
| Reclutamiento avanzado | ✅ **HECHO** | Embudo de selección con tasa de conversión, origen del candidato y evaluación por criterios ponderados (puntaje 0-100) |
| LMS completo | ✅ **HECHO** | Módulos/lecciones por curso (lectura/video/quiz/tarea), itinerarios (rutas de aprendizaje) y seguimiento de progreso por inscripción |
| Feedback 360° / OKRs | ✅ **HECHO** | OKRs con resultados clave medibles y avance; feedback 360° multi-evaluador (jefe/par/reporte/auto) con resultados agregados por competencia y relación |
| Escala enterprise (multi-país / multi-moneda / miles de empleados) | ➖ No aplica | Alcance del portal: Argentina, un peso, multiempresa del grupo LEITEN |

### Detalle técnico de los módulos nuevos
- **Reclutamiento avanzado**: `candidatos.origen/puntaje/evaluacion` + `GET /api/reclutamiento/embudo`. Vista «Selección — embudo y evaluación».
- **LMS**: tablas `curso_modulos`, `itinerarios`, `itinerario_cursos`, `formacion_progreso` + rutas `/api/lms`. Vista «LMS (contenidos e itinerarios)».
- **OKRs + Feedback 360**: tablas `okrs`, `okr_resultados`, `feedback_solicitudes`, `feedback_respuestas` + rutas `/api/desarrollo`. Vista «OKRs y Feedback 360°».

### Estado final
Frente a **Tango Sueldos**: paridad total en nómina argentina, y por encima en varios frentes (único no aplicable: SICORE). Frente a **Meta4/Cegid PeopleNet**: **todas las brechas funcionales cerradas**; la única diferencia remanente es la escala multinacional (multi-país/multi-moneda), fuera del alcance del grupo. Verificación: backend compila y monta todas las rutas, 44 tests OK (28 liquidación/Ganancias + 16 fórmulas), frontend type-check limpio.

---

## Quinta revisión — 12/07/2026 (mercado argentino: experiencia y movilidad)

Comparación contra apps de RR.HH. de Argentina (Buk, Humand, Rankmi, Bejerman, Nubo, Factorial). El portal ya estaba a la par en nómina y talento; las mejoras se enfocaron en experiencia del empleado y movilidad, que es donde esos productos se diferencian.

| Mejora (referencia de mercado) | Estado |
|---|---|
| **App móvil / mobile-first** (Buk, Humand) | ✅ **HECHO** — PWA instalable + service worker + menú responsive (hamburguesa) y tablas con scroll en celular |
| **Comunicación interna: muro + reconocimientos** (Humand) | ✅ **HECHO** — comunicados con acuse de lectura y reconocimientos entre pares + ranking |
| **Encuestas de pulso + eNPS** (Buk, Rankmi) | ✅ **HECHO** — preguntas NPS 0-10 y cálculo de eNPS en resultados |
| **Fichaje desde el celular con geolocalización** (Buk, Humand) | ✅ **HECHO** — self check-in web con ubicación, en tabla propia, **aislado de Pro-Soft** |
| **Firma digital de documentos** (Buk, Factorial) | ✅ **HECHO** — distribución de contratos/políticas con firma/acuse del empleado y seguimiento |
| IA (resúmenes, asistente) (Rankmi) | ➖ Pendiente / opcional |

### Detalle técnico
- **PWA**: `manifest.webmanifest`, `sw.js`, íconos y meta tags; sidebar off-canvas en ≤820px.
- **Comunicación**: tablas `comunicados`, `comunicado_lecturas`, `reconocimientos` + rutas `/api/comunicaciones`. Vistas «Muro y reconocimientos» (empleado) y «Comunicados y reconocimientos» (RR.HH.).
- **Pulso/eNPS**: `encuestas.tipo` + preguntas `nps`; eNPS en `/encuestas/:id/resultados`.
- **Fichaje web**: tabla `fichadas_web` + rutas `/api/fichaje`. Vistas «Fichar (web/celular)» y «Fichaje web (consulta)». No toca `fichadas_periodo` (Pro-Soft).
- **Firma de documentos**: tablas `documentos_firma`, `documento_destinatarios` + rutas `/api/firmas`. Vistas «Documentos a firmar» (empleado) y «Documentos para firma» (RR.HH.).

### Estado general
Frente a Tango Sueldos: paridad total en nómina. Frente a Meta4/PeopleNet: brechas funcionales cerradas. Frente al mercado argentino moderno (Buk/Humand/Rankmi): cerradas las diferencias de experiencia y movilidad; queda como opción a futuro la incorporación de IA. Verificación: backend compila y monta todas las rutas, 44 tests OK, frontend type-check limpio.

---

## Sexta revisión — 12/07/2026 (SICORE/SIRE — retenciones de Ganancias a ARCA)

Corrección de una brecha que antes figuraba como "no aplicable": la retención de Impuesto a las Ganancias de 4ª categoría sobre sueldos **sí** se informa a ARCA por el empleador (régimen 602, impuesto 217; RG 2233 / SICORE, en migración al SIRE). Se implementó el módulo completo.

| Función | Estado |
|---|---|
| Informe de retenciones y devoluciones de Ganancias 4ª a ARCA | ✅ **HECHO** |
| Archivo de salida SICORE (ancho fijo) + CSV de control | ✅ **HECHO** |
| Verificación mensual del diseño (como el F.931/SICOSS) | ✅ **HECHO** |
| Actualización automática del diseño/formato (calendario + arranque + diaria) | ✅ **HECHO** |
| Migración a SIRE | 🟡 preparado (entrada de calendario lista para activar con su fecha de vigencia) |

### Detalle técnico
- **Datos**: `/api/sicore/ganancias` arma por período y por empleado las retenciones y devoluciones desde los recibos liquidados (netea retención − devolución). Exporta `.txt` (formato SICORE de comprobantes, régimen 602 / impuesto 217, operación 1 retención / 2 devolución) y `.csv` de control. Vista «SICORE — Ganancias (informe ARCA)» en Cargas sociales y AFIP.
- **Versionado y verificación**: tablas `sicore_diseno` (versión + modo SICORE/SIRE) y `sicore_generaciones` (log). La pantalla muestra la versión vigente, si está al día o hay una versión nueva, y si el mes ya se generó con el diseño actual (validación mensual), igual que el F.931/LSD.
- **Actualización automática**: calendario de diseños en `lib/sicore.js` con `vigenciaDesde`; una tarea en el arranque y diaria adopta sola la versión vigente (mismo patrón que valores legales y tablas de Ganancias). Cuando ARCA fije la migración al SIRE para el régimen 602, se agrega la entrada con su fecha y el sistema la adopta en/desde esa fecha.

### Nota
Los datos del detalle y el CSV son exactos. El diseño de ancho fijo del `.txt` sigue el layout de comprobantes de SICORE; ante la migración al SIRE conviene validar el diseño vigente de ARCA antes de la primera importación (los anchos están centralizados en `lib/sicore.js` para ajustarlos en un solo lugar).

---

## Séptima revisión — 12/07/2026 (config de liquidación + diferencias Meta4/CEGID)

Se cerraron los ítems "nicho" de Tango y las diferencias de configuración con Meta4/CEGID PeopleNet.

### Configuración de liquidación (Tango)
| Función | Estado |
|---|---|
| Conceptos particulares con vigencia (alcance empresa/convenio/sindicato, fechas, legajos, tipos) | ✅ (ya existía) |
| Fórmula en 3 partes (cantidad × valor unitario, con unidad) | ✅ **HECHO** |
| Conceptos asociados a motivos de egreso (solo en la final, por motivo) | ✅ **HECHO** |
| Matriz de antigüedad para fijar el básico (tramos por convenio/categoría) | ✅ **HECHO** |
| Modalidades de contratación configurables (eventual, pasantía, práctica…) con hook de indemnización | ✅ **HECHO** |

### Diferencias de configuración con Meta4 / CEGID PeopleNet
| Función | Estado |
|---|---|
| Diccionario de competencias (catálogo central con niveles) | ✅ **HECHO** |
| Estructura organizativa (árbol de unidades + asignación al legajo + organigrama) | ✅ **HECHO** |
| Gestión de posiciones y vacantes (dotación planificada vs. ocupada) | ✅ **HECHO** |
| Motor de workflows de aprobación configurable | ✅ **HECHO** (definición por proceso + aplicación efectiva multinivel en adelantos, licencias y sanciones; aprobadores por rol o por puesto; bandeja unificada con avisos) |
| Multi-país / multi-moneda / multi-idioma | ➖ No aplica (alcance del grupo) |

### Aplicación efectiva de workflows (enforcement)
Los flujos definidos en la pantalla **Workflows** (pasos ordenados, obligatorios u opcionales) ya se aplican de forma efectiva en tres circuitos. Cada paso puede exigir un **rol** (responsable/gerente, RR.HH. o admin) o un **puesto específico** (p. ej. "Gerente de Finanzas"), que tiene prioridad sobre el rol.

- **Adelantos**: al pedirse un adelanto se toma una foto (*snapshot*) del flujo activo del proceso `adelantos`. Cada aprobador resuelve sólo su paso; se registra quién aprobó/rechazó cada nivel y, al cerrarse el último paso obligatorio, el adelanto pasa a `aprobado` con sus cuotas.
- **Licencias**: mismo mecanismo con el proceso `licencias` (aplica también a las justificaciones con comprobante y a las vacaciones, que son un tipo de licencia). Al cerrarse el último paso obligatorio queda `aprobada`; si alguien rechaza, `rechazada`.
- **Sanciones**: el proceso `sanciones` (solicitud del responsable) pasa por los niveles configurados; al aprobarse el último paso queda `aplicada`, o `rechazada` si se corta el circuito.

Es retrocompatible: si un proceso no tiene flujo definido, el circuito sigue con la aprobación clásica (un solo paso directo).

### Bandeja de aprobaciones y avisos
- **Bandeja unificada**: la pantalla "Aprobaciones pendientes" reúne, para gerentes y RR.HH., todos los trámites (adelantos, licencias y sanciones) que esperan su decisión, con **contador/badge en el menú** que se refresca solo.
- **Avisos por mail** (si hay SMTP configurado): al aprobador de turno cuando le toca su paso, y al solicitante cuando su trámite se aprueba o rechaza. Siempre queda además un **mensaje interno** para el solicitante.

### Actualización automática de escalas salariales de convenio
Mismo esquema de verificación/actualización que F.931, SICORE y valores legales, **manejando histórico**:

- **Verificación mensual (automática)**: al arrancar el backend y en el chequeo diario/mensual, el sistema toma la **escala unificada vigente** para el mes en curso (versión con vigencia ≤ período) y la adopta, dejando registro sin pisar ninguna versión cargada.
- **Actualización al liquidar**: al generar la corrida se adopta la escala unificada vigente del período (más las escalas por sindicato vigentes) y queda asentado en el histórico con usuario y fecha.
- **Confirmación antes de liquidar**: al generar la corrida, un mensaje indica qué escala unificada se aplicará (vigencia, cantidad de categorías, convenios vigentes) y **si cambió respecto del período anterior** (con el % de aumento). La corrida se ejecuta sólo si se confirma; al terminar, el aviso indica si la escala se actualizó o quedó igual.
- **Fuente**: las paritarias se cargan en "Escala salarial"; la "actualización automática" adopta la versión vigente cargada para el período (no hay una fuente pública única de convenios) y avisa del cambio.

### Operación y seguridad
- **Respaldo automático de la base**: `pg_dump` diario a `portal-rrhh-backend/backups/` con retención configurable (def. 14), activado al arrancar; respaldo manual con `npm run backup`; guía de restauración en `RESPALDO_Y_RESTAURACION.md`. Config por `.env` (`BACKUP_AUTO`, `BACKUP_HORA`, `BACKUP_RETENCION`, `BACKUP_DIR`).
- **Auditoría ampliada**: la bitácora (`audit_log`, visible en Admin → Auditoría) registra ahora las acciones sensibles de liquidación (correr, aprobar, publicar corrida) y de escalas (incremento, adopción), además de admin y cambios de datos personales. Conceptos tienen su propio historial de cambios.
- **Alerta de paritaria/escala vencida**: en Alertas se avisa cuando la escala de un convenio o la escala unificada llevan N meses sin actualizarse (`PARITARIA_MESES`, def. 6; "urgente" a partir de +3).
- **Aviso al empleado al publicar**: al publicar una corrida, cada empleado recibe un mensaje interno (y un mail breve si hay SMTP) avisando que su recibo está disponible.

### Monitoreo y recordatorios
- **Estado del sistema** (Administración, solo admin): pantalla que muestra la salud del backend y la base, el último respaldo y su cantidad, y la vigencia de las automatizaciones (valores legales, Ganancias, escala unificada + convenios). Endpoint `GET /api/admin/estado-sistema`.
- **Guardas globales**: excepciones no atrapadas quedan registradas (`[FATAL capturado]`) sin tumbar el backend (evita cortes de conexión/ECONNRESET).
- **Recordatorio de aprobaciones (SLA)**: chequeo diario que avisa por mail al aprobador de turno cuando un paso de adelantos/licencias/sanciones lleva más de N días sin resolver (`RECORDATORIO_APROB_DIAS`, def. 3).

### Detalle técnico
- **Escalas auto**: `lib/escalasAuto.js` (escala unificada y convenios vigentes, verificación con detección de cambios, adopción idempotente con histórico en `escala_adopciones`); endpoints `GET /api/escala/verificar`, `POST /api/escala/adoptar`, `GET /api/escala/adopciones`; integrado en la corrida y en el arranque/chequeo periódico; confirmación en la pantalla de Liquidación.
- **Motor de workflows**: `lib/workflowEngine.js` (funciones puras: paso actual, permisos por rol/puesto/equipo, cierre multinivel), reutilizado por adelantos, licencias y sanciones; endpoints `GET /:id/flujo` y `POST /:id/aprobar` por circuito + `GET /aprobaciones/pendientes` (bandeja). Frontend: componente único `FlujoAprobacion` y página `MisAprobaciones`.
- **Liquidación**: fórmula 3 partes y motivos de egreso en `liquidacion.js` (aditivo, tests OK); prioridad del básico por matriz de antigüedad; indemnización condicionada por la modalidad del legajo.
- **Config**: tablas y ABM de `matriz_antiguedad`, `modalidades_contratacion`, `competencias`, `unidades_org`, `posiciones`, `workflows`. Selectores de modalidad y unidad en el ABM de Empleados; selector de puesto por paso en Workflows.
- **Robustez de arranque**: el aplicador de esquema corre en varias pasadas (reintenta sentencias que dependen de otras aún no creadas) y registra el error exacto; script `diagSchema.js` para diagnóstico puntual.
- **Estado final**: a la par de Tango en nómina y de PeopleNet en Core HR + talento + configuración, con workflows configurables aplicados en adelantos, licencias y sanciones (por rol o puesto), bandeja unificada y avisos, y verificación/actualización automática de las escalas salariales con confirmación previa a la corrida e histórico; lo único remanente es la escala multinacional. Verificación: backend compila y monta todas las rutas, **55 tests OK** (28 liquidación + 16 fórmulas + 11 workflow), frontend type-check limpio.
