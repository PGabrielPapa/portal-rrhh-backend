# Portal RR.HH. — Backend (API)

API REST en **Node.js + Express**, base **PostgreSQL**, auth con **JWT + bcrypt**.
Pensado para correr en **Docker**.

## Correr con Docker (recomendado)

Desde la raíz del repo:

```bash
docker compose up --build
```

Esto levanta:
- **Postgres** en `localhost:5432` (user/pass/db: `portal`/`portal`/`portal_rrhh`)
- **API** en `http://localhost:4000` (aplica esquema + seed automáticamente)

## Correr local (sin Docker)

Necesitás un Postgres corriendo. Luego:

```bash
cd backend
cp .env.example .env      # ajustá DATABASE_URL
npm install
npm run migrate           # crea las tablas
npm run seed              # carga empresas + 135 empleados (pass inicial = DNI)
npm start                 # API en :4000
```

## Autenticación

- **Login:** `POST /api/auth/login` con `{ dni, password }` (y `token` si el
  usuario tiene 2FA). La contraseña inicial de cada empleado es su **DNI**, con
  cambio obligatorio en el primer ingreso (`mustChangePassword: true`).
- **Cambiar contraseña:** `POST /api/auth/change-password` (Bearer token) con
  `{ currentPassword, newPassword }`. Al cambiarla se **cierran todas las
  sesiones** de ese usuario, así que hay que volver a ingresar.
- **Cerrar sesión:** `POST /api/auth/logout` (Bearer token). Invalida el token en
  el servidor, en todos los dispositivos.
- **Perfil:** `GET /api/auth/me` (Bearer token).
- Contraseñas hasheadas con **bcrypt** (`BCRYPT_ROUNDS`, mínimo forzado 12). JWT
  en `Authorization: Bearer <token>`, con vigencia `JWT_EXPIRES_IN` (def. 2 h).

### Ciclo de vida de la sesión

El JWT lleva firmada la `token_version` del usuario y `requireAuth` la contrasta
contra la base en cada pedido. Cualquier cambio sensible —contraseña, rol,
desactivación, baja, cese, logout— incrementa esa versión e **invalida al
instante todos los tokens ya emitidos**. El rol efectivo se lee siempre de la
base, nunca del token, así que una degradación de permisos tiene efecto inmediato.

- Mientras un usuario tenga el cambio de contraseña pendiente, el resto del portal
  le queda **bloqueado** (solo `/auth/me`, `/auth/logout`, `/auth/2fa/*` y el
  propio cambio).
- La cuenta se bloquea `LOGIN_BLOQUEO_MIN` minutos tras `LOGIN_MAX_INTENTOS`
  intentos fallidos.
- Los ingresos (exitosos y fallidos) quedan en `login_audit`, consultables por un
  admin en `GET /api/admin/accesos`.

> Ver **[Auditoria_Seguridad_2026-08.md](Auditoria_Seguridad_2026-08.md)** para el
> detalle de las defensas, las tres medidas que quedaron sin desplegar y cómo
> activarlas.

## Empleados (`/api/empleados`, requiere auth)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/api/empleados?empresa=&q=&activos=true` | cualquiera | Listado / búsqueda |
| GET | `/api/empleados/:id` | cualquiera | Detalle |
| POST | `/api/empleados` | rrhh/admin | Alta individual |
| PUT | `/api/empleados/:id` | rrhh/admin | Edición |
| PATCH | `/api/empleados/:id/activo` | rrhh/admin | Baja/alta lógica |
| POST | `/api/empleados/import` | rrhh/admin | Alta masiva (`{ rows: [...] }`) |

### Identidad empresa + legajo

El legajo **no es único global**: puede repetirse entre empresas. La identidad
única es `empresa + legajo`:
- Restricción `UNIQUE (empresa_id, leg_num)` → un duplicado real se rechaza.
- Cada empleado expone `uid = SLUG_EMPRESA-legajo` (p. ej. `SINISSA-000074`) y
  `legNum` (el número visible). El DNI es único (clave de login).

## Estructura

```
backend/
  src/
    config.js            # variables de entorno
    db.js                # pool de Postgres
    app.js / server.js   # Express
    middleware/          # auth (JWT/roles/estado de sesión), rateLimit, errores
    routes/              # auth.routes.js, empleados.routes.js
    db/                  # schema.sql, migrate.js, seed.js, backup.js (cifrado)
    data/                # seeds (empleados/empresas) generados del vanilla
    lib/identity.js      # slug / uid / dni-desde-cuil
    lib/sesion.js        # estado vivo de la sesión + revocación de tokens
    lib/password.js      # política de contraseñas y clave temporal
  Dockerfile
```

---

## Deploy en DigitalOcean

Dos caminos habituales:

### A) App Platform (gestionado, recomendado para empezar)
1. Crear una base **Managed PostgreSQL** en DigitalOcean. Copiar su `DATABASE_URL`.
2. App Platform → *Create App* → conectar este repo de GitHub.
3. DO detecta el `Dockerfile`. Setear variables de entorno:
   - `DATABASE_URL` = (la de la Managed DB, con `?sslmode=require`)
   - `JWT_SECRET` = (un secreto largo y aleatorio)
   - `CORS_ORIGIN` = (URL pública del frontend)
   - `BCRYPT_ROUNDS` = `12` (mínimo forzado)
4. La primera vez, correr migraciones/seed: `npm run migrate` y (opcional) `npm run seed`
   como *Job* de App Platform, o vía consola.

### B) Droplet + Docker (control total)
1. Droplet con Docker + Docker Compose.
2. `git clone` del repo, crear `.env`, y `docker compose up -d --build`
   (levanta Postgres + API). Para producción, usar una DB gestionada en vez del
   contenedor `db`, y un reverse proxy (Caddy/Nginx) con HTTPS delante de la API.

> **Seguridad:** nunca commitear `.env`. En producción (`NODE_ENV=production`) el
> backend **no arranca** si `JWT_SECRET` es débil o conocido, si `CORS_ORIGIN` es
> `*` o falta, o si `DATABASE_URL` usa una contraseña de Postgres por defecto.
> Definí también `BACKUP_PASSPHRASE` para que los respaldos se cifren, y guardala
> **fuera del servidor**: sin ella no se pueden restaurar. Postgres no expuesto a
> internet (solo accesible por la API).
>
> El repaso completo de seguridad, con lo corregido y lo pendiente, está en
> [Auditoria_Seguridad_2026-08.md](Auditoria_Seguridad_2026-08.md).
