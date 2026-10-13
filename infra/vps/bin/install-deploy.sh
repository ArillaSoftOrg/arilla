#!/usr/bin/env bash
# VPS'te BIR KEZ (ve arilla-deploy/deploy-gate guncellendiginde) ROOT olarak calistirilir.
# Dagitim motorunu root-sahipli kurar, deploy kullanicisi icin dar sudoers kuralini yazar.
# Sir icermez, mevcut hicbir env/secret dosyasina, container ya da volume'a dokunmaz.
#
#   sudo infra/vps/bin/install-deploy.sh [--dir /opt/arilla] [--user deploy]
#   (--skip-checks: yalnizca test-ssh-gate.sh icin; arac/docker kontrollerini atlar)
#
# Sonra (elle):
#   1) /home/deploy/.ssh/authorized_keys icine TEK satir (GitHub Actions public anahtari):
#        restrict,command="/opt/arilla/bin/deploy-gate" ssh-ed25519 AAAA... github-actions-deploy
#   2) GHCR girisi (private paketler): sudo docker login ghcr.io -u <kullanici> --password-stdin
#   3) deploy kullanicisini docker grubundan CIKAR (artik gerekmez): sudo gpasswd -d deploy docker
set -euo pipefail

DIR=/opt/arilla
USER_NAME=deploy
SKIP_CHECKS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --user) USER_NAME=$2; shift 2 ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    *) echo "bilinmeyen arguman: $1" >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "root olarak calistirin (sudo)" >&2; exit 1; }
id "$USER_NAME" >/dev/null 2>&1 || { echo "kullanici yok: $USER_NAME" >&2; exit 1; }
command -v visudo >/dev/null || { echo "visudo yok" >&2; exit 1; }
if [ "$SKIP_CHECKS" = 0 ]; then
  for tool in git python3 curl tar; do command -v "$tool" >/dev/null || { echo "$tool gerekli (apt install $tool)" >&2; exit 1; }; done
  docker compose version >/dev/null 2>&1 || { echo "docker compose gerekli" >&2; exit 1; }
fi

here=$(cd "$(dirname "$0")" && pwd)
infra=$(cd "$here/../.." && pwd)

install -d -m 0755 -o root -g root "$DIR/bin"
install -d -m 0700 -o root -g root "$DIR/logs" "$DIR/backups" "$DIR/work" "$DIR/releases"
install -m 0755 -o root -g root "$here/arilla-deploy" "$DIR/bin/arilla-deploy"
# deploy-gate sudo yolunu sabit tasir; --dir farkliysa uyarla
gate=$(mktemp)
sed -e "s#/opt/arilla#$DIR#g" "$here/deploy-gate" >"$gate"
install -m 0755 -o root -g root "$gate" "$DIR/bin/deploy-gate"
rm -f "$gate"

# sudoers: /opt/arilla yolu ve kullanici adi sablondan uyarlanir, visudo ile dogrulanir
tmp=$(mktemp)
sed -e "s#/opt/arilla#$DIR#g" -e "s#^Defaults:deploy#Defaults:$USER_NAME#; s#^deploy ALL#$USER_NAME ALL#" \
  "$infra/vps/sudoers/arilla-deploy" >"$tmp"
visudo -cf "$tmp" >/dev/null || { echo "sudoers kurali gecersiz, kurulmadi" >&2; rm -f "$tmp"; exit 1; }
install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/arilla-deploy
rm -f "$tmp"
visudo -c >/dev/null

echo "Kuruldu:"
ls -l "$DIR/bin"
echo
echo "Sonraki adimlar (elle): authorized_keys satiri, 'docker login ghcr.io' (root), deploy kullanicisini docker grubundan cikarma."
