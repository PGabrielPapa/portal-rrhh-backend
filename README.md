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

- **Login:** `POST /api/auth/login` con `{ dni, password }`. La contraseña
  inicial de cada empleado es su **DNI**, con cambio forzado en el primer login
  (`mustChangePassword: true` en la respuesta).
- **Cambiar contraseña:** `POST /api/auth/change-password` (Bearer token) con
  `{ currentPassword, newPassword }`.
- **Perfil:** `GET /api/auth/me` (Bearer token).
- Contraseñas hasheadas con **bcrypt** (`BCRYPT_ROUNDS=10`). JWT en
  `Authorization: Bearer <token>`.

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
    middleware/          # auth (JWT/roles) + manejo de errores
    routes/              # auth.routes.js, empleados.routes.js
    db/                  # schema.sql, migrate.js, seed.js
    data/                # seeds (empleados/empresas) generados del vanilla
    lib/identity.js      # slug / uid / dni-desde-cuil
  Dockerfile
```
