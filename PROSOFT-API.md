# Integración ProSoft (Gestión de Personal) — mapeo de API

> Notas de la API de ProSoft "Gestión de Personal" para integrar la **descarga de
> registros horarios** al Portal RR.HH. Mapeado el 2026-06-22 inspeccionando la
> sesión real del panel web (no hay documentación pública). Pendiente de desarrollo.

## Datos generales

- **Panel web:** https://www.pro-soft.com.ar/gestiondepersonal/ (SPA; el front es solo UI).
- **API base:** `https://apild.azurewebsites.net/api` (backend .NET / ASP.NET Web API).
- **Autenticación:** **cookie de sesión**. Se inicia con `POST /api/login`; las
  llamadas siguientes reutilizan la cookie. No usa token Bearer ni API key.
  - El cliente Node debe mantener un *cookie jar* (p. ej. `fetch` + `set-cookie`,
    o `axios` con `withCredentials` + jar, o `tough-cookie`).
- **Credenciales:** van en variables de entorno del servidor, NUNCA en código ni git:
  - `PROSOFT_USER` (ej. el email de usuario de ProSoft)
  - `PROSOFT_PASS`
  - `PROSOFT_BASE=https://apild.azurewebsites.net/api`

## Endpoints

### Login
```
POST /api/login
Content-Type: application/json
{ "usuario": "<PROSOFT_USER>", "clave": "<PROSOFT_PASS>" }
```
- Con body vacío responde `400 {"Message":"Usuario y clave requeridos"}` → los
  campos son `usuario` y `clave`.
- En éxito setea la cookie de sesión (guardar y reenviar en las próximas requests).

### Maestro de legajos / filtros
```
GET /api/filtros
```
Devuelve (string JSON) algo como:
```json
{ "legajos": [
    { "id": 7401, "legajo": 91, "nombre": "ABIBE NUÑEZ JUAN ALI",
      "idarea": 1518, "idturno": 1156, "idcontratante": 138 },
    ...
  ],
  "turnos": [...], "areas": [...], "contratantes": [...] }
```
- `legajo` = número de legajo (clave de matching con el portal).
- `idcontratante` = empresa/contratante (en el ejemplo 138=Leiten, 140=otra).

### Resumen (FICHADAS + HORAS CALCULADAS) — lo que necesitamos
Patrón **job asíncrono** (start → poll):

1) Iniciar:
```
POST /api/resumen/GetValue
Content-Type: application/json
{ "fechaDesde": "2026-06-18", "fechaHasta": "2026-06-19",
  "legajos": [], "turnos": [], "areas": [], "sucursales": [] }
→ { "jobId": "<guid>", "total": 456 }
```
   - Arrays vacíos = todos. Fechas en formato `YYYY-MM-DD`.

2) Pollear hasta completar:
```
GET /api/resumen/GetStatus?jobId=<guid>
→ { "total": 456, "procesados": 31, "completado": false }
...
→ { "completado": true, "datos": [ { ...fila... }, ... ] }
```
   - Cuando `completado:true`, la MISMA respuesta incluye `datos` (array de filas).
   - Conviene pollear cada ~1,5 s.

**Forma de cada fila de `datos`** (campos relevantes):
```
dia            "6/18/2026"        (M/D/YYYY)
diasemana      "jueves"
legajo         "91"
nombre         "ABIBE NUÑEZ JUAN ALI"
dni            " "                (frecuentemente vacío → NO confiable para match)
e1 / s1        "07:13" / "17:00"  (entrada/salida 1; hasta e4/s4)
id_e1 / id_s1  "10679259" / ...   (id único de cada marca; sirve para idempotencia)
tipo_e1 ...    tipo de marca
hsnetas        "09:46"
hs_normal      "08:46"
hs_extra50     "01:00"
hs_extra100    "00:00"
hs_nocturna / hs_nocturna_extra
total          "09:46"
estado         "Presente con tardanza"   (idestado: 2)
tarde          "00:13"
turno / idturno
area / idarea
nombreempresa  "Leiten"
cuitempresa    "30-65127003-7"
idempresa
hsNormalesBDH / ResultadoBDH   (banco de horas)
comentario / idcomentario
```
- ProSoft ya entrega las **horas calculadas** (normales, extra 50/100, nocturnas,
  netas) además de las marcas crudas → ideal para fichadas y liquidación.
- `id_e1..id_s4` son ids de marca únicos → usarlos como clave de idempotencia al
  importar (evita duplicar al reimportar un período).

### Consolidado (NOVEDADES: licencias, etc.)
```
POST /api/consolidado/GetValue
{ "fechaDesde": "2026-06-20", "fechaHasta": "2026-06-21",
  "legajos": [], "turnos": [], "areas": [], "sucursales": [] }
→ [ { "area":"OBRA", "idarea":"1517", "Nombre":"ANGEL CARLOS ALBERTO",
      "Cantidad":1, "Novedad":"", "Descripcion":"Licencia por enfermedad" } ]
```
(Respuesta directa, no usa job.)

### Marcas incompletas (días con cantidad impar de marcas)
```
GET /api/marcas/impares?ffin=2026-06-21
→ [ { "legajo":"15", "nombre":"...", "dia":"6/17/2026", "cant":1 } ]
```
Útil para alertar fichadas incompletas (entrada sin salida).

### Otros vistos
- `GET /api/documentos` (documentos del panel).
- `POST /api/outlook/` (integración interna del panel; no relevante).

## Plan de integración (pendiente, a definir con el usuario)

Decisiones abiertas (preguntadas, sin responder aún):
1. **Matching** Portal↔ProSoft: por `legajo` (recomendado, estable) / por DNI
   (riesgoso, suele venir vacío) / legajo con fallback a DNI.
2. **Qué importar:** marcas + horas calculadas (recomendado) y/o novedades;
   o solo marcas crudas.
3. **Disparo:** botón manual + tarea automática diaria / solo manual / solo diario.

Diseño tentativo del backend (`portal-rrhh-backend`):
- `src/lib/prosoft.js`: cliente (login + cookie jar + helpers `getFiltros`,
  `getResumen(desde, hasta)` con polling del job, `getNovedades`, `getImpares`).
- `src/routes/prosoft.routes.js`: `POST /api/prosoft/importar?desde=&hasta=`
  (gestor) → trae el resumen, matchea por legajo, upsert en una tabla nueva de
  fichadas usando `id_e1..id_s4` como clave de idempotencia.
- `schema.sql`: tabla `fichadas_prosoft` (empleado_id, legajo, dia, e1..s4, horas,
  estado, ids de marca, origen, created_at) idempotente.
- Reusar el dataset/reporte "Fichadas" ya existente en el generador de reportes.
- Tarea programada diaria (opcional) que importe el día anterior.

> Credenciales SIEMPRE por env (`PROSOFT_USER`, `PROSOFT_PASS`). No commitear.
