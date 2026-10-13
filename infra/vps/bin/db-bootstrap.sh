#!/usr/bin/env bash
# Temiz veritabani kurulumu (ilk dagitim): migration -> rol -> bolumler -> dogrulama.
# `seed` CALISTIRILMAZ (katalogu siler). Hepsi gecici `migrate` konteynerinde.
#
#   infra/vps/bin/db-bootstrap.sh [compose.env] [compose.prod.yml]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${1:-/opt/arilla/compose.env}
COMPOSE_FILE=${2:-$here/../../compose.prod.yml}
[ -f "$COMPOSE_FILE" ] || COMPOSE_FILE=/opt/arilla/compose.prod.yml

c() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

c up -d postgres redis
echo "postgres hazir olana kadar bekleniyor..."
for _ in $(seq 1 60); do
  state=$(docker inspect --format '{{.State.Health.Status}}' "$(c ps -q postgres)" 2>/dev/null || true)
  [ "$state" = "healthy" ] && break
  sleep 2
done
[ "${state:-}" = "healthy" ] || { echo "postgres healthy olmadi" >&2; exit 1; }

for step in migrate.ts bootstrap-app-role.ts partitions.ts "partitions.ts --check" verify-schema.ts; do
  echo "== node scripts/$step"
  # shellcheck disable=SC2086
  c run --rm migrate node scripts/$step
done
echo "Veritabani hazir."
