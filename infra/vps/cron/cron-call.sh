#!/bin/sh
# Bir cron ucunu cagirir: cron-call <is-adi>. CRON_SECRET yalniz ortamdan
# okunur; komut satirina (ps'te gorunur) ve loga YAZILMAZ (curl -K ile stdin).
set -eu

job="${1:-}"
base="${ARILLA_WEB_URL:-http://web:3000}"

# Izinli is adlari (apps/web/app/api/cron/*): yol enjeksiyonu yok.
case "$job" in
  marketing-campaigns) max_time=90 ;;
  cleanup-auth) max_time=300 ;;
  generate-discovery-slots | interpret-queries | refresh-product-aggregates | trigger-alerts)
    max_time=120 ;;
  *)
    echo "cron-call: bilinmeyen is: ${job}" >&2
    exit 64 ;;
esac

if [ -z "${CRON_SECRET:-}" ]; then
  echo "cron-call: CRON_SECRET tanimli degil" >&2
  exit 78
fi

started=$(date +%s)
status=$(
  printf 'header = "Authorization: Bearer %s"\n' "$CRON_SECRET" |
    curl -sS -K - -o /dev/null -w '%{http_code}' \
      --max-time "$max_time" --retry 2 --retry-delay 5 --retry-connrefused \
      "${base}/api/cron/${job}"
) || status="000"
elapsed=$(($(date +%s) - started))

echo "cron-call job=${job} status=${status} seconds=${elapsed}"
case "$status" in
  2??) exit 0 ;;
  *) exit 1 ;;
esac
