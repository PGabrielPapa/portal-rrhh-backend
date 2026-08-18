# Auditoría integral — Portal RR.HH. (Grupo LEITEN)

Fecha: julio 2026 · Alcance: backend (Node/Express/PostgreSQL) y frontend (React/TS).
Metodología: revisión de código en cuatro ejes (seguridad, liquidación/legal, datos/arquitectura, frontend). Solo lectura, salvo las correcciones ya aplicadas que se detallan abajo.

## Resumen ejecutivo

La base del sistema es sólida: queries parametrizadas (sin inyección SQL), JWT con fail-fast del secret y `alg` fijo, 2FA/TOTP, bcrypt, rate-limit en login, escala de Ganancias y deducciones versionadas por período, y migraciones de puestos/seed idempotentes y transaccionales. No se detectó XSS, `eval` ni `dangerouslySetInnerHTML` en el frontend.

Los focos de atención, por orden de urgencia, son: (1) exposición de datos personales/salariales por endpoints de empleados sin control de rol, (2) corridas de liquidación sin transacción, (3) actualización de valores 2026 (SMVM y tope SIPA) y separación de la base imponible de obra social, (4) endurecimiento de adjuntos. Ya se corrigieron dos ítems críticos autocontenidos (ver siguiente sección).

## Correcciones ya aplicadas en esta auditoría

- Eliminada `calcularF1357` en `lib/liquidacion.js`: era código muerto (nadie la importaba) y tenía un bug de scope (`opts` inexistente) que reventaba si se invocaba. El F.1357 real lo arma `ganancias.routes.js` (f1357For), que sí integra SiRADIG, topes RG 4003 y acumulados.
- Prevención de ciclos en `puestos.reporta_a` (`routes/puestos.routes.js`, PUT): ahora se rechaza asignar como superior a un puesto que depende del que se edita. Evita que, por un ciclo, un empleado quede como "su propio superior" y se autoaprobara adelantos/licencias/fichadas.

Verificación tras los cambios: `node --check` OK y suite de tests 16/16.

---

## 1) Seguridad

### CRÍTICO
- IDOR en `routes/empleados.routes.js` — `GET /` (lista completa) y `GET /:id` solo tienen `requireAuth`. Un empleado cualquiera puede listar o leer el legajo de terceros (bruto, neto, DNI, CUIL, domicilio, etc. vía `mapRow`). No se filtran password/2FA (el DTO se arma campo por campo), pero sí el resto de datos personales/salariales.
  - Matiz de implementación: `/empleados?q=` lo usan también RR.HH., managers y **comité de H&S** (buscador de empleados en siniestros/EPP), por eso hoy está abierto. La corrección correcta es un endpoint de búsqueda liviano (id, nombre, legajo, empresa) para los roles que arman selectores, y restringir la lista/`:id` completos a RR.HH./admin (+ manager solo su equipo, + self). Requiere refactor del `EmpleadoPicker`.

### ALTO
- `GET /empleados/cumpleanios` (`empleados.routes.js:154`): fecha de nacimiento/edad de toda la empresa con solo `requireAuth`.
- `GET /puestos/organigrama` y `GET /puestos`: exponen dotación (nombre, legajo, cat, tramo, lugar, tarea, foto) a cualquier autenticado. Si el organigrama debe ser público interno, reducir el DTO; si no, exigir rol.

### MEDIO
- Adjuntos base64 (licencias `/justificar` y `/:id/comprobante`, sanciones `/:id/notificacion`, chs, legajo): sin validación de tamaño real ni allowlist de MIME; el único freno es `express.json({limit:'5mb'})`.
- `Content-Disposition: inline` con MIME provisto por el usuario (licencias `:243`, sanciones `:126`): subiendo un HTML/SVG y compartiendo el link se puede ejecutar script (XSS almacenado). Servir siempre `attachment` (como ya hace chs) + `X-Content-Type-Options: nosniff`.
- CORS sin fail-fast de `CORS_ORIGIN` en producción (el default de dev es localhost; el código ya evita `*` con credenciales).

### BAJO
- Rate-limit solo en login/change-password; no hay limiter global suave.
- JWT stateless de 8 h sin revocación: desactivar un usuario o resetear 2FA no invalida su token vigente.

### Bien resuelto
Sin inyección SQL; recibos, licencias, sanciones, fichadas, familiares, cbus y mensajes validan dueño/equipo/rol; admin bajo `requireRole('admin')` con `audit_log`; el errorHandler no filtra stack traces.

---

## 2) Liquidación y cumplimiento legal

### CRÍTICO
- (RESUELTO) `calcularF1357` con `ReferenceError` — eliminada.
- Prorrateo de remuneraciones NO habituales (RG 4003 Anexo II ap. B) en el mes de pago (`liquidacion.js`, factor `fB`): validar con un caso anual completo (una gratificación en el mes 6 debe quedar imputada al 100% al 31/12). Riesgo de sub-declaración de Ganancias en el mes de pago. Recomendado: test de integración de "B" a lo largo del año.

### ALTO
- SMVM desactualizado en el seed (`params.seed.json` `smvmMensual: 367800`) — impacta el tope de embargo. `getParamsConValores` lo pisa si hay valor legal cargado, pero el fallback usa el seed viejo.
- Tope base SIPA desactualizado en el seed (`topeAportesMax: 4414652.38`). Mismo caveat.
- Base imponible de Obra Social/ANSSAL/PAMI: hoy se aplica el mismo tope SIPA que a jubilación (`liquidacion.js` base única de aportes). La base de OS (Ley 23.660/23.661) tiene su propio tratamiento; conviene separarla (`f931TopeOS` ya existe en el seed pero está en 0 y sin uso).
- Contribuciones patronales: se calculan sobre `totalRemun × %` sin la detracción de base (mínimo no imponible de contribuciones, Dto. 814 y actualizaciones). Sobre-estima el costo patronal.

### MEDIO
- Antigüedad por año calendario sin comparar el día (`aniosAntiguedad`): en el mes de aniversario puede contar un año de más. Vacaciones (art. 150) deben computar antigüedad al 31/12.
- Inconsistencia interna del promedio de variables: vacaciones divide por 25 y enfermedad por 30. Definir un criterio y documentarlo (art. 155 inc. c es opinable).
- Indemnización art. 245: la base incluye no remunerativos; jurisprudencialmente suele excluirlos. Parametrizable.
- Integración mes de despido sin SAC (art. 233): menor.
- Redondeo "round-then-sum": acumula centavos que se propagan a aportes/Ganancias/F.931.

### BAJO
- Distribución OS/ANSSAL: `pctAnssal: 0` mete todo al 3% de OS. Neutro para el neto, pero incorrecto para F.931/SICOSS real.
- Vista F.1357/control muestra impuesto determinado sin el tope del 35% del neto (sí aplicado en el recibo). Aclararlo en la vista.

### Bien resuelto
Aportes 11/3/3 sin tope indebido en el neto; tope SIPA sí en jubilación; SAC = 50% mejor remuneración del semestre; vacaciones a /25 (art. 155 inc. a); enfermedad art. 208 con promedio; licencia sin goce art. 78 CCT 130/75 sin perder presentismo; fondo de cese Ley Bases; embargo con tope 20% s/excedente SMVM; escala art. 94 y deducciones versionadas por período.

---

## 3) Datos y arquitectura

### CRÍTICO
- Corrida de liquidación no transaccional (`routes/liquidacion.routes.js` `POST /corrida`): inserta la corrida y N recibos + cuotas + ajustes en autocommit dentro de un loop. Si falla en el empleado K, quedan datos parciales y el `UPDATE` de totales no corre. Envolver en `BEGIN/COMMIT/ROLLBACK`.
- (RESUELTO) Ciclos en `puestos.reporta_a` — bloqueados en el PUT.

### ALTO
- `POST /guardar` (recibo individual) y `DELETE /corrida`: varias escrituras sin transacción.
- N+1 en la corrida: ~8-10 queries seriales por empleado. Con cientos de legajos, minutos por corrida. Precargar por período con `WHERE empleado_id = ANY($1)`.
- `catch (e) {}` silenciosos en `dashboard.routes.js` (varios): si cambia una tabla/columna, el tablero muestra 0 sin rastro. Loguear al menos `console.warn`.
- Fallback por nombre (`lib/equipo.js`) recarga toda la nómina en cada request de aprobación; cachear con TTL corto y loguear el catch antes del fallback.

### MEDIO
- FKs faltantes en columnas agregadas por ALTER: `recibos.corrida_id`, `anticipo_cuotas.recibo_id/corrida_id`, `banco_generaciones.corrida_id`, `beneficios_hist/elementos_hist.empleado_id`. Riesgo de huérfanos.
- Índice compuesto faltante en `recibos(anio, mes, tipo)` (consultado intensivamente en controles/acumuladores/corrida previa).
- `ON DELETE CASCADE` sobre `empleados` en tablas con valor legal (recibos con acuse Ley 27.555): borrar un empleado elimina su historial liquidado. Evaluar RESTRICT o soft-delete.
- `migrate.js --reset` solo dropea `empleados` y `empresas` (deja el resto). Documentar o usar DROP SCHEMA.

### Bien resuelto
`db.js` siempre parametriza; `seed.js` y `migratePuestos.js` transaccionales e idempotentes; recursiones del organigrama con guarda de visitados; schema idempotente (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

---

## 4) Frontend

### ALTO
- `SectionView.tsx`: la guarda por URL solo cubre módulos "siempre visibles"; el control real es del backend, pero conviene verificar `groupsForRole()` antes de renderizar para no exponer acciones que el rol no debería ver.
- Expiración de sesión silenciosa: si `/auth/me` falla en `refresh()`, se limpia el usuario sin avisar.

### MEDIO / BAJO
- Varios `.catch(() => {})` sin feedback visual (Ganancias, dashboards): ante fallo de red la UI muestra vacío sin aviso.
- Accesos a campos que el backend podría no devolver sin fallback (`ReciboView`, `TableroGerente.evolucion`, `Ganancias.emp.id`): usar `?.`/`|| []` para no romper el render.
- `key={i}` por índice en algunas listas/headers (GananciasControl, Organigrama ocupantes): usar id único.

---

## Plan de remediación priorizado

1. Seguridad de datos de empleados (CRÍTICO): endpoint de búsqueda liviano para selectores + restringir lista/`:id` completos a RR.HH./admin (+ manager su equipo + self). Ajustar `EmpleadoPicker`.
2. Transacción en la corrida de liquidación (CRÍTICO) y en `/guardar` y `DELETE /corrida` (ALTO).
3. Actualizar SMVM y tope SIPA vigentes 2026 en Valores Legales y separar la base imponible de Obra Social del tope SIPA (ALTO).
4. Endurecer adjuntos: allowlist de MIME + límite de tamaño + servir `attachment` (MEDIO).
5. Detracción de base en contribuciones patronales (ALTO, costo patronal).
6. Performance de la corrida (N+1) y FKs/índices faltantes (ALTO/MEDIO).
7. Frontend: manejo de errores visible y fallbacks de campos (MEDIO).

Nota: los puntos legales marcados "opinable" (promedio de variables /25 vs /30, base del art. 245, cómputo de antigüedad de vacaciones al 31/12) conviene definirlos con el criterio del estudio contable/legal antes de tocarlos.
