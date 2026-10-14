#!/usr/bin/env bash
# Yedekleme / PITR / geri yukleme UCTAN UCA testi (karar 0110) - YEREL ya da CI.
# Uretime, R2'ye ve gercek sirlara DOKUNMAZ: R2 yerine TLS'li VersityGW (S3 uyumlu), atilabilir
# sirlar, atilabilir proje (arilla-bkp). VPS duzeni (/opt/arilla) gecici dizinde kopyalanir ve
# betikler uretimdeki gibi oradan calisir: pg-backup-configure -> pg-backup-activate ->
# pg-backup diff/verify -> pg-restore-test (latest + PITR) -> saglik kontrolu -> depo kesintisi
# alarmi -> deactivate.
#
#   sudo -E infra/vps/bin/test-backup.sh          KEEP=1 ... (sonunda ayakta birakir)
#
# ROOT ile calisir (uretimle ayni sahiplik: yapilandirma root:999 0640; pgBackRest anahtar dosyasi
# izinlerini denetler). CI: `sudo -E`; Windows: `wsl -u root` (Docker Desktop WSL entegrasyonu).
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "root gerekli: sudo -E $0" >&2; exit 2; }
export MSYS_NO_PATHCONV=1

here=$(cd "$(dirname "$0")" && pwd)
infra=$(cd "$here/../.." && pwd)
if command -v cygpath >/dev/null 2>&1; then infra=$(cygpath -m "$infra"); here=$(cygpath -m "$here"); fi
PY=python3; command -v python3 >/dev/null 2>&1 && python3 -c '' >/dev/null 2>&1 || PY=python

export COMPOSE_PROJECT_NAME=arilla-bkp
work=$(mktemp -d)
if command -v cygpath >/dev/null 2>&1; then work=$(cygpath -m "$work"); fi
export ARILLA_ROOT="$work"
export ARILLA_ENV_DIR="$work/env"
export ARILLA_BACKUP_DIR="$work/backup"
export ARILLA_COMPOSE_EXTRA="$work/test.override.yml"
export ARILLA_POSTGRES_IMAGE=arilla-postgres:test
export ARILLA_TAG=bkp
# Betikler PATH'i sabitler; Windows/Git Bash'te docker/openssl/python yollari eklenir (Linux'ta zararsiz).
ARILLA_EXTRA_PATH="$(dirname "$(command -v docker)"):$(dirname "$(command -v openssl)")"
command -v python3 >/dev/null 2>&1 && ARILLA_EXTRA_PATH="$ARILLA_EXTRA_PATH:$(dirname "$(command -v python3)")"
export ARILLA_EXTRA_PATH
export ARILLA_MIN_FREE_BYTES=1073741824  # test: 1 GiB (uretim varsayilani 10 GiB)
# MinIO imajlari artik Docker Hub/Quay'den cekilemiyor; VersityGW (Apache-2.0, S3 ag gecidi) kullanilir.
S3_IMAGE=${S3_IMAGE:-versity/versitygw:v1.0.16@sha256:605de57c0cdc297fc5bc905ece592965d542d8df70d6eedf755734c80f2eb797}
S3_HOST_PORT=${S3_HOST_PORT:-19000}
BUCKET=arilla-backup-test

failures=0
pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; failures=$((failures + 1)); }
c() { docker compose --env-file "$work/compose.env" -f "$work/compose.prod.yml" -f "$ARILLA_COMPOSE_EXTRA" "$@"; }
q() { c exec -T postgres psql -U arilla -d arilla -AtqXc "$1" 2>/dev/null | tr -d '\r'; }
B="$work/vps/bin"

cleanup() {
  if [ "$failures" -ne 0 ]; then
    echo "== Hata ayiklama (son satirlar; sirlar maskeli)"
    c --profile backup logs --no-color --tail 30 2>&1 | sed -E 's/(key-secret|cipher-pass|SECRET|PASSWORD)[=: ][^ ]+/\1=<gizli>/g'
  fi
  if [ "${KEEP:-0}" != 1 ]; then
    c --profile backup --profile restore down -v --remove-orphans >/dev/null 2>&1
    rm -rf "$work"
  else
    echo "KEEP=1: $work"
  fi
}
trap cleanup EXIT

echo "== 0. Birim testleri ve imaj"
(cd "$here" && PYTHONIOENCODING=utf-8 "$PY" test_arilla_healthcheck.py >"$work/hc-unit.log" 2>&1) && pass "arilla_healthcheck birim testleri" || { fail "healthcheck birim testleri"; tail -20 "$work/hc-unit.log"; }
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  docker build -q -t "$ARILLA_POSTGRES_IMAGE" "$infra/vps/postgres" >/dev/null && pass "arilla-postgres imaji derlendi" || { fail "imaj derlemesi"; exit 1; }
fi
v=$(docker run --rm --network none --entrypoint pgbackrest "$ARILLA_POSTGRES_IMAGE" version) && pass "imajda $v" || fail "imajda pgbackrest yok"
bash "$here/verify-image.sh" "$ARILLA_POSTGRES_IMAGE" >"$work/verify.log" 2>&1 && pass "verify-image: sir/kimlik dosyasi yok" || { fail "verify-image"; grep FAIL "$work/verify.log"; }

echo "== 1. VPS duzeni (gecici /opt/arilla) ve sirlar"
cp "$infra/compose.prod.yml" "$work/compose.prod.yml"
cp -r "$infra/vps" "$work/vps"
"$here/init-secrets.sh" --dir "$work" --domain bkp.example.test --tag bkp >/dev/null || fail "init-secrets"
# S3 TLS sertifikasi (SAN: s3 + 127.0.0.1); pgBackRest bunu CA olarak dogrular (verify-tls ACIK)
mkdir -p "$work/s3/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=s3" -addext "subjectAltName=DNS:s3,IP:127.0.0.1" \
  -keyout "$work/s3/certs/private.key" -out "$work/s3/certs/public.crt" >/dev/null 2>&1
chmod 0644 "$work/s3/certs/private.key"
MINIO_USER=bkp$(openssl rand -hex 8); MINIO_PASS=$(openssl rand -hex 20); CIPHER=$(openssl rand -base64 48 | tr -d '\n')
cat >"$work/test.override.yml" <<YML
services:
  s3:
    image: $S3_IMAGE
    command: ["--port", ":9000", "--cert", "/certs/public.crt", "--key", "/certs/private.key", "posix", "/data"]
    environment:
      ROOT_ACCESS_KEY_ID: $MINIO_USER
      ROOT_SECRET_ACCESS_KEY: $MINIO_PASS
    volumes:
      - $work/s3/certs:/certs:ro
      - s3data:/data
    # Yalniz test: host'tan bucket olusturma/okuma icin 127.0.0.1'e yayin
    ports: ["127.0.0.1:$S3_HOST_PORT:9000"]
    networks:
      egress:
        aliases: [s3]
volumes:
  s3data:
YML
# Host'tan S3 istegi (curl SigV4) - yalniz test
s3curl() { curl -sS --fail --cacert "$work/s3/certs/public.crt" --aws-sigv4 "aws:amz:us-east-1:s3" --user "$MINIO_USER:$MINIO_PASS" "$@"; }
S3URL="https://127.0.0.1:$S3_HOST_PORT"
cat >"$work/env/backup.env" <<ENV
R2_BACKUP_BUCKET=$BUCKET
R2_BACKUP_ACCESS_KEY_ID=$MINIO_USER
R2_BACKUP_SECRET_ACCESS_KEY=$MINIO_PASS
PGBACKREST_REPO_CIPHER_PASS=$CIPHER
PGBACKREST_S3_ENDPOINT=s3
PGBACKREST_S3_PORT=9000
PGBACKREST_S3_REGION=us-east-1
PGBACKREST_S3_CA_FILE=/etc/arilla-backup/s3-ca.crt
PGBACKREST_ARCHIVE_TIMEOUT=60
ENV

echo "== 2. Yapilandirma uretimi (pg-backup-configure)"
"$B/pg-backup-configure" --env-file "$work/env/backup.env" --dir "$work/backup" >"$work/configure.log" 2>&1 && pass "pg-backup-configure" || { fail "pg-backup-configure"; cat "$work/configure.log"; exit 1; }
cp "$work/s3/certs/public.crt" "$work/backup/repo/s3-ca.crt"
[ ! -e "$work/backup/pg/archive.conf" ] && pass "archive.conf YAZILMADI (yapilandirma tek basina etkinlestirmez)" || fail "archive.conf erken yazildi"
grep -q "$MINIO_PASS" "$work/backup/pg/pgbackrest.conf" && fail "postgres tarafi yapilandirmada depo sirri" || pass "postgres tarafi yapilandirmada depo sirri yok"
grep -q "repo1-cipher-pass" "$work/backup/pg/pgbackrest.conf" && fail "postgres tarafinda sifreleme parolasi" || pass "postgres tarafinda sifreleme parolasi yok"
grep -q "$MINIO_PASS" "$work/configure.log" && fail "configure ciktisinda sir" || pass "configure ciktisinda sir yok"
"$B/pg-backup-configure" --env-file "$work/env/backup.env" --dir "$work/backup" >/dev/null 2>&1
cmp -s "$work/backup/repo/tls/ca.crt" "$work/backup/pg/tls/ca.crt" && pass "ikinci calistirma: TLS anahtarlari korunur (idempotent)" || fail "TLS idempotent degil"
printf 'R2_BACKUP_BUCKET=X_bad\n' >"$work/bad.env"
"$B/pg-backup-configure" --env-file "$work/bad.env" --dir "$work/badout" >/dev/null 2>&1 && fail "gecersiz backup.env kabul edildi" || pass "gecersiz backup.env reddedilir"

echo "== 3. Etkinlestirme oncesi: postgres (yeni imaj, arsiv KAPALI) + S3"
c up -d s3 postgres >"$work/up.log" 2>&1 || { fail "compose up"; tail -15 "$work/up.log"; exit 1; }
for _ in $(seq 1 60); do [ "$(q 'select 1')" = 1 ] && break; sleep 2; done
bucket_ok=0
for _ in $(seq 1 60); do
  if s3curl -X PUT -o /dev/null "$S3URL/$BUCKET" 2>"$work/s3.err" || s3curl -o /dev/null "$S3URL/$BUCKET?list-type=2" 2>>"$work/s3.err"; then bucket_ok=1; break; fi
  sleep 1
done
[ "$bucket_ok" = 1 ] && pass "S3 bucket hazir (TLS)" || { fail "S3 bucket"; tail -3 "$work/s3.err"; }
[ "$(q 'show archive_mode')" = off ] && pass "include_if_exists: archive.conf yokken archive_mode=off" || fail "archive_mode on olmamaliydi"
q "create table schema_migration(filename text primary key); insert into schema_migration values ('0001_test.sql');
   create table bkp_test(id int, phase text, at timestamptz default clock_timestamp());
   create table bkp_part(id int, at date) partition by range (at);
   create table bkp_part_2026 partition of bkp_part for values from ('2026-01-01') to ('2027-01-01');
   insert into bkp_part select g, date '2026-06-01' from generate_series(1,25) g;" >/dev/null
[ "$(q 'select count(*) from bkp_part')" = 25 ] && pass "test semasi hazir" || fail "test semasi"

echo "== 4. Etkinlestirme (preflight + activate: yeniden baslatma, stanza, check, TAM yedek)"
ARILLA_ACTIVATE_ALLOW_TAG=1 ARILLA_PULL=0 "$B/pg-backup-activate" activate --image "$ARILLA_POSTGRES_IMAGE" >"$work/act0.log" 2>&1
grep -q "confirm-restart" "$work/act0.log" && [ ! -e "$work/backup/pg/archive.conf" ] && pass "--confirm-restart olmadan yeniden baslatma YOK" || { fail "onaysiz etkinlestirme"; tail -5 "$work/act0.log"; }
if ARILLA_ACTIVATE_ALLOW_TAG=1 ARILLA_PULL=0 "$B/pg-backup-activate" activate --image "$ARILLA_POSTGRES_IMAGE" --confirm-restart >"$work/act.log" 2>&1; then
  pass "pg-backup-activate activate"
else
  fail "pg-backup-activate activate"; tail -30 "$work/act.log"; exit 1
fi
[ "$(q 'show archive_mode')" = on ] && pass "archive_mode=on" || fail "archive_mode"
grep -q "^ARILLA_POSTGRES_IMAGE=$ARILLA_POSTGRES_IMAGE" "$work/compose.env" && pass "compose.env: ARILLA_POSTGRES_IMAGE yazildi" || fail "compose.env imaj satiri"
[ "$(q 'select count(*) from bkp_part')" = 25 ] && pass "yeniden baslatma sonrasi veri yerinde" || fail "veri kaybi"

echo "== 5. Veri + PITR hedefi + fark yedegi + dogrulama"
q "insert into bkp_test(id, phase) select g, 'A' from generate_series(1,100) g" >/dev/null
sleep 2
T1=$(q "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')||'+00'")
sleep 2
q "insert into bkp_test(id, phase) select g, 'B' from generate_series(1,50) g" >/dev/null
"$B/pg-backup" check >"$work/check.log" 2>&1 && pass "pg-backup check (arsiv zinciri)" || { fail "pg-backup check"; tail -10 "$work/check.log"; }
"$B/pg-backup" diff >"$work/diff.log" 2>&1 && pass "fark yedegi" || { fail "fark yedegi"; tail -10 "$work/diff.log"; }
"$B/pg-backup" verify >"$work/verify-repo.log" 2>&1 && pass "pgbackrest verify" || { fail "verify"; tail -10 "$work/verify-repo.log"; }
inf=$("$B/pg-backup" info --json 2>/dev/null)
n=$(printf '%s' "$inf" | "$PY" -c 'import json,sys;d=json.load(sys.stdin);print(len(d[0]["backup"]),d[0]["status"]["code"])' 2>/dev/null)
[ "$n" = "2 0" ] && pass "info: 1 tam + 1 fark, stanza saglikli" || fail "info: $n"
grep -q '"ok":true' "$work/state/backup-full.json" 2>/dev/null && grep -q '"ok":true' "$work/state/backup-diff.json" && pass "durum dosyalari yazildi" || fail "durum dosyalari"
hdr=$(s3curl "$S3URL/$BUCKET/pgbackrest/backup/arilla/backup.info" 2>/dev/null | head -c 8)
[ "$hdr" = "Salted__" ] && pass "depoda dosyalar istemci tarafinda sifreli (Salted__)" || fail "depo sifreli degil: $hdr"

echo "== 6. Izole geri yukleme provasi: en son durum"
ARILLA_RESTORE_ASSERT_SQL="select (count(*) filter (where phase='A')=100 and count(*) filter (where phase='B')=50)::int from bkp_test" \
  "$B/pg-restore-test" >"$work/rt1.log" 2>&1 && pass "pg-restore-test (latest): A+B geri geldi, amcheck, sema = uretim" || { fail "pg-restore-test latest"; tail -15 "$work/rt1.log"; }
grep -q '"schema_match":"true"' "$work/state/restore-test.json" && pass "sema ozeti uretimle ayni" || fail "sema eslesmedi"
grep -q '"amcheck":"pass"' "$work/state/restore-test.json" && pass "pg_amcheck temiz" || fail "amcheck"

echo "== 7. PITR: T1 anina (A var, B YOK)"
ARILLA_RESTORE_ASSERT_SQL="select (count(*) filter (where phase='A')=100 and count(*) filter (where phase='B')=0)::int from bkp_test" \
  "$B/pg-restore-test" --time "$T1" >"$work/rt2.log" 2>&1 && pass "PITR $T1: yalniz A" || { fail "PITR"; tail -15 "$work/rt2.log"; }
[ -z "$(ls -A "$work/restore-test" 2>/dev/null)" ] && pass "prova dizini temizlendi" || fail "prova dizini kaldi"
[ "$(q "select count(*) from bkp_test")" = 150 ] && pass "uretim veritabani provalardan etkilenmedi (150 satir)" || fail "uretim degisti"

echo "== 8. Ag yalitimi ve sir sizintisi"
cfg=$(c --profile backup --profile restore config --format json 2>/dev/null)
nets() { printf '%s' "$cfg" | "$PY" -c "import json,sys;print('+'.join(sorted(json.load(sys.stdin)['services']['$1']['networks'])))"; }
[ "$(nets postgres)" = data ] && pass "postgres yalniz data aginda (internete cikmaz)" || fail "postgres aglari: $(nets postgres)"
[ "$(nets backup)" = "data+egress" ] && pass "backup: data + egress" || fail "backup aglari: $(nets backup)"
[ "$(nets restore)" = egress ] && pass "restore: yalniz egress (uretim DB'ye erisemez)" || fail "restore aglari: $(nets restore)"
docker exec "${COMPOSE_PROJECT_NAME}-postgres-1" bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' >/dev/null 2>&1 && fail "postgres internete cikabiliyor" || pass "postgres internete cikamaz"
docker exec "${COMPOSE_PROJECT_NAME}-postgres-1" sh -c "grep -rq '$MINIO_PASS' /etc/arilla-backup" 2>/dev/null && fail "postgres konteynerinde depo sirri" || pass "postgres konteynerinde depo sirri yok"
leak=0
for ctr in postgres backup s3; do
  docker inspect "${COMPOSE_PROJECT_NAME}-$ctr-1" 2>/dev/null | grep -q "$CIPHER" && leak=1
done
cat "$work"/*.log 2>/dev/null | grep -qF -e "$CIPHER" -e "$MINIO_PASS" && leak=1
c --profile backup logs --no-color postgres backup 2>&1 | grep -qF -e "$CIPHER" -e "$MINIO_PASS" && leak=1
[ "$leak" = 0 ] && pass "sifreleme parolasi/depo anahtari env, gunluk ve ciktilarda yok" || fail "sir sizintisi"

echo "== 9. Saglik kontrolu"
hc=$("$PY" "$work/vps/bin/arilla_healthcheck.py" --root "$work" --json 2>/dev/null)
lvl() { printf '%s' "$hc" | "$PY" -c "import json,sys;print({c['name']:c['level'] for c in json.load(sys.stdin)['checks']}.get('$1','yok'))"; }
for k in wal-archive backup:container backup:last backup:full restore-test; do
  [ "$(lvl "$k")" = ok ] && pass "saglik: $k ok" || fail "saglik: $k = $(lvl "$k")"
done

echo "== 10. Depo kesintisi: arsiv hatasi alarm verir, sonra toparlanir"
c stop s3 >/dev/null 2>&1
# Bekleyen WAL >= 4 -> uyari (esik: THRESHOLDS["archive_ready_warn"]); 15 dk bekleyen -> kritik.
for _ in 1 2 3 4 5 6; do q "insert into bkp_test(id, phase) select g, 'C' from generate_series(1,10) g; select pg_switch_wal();" >/dev/null; sleep 3; done
alarm=ok
for _ in $(seq 1 24); do
  hc=$("$PY" "$work/vps/bin/arilla_healthcheck.py" --root "$work" --json 2>/dev/null)
  alarm=$(lvl wal-archive); [ "$alarm" != ok ] && break
  sleep 5
done
[ "$alarm" != ok ] && pass "depo erisilemezken wal-archive alarm: $alarm ($(printf '%s' "$hc" | "$PY" -c "import json,sys;print([c['message'] for c in json.load(sys.stdin)['checks'] if c['name']=='wal-archive'][0])"))" || fail "arsiv hatasi algilanmadi"
c start s3 >/dev/null 2>&1
ok=0
for _ in $(seq 1 30); do "$B/pg-backup" check >/dev/null 2>&1 && { ok=1; break; }; sleep 5; done
[ "$ok" = 1 ] && pass "depo geri gelince arsiv zinciri toparlandi (check)" || fail "toparlanmadi"

echo "== 11. Geri alma: deactivate (arsiv kapanir, depo SILINMEZ)"
"$B/pg-backup-activate" deactivate --confirm-restart >"$work/deact.log" 2>&1 && pass "deactivate" || { fail "deactivate"; tail -10 "$work/deact.log"; }
[ "$(q 'show archive_mode')" = off ] && pass "archive_mode=off" || fail "archive_mode kapanmadi"
s3curl "$S3URL/$BUCKET?list-type=2&prefix=pgbackrest/backup/arilla/" 2>/dev/null | grep -q "backup.info" && pass "depodaki yedekler duruyor" || fail "depo bos"

echo
if [ "$failures" -eq 0 ]; then echo "TUM YEDEKLEME KONTROLLERI GECTI"; else echo "$failures KONTROL BASARISIZ"; fi
exit $((failures > 0))
