#!/usr/bin/env bash
# Dagitim motorunun (arilla-deploy) YEREL uctan uca testi (VPS'e/uretime dokunmaz).
#
# Atilabilir bir proje (arilla-deploytest), gecici dizinde "/opt/arilla" benzeri bir kok,
# yerel bir imaj registry'si (localhost:5055) ve sentetik bir git deposu kullanir. Sunlari sinar:
#   - guvenlik kapilari: main'de olmayan commit, yabanci imaj oneki, etiket (revision) uyusmazligi
#   - basarili dagitim, digest sabitleme, degisen servislerin yeniden olusturulmasi
#   - SAGLIK BASARISIZ sürüm -> otomatik geri alma (dosyalar + servisler), postgres/redis dokunulmaz
#   - bekleyen migration: pg_dump + migrate + verify-schema; Caddyfile degisimi
#   - tekrar dagitim (idempotent), elle geri alma, es zamanli dagitim kilidi
#   - deploy-gate komut izin listesi; gunluklerde sir yok
#
#   infra/vps/bin/test-deploy.sh     # onkosul: smoke-local.sh calismis olmali (arilla-*:smoke imajlari)
#
# Gereksinim: docker compose, git, python3/python, curl, openssl. smoke-local.sh imajlarini kullanir.
set -uo pipefail
export MSYS_NO_PATHCONV=1

here=$(cd "$(dirname "$0")" && pwd)
infra=$(cd "$here/../.." && pwd)
repo=$(cd "$infra/.." && pwd)
if command -v cygpath >/dev/null 2>&1; then
  here=$(cygpath -m "$here")
  infra=$(cygpath -m "$infra")
  repo=$(cygpath -m "$repo")
fi
PY=python3
python3 -c '' >/dev/null 2>&1 || PY=python

export COMPOSE_PROJECT_NAME=arilla-deploytest
REG_PORT=${DT_REGISTRY_PORT:-5055}
HTTP_PORT=${DT_HTTP_PORT:-18090}
REG=localhost:$REG_PORT

work=$(mktemp -d)
if command -v cygpath >/dev/null 2>&1; then work=$(cygpath -m "$work"); fi
ROOT="$work/arilla"
SRC="$work/srcrepo"
IMG="$work/img"
mkdir -p "$ROOT" "$IMG"

# grep -q ilk eslesmede cikar; uretici (docker/python) SIGPIPE ile dusup pipefail ile hatali sonuc verebilir.
gq() { grep "$@" >/dev/null; }
failures=0
pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; failures=$((failures + 1)); }
section() { printf '== %s\n' "$1"; }
c() { docker compose --env-file "$ROOT/compose.env" -f "$ROOT/compose.prod.yml" "$@"; }

cleanup() {
  if [ "$failures" -ne 0 ]; then
    echo "== Hata ayiklama: son gunluk satirlari"
    c logs --no-color --tail 25 2>&1 | sed -E 's/(PASSWORD|SECRET|requirepass)[=: ][^ ]+/\1=<gizli>/g'
    ls "$ROOT/logs" 2>/dev/null | tail -3
  fi
  if [ "${KEEP:-0}" != "1" ]; then
    c --profile ops down -v --remove-orphans >/dev/null 2>&1
    docker rm -f arilla-dt-registry >/dev/null 2>&1
    rm -rf "$work"
  else
    echo "KEEP=1: yigin ayakta ($COMPOSE_PROJECT_NAME), dizin: $work"
  fi
}
trap cleanup EXIT

# --- sentetik git deposu: A (iyi), B (kotu web), C (iyi + migration + Caddyfile), D (main disi)
git_s() { git -C "$SRC" -c user.name=deploytest -c user.email=deploytest@example.test "$@"; }

section "1. Hazirlik: sentetik depo, registry, imajlar"
git init -q -b main "$SRC"
mkdir -p "$SRC/infra"
cp "$infra/compose.prod.yml" "$SRC/infra/"
cp -R "$infra/vps" "$SRC/infra/vps"
git_s add -A >/dev/null && git_s commit -q -m A
shaA=$(git_s rev-parse HEAD)
echo "B" >"$SRC/infra/notes-b.txt"
git_s add -A >/dev/null && git_s commit -q -m B
shaB=$(git_s rev-parse HEAD)
printf '\n# deploytest-marker\n' >>"$SRC/infra/vps/Caddyfile"
git_s add -A >/dev/null && git_s commit -q -m C
shaC=$(git_s rev-parse HEAD)
git_s checkout -q -b side "$shaA"
echo "D" >"$SRC/infra/notes-d.txt"
git_s add -A >/dev/null && git_s commit -q -m D
shaD=$(git_s rev-parse HEAD)
git_s checkout -q main
[ "$(git_s rev-parse main)" = "$shaC" ] && pass "depo: A<B<C main'de, D yan dalda" || fail "depo kurulumu"

docker rm -f arilla-dt-registry >/dev/null 2>&1
docker run -d --name arilla-dt-registry -p 127.0.0.1:$REG_PORT:5000 registry:2 >/dev/null || fail "registry baslamadi"

for n in web migrate ingest cron; do
  docker image inspect "ghcr.io/arillasoftorg/arilla-$n:smoke" >/dev/null 2>&1 || { fail "temel imaj yok: arilla-$n:smoke (once infra/vps/bin/smoke-local.sh calistirin: imajlari derler)"; exit 1; }
done

# etiketli sürüm imaji uret + yayinla; digest'i dosyaya yaz
mk_image() { # mk_image <ad> <sha> <mod: normal|bad|migration>
  local name=$1 sha=$2 mode=$3 dir="$IMG/$1-$2"
  mkdir -p "$dir"
  case "$mode" in
    bad)
      printf 'FROM alpine:3.21\nLABEL org.opencontainers.image.revision=%s\nCMD ["sleep","3600"]\n' "$sha" >"$dir/Dockerfile" ;;
    migration)
      printf -- '-- 9999: deploytest noop\nSELECT 1;\n' >"$dir/9999_deploytest_noop.sql"
      printf 'FROM ghcr.io/arillasoftorg/arilla-%s:smoke\nLABEL org.opencontainers.image.revision=%s\nCOPY --chown=node:node 9999_deploytest_noop.sql /app/packages/db/migrations/\n' "$name" "$sha" >"$dir/Dockerfile" ;;
    *)
      printf 'FROM ghcr.io/arillasoftorg/arilla-%s:smoke\nLABEL org.opencontainers.image.revision=%s\n' "$name" "$sha" >"$dir/Dockerfile" ;;
  esac
  docker build -q -t "$REG/arilla-$name:sha-$sha" "$dir" >/dev/null 2>&1 || return 1
  docker push -q "$REG/arilla-$name:sha-$sha" >/dev/null 2>&1 || return 1
  docker inspect --format '{{index .RepoDigests 0}}' "$REG/arilla-$name:sha-$sha" | sed 's/.*@//' >"$IMG/$name-$sha.digest"
}
for sha in $shaA $shaC; do
  for n in web migrate ingest cron; do
    mode=normal
    [ "$n" = migrate ] && [ "$sha" = "$shaC" ] && mode=migration
    mk_image "$n" "$sha" "$mode" || fail "imaj uretilemedi $n $sha"
  done
done
for n in migrate ingest cron; do mk_image "$n" "$shaB" normal || fail "imaj $n B"; done
mk_image web "$shaB" bad || fail "imaj web B (kotu)"

cat >"$IMG/mkmanifest.py" <<'EOF'
import json, sys
sha, out, imgdir, prefix = sys.argv[1:5]
swap = dict(a.split("=") for a in sys.argv[5:])  # ad=baska-sha: o imajin digest'i baska surumden
images = {}
for n in ("web", "migrate", "ingest", "cron"):
    src = swap.get(n, sha)
    digest = open(f"{imgdir}/{n}-{src}.digest").read().strip()
    images[n] = {"image": f"{prefix}arilla-{n}", "tag": f"sha-{sha}", "digest": digest}
json.dump({"sha": sha, "tag": f"sha-{sha}", "complete": True, "created": "2026-01-01T00:00:00Z", "images": images}, open(out, "w"))
EOF
mm() { "$PY" "$IMG/mkmanifest.py" "$@"; }
mm "$shaA" "$work/mA.json" "$IMG" "$REG/"
mm "$shaB" "$work/mB.json" "$IMG" "$REG/"
mm "$shaC" "$work/mC.json" "$IMG" "$REG/"
cp "$work/mA.json" "$work/mD.json"   # D main'de degil: soy agaci kontrolu manifestten ONCE reddeder
mm "$shaA" "$work/mMismatch.json" "$IMG" "$REG/" web=$shaB          # web digest'i B'den, sha A -> etiket uyusmazligi
mm "$shaA" "$work/mForeign.json" "$IMG" "docker.io/yabanci/"
[ -s "$work/mA.json" ] && pass "imajlar $REG registry'sine yayinlandi, manifestler hazir" || fail "manifest uretimi"

section "2. Kok dizin (/opt/arilla benzeri) + temel yigin"
cp "$infra/compose.prod.yml" "$ROOT/"
cp -R "$infra/vps" "$ROOT/vps"
bash "$here/init-secrets.sh" --dir "$ROOT" --domain dt.example.test --tag smoke >/dev/null || fail "init-secrets"
sed -i "s|^ARILLA_SITE_ADDRESS=.*|ARILLA_SITE_ADDRESS=http://:80|" "$ROOT/compose.env"
cat >>"$ROOT/compose.env" <<EOF
CADDY_BIND=127.0.0.1
CADDY_HTTP_PORT=$HTTP_PORT
CADDY_HTTPS_PORT=18453
ARILLA_WWW_ADDRESS=http://www.dt.example.test
ARILLA_CANONICAL_ORIGIN=http://dt.example.test
EOF
export ARILLA_ENV_DIR="$ROOT/env"
export ARILLA_BACKUP_DIR="$ROOT/backup"  # karar 0110: host /opt/arilla/backup kullanilmaz
bash "$here/db-bootstrap.sh" "$ROOT/compose.env" "$ROOT/compose.prod.yml" >"$work/bootstrap.log" 2>&1 && pass "temiz veritabani (db-bootstrap)" || { fail "db-bootstrap"; tail -5 "$work/bootstrap.log"; exit 1; }
c up -d web worker cron caddy >/dev/null 2>&1
for s in web worker cron caddy postgres redis; do
  for _ in $(seq 1 60); do [ "$(c ps --format '{{.Service}}={{.Health}}' | grep "^$s=" | cut -d= -f2)" = healthy ] && break; sleep 3; done
  [ "$(c ps --format '{{.Service}}={{.Health}}' | grep "^$s=" | cut -d= -f2)" = healthy ] || fail "$s healthy degil (temel yigin)"
done
pass "temel yigin healthy (smoke imajlariyla)"

started() { docker inspect -f '{{.State.StartedAt}}' "${COMPOSE_PROJECT_NAME}-$1-1" 2>/dev/null; }
img_of() { docker inspect -f '{{.Config.Image}}' "${COMPOSE_PROJECT_NAME}-$1-1" 2>/dev/null; }
sum_of() { sha256sum "$1" | cut -d' ' -f1; }
pg_started=$(started postgres); redis_started=$(started redis)

run_deploy() { # run_deploy <sha> <manifest> -> cikis kodu; cikti $work/out.log
  env ARILLA_EXTRA_PATH="$PATH" ARILLA_ROOT="$ROOT" ARILLA_REPO_URL="$SRC" ARILLA_IMAGE_PREFIX="$REG/" \
    ARILLA_VERIFY_URL="http://127.0.0.1:$HTTP_PORT" ARILLA_HEALTH_TIMEOUT_WEB=${DT_WEB_TIMEOUT:-150} ARILLA_HEALTH_TIMEOUT=90 \
    bash "$here/arilla-deploy" deploy "$1" <"$2" >"$work/out.log" 2>&1
}
run_cmd() { env ARILLA_EXTRA_PATH="$PATH" ARILLA_ROOT="$ROOT" ARILLA_REPO_URL="$SRC" ARILLA_IMAGE_PREFIX="$REG/" ARILLA_VERIFY_URL="http://127.0.0.1:$HTTP_PORT" \
    ARILLA_HEALTH_TIMEOUT_WEB=${DT_WEB_TIMEOUT:-150} ARILLA_HEALTH_TIMEOUT=90 bash "$here/arilla-deploy" "$@" >"$work/out.log" 2>&1; }

section "3. Guvenlik kapilari (hicbir sey degismemeli)"
env_before=$(sum_of "$ROOT/compose.env"); web_before=$(started web)
run_deploy "$shaD" "$work/mD.json"; rc=$?
[ $rc -eq 2 ] && gq "main dalinda DEGIL" "$work/out.log" && pass "main'de olmayan commit reddedildi (exit 2)" || { fail "main disi commit: rc=$rc"; tail -3 "$work/out.log"; }
run_deploy "$shaA" "$work/mForeign.json"; rc=$?
[ $rc -eq 2 ] && pass "yabanci imaj oneki reddedildi (exit 2)" || fail "yabanci onek: rc=$rc"
run_deploy "$shaA" "$work/mMismatch.json"; rc=$?
[ $rc -eq 2 ] && gq "revision etiketi" "$work/out.log" && pass "revision etiketi sha ile uyusmayan imaj reddedildi (exit 2)" || { fail "etiket uyusmazligi: rc=$rc"; tail -3 "$work/out.log"; }
run_deploy "xyz" "$work/mA.json"; rc=$?
[ $rc -eq 2 ] && pass "gecersiz sha reddedildi" || fail "gecersiz sha: rc=$rc"
printf '{"bozuk": ' >"$work/bad.json"
run_deploy "$shaA" "$work/bad.json"; rc=$?
[ $rc -ne 0 ] && pass "bozuk manifest reddedildi" || fail "bozuk manifest kabul"
[ "$(sum_of "$ROOT/compose.env")" = "$env_before" ] && [ "$(started web)" = "$web_before" ] && pass "reddedilen denemeler compose.env'e ve servislere dokunmadi" || fail "reddedilen deneme bir sey degistirdi"

section "4. Basarili dagitim: A"
run_deploy "$shaA" "$work/mA.json"; rc=$?
if [ $rc -eq 0 ] && gq "^DEPLOY_RESULT=success sha=$shaA" "$work/out.log"; then pass "deploy A basarili"; else fail "deploy A rc=$rc"; tail -15 "$work/out.log"; fi
grep "^DEPLOY_RESULT" "$work/out.log"
[ "$(img_of web)" = "$REG/arilla-web:sha-$shaA@$(cat "$IMG/web-$shaA.digest")" ] && pass "web A digest'ine sabitlendi" || fail "web imaji: $(img_of web)"
[ "$(img_of cron)" = "$REG/arilla-cron:sha-$shaA@$(cat "$IMG/cron-$shaA.digest")" ] && pass "cron A digest'ine sabitlendi" || fail "cron imaji"
"$PY" "$ROOT/vps/bin/release.py" current --dir "$ROOT" | gq "current=$shaA" && pass "releases/current = A" || fail "current pointer"
[ -f "$ROOT/releases/$shaA.infra.tar" ] && pass "altyapi paketi saklandi (manuel geri alma icin)" || fail "infra.tar yok"
[ "$(started postgres)" = "$pg_started" ] && [ "$(started redis)" = "$redis_started" ] && pass "postgres ve redis yeniden baslatilmadi" || fail "postgres/redis yeniden basladi"
[ "$(c exec -T postgres psql -U arilla -d arilla -Atc 'select count(*) from schema_migration' | tr -d '\r')" -ge 58 ] && pass "veritabani verisi korundu (58+ migration)" || fail "schema_migration"

section "5. Basarisiz surum (B: saglik gecmiyor) -> otomatik geri alma"
env_a=$(sum_of "$ROOT/compose.env"); web_img_a=$(img_of web)
run_deploy "$shaB" "$work/mB.json"; rc=$?
[ $rc -eq 1 ] && pass "deploy B basarisiz, cikis kodu 1" || { fail "deploy B rc=$rc (1 beklenir)"; tail -8 "$work/out.log"; }
gq "^DEPLOY_RESULT=failed rollback=ok sha=$shaB" "$work/out.log" && pass "sonuc: failed rollback=ok" || { fail "geri alma sonucu"; grep -E "DEPLOY_RESULT|GERI ALMA" "$work/out.log"; }
[ "$(sum_of "$ROOT/compose.env")" = "$env_a" ] && pass "compose.env geri yuklendi (birebir)" || fail "compose.env geri yuklenmedi"
[ "$(img_of web)" = "$web_img_a" ] && pass "web A imajina geri dondu" || fail "web imaji: $(img_of web)"
[ "$(c ps --format '{{.Service}}={{.Health}}' | grep '^web=' | cut -d= -f2)" = healthy ] && pass "web healthy (geri alma sonrasi)" || fail "web healthy degil"
"$PY" "$ROOT/vps/bin/release.py" current --dir "$ROOT" | gq "current=$shaA" && pass "releases/current hala A" || fail "current pointer degisti"
[ "$(started postgres)" = "$pg_started" ] && [ "$(started redis)" = "$redis_started" ] && pass "postgres/redis geri alma sirasinda da dokunulmadi" || fail "postgres/redis yeniden basladi"
curl -fsS -o /dev/null "http://127.0.0.1:$HTTP_PORT/api/health" && pass "uygulama dis erisimde yanit veriyor" || fail "/api/health"

section "6. Migration + Caddyfile degisimi: C"
run_deploy "$shaC" "$work/mC.json"; rc=$?
if [ $rc -eq 0 ] && gq "^DEPLOY_RESULT=success sha=$shaC" "$work/out.log"; then pass "deploy C basarili"; else fail "deploy C rc=$rc"; tail -15 "$work/out.log"; fi
gq "bekleyen migration: 1 dosya" "$work/out.log" && pass "bekleyen migration tespit edildi (1 dosya)" || fail "migration tespiti"
ls "$ROOT"/backups/pre-migrate-*.dump >/dev/null 2>&1 && pass "migration oncesi pg_dump alindi" || fail "pg_dump yok"
[ "$(c exec -T postgres psql -U arilla -d arilla -Atc "select count(*) from schema_migration where filename='9999_deploytest_noop.sql'" | tr -d '\r')" = 1 ] && pass "migration uygulandi (schema_migration)" || fail "migration uygulanmadi"
gq "changed=.*caddy" "$work/out.log" && pass "Caddy yeniden olusturuldu" || fail "caddy degisimi"
[ "$(c exec -T caddy cat /etc/caddy/Caddyfile | grep -c deploytest-marker)" = 1 ] && pass "Caddy yeni Caddyfile'i goruyor" || fail "Caddyfile eski"
"$PY" "$ROOT/vps/bin/release.py" current --dir "$ROOT" | tr -d '\r' | tr '\n' ' ' | gq "current=$shaC previous=$shaA"
[ "$(started postgres)" = "$pg_started" ] && [ "$(started redis)" = "$redis_started" ] && pass "postgres/redis hala dokunulmadi" || fail "postgres/redis yeniden basladi"

section "7. Tekrar dagitim, kilit, elle geri alma"
run_deploy "$shaC" "$work/mC.json"; rc=$?
{ [ $rc -eq 0 ] && gq "servis degisikligi yok" "$work/out.log" && gq "bekleyen migration yok" "$work/out.log"; } && pass "ayni surumu tekrar dagitmak hicbir sey yapmaz (idempotent)" || { fail "idempotent: rc=$rc"; tail -6 "$work/out.log"; }
if command -v flock >/dev/null 2>&1; then
  exec 8>"$ROOT/.deploy.lock"; flock -n 8
  run_deploy "$shaC" "$work/mC.json"; rc=$?
  exec 8>&-
else
  mkdir "$ROOT/.deploy.lock.d"
  run_deploy "$shaC" "$work/mC.json"; rc=$?
  rmdir "$ROOT/.deploy.lock.d"
fi
[ $rc -eq 2 ] && gq "baska bir dagitim calisiyor" "$work/out.log" && pass "es zamanli dagitim engellendi" || fail "kilit: rc=$rc"
run_cmd rollback; rc=$?
{ [ $rc -eq 0 ] && gq "^DEPLOY_RESULT=success sha=$shaA" "$work/out.log"; } && pass "elle geri alma (A) basarili" || { fail "rollback rc=$rc"; tail -10 "$work/out.log"; }
[ "$(img_of web)" = "$REG/arilla-web:sha-$shaA@$(cat "$IMG/web-$shaA.digest")" ] && pass "web yeniden A digest'inde" || fail "rollback sonrasi web imaji"
run_cmd status; rc=$?
[ $rc -eq 0 ] && gq "web:" "$work/out.log" && pass "status calisiyor" || fail "status"

section "8. deploy-gate izin listesi ve gunlukte sir"
mkdir -p "$work/shim"
printf '#!/bin/sh\nshift\necho "SUDO-CAGRISI: $*"\n' >"$work/shim/sudo"
chmod +x "$work/shim/sudo"
shimdir="$work/shim"; command -v cygpath >/dev/null 2>&1 && shimdir=$(cygpath -u "$work/shim")
gate() { env PATH="$shimdir:$PATH" SSH_ORIGINAL_COMMAND="$1" bash "$here/deploy-gate" 2>&1; }
gate "deploy $shaA" | gq "SUDO-CAGRISI: /opt/arilla/bin/arilla-deploy deploy $shaA" && pass "gate: deploy <sha> iletilir" || fail "gate deploy"
gate "rollback" | gq "arilla-deploy rollback" && pass "gate: rollback iletilir" || fail "gate rollback"
gate "status" | gq "arilla-deploy status" && pass "gate: status iletilir" || fail "gate status"
bad_ok=1
for cmd in "bash" "deploy abc" "deploy $shaA extra" "deploy $shaA; id" 'deploy $(id)' "rollback now" "status && id" "docker ps" "" "deploy ${shaA}0" "DEPLOY $shaA" "cat /etc/shadow" "deploy -$shaA"; do
  out=$(gate "$cmd"); rc=$?
  if [ $rc -ne 126 ] || echo "$out" | gq "SUDO-CAGRISI"; then bad_ok=0; echo "    gecti (olmamali): [$cmd] rc=$rc"; fi
done
[ $bad_ok -eq 1 ] && pass "gate: izin disi 14 komut reddedildi (126), sudo'ya ulasmadi" || fail "gate izin listesi"
leak=0
for key in POSTGRES_PASSWORD APP_DB_PASSWORD REDIS_PASSWORD SESSION_SECRET CRON_SECRET; do
  val=$(grep -h "^$key=" "$ROOT/env/"*.env | head -1 | cut -d= -f2)
  [ -n "$val" ] && grep -rqF -- "$val" "$ROOT/logs" "$work/out.log" 2>/dev/null && { leak=1; echo "    SIZINTI: $key"; }
done
[ $leak -eq 0 ] && pass "dagitim gunluklerinde sir yok" || fail "gunlukte sir"
ls "$ROOT/logs"/deploy-*.log >/dev/null 2>&1 && pass "dagitim gunlukleri yazildi" || fail "gunluk yok"

echo
if [ $failures -eq 0 ]; then echo "TUM DAGITIM TESTLERI GECTI"; else echo "$failures KONTROL BASARISIZ"; fi
exit $((failures > 0))
