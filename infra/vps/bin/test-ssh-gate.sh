#!/usr/bin/env bash
# VPS tarafi yetki zincirinin GERCEK sshd + sudo ile testi (tek kullanimlik Ubuntu 24.04 konteyneri;
# gercek VPS'e dokunmaz): install-deploy.sh -> sudoers -> authorized_keys `restrict,command=` ->
# deploy-gate -> sudo -> (sahte) arilla-deploy.
#
#   infra/vps/bin/test-ssh-gate.sh
#
# Dogrulananlar: izin verilen 3 komut kok yetkisiyle ve dogru argumanlarla ulasir (manifest stdin dahil);
# her baska komut/kabuk/yonlendirme/pty reddedilir; deploy kullanicisi baska hicbir sudo yapamaz,
# docker grubunda degildir, motoru ve kapiyi DEGISTIREMEZ; sudoers visudo ile gecerli.
set -uo pipefail
export MSYS_NO_PATHCONV=1

here=$(cd "$(dirname "$0")" && pwd)
infra=$(cd "$here/../.." && pwd)
if command -v cygpath >/dev/null 2>&1; then here=$(cygpath -m "$here"); infra=$(cygpath -m "$infra"); fi

work=$(mktemp -d)
if command -v cygpath >/dev/null 2>&1; then work=$(cygpath -m "$work"); fi
NAME=arilla-gate-test
PORT=${GATE_TEST_PORT:-2223}
failures=0
pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; failures=$((failures + 1)); }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$work"; }
trap cleanup EXIT

SHA=$(printf '%040d' 0 | tr '0' 'a')

echo "== Hazirlik: anahtar + imaj"
ssh-keygen -q -t ed25519 -N "" -C github-actions-test -f "$work/id" >/dev/null || { fail "ssh-keygen"; exit 1; }
mkdir -p "$work/ctx/infra"
cp -R "$infra/vps" "$work/ctx/infra/vps"
# Gercek motor yerine SAHTE arilla-deploy: argumanlari, uid'i ve stdin bayt sayisini yazar.
cat >"$work/ctx/infra/vps/bin/arilla-deploy" <<'EOF'
#!/bin/sh
echo "STUB args=$*"
echo "STUB uid=$(id -u)"
if [ "$1" = deploy ]; then echo "STUB stdin_bytes=$(wc -c)"; fi
EOF
cp "$work/id.pub" "$work/ctx/id.pub"
cat >"$work/ctx/Dockerfile" <<'EOF'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server sudo ca-certificates >/dev/null \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash deploy && passwd -l deploy \
    && mkdir -p /run/sshd /home/deploy/.ssh && ssh-keygen -A >/dev/null
COPY infra /src/infra
RUN chmod +x /src/infra/vps/bin/* && /src/infra/vps/bin/install-deploy.sh --skip-checks >/dev/null
COPY id.pub /tmp/id.pub
RUN printf 'restrict,command="/opt/arilla/bin/deploy-gate" %s\n' "$(cat /tmp/id.pub)" > /home/deploy/.ssh/authorized_keys \
    && chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys \
    && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers deploy\n' > /etc/ssh/sshd_config.d/10-test.conf
CMD ["/usr/sbin/sshd", "-D", "-e"]
EOF
docker build -q -t "$NAME" "$work/ctx" >"$work/build.log" 2>&1 && pass "imaj: ubuntu 24.04 + sshd + sudo + install-deploy.sh (--skip-checks)" || { fail "imaj derlemesi"; tail -10 "$work/build.log"; exit 1; }
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p 127.0.0.1:$PORT:22 "$NAME" >/dev/null || { fail "konteyner"; exit 1; }
for _ in $(seq 1 30); do
  (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break
  sleep 1
done

S() { ssh -T -i "$work/id" -p $PORT -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 deploy@127.0.0.1 "$@"; }
D() { docker exec "$NAME" "$@"; }

echo "== Kurulum cikti kontrolleri"
D visudo -c >/dev/null 2>&1 && pass "sudoers gecerli (visudo -c)" || fail "visudo"
[ "$(D stat -c '%U:%G:%a' /opt/arilla/bin/arilla-deploy)" = "root:root:755" ] && pass "arilla-deploy root:root 755" || fail "arilla-deploy sahipligi"
[ "$(D stat -c '%U:%G:%a' /opt/arilla/bin/deploy-gate)" = "root:root:755" ] && pass "deploy-gate root:root 755" || fail "deploy-gate sahipligi"
[ "$(D stat -c '%U:%G:%a' /etc/sudoers.d/arilla-deploy)" = "root:root:440" ] && pass "sudoers dosyasi root:root 440" || fail "sudoers dosyasi"
[ "$(D stat -c '%a' /opt/arilla/backups)" = "700" ] && pass "backups/ logs/ work/ releases/ yalniz root (700)" || fail "dizin izinleri"
D id -nG deploy | grep -qw docker && fail "deploy docker grubunda" || pass "deploy docker grubunda DEGIL"

echo "== SSH uzerinden izin verilen komutlar"
out=$(printf '{"manifest":"x"}' | S "deploy $SHA" 2>&1)
echo "$out" | grep -q "STUB args=deploy $SHA" && echo "$out" | grep -q "STUB uid=0" && echo "$out" | grep -q "STUB stdin_bytes=16" \
  && pass "deploy <sha>: kok yetkisiyle, dogru argumanla, manifest stdin'den (16 bayt) ulasti" || { fail "deploy komutu: $out"; }
out=$(S "status" 2>&1)
echo "$out" | grep -q "STUB args=status" && echo "$out" | grep -q "STUB uid=0" && pass "status" || fail "status: $out"
out=$(S "rollback" 2>&1)
echo "$out" | grep -q "STUB args=rollback" && pass "rollback" || fail "rollback: $out"

echo "== SSH uzerinden izin verilmeyenler (126, kok komutu yok)"
bad_ok=1
for cmd in "bash" "id" "cat /etc/shadow" "deploy abc" "deploy $SHA extra" "deploy $SHA; id" 'deploy $(id)' "rollback now" "status && id" "sudo -n bash" "sh -c id" "scp -t /tmp" "DEPLOY $SHA" "arilla-deploy deploy $SHA" "/opt/arilla/bin/arilla-deploy deploy $SHA"; do
  out=$(S "$cmd" 2>&1); rc=$?
  if [ $rc -ne 126 ] || echo "$out" | grep -q "STUB"; then bad_ok=0; echo "    gecti (olmamali): [$cmd] rc=$rc $out"; fi
done
[ $bad_ok -eq 1 ] && pass "15 izin disi komut reddedildi (126) ve motora ulasmadi" || fail "izin listesi"
out=$(S 2>&1); rc=$?
[ $rc -eq 126 ] && pass "komutsuz (etkilesimli kabuk) oturum reddedildi" || fail "komutsuz oturum rc=$rc: $out"
out=$(ssh -t -t -i "$work/id" -p $PORT -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR deploy@127.0.0.1 status 2>&1 </dev/null)
echo "$out" | grep -qi "PTY allocation request failed" && pass "pty istegi reddedildi (restrict)" || fail "pty verildi: $out"
out=$(ssh -W 127.0.0.1:22 -i "$work/id" -p $PORT -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 deploy@127.0.0.1 2>&1 </dev/null)
echo "$out" | grep -qi "administratively prohibited\|open failed\|stdio forwarding failed" && pass "port/stdio yonlendirme (restrict) reddedildi" || fail "yonlendirme reddedilmedi: $out"

echo "== deploy kullanicisinin yetkisi (konteyner icinden, sudo kurali)"
sudo_as() { docker exec -u deploy "$NAME" sudo -n "$@" 2>&1; }
out=$(sudo_as /opt/arilla/bin/arilla-deploy status </dev/null); [[ "$out" == *"STUB args=status"* ]] && pass "sudo arilla-deploy status calisir" || fail "sudo status: $out"
sudo_as /opt/arilla/bin/arilla-deploy deploy "$SHA" </dev/null | grep -q "STUB args=deploy $SHA" && pass "sudo arilla-deploy deploy <40 hane> calisir" || fail "sudo deploy"
denied=1
for args in "bash" "id" "/bin/sh -c id" "/opt/arilla/bin/arilla-deploy deploy abc" "/opt/arilla/bin/arilla-deploy deploy ${SHA}0" "/opt/arilla/bin/arilla-deploy deploy $SHA extra" "/opt/arilla/bin/arilla-deploy rollback now" "/opt/arilla/bin/arilla-deploy" "/opt/arilla/bin/deploy-gate" "cat /etc/shadow" "-l"; do
  # shellcheck disable=SC2086
  out=$(docker exec -u deploy "$NAME" sudo -n $args 2>&1 </dev/null)
  if echo "$out" | grep -q "STUB"; then denied=0; echo "    sudo izin verdi (olmamali): $args"; fi
  if echo "$out" | grep -q "^uid=0"; then denied=0; echo "    root kabugu (olmamali): $args"; fi
done
[ $denied -eq 1 ] && pass "sudo: izin listesi disi 11 komut kok olarak calismadi" || fail "sudo kurali fazla genis"
D su deploy -c 'echo x >> /opt/arilla/bin/arilla-deploy' 2>/dev/null && fail "deploy motoru DEGISTIREBILIYOR" || pass "deploy kullanicisi arilla-deploy'u degistiremez"
D su deploy -c 'echo x >> /opt/arilla/bin/deploy-gate' 2>/dev/null && fail "deploy kapiyi DEGISTIREBILIYOR" || pass "deploy kullanicisi deploy-gate'i degistiremez"
D su deploy -c 'echo x >> /etc/sudoers.d/arilla-deploy' 2>/dev/null && fail "deploy sudoers'i DEGISTIREBILIYOR" || pass "deploy kullanicisi sudoers'i degistiremez"
D su deploy -c 'ls /opt/arilla/backups' >/dev/null 2>&1 && fail "deploy yedekleri okuyabiliyor" || pass "deploy kullanicisi backups/ okuyamaz"
D su deploy -c 'docker ps' >/dev/null 2>&1 && fail "deploy docker kullanabiliyor" || pass "deploy docker kullanamaz"

echo
if [ $failures -eq 0 ]; then echo "TUM SSH/SUDO KAPI TESTLERI GECTI"; else echo "$failures KONTROL BASARISIZ"; fi
exit $((failures > 0))
