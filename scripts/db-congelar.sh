#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Congela la base de datos: crea (o renueva) una copia interna como punto de
# restauración. Corré esto ANTES de empezar una tanda de pruebas.
#
# El snapshot se guarda como una base aparte (portal_rrhh_snap) dentro del
# mismo contenedor de Postgres, usando copia por TEMPLATE (rápida, a nivel
# archivos). Para restaurar: ./scripts/db-restaurar.sh
#
# Uso (desde cualquier lado):  ./scripts/db-congelar.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DB_CONTAINER="${DB_CONTAINER:-prh_db_prod}"
DB_USER="${POSTGRES_USER:-portal}"
DB_NAME="${POSTGRES_DB:-portal_rrhh}"
SNAP="${DB_NAME}_snap"
DC=(docker compose -f docker-compose.prod.yml -f docker-compose.host-nginx.yml)

existe_snap() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${SNAP}'" | grep -q 1
}

echo "▶ Congelar '${DB_NAME}' → snapshot '${SNAP}'"

if existe_snap; then
  echo "⚠ Ya hay un snapshot previo (${SNAP}). Se va a REEMPLAZAR por el estado ACTUAL de la base."
  read -rp "  Escribí SI para continuar: " r; [ "$r" = "SI" ] || { echo "Cancelado."; exit 1; }
fi

echo "  Parando api/web (para cerrar conexiones a la base)…"
"${DC[@]}" stop api web

echo "  Creando el snapshot…"
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS ${SNAP} WITH (FORCE);"
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE ${SNAP} WITH TEMPLATE ${DB_NAME} OWNER ${DB_USER};"

echo "  Levantando api/web…"
"${DC[@]}" start api web

echo "✅ Base congelada. Punto de restauración: '${SNAP}'."
echo "   Cuando termines de probar, volvé a este punto con: ./scripts/db-restaurar.sh"
