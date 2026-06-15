# Deploy — Portal RR.HH. (DigitalOcean)

Arquitectura: **Postgres + API (Node/Express) + Frontend (React/Vite servido por nginx)**.
Dos repos: `portal-rrhh-backend` (este) y `portal-rrhh-frontend`.

---

## Opción A — Despliegue en UN comando (recomendada)

Requisitos que hacés vos: un droplet **Ubuntu** con puertos **80/443** abiertos y un registro **DNS A** de tu dominio apuntando a la IP del droplet.

Después, en el droplet (como root), un solo comando hace todo (instala Docker, clona, genera secretos y levanta con HTTPS):

```bash
curl -fsSL https://raw.githubusercontent.com/PGabrielPapa/portal-rrhh-backend/main/deploy.sh | bash -s rrhh.tu-dominio.com
```

Cuando termina: `https://tu-dominio` (la 1ª carga tarda unos segundos mientras Caddy emite el certificado). Los secretos generados quedan en `~/portal-rrhh-backend/.env`.

Para actualizar a una nueva versión, volvé a correr el mismo comando (respeta tu `.env` y los datos del volumen Postgres).

---

## Opción A (manual, paso a paso)

1. **Crear el Droplet**: Ubuntu 22.04/24.04 (imagen "Docker" del Marketplace si está; si no, Ubuntu común e instalás Docker con `curl -fsSL https://get.docker.com | sh`). Mínimo 2 GB RAM.

   **DNS (para HTTPS):** creá un registro **A** de tu dominio (ej. `rrhh.tu-dominio.com`) apuntando a la **IP del droplet**, y abrí los puertos **80 y 443** (firewall de DigitalOcean).

2. **Clonar los dos repos lado a lado** (en el server):
   ```bash
   git clone https://github.com/PGabrielPapa/portal-rrhh-backend.git
   git clone https://github.com/PGabrielPapa/portal-rrhh-frontend.git
   cd portal-rrhh-backend
   ```

3. **Configurar variables**:
   ```bash
   cp .env.prod.example .env
   nano .env            # completar POSTGRES_PASSWORD, JWT_SECRET (openssl rand -hex 32) y DOMAIN
   ```

4. **Levantar**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
   - Postgres queda con volumen persistente (`pgdata_prod`).
   - La API migra el esquema y siembra los datos iniciales en el primer arranque (idempotente).
   - **Caddy** publica los puertos 80/443 y obtiene el **certificado HTTPS automáticamente** (Let's Encrypt) para `DOMAIN`. El frontend (nginx) y la API quedan solo en la red interna; la API se sirve vía `/api`.

5. **Acceso**: `https://TU_DOMINIO` → login con DNI; contraseña inicial = DNI (se fuerza cambio). La primera carga puede tardar unos segundos mientras Caddy emite el certificado.

6. **HTTPS**: ya viene resuelto por Caddy (no hay que hacer nada más que tener el DNS apuntando y los puertos 80/443 abiertos). El certificado se renueva solo.

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
