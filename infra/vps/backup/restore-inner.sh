#!/usr/bin/env bash
# Izole geri yukleme provasi - `restore` konteynerinin ICINDE calisir (karar 0110).
# Uretim veritabanina erisimi YOKTUR (yalniz egress agi + bos /restore dizini). R2'deki
# depodan geri yukler, ayri bir PostgreSQL'i YALNIZ unix soketiyle (TCP yok) baslatir,
# dogrular, durdurur. Son satir: RESULT {json}.
#
#   restore-inner.sh latest
#   restore-inner.sh time "2026-10-14 03:00:00+00"
#
# Ortam: RESTORE_DB_USER / RESTORE_DB_NAME (varsayilan arilla),
#        RESTORE_ASSERT_SQL (istege bagli; '1' donmesi gereken tek sorgu - yalniz testler)
set -euo pipefail

MODE=${1:-latest}
TARGET=${2:-}
DATA=/restore/data
DBU=${RESTORE_DB_USER:-arilla}
DBN=${RESTORE_DB_NAME:-arilla}
SOCK=/var/run/postgresql
STANZA=arilla
log() { printf '%s [restore] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

[ -d /restore ] && [ -w /restore ] || { echo "RESULT {\"ok\":false,\"error\":\"/restore yazilamaz\"}"; exit 1; }
if [ -e "$DATA" ] && [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
  echo 'RESULT {"ok":false,"error":"hedef dizin bos degil"}'
  exit 1
fi
mkdir -p "$DATA"
chmod 0700 "$DATA"

t0=$(date -u +%s)
args=(--stanza="$STANZA" --pg1-path="$DATA" --archive-mode=off --log-level-console=warn)
case "$MODE" in
  latest) args+=(--type=default) ;;
  time)
    [ -n "$TARGET" ] || { echo 'RESULT {"ok":false,"error":"hedef zaman yok"}'; exit 1; }
    args+=(--type=time "--target=$TARGET" --target-action=promote) ;;
  *) echo 'RESULT {"ok":false,"error":"kip latest|time"}'; exit 1 ;;
esac
log "pgbackrest restore ($MODE ${TARGET:-})"
pgbackrest "${args[@]}" restore
t_restore=$(date -u +%s)

# Ayri ornek: TCP KAPALI, arsivleme KAPALI (geri yuklenen kopya depoya ASLA WAL gondermez).
# max_connections uretimdekinden (60) dusuk OLAMAZ (PostgreSQL kurtarma kurali); 200 ust sinir payi.
log "PostgreSQL baslatiliyor (yalniz soket, arsiv kapali)"
if ! pg_ctl -D "$DATA" -w -t 3600 -l /restore/postgres.log start \
  -o "-c listen_addresses='' -c unix_socket_directories=$SOCK -c archive_mode=off -c archive_command=/bin/false -c port=5432 -c max_connections=200 -c shared_buffers=256MB" >/dev/null; then
  tail -30 /restore/postgres.log >&2 || true
  echo 'RESULT {"ok":false,"error":"PostgreSQL baslamadi"}'
  exit 1
fi

psqlq() { psql -h "$SOCK" -U "$DBU" -d "$DBN" -v ON_ERROR_STOP=1 -Atqc "$1"; }
for _ in $(seq 1 1800); do
  if [ "$(psqlq 'select pg_is_in_recovery()' 2>/dev/null || true)" = "f" ]; then break; fi
  sleep 1
done
[ "$(psqlq 'select pg_is_in_recovery()')" = "f" ] || { echo 'RESULT {"ok":false,"error":"kurtarma tamamlanmadi"}'; exit 1; }
t_ready=$(date -u +%s)
log "kurtarma tamamlandi"

# --- dogrulama ---------------------------------------------------------------------------
ok=true
errors=()
# 1) Sema ozeti (uretimle karsilastirma disarida yapilir). amcheck uzantisi kurulmadan ONCE alinir.
#    pg_dump'in rastgele \restrict satirlari ve yorumlar ayiklanir.
schema_hash=$(pg_dump -h "$SOCK" -U "$DBU" -d "$DBN" --schema-only --no-owner --no-privileges \
  | grep -vE '^(--|\\restrict|\\unrestrict)' | grep -v '^$' | sha256sum | cut -d' ' -f1)
# 2) Sayfa/indeks butunlugu (data_checksums + amcheck). Uzanti yalniz bu kopyaya kurulur (uretime dokunmaz).
if pg_amcheck -h "$SOCK" -U "$DBU" -d "$DBN" --install-missing --no-dependent-indexes >/restore/amcheck.log 2>&1; then
  amcheck=pass
else
  amcheck=fail; ok=false; errors+=("pg_amcheck")
fi
# 3) Migration defteri
ledger=$(psqlq "select coalesce((select count(*) from schema_migration)::text,'0')||'|'||coalesce((select max(filename) from schema_migration),'')" 2>/dev/null || echo "0|")
# 4) Tablo satir sayilari (tam sayim; tablo basina zaman asimi)
tables=$(psqlq "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')")
rows_total=$(psql -h "$SOCK" -U "$DBU" -d "$DBN" -Atq -v ON_ERROR_STOP=1 <<'SQL' || echo -1
set statement_timeout = '120s';
select coalesce(sum((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint), 0)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relispartition;
SQL
)
rows_total=$(printf '%s' "$rows_total" | tail -1)
[ "$rows_total" = "-1" ] && { ok=false; errors+=("satir sayimi"); }
# 5) Istege bagli test iddiasi (yalniz testler)
assert=skip
if [ -n "${RESTORE_ASSERT_SQL:-}" ]; then
  if [ "$(psqlq "$RESTORE_ASSERT_SQL" 2>/dev/null || true)" = "1" ]; then assert=pass; else assert=fail; ok=false; errors+=("assert"); fi
fi
size=$(psqlq "select pg_database_size(current_database())")

pg_ctl -D "$DATA" -w -t 120 stop -m fast >/dev/null || true
err=$(IFS=,; echo "${errors[*]:-}")
printf 'RESULT {"ok":%s,"mode":"%s","target":"%s","restore_s":%d,"recovery_s":%d,"rto_s":%d,"amcheck":"%s","schema_sha256":"%s","ledger":"%s","tables":%s,"rows_total":%s,"db_bytes":%s,"assert":"%s","errors":"%s"}\n' \
  "$ok" "$MODE" "$TARGET" "$((t_restore - t0))" "$((t_ready - t_restore))" "$((t_ready - t0))" \
  "$amcheck" "$schema_hash" "$ledger" "${tables:-0}" "${rows_total:-0}" "${size:-0}" "$assert" "$err"
[ "$ok" = true ]
