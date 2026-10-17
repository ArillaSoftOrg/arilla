#!/usr/bin/env bash
# test-wal-backpressure.sh - catalog-publish bekcisinin WAL kararlarini GERCEK arsivleyen
# PostgreSQL 16 ile sinar (karar 0134). Uretime dokunmaz: tek kullanimlik konteyner, olcek
# kucultulmus (max_wal_size 256MB, kuyruk siniri 512MiB). Docker ister.
#
#   bash infra/vps/bin/test-wal-backpressure.sh
#
# Senaryolar: esik turetme ve yapilandirma emniyeti, kok neden regresyonu (arsiv bosaldiktan
# sonra CHECKPOINT beklemeden devam), yavas arsiv, arsiv hatasi (bekle -> KESIN DUR -> duzelme),
# disk baskisi, pgBackRest'in biraktigi WAL, bekciye SIGTERM (is guvenle durur), is ici WAL
# siniri (kod 3) sonrasi cokme sayilmadan kaldigi yerden devam.
#
# KEEP=1: konteyner silinmez (hata ayiklama). WAL_TEST_IMAGE: imaj (varsayilan uretim tabani).
# shellcheck source-path=SCRIPTDIR
# Sahte isin ve kutuphanenin okudugu degiskenler (WEB_LAST_CODE, ARCH_FAIL_SINCE, MAX_CRASHES...)
# bu dosyada atanir, catalog-publish icinde okunur.
# shellcheck disable=SC2034
set -uo pipefail
export LC_ALL=C MSYS_NO_PATHCONV=1
# Bekcinin uzun beklemeleri (run_phase'te 10/60 sn) testte 1 sn'ye kisalir; kisa olanlar aynen.
sleep() { command sleep "$(awk -v s="$1" 'BEGIN{print (s>2?1:s)}')"; }

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${WAL_TEST_IMAGE:-pgvector/pgvector:0.8.1-pg16}
C=arilla-walbp-test-$$
WORK=$(mktemp -d)
PASS=0 FAIL=0

cleanup() {
  [ "${KEEP:-0}" = 1 ] && { echo "konteyner korunuyor: $C, dizin: $WORK"; return; }
  docker rm -f "$C" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); echo "  GECTI  $*"; }
bad() { FAIL=$((FAIL + 1)); echo "  KALDI  $*"; }
check() { if eval "$2"; then ok "$1"; else bad "$1 ($2)"; fi; }

echo "== laboratuvar: $IMAGE (arsiv acik, gecikme/hata denetimli)"
docker run -d --name "$C" -e POSTGRES_PASSWORD=lab "$IMAGE" postgres \
  -c wal_level=replica -c archive_mode=on \
  -c "archive_command=sh -c 'd=\$(cat /tmp/archive_delay 2>/dev/null || echo 0); sleep \$d; test ! -f /tmp/archive_fail && cp %p /archive/%f'" \
  -c max_wal_size=256MB -c min_wal_size=64MB -c checkpoint_timeout=300s \
  -c checkpoint_completion_target=0.9 -c shared_buffers=128MB >/dev/null || exit 1
# Resmi imaj once gecici bir sunucuyla initdb yapar ve kapatir: ikinci "ready" asil sunucudur.
for _ in $(seq 1 120); do
  [ "$(docker logs "$C" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 1
done
docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 || { echo "laboratuvar acilmadi"; exit 1; }
docker exec "$C" sh -c 'mkdir -p /archive && chown postgres /archive'
sql() { docker exec -i -u postgres "$C" psql -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
sql "CREATE TABLE load (id bigserial PRIMARY KEY, v text)"
set_archive() { # set_archive <gecikme_sn> <fail 0|1>
  docker exec -u postgres "$C" sh -c "echo $1 > /tmp/archive_delay"
  if [ "$2" = 1 ]; then docker exec -u postgres "$C" touch /tmp/archive_fail
  else docker exec -u postgres "$C" rm -f /tmp/archive_fail; fi
}
# write_mb <MB>: yaklasik MB kadar WAL, tek islemde. Birikim, disk hizindan bagimsiz olsun diye
# yazim sirasinda arsiv DURDURULARAK kurulur (R2 duraklamasi gibi).
write_mb() { sql "INSERT INTO load (v) SELECT repeat(md5(random()::text), 8) FROM generate_series(1, $(( $1 * 3200 )))"; }
drain() {
  sql "SELECT pg_switch_wal()" >/dev/null
  for _ in $(seq 1 240); do
    [ "$(sql "SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'")" = 0 ] && return 0
    sleep 0.5
  done
  return 1
}

# --- bekciyi kutuphane olarak yukle; dis bagimliliklari sahtele ----------------------------
mkdir -p "$WORK/root/backup/pg" "$WORK/state"
printf '[global]\narchive-push-queue-max=512MiB\n' >"$WORK/root/backup/pg/pgbackrest.conf"
export ARILLA_ROOT=$WORK/root STATE_DIR=$WORK/state ARILLA_PSQL="docker exec -i -u postgres $C psql"
export CHECK_EVERY=1 RESUME_HEALTHY_S=1 ARCHIVE_FAIL_S=6
FAKE_DISK_GB=100
: >"$WORK/pg.log"
# shellcheck source=catalog-publish
CATALOG_PUBLISH_LIB=1 source "$HERE/catalog-publish"
svc_health() { echo healthy; }
disk_free_gb() { echo "$FAKE_DISK_GB"; }
mem_avail_mb() { echo 8000; }
load_x100() { echo 10; }
web_median_ms() { WEB_LAST_CODE=307; echo 40; }
pg_logs_since() { cat "$WORK/pg.log"; }

echo "== 1. esikler gercek yapilandirmadan turetilir"
init_wal_thresholds
check "kuyruk siniri okundu (512 MiB)" '[ "$QUEUE_MAX_MB" = 512 ]'
check "bekci duraklamasi = kuyrugun yarisi" '[ "$READY_PAUSE_MB" = 256 ]'
check "is ici hedef < duraklama < bekci" '[ "$JOB_WAL_TARGET_MB" = 128 ] && [ "$JOB_WAL_PAUSE_MB" = 192 ] && [ "$READY_PAUSE_MB" -gt "$JOB_WAL_PAUSE_MB" ]'
check "max_wal_size okundu" '[ "$MAX_WAL_MB" = 256 ]'
# shellcheck disable=SC2034 # check() icinde eval ile okunur
out=$( (unset READY_PAUSE_MB; READY_PAUSE=32 init_wal_thresholds) 2>&1); rc=$?
check "eski READY_PAUSE (kuyrugun %100'u) reddedilir" '[ $rc -ne 0 ] && echo "$out" | grep -q "BIRAKILIR"'
check "is argumanlari" '[ "$(job_wal_args)" = "--wal-target-mb 128 --wal-pause-mb 192 --wal-resume-mb 64 --wal-failing-grace-s 6" ]'

echo "== 2. kok neden: arsiv bosaldiktan sonra CHECKPOINT beklemeden devam"
# Uretimdeki sira: yavas arsivde birikim varken bir checkpoint olur (.ready segmentler silinemez),
# sonra arsiv yetisir. Bu segmentler (removable) bir SONRAKI checkpoint'e kadar dizinde kalir.
set_archive 0 1
sql "CHECKPOINT"
write_mb 300
sql "CHECKPOINT" # birikim varken (uretimde WAL ile tetiklenen checkpoint)
set_archive 0 0
drain || bad "arsiv bosalmadi"
read_wal_state
old_resume_mb=$((MAX_WAL_MB * 5 / 4)) # eski kural: WAL_RESUME_GB=5 @ max_wal_size=4GB
echo "  pg_wal toplam $(mb "$W_TOTAL") MB: recycled $(mb "$W_RECYCLED"), removable $(mb "$W_REMOVABLE"), redo sonrasi $(mb "$W_SINCE_REDO"), arsivsiz $(mb "$W_READY")"
check "arsiv borcu yok" '[ "$(mb "$W_READY")" -eq 0 ]'
check "dizin eski devam esiginin ($old_resume_mb MB) ustunde: eski bekci beklerdi" '[ "$(mb "$W_TOTAL")" -ge "$old_resume_mb" ]'
check "borc olmayan WAL (recycled + removable) ayrildi" '[ $((W_RECYCLED + W_REMOVABLE)) -gt 0 ]'
check_health resume; rc=$?
check "yeni bekci hemen devam der (rc=0, CHECKPOINT yok)" '[ $rc -eq 0 ]'
check "metrik satiri yazildi" '[ "$(wc -l <"$METRICS")" -ge 2 ] && tail -1 "$METRICS" | grep -q ",resume$"'
bw_until=$(grep -o '"until": [0-9]*' "$S/bulk-window.json" 2>/dev/null | grep -o '[0-9]*$')
check "saglik kontrolu kalp atisi (bekci esigi = 16 dosya, taze)" 'grep -q "\"ready_crit\": 16," "$S/bulk-window.json" && [ "${bw_until:-0}" -gt "$(date -u +%s)" ]'

echo "== 3. yavas arsiv: arsiv borcu esigi"
set_archive 0 1
write_mb 300
sql "SELECT pg_switch_wal()" >/dev/null
set_archive 3 0 # arsiv geri geldi ama yavas (~5 MB/sn)
# Ilk basarili gonderime kadar "arsiv basarisiz" kurali onceliklidir (dogru); borc esigini olcmek
# icin ilk basariyi bekle.
for _ in $(seq 1 180); do read_wal_state; [ "$W_ARCH_T" -ge "$W_FAIL_T" ] && break; command sleep 0.5; done
check_health run; rc=$?
echo "  arsivsiz $(mb "$W_READY") MB, neden: $REASON"
check "arsivsiz WAL >= ${READY_PAUSE_MB} MB -> bekle (rc=1)" '[ $rc -eq 1 ] && echo "$REASON" | grep -q "arsivlenmemis"'
set_archive 0 0
drain
check_health resume; rc=$?
check "arsiv yetisince devam (rc=0)" '[ $rc -eq 0 ]'

echo "== 4. arsiv hatasi: bekle -> ${ARCHIVE_FAIL_S} sn sonra KESIN DUR -> duzelme"
set_archive 0 1
write_mb 4; sql "SELECT pg_switch_wal()" >/dev/null
for _ in $(seq 1 30); do read_wal_state; [ "$W_FAIL_T" -gt "$W_ARCH_T" ] && break; command sleep 0.5; done
ARCH_FAIL_SINCE=0
check_health run; rc=$?
check "ilk hata: bekle (rc=1)" '[ $rc -eq 1 ] && echo "$REASON" | grep -q "basarisiz"'
command sleep "$((ARCHIVE_FAIL_S + 1))"
check_health run; rc=$?
check "uzun sureli hata: KESIN DUR (rc=2)" '[ $rc -eq 2 ]'
set_archive 0 0
write_mb 1; drain
check_health resume; rc=$?
check "duzelince saglikli ve hata sayaci sifirlandi" '[ $rc -eq 0 ] && [ "$ARCH_FAIL_SINCE" -eq 0 ]'

echo "== 5. disk baskisi"
FAKE_DISK_GB=30
check_health resume; rc=$?
check "disk rezervi altinda KESIN DUR" '[ $rc -eq 2 ] && echo "$REASON" | grep -q "rezerv"'
FAKE_DISK_GB=100

echo "== 6. pgBackRest WAL birakti"
check "temiz gunluk: gecer" 'periodic_hard_checks'
echo "WARN: dropped WAL file '000000010000000000000042' because archive queue exceeded 512MB" >>"$WORK/pg.log"
periodic_hard_checks; rc=$?
check "birakilan WAL: KESIN DUR" '[ $rc -eq 2 ] && echo "$REASON" | grep -q "PITR"'
: >"$WORK/pg.log"

# --- sahte is: docker yerine yerel surec (gercek sinyallerle) ------------------------------
export FJ=$WORK/fakejob
mkdir -p "$FJ"
# fake_job <cikis_kodu> <satir...>: SIGTERM'de "mevcut partiyi bitirip" 0 ile cikar.
fake_job_script() {
  cat >"$FJ/job.sh" <<'EOS'
#!/usr/bin/env bash
code=$1; shift
trap 'echo $? >"$FJ/exit"' EXIT
trap 'echo term >"$FJ/term"; exit 0' TERM
for l in "$@"; do echo "$l"; done
[ "$code" = hang ] && while true; do sleep 0.2; done
sleep 1; exit "$code"
EOS
}
fake_job_script
docker() {
  case "$1" in
    kill) [ -f "$FJ/pid" ] && kill -TERM "$(cat "$FJ/pid")" 2>/dev/null; return 0 ;;
    stop) [ -f "$FJ/pid" ] && kill -KILL "$(cat "$FJ/pid")" 2>/dev/null; return 0 ;;
    rm|stats) return 0 ;;
    *) command docker "$@" ;;
  esac
}
job_running() { [ -f "$FJ/pid" ] && kill -0 "$(cat "$FJ/pid")" 2>/dev/null; }
job_exit() { cat "$FJ/exit" 2>/dev/null || echo 255; }
NEXT_JOB=()
start_job() { # sira NEXT_JOB'dan: "<kod>|satir1|satir2"
  local lf=$1; shift
  echo "$*" >>"$FJ/starts"
  local spec=${NEXT_JOB[0]}; NEXT_JOB=("${NEXT_JOB[@]:1}")
  IFS='|' read -r -a parts <<<"$spec"
  rm -f "$FJ/exit"
  bash "$FJ/job.sh" "${parts[@]}" >>"$lf" 2>&1 &
  echo $! >"$FJ/pid"
}

echo "== 7. is ici WAL siniri (kod 3) cokme sayilmaz; kaldigi yerden (--after-id) surer"
: >"$FJ/starts"
MAX_CRASHES=1 # cokme sayilsaydi ilk cikista KESIN DUR olurdu
NEXT_JOB=("3|parti 1: taranan 5000 hazir 4000 son_urun 100" "0|parti 2: taranan 10 hazir 10 son_urun 110|bitti=True hazir=10")
run_phase gate; rc=$?
check "gate bitti (rc=0)" '[ $rc -eq 0 ]'
check "ikinci baslatma --after-id 100" 'sed -n 2p "$FJ/starts" | grep -q -- "--after-id 100"'
check "is WAL argumanlarini aldi" 'head -1 "$FJ/starts" | grep -q -- "--wal-pause-mb 192"'
check "geri basinc cikisi gunlukte" 'grep -q "WAL geri basinci nedeniyle durdu" "$LOG"'

echo "== 8. bekciye SIGTERM: is guvenle durur, bekci 143 ile cikar"
rm -f "$FJ/term"
(
  install_signal_traps
  NEXT_JOB=("hang|parti 1: taranan 1 hazir 1 son_urun 1")
  start_job "$WORK/sig.log" gate
  while job_running; do command sleep 0.2; done
  exit 0
) &
wpid=$!
command sleep 2
kill -TERM "$wpid"
wait "$wpid"; rc=$?
check "bekci 143 ile cikti" '[ $rc -eq 143 ]'
check "is SIGTERM aldi (mevcut parti bitti)" '[ -f "$FJ/term" ]'
check "is artik calismiyor" '! job_running'
check "sinyal gunlukte" 'grep -q "bekci sinyal aldi (TERM)" "$LOG"'

echo
echo "SONUC: $PASS gecti, $FAIL kaldi"
[ "$FAIL" -eq 0 ]
