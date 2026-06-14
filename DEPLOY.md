# Deploy — Portal RR.HH. (DigitalOcean)

Arquitectura: **Postgres + API (Node/Express) + Frontend (React/Vite servido por nginx)**.
Dos repos: `portal-rrhh-backend` (este) y `portal-rrhh-frontend`.

---

## Opción A — Droplet con Docker (recomendada, todo en un servidor)

1. **Crear el Droplet**: Ubuntu 22.04, imagen "Docker" del Marketplace (ya trae Docker + Compose). Mínimo 2 GB RAM.

2. **Clonar los dos repos lado a lado** (en el server):
   ```bash
   git clone https://github.com/PGabrielPapa/portal-rrhh-backend.git
   git clone https://github.com/PGabrielPapa/portal-rrhh-frontend.git
   cd portal-rrhh-backend
   ```

3. **Configurar variables**:
   ```bash
   cp .env.prod.example .env
   nano .env            # completar POSTGRES_PASSWORD y JWT_SECRET (openssl rand -hex 32)
   ```

4. **Levantar**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
   - Postgres queda con volumen persistente (`pgdata_prod`).
   - La API migra el esquema y siembra los datos iniciales en el primer arranque (idempotente).
   - El frontend queda en el **puerto 80**. La API no se expone afuera; el nginx del frontend la proxya en `/api`.

5. **Acceso**: `http://IP_DEL_DROPLET` → login con DNI; contraseña inicial = DNI (se fuerza cambio).

6. **HTTPS** (recomendado): poné un reverse proxy delante (Caddy o nginx con certbot) apuntando al puerto 80, o usá un Load Balancer de DigitalOcean con certificado gestionado.

### Actualizar a una nueva versión
```bash
cd portal-rrhh-backend && git pull
cd ../portal-rrhh-frontend && git pull
cd ../portal-rrhh-backend
docker compose -f docker-compose.prod.yml up -d --build
```
Los datos persisten (volumen `pgdata_prod`). El esquema se re-aplica idempotente; el seed no duplica.

### Backup de la base
```bash
docker exec prh_db_prod pg_dump -U portal portal_rrhh > backup_$(date +%F).sql
```

---

## Opción B — DigitalOcean App Platform (gestionado)

1. **Base de datos**: crear un **Managed PostgreSQL** (cluster). Copiar su `DATABASE_URL`.
2. **API (Web Service)**: conectar el repo `portal-rrhh-backend`.
   - Dockerfile detectado automáticamente.
   - **Run command**: `node src/db/migrate.js && node src/db/seed.js && node src/server.js`
   - **Env vars**: `DATABASE_URL` (la del managed PG, con `?sslmode=require`), `JWT_SECRET`, `CORS_ORIGIN` (el dominio del frontend), `PORT=4000`.
   - HTTP port: 4000.
3. **Frontend (Static Site o Web Service)**: conectar `portal-rrhh-frontend`.
   - Build command: `npm install && npm run build` · Output dir: `dist`.
   - Definir `VITE_API_URL` = URL pública de la API (ej: `https://api-rrhh.ondigitalocean.app/api`) **o** usar reglas de ruteo de App Platform para mapear `/api` → el servicio API (en ese caso dejar `VITE_API_URL=/api`).

> Nota: con Managed PostgreSQL hay que habilitar SSL en la conexión. Si hiciera falta, agregar a la conexión `?sslmode=require` y configurar el pool con `ssl: { rejectUnauthorized: false }`.

---

## Post-deploy
- Cambiar la contraseña del admin (DNI 17304264) en el primer login.
- Cargar/verificar en el panel RR.HH.: parámetros de liquidación, escalas/convenios, **parámetros de Ganancias** (MNI, deducciones, escala vigente) y el tope de aportes del período.
- Revisar `CORS_ORIGIN` si el front está en otro dominio que la API.
