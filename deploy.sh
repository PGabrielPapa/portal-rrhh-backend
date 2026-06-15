#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Portal RR.HH. — Despliegue de un comando (DigitalOcean / cualquier Ubuntu).
# Instala Docker, clona los repos, genera secretos y levanta todo con HTTPS.
#
# Uso (en el droplet, como root):
#   curl -fsSL https://raw.githubusercontent.com/PGabrielPapa/portal-rrhh-backend/main/deploy.sh | bash -s rrhh.tu-dominio.com
# o:
#   ./deploy.sh rrhh.tu-dominio.com
#
# Requisitos previos (los hacés vos): droplet Ubuntu con puertos 80/443
# abiertos y un registro DNS A de tu dominio apuntando a la IP del droplet.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then read -rp "Dominio (ej. rrhh.tu-dominio.com): " DOMAIN; fi
[ -z "$DOMAIN" ] && { echo "ERROR: necesito un dominio."; exit 1; }

WORK="${HOME:-/root}"
GH="https://github.com/PGabrielPapa"

echo "▶ 1/4 Docker…"
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
docker --version

echo "▶ 2/4 Repos…"
cd "$WORK"
for r in portal-rrhh-backend portal-rrhh-frontend; do
  if [ -d "$r/.git" ]; then (cd "$r" && git pull --ff-only || true); else git clone "$GH/$r.git"; fi
done
cd "$WORK/portal-rrhh-backend"

echo "▶ 3/4 Variables (.env)…"
if [ ! -f .env ]; then
  cp .env.prod.example .env
  PGPASS="$(openssl rand -hex 24)"; JWT="$(openssl rand -hex 32)"
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PGPASS}|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT}|"                 .env
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|"                      .env
  sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://${DOMAIN}|"    .env
  grep -q '^NODE_ENV=' .env || echo "NODE_ENV=production" >> .env
  echo "  .env generado con secretos aleatorios (guardalos: están en ./.env)."
else
  echo "  .env ya existe → lo respeto (no piso tus secretos)."
fi

echo "▶ 4/4 Levantando contenedores (build + up)…"
docker compose -f docker-compose.prod.yml up -d --build
sleep 6
docker compose -f docker-compose.prod.yml ps
echo
echo "✅ Listo. Abrí: https://${DOMAIN}"
echo "   (La primera carga puede tardar unos segundos mientras Caddy emite el certificado TLS.)"
echo "   Login: DNI · contraseña inicial = DNI (cambio forzado)."
