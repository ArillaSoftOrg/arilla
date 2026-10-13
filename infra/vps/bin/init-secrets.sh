#!/usr/bin/env bash
# VPS'te (ya da yerel testte) ortam dosyalarini ve rastgele sirlari URETIR.
# Depoya sir girmez: ciktilar --dir altina yazilir (varsayilan /opt/arilla).
#
#   sudo infra/vps/bin/init-secrets.sh --domain alan-adi.com [--dir /opt/arilla] [--tag local]
#
# - Var olan dosyanin USTUNE YAZMAZ (parola donusumu veri kaybettirir); sifirdan
#   baslatmak icin dosyayi elle sil.
# - Dosya modu 0640, dizin 0750; root ile calisiyorsa ve `deploy` grubu varsa
#   grup `deploy` olur (compose'u deploy kullanicisi calistirir).
# - Uretilen sirlar ekrana YAZILMAZ.
set -euo pipefail

DIR=/opt/arilla
DOMAIN=
TAG=latest
SCHEME=https
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --tag) TAG=$2; shift 2 ;;
    --scheme) SCHEME=$2; shift 2 ;; # yalniz yerel test (http); uretimde https
    *) echo "bilinmeyen arguman: $1" >&2; exit 64 ;;
  esac
done
[ -n "$DOMAIN" ] || { echo "--domain gerekli (orn. alan-adi.com)" >&2; exit 64; }

here=$(cd "$(dirname "$0")/.." && pwd)
ENV_DIR="$DIR/env"
rand() { openssl rand -hex "${1:-24}"; }

umask 027
mkdir -p "$ENV_DIR"
chmod 0750 "$DIR" "$ENV_DIR"

POSTGRES_PASSWORD=$(rand 24)
APP_DB_PASSWORD=$(rand 24)
REDIS_PASSWORD=$(rand 24)
SESSION_SECRET=$(rand 32)
CRON_SECRET=$(rand 24)

render() { # render <sablon> <hedef>
  local src=$1 dst=$2
  if [ -e "$dst" ]; then
    echo "atlandi (var): $dst"
    return
  fi
  sed \
    -e "s|@@APP_URL@@|${SCHEME}://${DOMAIN}|g" \
    -e "s|@@DOMAIN@@|${DOMAIN}|g" \
    -e "s|@@ENV_DIR@@|${ENV_DIR}|g" \
    -e "s|@@TAG@@|${TAG}|g" \
    -e "s|@@POSTGRES_PASSWORD@@|${POSTGRES_PASSWORD}|g" \
    -e "s|@@APP_DB_PASSWORD@@|${APP_DB_PASSWORD}|g" \
    -e "s|@@REDIS_PASSWORD@@|${REDIS_PASSWORD}|g" \
    -e "s|@@SESSION_SECRET@@|${SESSION_SECRET}|g" \
    -e "s|@@CRON_SECRET@@|${CRON_SECRET}|g" \
    "$src" >"$dst"
  chmod 0640 "$dst"
  echo "yazildi: $dst"
}

# Parolalar dosyalar arasinda TUTARLI olmali; biri zaten varsa kalanlar
# yeni parolalarla yazilirsa uyumsuz olur. Hepsi ya hep ya hic.
existing=0
for n in web worker cron migrate postgres redis; do [ -e "$ENV_DIR/$n.env" ] && existing=$((existing + 1)); done
if [ "$existing" -ne 0 ] && [ "$existing" -ne 6 ]; then
  echo "HATA: ortam dosyalari kismen var ($existing/6). Tutarsiz parola riski: hepsini sil ya da hepsini koru." >&2
  exit 1
fi

for n in web worker cron migrate postgres redis; do render "$here/env/$n.env.example" "$ENV_DIR/$n.env"; done
render "$here/env/compose.env.example" "$DIR/compose.env"

if [ "$(id -u)" -eq 0 ] && getent group deploy >/dev/null 2>&1; then
  chgrp -R deploy "$DIR" 2>/dev/null || true
fi
echo
echo "Tamam. Elle doldurulacak anahtarlar: $ENV_DIR/web.env (bos birakilan ozellik kapali kalir)."
