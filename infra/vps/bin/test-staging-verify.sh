#!/usr/bin/env bash
# pg-staging-verify PROVASI (karar 0148) - YEREL ya da CI, root GEREKMEZ.
# Uretime, yedege, R2'ye ve gercek sirlara DOKUNMAZ: sentetik bir "uretim" veri dizini kurulur
# (imajdaki migration'lar eksi EN SONUNCUSU), betik prova kipinde onun kopyasinda calisir.
#
#   MIGRATE_IMAGE=<migrate-imaji> infra/vps/bin/test-staging-verify.sh
#   SKIP_BUILD=1 ARILLA_POSTGRES_IMAGE=arilla-postgres:test MIGRATE_IMAGE=... (imaj derlemeden)
#   EXPECT_DIFF=<desen>  sema farkinda aranacak metin (ornek: curation); bos = denetlenmez
#
# Kanitlar: bekleyen = yalniz son migration; uygulandi + verify gecti + iddia gecti; yalitim
# (ag yok, yalniz soket, arsiv kapali, pg_hba yalniz local); rapor/ciktida sentetik "gizli"
# isaret YOK; gecici dizin ve konteyner kalmadi; kaynak ("uretim") veri dizini DEGISMEDI;
# hata yollari (beklenen eksik, iddia 0, bekleyen yok, /opt/arilla korumasi) raporla durur.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
infra=$(cd "$here/../.." && pwd)
PGIMG=${ARILLA_POSTGRES_IMAGE:-arilla-postgres:staging-test}
MIGRATE_IMAGE=${MIGRATE_IMAGE:?MIGRATE_IMAGE gerekli (docker build -f apps/web/Dockerfile --target migrate)}
SEED_IMAGE="arilla-migrate-seed:staging-test-$$"
EXPECT_DIFF=${EXPECT_DIFF:-}
# Betik PATH'i sabitler; docker/python3 baska dizindeyse (macOS, Docker Desktop) eklenir.
ARILLA_EXTRA_PATH="$(dirname "$(command -v docker)"):$(dirname "$(command -v python3)")"
export ARILLA_EXTRA_PATH
work=$(mktemp -d)
seedc="arilla-staging-seed-$$"
failures=0
pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; failures=$((failures + 1)); }
dsh() { docker run --rm --network none --log-driver none "$@"; }

cleanup() {
  docker rm -f "$seedc" >/dev/null 2>&1 || true
  docker image rm -f "$SEED_IMAGE" >/dev/null 2>&1 || true
  if [ "${KEEP:-0}" != 1 ]; then
    dsh --user 0 -v "$work:/w" --entrypoint sh "$PGIMG" -c 'find /w -mindepth 1 -delete' >/dev/null 2>&1 || true
    rm -rf -- "${work:?}"
  else
    echo "KEEP=1: $work"
  fi
}
trap cleanup EXIT

echo "== 0. Imajlar"
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  docker build -q -t "$PGIMG" "$infra/vps/postgres" >/dev/null && pass "arilla-postgres imaji derlendi" || { fail "postgres imaji"; exit 1; }
fi
docker image inspect "$MIGRATE_IMAGE" >/dev/null 2>&1 && pass "migrate imaji: $MIGRATE_IMAGE" || { fail "migrate imaji yok"; exit 1; }
LAST=$(dsh --entrypoint ls "$MIGRATE_IMAGE" /app/packages/db/migrations | grep -E '^[0-9]{4}_.*[.]sql$' | sort | tail -1)
[ -n "$LAST" ] && pass "imajdaki en son migration: $LAST" || { fail "migration listesi"; exit 1; }
# Tohum imaji = ayni imaj eksi en son migration: "uretim" bir migration geride.
printf 'FROM %s\nUSER root\nRUN rm /app/packages/db/migrations/%s\nUSER node\n' "$MIGRATE_IMAGE" "$LAST" \
  | docker build -q -t "$SEED_IMAGE" - >/dev/null && pass "tohum imaji ($LAST haric)" || { fail "tohum imaji"; exit 1; }

echo "== 1. Sentetik 'uretim' veri dizini"
mkdir -p "$work/seed/sock" && chmod 0777 "$work/seed" "$work/seed/sock"
dsh --user 999:999 -v "$work/seed:/seed" --entrypoint initdb "$PGIMG" -D /seed/data -U arilla \
  --auth-local=trust --auth-host=reject -E UTF8 >"$work/initdb.log" 2>&1 && pass "initdb" || { fail "initdb"; tail -5 "$work/initdb.log"; exit 1; }
docker run -d --name "$seedc" --network none --log-driver none --user 999:999 -v "$work/seed:/seed" \
  --entrypoint postgres "$PGIMG" -D /seed/data -c listen_addresses= -c unix_socket_directories=/seed/sock >/dev/null
for _ in $(seq 1 60); do docker exec "$seedc" pg_isready -q -h /seed/sock 2>/dev/null && break; sleep 1; done
docker exec "$seedc" createdb -h /seed/sock -U arilla arilla && pass "tohum PostgreSQL (ag yok)" || { fail "createdb"; exit 1; }
seedrun() {
  dsh --read-only --tmpfs /tmp -v "$work/seed/sock:/sock" \
    -e "DATABASE_URL_OWNER=postgresql://arilla@localhost/arilla?host=/sock" \
    -e "DATABASE_URL=postgresql://arilla_app@localhost/arilla?host=/sock" \
    -e "APP_DB_PASSWORD=$APP_PW" "$SEED_IMAGE" node "scripts/$1"
}
APP_PW=$(openssl rand -hex 16)
{ seedrun migrate.ts && seedrun bootstrap-app-role.ts && seedrun partitions.ts; } >"$work/seed.log" 2>&1 \
  && pass "tohum: migration'lar ($LAST haric) + rol + bolumler" || { fail "tohum migration"; tail -15 "$work/seed.log"; exit 1; }
MARKER="GIZLI-SENTETIK-$(openssl rand -hex 6)"
q() { docker exec "$seedc" psql -h /seed/sock -U arilla -d arilla -AtqXc "$1"; }
q "update trend set description = '$MARKER' where id = (select min(id) from trend)" >/dev/null 2>&1 \
  || q "create table staging_marker(v text); insert into staging_marker values ('$MARKER')" >/dev/null
seed_max=$(q "select max(filename) from schema_migration")
docker exec "$seedc" pg_ctl -D /seed/data -m fast stop >/dev/null 2>&1; docker rm -f "$seedc" >/dev/null 2>&1
seedsum() { dsh --user 0 -v "$work/seed/data:/d:ro" --entrypoint sh "$PGIMG" -c 'cd /d && find . -type f -exec sha256sum {} + | sort | sha256sum'; }
sum_before=$(seedsum)
pass "tohum hazir (defter: $seed_max; gizli isaret eklendi)"

run_verify() { # run_verify <etiket> [arguman...]: cikis kodu + rapor $work/<etiket>.json
  local tag=$1; shift
  mkdir -p "$work/root-$tag/state"
  ARILLA_ROOT="$work/root-$tag" ARILLA_STAGING_TEST_DATADIR="$work/seed/data" ARILLA_POSTGRES_IMAGE="$PGIMG" \
    "$here/pg-staging-verify" "$@" >"$work/$tag.out" 2>&1
  local rc=$?
  cp "$work/root-$tag/state/staging-verify.json" "$work/$tag.json" 2>/dev/null || echo '{}' >"$work/$tag.json"
  return $rc
}
j() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$@"; }
leftovers() { # leftovers <etiket>: gecici dizin ya da konteyner kaldi mi
  local n
  n=$(find "$work/root-$1/restore-test" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
  n=$((n + $(docker ps -aq --filter label=arilla.staging-verify | wc -l | tr -d ' ')))
  echo "$n"
}

echo "== 2. Basarili yol: bekleyen = $LAST"
ASSERT="select (count(*) = 1)::int from schema_migration where filename = '$LAST'"
if run_verify ok --image "$MIGRATE_IMAGE" --expect "$LAST" --assert-sql "$ASSERT"; then pass "pg-staging-verify cikis 0"; else fail "pg-staging-verify"; tail -20 "$work/ok.out"; fi
[ "$(j "$work/ok.json" 'd["ok"]')" = True ] && pass "rapor ok=true" || fail "rapor ok"
[ "$(j "$work/ok.json" 'd["migrations"]["pending"]')" = "['$LAST']" ] && pass "bekleyen yalniz $LAST" || fail "bekleyen listesi"
[ "$(j "$work/ok.json" 'd["migrations"]["applied"]')" = "['$LAST']" ] && pass "uygulanan yalniz $LAST" || fail "uygulanan listesi"
[ "$(j "$work/ok.json" '[r["status"] for r in d["migrations"]["results"]]')" = "['tamam']" ] && pass "calistirici: tamam" || fail "calistirici satiri"
[ "$(j "$work/ok.json" 'd["verify"]["passed"] and d["verify"]["exit"] == 0')" = True ] && pass "verify-schema gecti" || fail "verify-schema"
[ "$(j "$work/ok.json" 'd["assert"]')" = pass ] && pass "iddia sorgusu gecti" || fail "iddia"
[ "$(j "$work/ok.json" 'd["isolation"]')" = "{'network': 'none', 'data_directory': '/restore/data', 'listen_addresses': '', 'archive_mode': 'off', 'in_recovery': 'false', 'hba_non_local_rules': 0}" ] \
  && pass "yalitim: ag none, TCP yok, arsiv kapali, pg_hba yalniz local" || fail "yalitim alanlari"
[ "$(j "$work/ok.json" 'd["schema"]["before_sha256"] is not None and d["schema"]["after_sha256"] is not None')" = True ] && pass "sema ozetleri (once/sonra)" || fail "sema ozetleri"
if [ -n "$EXPECT_DIFF" ]; then
  grep -q -- "$EXPECT_DIFF" "$work/root-ok/state/staging-verify.schema.diff" 2>/dev/null && pass "sema farkinda '$EXPECT_DIFF'" || fail "sema farkinda '$EXPECT_DIFF' yok"
fi
# Ag'siz konteynerden disari TCP (IP ile; DNS de yok) kurulamamali: uretim DB'si dahil hicbir hedef.
probe='const s=require("net").connect({host:"1.1.1.1",port:53,timeout:3000});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1));'
if dsh --read-only --entrypoint node "$MIGRATE_IMAGE" -e "$probe" >/dev/null 2>&1; then
  fail "agsiz migrate konteyneri disari baglanabildi"
else
  pass "agsiz migrate konteynerinden disari TCP baglantisi kurulamaz"
fi
leak=0
for f in "$work/ok.out" "$work/ok.json" "$work/root-ok/state/staging-verify.schema.diff"; do
  [ -f "$f" ] && grep -q "$MARKER" "$f" && leak=1
done
[ "$leak" = 0 ] && pass "gizli isaret ciktida/raporda/farkta YOK" || fail "VERI SIZINTISI"
grep -q "$APP_PW" "$work/ok.out" "$work/ok.json" && fail "parola ciktida" || pass "parola ciktida yok"
[ "$(stat -c %a "$work/root-ok/state/staging-verify.json" 2>/dev/null || stat -f %Lp "$work/root-ok/state/staging-verify.json")" = 640 ] && pass "rapor izni 0640" || fail "rapor izni"
[ "$(leftovers ok)" = 0 ] && pass "gecici dizin ve konteyner kalmadi" || fail "artik kaldi"
[ "$(seedsum)" = "$sum_before" ] && pass "kaynak ('uretim') veri dizini DEGISMEDI" || fail "kaynak degisti"

echo "== 3. Hata yollari raporla durur"
expect_fail() { # expect_fail <etiket> <aciklama> <rapor-kosulu> [arguman...]
  local tag=$1 what=$2 cond=$3; shift 3
  if run_verify "$tag" "$@"; then
    fail "$what: cikis 0 (durmaliydi)"
  elif [ "$(j "$work/$tag.json" "$cond" 2>/dev/null)" = True ]; then
    pass "$what: durdu, raporladi"
  else
    fail "$what: rapor beklenen gibi degil"; tail -5 "$work/$tag.out"
  fi
}
expect_fail expect "beklenen migration bekleyenlerde yok" \
  'd["ok"] is False and any("beklenen" in e for e in d["errors"])' --image "$MIGRATE_IMAGE" --expect 9999_yok.sql
expect_fail assert "iddia sorgusu 0" \
  'd["ok"] is False and d["assert"] == "fail"' --image "$MIGRATE_IMAGE" --assert-sql "select 0"
expect_fail nopend "bekleyen migration yok (imaj = uretim)" \
  'd["ok"] is False and any("bekleyen migration yok" in e for e in d["errors"])' --image "$SEED_IMAGE"
for t in expect assert nopend; do [ "$(leftovers "$t")" = 0 ] || fail "$t: artik kaldi"; done
pass "hata yollarinda da temizlik yapildi"
if ARILLA_ROOT=/opt/arilla ARILLA_STAGING_TEST_DATADIR="$work/seed/data" ARILLA_POSTGRES_IMAGE="$PGIMG" \
  "$here/pg-staging-verify" --image "$MIGRATE_IMAGE" >"$work/opt.out" 2>&1; then
  fail "/opt/arilla prova kipine izin verdi"
elif grep -q "prova kipi /opt/arilla" "$work/opt.out"; then
  pass "prova kipi /opt/arilla altinda reddedilir"
else
  fail "/opt/arilla korumasi"
fi
[ "$(seedsum)" = "$sum_before" ] && pass "kaynak veri dizini tum kosulardan sonra DEGISMEDI" || fail "kaynak degisti"

echo
if [ "$failures" -eq 0 ]; then echo "TUM KONTROLLER GECTI"; else echo "$failures KONTROL BASARISIZ"; exit 1; fi
