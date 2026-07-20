#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Restaura la base de datos al último punto congelado (portal_rrhh_snap),
# DESCARTANDO todo lo que se escribió después del congelamiento.
#
# OPERACIÓN DESTRUCTIVA: se pierde TODO lo posterior al snapshot (no solo el
# testeo). Usar solo mientras el sistema NO esté en uso real.
#
# Uso (desde cualquier lado):  ./scripts/db-restaurar.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DB_CONTAINER="${DB_CONTAINER:-prh_db_prod}"
DB_USER="${POSTGRES_USER:-portal}"
DB_NAME="${POSTGRES_DB:-portal_rrhh}"
SNAP="${DB_NAME}_snap"
DC=(docker compose -f docker-compose.prod.yml -f docker-compose.host-nginx.yml)

# Verificar que exista un snapshot.
if ! docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -tAc \
       "SELECT 1 FROM pg_database WHERE datname='${SNAP}'" | grep -q 1; then
  echo "✗ No existe un snapshot (${SNAP}). Primero congelá con: ./scripts/db-congelar.sh"
  exit 1
fi

echo "⚠ ATENCIÓN: restaura '${DB_NAME}' al punto congelado y DESCARTA todo lo posterior."
read -rp "  Para confirmar, escribí RESTAURAR: " r; [ "$r" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }

echo "  Parando api/web…"
"${DC[@]}" stop api web

echo "  Restaurando desde el snapshot…"
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE ${DB_NAME} WITH (FORCE);"
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE ${DB_NAME} WITH TEMPLATE ${SNAP} OWNER ${DB_USER};"

echo "  Levantando api/web…"
"${DC[@]}" start api web

echo "✅ Base restaurada al punto congelado."
echo "   El snapshot (${SNAP}) se conserva: podés volver a restaurar, o pisarlo con ./scripts/db-congelar.sh"
