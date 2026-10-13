#!/usr/bin/env bash
# Uretim Compose yiginin YEREL duman testi (VPS'e dokunmaz, uretim verisine
# baglanmaz). Atilabilir bir proje (arilla-smoke), gecici dizinde uretilen
# rastgele sirlar ve yalniz 127.0.0.1'e baglanan Caddy portlariyla calisir.
# Bitince her sey silinir (volume'lar dahil).
#
#   infra/vps/bin/smoke-local.sh            # imajlari derler, test eder
#   SKIP_BUILD=1 infra/vps/bin/smoke-local.sh   # imajlar zaten derlenmisse
#   KEEP=1 ...                              # sonunda yigini AYAKTA birakir
#
# Gereksinim: docker compose, node, curl, openssl.
set -uo pipefail
# Git Bash (Windows) /etc/... gibi arguman yollarini bozmasin; Linux/CI icin zararsiz.
export MSYS_NO_PATHCONV=1

here=$(cd "$(dirname "$0")" && pwd)
infra=$(cd "$here/../.." && pwd)
repo=$(cd "$infra/.." && pwd)
# Git Bash (Windows): Windows docker/node icin karisik (C:/...) yol gerekir.
if command -v cygpath >/dev/null 2>&1; then
  infra=$(cygpath -m "$infra")
  repo=$(cygpath -m "$repo")
  here=$(cygpath -m "$here")
fi
COMPOSE_FILE="$infra/compose.prod.yml"

export COMPOSE_PROJECT_NAME=arilla-smoke
export ARILLA_TAG=smoke
export ARILLA_BUILD_APP_URL=https://smoke.example.test
export ARILLA_SITE_ADDRESS="http://:80"
export CADDY_BIND=127.0.0.1
export CADDY_HTTP_PORT=${SMOKE_HTTP_PORT:-18080}
export CADDY_HTTPS_PORT=${SMOKE_HTTPS_PORT:-18443}
BASE="http://127.0.0.1:${CADDY_HTTP_PORT}"

work=$(mktemp -d)
if command -v cygpath >/dev/null 2>&1; then work=$(cygpath -m "$work"); fi
export ARILLA_ENV_DIR="$work/env"
ENV_FILE="$work/compose.env"

failures=0
pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; failures=$((failures + 1)); }
check() { # check <aciklama> <komut...>
  local desc=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi
}
c() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }

cleanup() {
  if [ "$failures" -ne 0 ]; then
    echo "== Hata ayiklama: son gunluk satirlari"
    c logs --no-color --tail 40 2>&1 | sed -E 's/(PASSWORD|SECRET|requirepass)[=: ][^ ]+/=<gizli>/g'
  fi
  if [ "${KEEP:-0}" != "1" ]; then
    c --profile ops down -v --remove-orphans >/dev/null 2>&1
    rm -rf "$work"
  else
    echo "KEEP=1: yigin ayakta ($COMPOSE_PROJECT_NAME), dizin: $work"
  fi
}
trap cleanup EXIT

echo "== 0. Surum yonetimi (release.py) ve digest'li imaj referanslari"
PY=python3; command -v python3 >/dev/null 2>&1 && python3 -c '' >/dev/null 2>&1 || PY=python
(cd "$here" && PYTHONIOENCODING=utf-8 "$PY" test_release.py >"$work/release-test.log" 2>&1) && pass "release.py testleri" || { fail "release.py testleri"; tail -15 "$work/release-test.log"; }

echo "== 1. Sablon ve ag dogrulamasi (sirlar yazdirilmaz)"
"$here/init-secrets.sh" --dir "$work" --domain smoke.example.test --tag smoke >/dev/null || fail "init-secrets"
sed -i "s|^ARILLA_SITE_ADDRESS=.*|ARILLA_SITE_ADDRESS=http://:80|" "$ENV_FILE"
check "compose config gecerli" c --profile ops config -q
# release.py -> compose.env -> imaj referansi: etiket + digest birlikte cozulur
mf="$work/manifest.json"
"$PY" - "$mf" <<'MANIFEST'
import json, sys
sha = "c" * 40
names = ["web", "migrate", "ingest", "cron"]
json.dump({"sha": sha, "tag": f"sha-{sha}", "complete": True, "images": {
    n: {"image": f"ghcr.io/arillasoftorg/arilla-{n}", "tag": f"sha-{sha}", "digest": "sha256:" + str(i) * 64}
    for i, n in enumerate(names, 1)}}, open(sys.argv[1], "w"))
MANIFEST
cp "$ENV_FILE" "$work/compose.env.backup"
"$PY" "$here/release.py" apply "$mf" --dir "$work" >/dev/null && pass "release.py apply" || fail "release.py apply"
# Surec ortami --env-file'a ustundur; testte export edilen ARILLA_TAG'i kaldirip dosyadakini sinariz.
resolved=$(env -u ARILLA_TAG docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile ops config --format json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).services;console.log(["web","worker","cron","migrate"].map(n=>c[n].image).join(" "))})')
echo "$resolved" | grep -q "arilla-web:sha-cccccccccccccccccccccccccccccccccccccccc@sha256:1111" && echo "$resolved" | grep -q "arilla-cron:sha-cccccccccccccccccccccccccccccccccccccccc@sha256:4444" && pass "imajlar etiket@digest ile cozuluyor" || fail "imaj referansi: $resolved"
"$PY" "$here/release.py" current --dir "$work" | grep -q "current=cccc" && pass "release.py current" || fail "release.py current"
cp "$work/compose.env.backup" "$ENV_FILE"; rm -rf "$work/releases"
cfg=$(c --profile ops config --format json 2>/dev/null | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const c=JSON.parse(s),svc=c.services,out=[];
    const pub=n=>(svc[n].ports||[]).length;
    out.push("pg_ports="+pub("postgres"),"redis_ports="+pub("redis"),"web_ports="+pub("web"),"worker_ports="+pub("worker"),"cron_ports="+pub("cron"),"caddy_ports="+pub("caddy"));
    out.push("data_internal="+c.networks.data.internal,"edge_internal="+c.networks.edge.internal,"egress_internal="+(c.networks.egress.internal||false));
    out.push("pg_nets="+Object.keys(svc.postgres.networks).join("+"),"redis_nets="+Object.keys(svc.redis.networks).join("+"),"cron_nets="+Object.keys(svc.cron.networks).join("+"));
    out.push("owner_in_web="+(Object.keys(svc.web.environment).some(k=>k==="DATABASE_URL_OWNER")),"owner_in_cron="+(Object.keys(svc.cron.environment).some(k=>k==="DATABASE_URL_OWNER")));
    console.log(out.join("\n"));
  });' 2>/dev/null)
echo "$cfg" | grep -q '^pg_ports=0$' && pass "postgres port yayinlamaz" || fail "postgres port yayinliyor"
echo "$cfg" | grep -q '^redis_ports=0$' && pass "redis port yayinlamaz" || fail "redis port yayinliyor"
echo "$cfg" | grep -q '^web_ports=0$' && echo "$cfg" | grep -q '^worker_ports=0$' && echo "$cfg" | grep -q '^cron_ports=0$' && pass "web/worker/cron port yayinlamaz" || fail "web/worker/cron port yayinliyor"
echo "$cfg" | grep -q '^data_internal=true$' && echo "$cfg" | grep -q '^edge_internal=true$' && pass "data ve edge aglari internal" || fail "data/edge internal degil"
echo "$cfg" | grep -q '^pg_nets=data$' && echo "$cfg" | grep -q '^redis_nets=data$' && pass "postgres ve redis yalniz data aginda" || fail "postgres/redis baska aga bagli"
echo "$cfg" | grep -q '^cron_nets=data$' && pass "cron yalniz data aginda" || fail "cron baska aga bagli"
echo "$cfg" | grep -q '^owner_in_web=false$' && echo "$cfg" | grep -q '^owner_in_cron=false$' && pass "sahip kimligi web/cron'da yok" || fail "sahip kimligi web/cron'da"

# Tum cron/vercel esitligi: apps/web/vercel.json <-> infra/vps/cron/crontab
node -e '
  const v=require(process.argv[1]+"/apps/web/vercel.json").crons;
  const t=require("fs").readFileSync(process.argv[1]+"/infra/vps/cron/crontab","utf8").split("\n")
    .filter(l=>l&&!l.startsWith("#")).map(l=>l.trim().split(/\s+/));
  const have=new Map(t.map(a=>[a[a.length-1],a.slice(0,5).join(" ")]));
  const bad=v.filter(c=>have.get(c.path.replace("/api/cron/",""))!==c.schedule);
  const extra=["trigger-alerts","marketing-campaigns"].filter(j=>have.get(j)!=="*/15 * * * *");
  if(bad.length||extra.length){console.error("farkli:",JSON.stringify(bad),extra);process.exit(1)}' "$repo" \
  && pass "crontab = vercel.json (4 is) + 2 x 15 dk is" || fail "crontab vercel.json ile uyusmuyor"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== 2. Imajlar derleniyor (web, migrate, ingest, cron)"
  c --profile ops build >/dev/null 2>&1 && pass "imajlar derlendi" || { fail "imaj derlemesi"; exit 1; }
fi

echo "== 3. Temiz veritabani: migration zinciri"
if "$here/db-bootstrap.sh" "$ENV_FILE" "$COMPOSE_FILE" >"$work/bootstrap.log" 2>&1; then
  pass "db-bootstrap (migrate, rol, bolum, verify-schema)"
  grep -E "migration uygulandi" "$work/bootstrap.log" | head -1
else
  fail "db-bootstrap"; tail -20 "$work/bootstrap.log"; exit 1
fi

echo "== 4. Yigin ayaga kaldiriliyor"
c up -d >/dev/null 2>&1 || { fail "compose up"; exit 1; }
for _ in $(seq 1 60); do
  unhealthy=$(c ps --format '{{.Service}}={{.Health}}' 2>/dev/null | grep -v '=healthy' | grep -v '^migrate=' || true)
  [ -z "$unhealthy" ] && break
  sleep 3
done
for s in postgres redis web worker cron caddy; do
  st=$(c ps --format '{{.Service}}={{.Health}}' | grep "^$s=" | cut -d= -f2)
  [ "$st" = "healthy" ] && pass "$s healthy" || fail "$s healthy degil ($st)"
done

echo "== 5. Caddy yonlendirmesi ve dis erisim kapilari"
[ "$(code "$BASE/api/health")" = "200" ] && pass "/api/health -> 200 (disaridan)" || fail "/api/health"
[ "$(code "$BASE/")" = "200" ] && pass "/ -> 200" || fail "/"
for p in /api/health/ready /api/health/ready/ //api/health/ready /API/HEALTH/READY /api/health/%72eady /api/health/./ready "/api/health/ready?x=1" /api/cron/cleanup-auth /api/cron/trigger-alerts/ /api/cron/%63leanup-auth; do
  r=$(code --path-as-is "$BASE$p")
  [ "$r" = "404" ] && pass "$p -> 404" || fail "$p -> $r (404 beklenir)"
done
r=$(code -H "Authorization: Bearer $(grep '^CRON_SECRET=' "$work/env/cron.env" | cut -d= -f2)" "$BASE/api/cron/cleanup-auth")
[ "$r" = "404" ] && pass "gecerli CRON_SECRET ile bile /api/cron dis erisimde 404" || fail "/api/cron dis erisimde $r"
head -c 1048576 /dev/zero >"$work/1mb.bin"; head -c 5800000 /dev/zero >"$work/5_8mb.bin"; head -c 7340032 /dev/zero >"$work/7mb.bin"
# /api/email/unsubscribe govdeyi OKUR (POST); Caddy limiti okuma sirasinda uygular.
big() { code -X POST -H 'Content-Type: application/octet-stream' --data-binary @"$work/$1" "$BASE/api/email/unsubscribe"; }
r=$(big 1mb.bin); [ "$r" != "413" ] && [ "$r" != "502" ] && pass "1 MB govde reddedilmez ($r)" || fail "1 MB govde -> $r"
r=$(big 5_8mb.bin); [ "$r" != "413" ] && [ "$r" != "502" ] && pass "5.8 MB govde sinir icinde ($r)" || fail "5.8 MB govde -> $r"
r=$(big 7mb.bin); [ "$r" = "413" ] && pass "7 MB govde -> 413 (limit 6 MB)" || fail "7 MB govde -> $r (413 beklenir)"

echo "== 6. Ic baglantilar ve hazirlik"
ready=$(c exec -T web node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(async r=>{console.log(r.status,await r.text())})" 2>/dev/null)
echo "$ready" | grep -q '^200 {"status":"ready","checks":{"database":"ok","redis":"ok"}}' && pass "ic ag /api/health/ready -> 200 (database ok, redis ok)" || fail "ready: $ready"
check "worker kuyruga baglandi (log)" bash -c "docker logs ${COMPOSE_PROJECT_NAME}-worker-1 2>&1 | grep -q 'worker basladi'"

echo "== 7. PostgreSQL"
q() { c exec -T postgres psql -U arilla -d arilla -Atqc "$1" 2>/dev/null; }
[ "$(q 'show shared_buffers')" = "2GB" ] && pass "shared_buffers=2GB" || fail "shared_buffers"
[ "$(q 'show max_connections')" = "60" ] && pass "max_connections=60" || fail "max_connections"
[ "$(q 'show password_encryption')" = "scram-sha-256" ] && pass "scram-sha-256" || fail "password_encryption"
[ "$(q 'show data_checksums')" = "on" ] && pass "data_checksums=on" || fail "data_checksums"
[ "$(q 'show timezone')" = "UTC" ] && pass "timezone=UTC" || fail "timezone"
[ "$(q "select string_agg(extname,',' order by extname) from pg_extension where extname in ('vector','pg_trgm','uuid-ossp')")" = "pg_trgm,uuid-ossp,vector" ] && pass "vector, pg_trgm, uuid-ossp" || fail "extension"
[ "$(q 'select count(*) from schema_migration')" -ge 58 ] && pass "schema_migration >= 58" || fail "schema_migration"
[ "$(q "select rolsuper from pg_roles where rolname='arilla_app'")" = "f" ] && pass "arilla_app superuser degil" || fail "arilla_app"
col=$(q "select column_name from information_schema.columns where table_name='price_point' order by ordinal_position limit 1")
upd=$(c exec -T -e PGPASSWORD="$(grep '^APP_DB_PASSWORD=' "$work/env/migrate.env" | cut -d= -f2)" postgres psql -h 127.0.0.1 -U arilla_app -d arilla -Atqc "update price_point set $col=$col where false" 2>&1 | head -1)
echo "$upd" | grep -qi "permission denied" && pass "arilla_app price_point UPDATE yetkisiz (kural 4)" || fail "price_point UPDATE: $upd"

echo "== 8. Redis"
[ "$(c exec -T -e REDISCLI_AUTH= redis redis-cli ping 2>&1 | head -1 | tr -d '\r')" != "PONG" ] && pass "parolasiz istek reddedilir" || fail "redis parolasiz erisim"
r() { c exec -T redis redis-cli "$@" 2>/dev/null | tr -d '\r'; }
[ "$(r ping)" = "PONG" ] && pass "parola ile PONG" || fail "redis ping"
[ "$(r config get appendonly | tail -1)" = "yes" ] && pass "appendonly yes" || fail "appendonly"
[ "$(r config get maxmemory-policy | tail -1)" = "noeviction" ] && pass "maxmemory-policy noeviction" || fail "maxmemory-policy"
[ "$(r config get maxmemory | tail -1)" = "536870912" ] && pass "maxmemory 512mb" || fail "maxmemory"
r config get requirepass 2>&1 | grep -q . && true
check "redis ayarlari argv'de parola icermez" bash -c "! docker top ${COMPOSE_PROJECT_NAME}-redis-1 | grep -q \"$(grep '^REDIS_PASSWORD=' "$work/env/redis.env" | cut -d= -f2)\""

echo "== 9. Ag yalitimi"
check "postgres internete cikamaz" bash -c "! docker exec ${COMPOSE_PROJECT_NAME}-postgres-1 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>/dev/null"
check "redis internete cikamaz" bash -c "! docker exec ${COMPOSE_PROJECT_NAME}-redis-1 nc -w 3 1.1.1.1 53 2>/dev/null"
check "cron internete cikamaz" bash -c "! docker exec ${COMPOSE_PROJECT_NAME}-cron-1 curl -sS --max-time 4 https://example.com 2>/dev/null"
check "web egress ile internete cikabilir" bash -c "docker exec ${COMPOSE_PROJECT_NAME}-web-1 node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))\""
for svc in postgres redis web worker cron; do
  ports=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${COMPOSE_PROJECT_NAME}-${svc}-1" 2>/dev/null)
  echo "$ports" | grep -q HostPort && fail "$svc host portu yayinliyor: $ports" || pass "$svc host portu yayinlamaz"
done
echo "(yayinlanan: $(docker ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" --format '{{.Names}}={{.Ports}}' | grep -- '->' | tr '
' ' '))"

echo "== 10. Cron"
check "supercronic crontab'i gecerli" c exec -T cron supercronic -test /etc/arilla/crontab
for j in generate-discovery-slots interpret-queries refresh-product-aggregates cleanup-auth trigger-alerts marketing-campaigns; do
  out=$(c exec -T cron cron-call "$j" 2>&1); rc=$?
  [ $rc -eq 0 ] && pass "cron-call $j -> $out" || fail "cron-call $j rc=$rc ($out)"
done
c exec -T -e CRON_SECRET=yanlis-yanlis-yanlis cron cron-call cleanup-auth >/dev/null 2>&1; [ $? -eq 1 ] && pass "yanlis CRON_SECRET -> basarisiz (exit 1)" || fail "yanlis secret kabul edildi"
c exec -T cron cron-call ../../etc/passwd >/dev/null 2>&1; [ $? -eq 64 ] && pass "bilinmeyen is adi reddedilir (exit 64)" || fail "yol enjeksiyonu"
jobs=$(q "select count(distinct job) from job_run")
[ "${jobs:-0}" -ge 4 ] && pass "job_run kayitlari yazildi ($jobs farkli is)" || fail "job_run ($jobs)"

echo "== 11. Gunluk ve sizinti"
curl -s -o /dev/null -H 'Cookie: session=gizli-cerez-degeri' -H 'X-Forwarded-For: 203.0.113.9' "$BASE/api/health?q=gizli-sorgu-metni&token=gizli-token"
sleep 1
caddy_log=$(docker logs ${COMPOSE_PROJECT_NAME}-caddy-1 2>&1)
echo "$caddy_log" | grep -q '"/api/health"' && pass "erisim kaydi yol iceriyor" || fail "erisim kaydinda yol yok"
echo "$caddy_log" | grep -qE 'gizli-sorgu-metni|gizli-token|gizli-cerez-degeri|203\.0\.113\.9|172\.[0-9]+\.[0-9]+\.[0-9]+"' && fail "erisim kaydinda sorgu/cerez/IP var" || pass "erisim kaydinda sorgu, cerez, IP yok"
leak=0
for key in POSTGRES_PASSWORD APP_DB_PASSWORD REDIS_PASSWORD SESSION_SECRET CRON_SECRET; do
  val=$(grep -h "^$key=" "$work/env/"*.env 2>/dev/null | head -1 | cut -d= -f2)
  [ -z "$val" ] && continue
  for img in web ingest cron migrate; do
    docker image inspect "ghcr.io/arillasoftorg/arilla-$img:smoke" 2>/dev/null | grep -q "$val" && { leak=1; echo "    SIZINTI: $key -> arilla-$img"; }
  done
done
[ $leak -eq 0 ] && pass "imaj metaverisinde (ENV/History/Config) uretilmis sir yok" || fail "imajda sir"
"$here/verify-image.sh" ghcr.io/arillasoftorg/arilla-web:smoke ghcr.io/arillasoftorg/arilla-migrate:smoke ghcr.io/arillasoftorg/arilla-ingest:smoke ghcr.io/arillasoftorg/arilla-cron:smoke >"$work/verify-image.log" 2>&1 && pass "verify-image.sh: dort imajda sir/kimlik dosyasi yok, root degil" || { fail "verify-image.sh"; grep -E "FAIL" "$work/verify-image.log"; }
git -C "$repo" ls-files --error-unmatch infra/vps/env/web.env >/dev/null 2>&1 && fail "web.env depoda izleniyor" || pass "gercek env dosyalari depoda izlenmiyor"
check "ortam dosyalari 0640" bash -c "[ \"\$(stat -c %a '$work/env/web.env' 2>/dev/null || stat -f %Lp '$work/env/web.env')\" = 640 ] || [ -n \"\${MSYSTEM:-}\" ]"

echo
if [ $failures -eq 0 ]; then echo "TUM KONTROLLER GECTI"; else echo "$failures KONTROL BASARISIZ"; fi
exit $((failures > 0))
