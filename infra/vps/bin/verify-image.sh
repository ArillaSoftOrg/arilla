#!/usr/bin/env bash
# Bir imajin icinde gizli deger / kimlik dosyasi / ozel anahtar OLMADIGINI ve
# root calismadigini dogrular (karar 0109). CI'da (build-push, docker isi) ve
# yerelde calisir; imaji CALISTIRIR ama komutlari yalnizca dosya sistemini okur.
#
#   infra/vps/bin/verify-image.sh <imaj> [<imaj>...]
#
# Bulunan yollar yazdirilir, icerik ASLA yazdirilmaz.
set -uo pipefail
export MSYS_NO_PATHCONV=1

[ $# -ge 1 ] || { echo "kullanim: $0 <imaj>..." >&2; exit 64; }
overall=0

# Kimlik/anahtar dosya adlari (node_modules disinda; icerik taramasi asagida tum agacta).
NAMES='-name .env -o -name .env.* -o -name *.p8 -o -name *.p12 -o -name *.pfx -o -name *.key -o -name id_rsa* -o -name id_ed25519* -o -name .git-credentials -o -name .npmrc -o -name .netrc -o -name .pgpass'

for img in "$@"; do
  failures=0
  echo "== $img"

  # 1) Kimlik/anahtar dosya adlari
  found=$(docker run --rm --entrypoint sh "$img" -c \
    "find / -xdev \\( $NAMES \\) -not -path '*/node_modules/*' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null || true")
  if [ -n "$found" ]; then
    echo "  FAIL kimlik/anahtar dosyasi var:"
    echo "$found" | sed 's/^/        /'
    failures=$((failures + 1))
  else
    echo "  OK   kimlik/anahtar dosyasi yok (.env*, *.p8, *.p12, *.key, id_*, .npmrc ...)"
  fi

  # 2) PEM ozel anahtar ICERIGI: baslik + ardindan base64 govde. Yalniz baslik metni
  # (ornegin jose/@vercel/oidc kutuphane kodunda bir karsilastirma dizgesi) ve
  # sertifika paketleri bayrak almaz. Baslik, depo tarayicisi (scripts/check-private-keys.mjs)
  # bu dosyayi anahtar sanmasin diye iki parcadan birlestirilir.
  # Satir tabanli: baslik satirini iceren dosyada, hemen ardindan TAM SATIR base64 govde varsa.
  # (busybox grep --exclude-dir bilmez; adaylar find ile secilir, her imajda calisir.)
  begin="-----BEGIN"; tail="PRIVATE KEY-----"
  hdr="$begin [A-Z ]*$tail"
  scan='find / -xdev -type f -size -4096k -not -path "/proc/*" -not -path "/sys/*" -not -path "/dev/*" -not -path "*/node_modules/*" 2>/dev/null | xargs grep -l -e "'"$hdr"'" 2>/dev/null | while read -r f; do grep -A1 -e "'"$hdr"'" "$f" 2>/dev/null | grep -qE "^[A-Za-z0-9+/=]{40,}[[:space:]]*$" && echo "$f"; done; true'
  keys=$(docker run --rm --entrypoint sh "$img" -c "$scan")
  if [ -n "$keys" ]; then
    echo "  FAIL ozel anahtar icerigi var:"
    echo "$keys" | sed 's/^/        /'
    failures=$((failures + 1))
  else
    echo "  OK   PEM ozel anahtar icerigi yok"
  fi

  # 3) Imaj ortami (ENV): sir adli degisken DOLU olamaz. Yalniz ad yazdirilir.
  leaked=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$img" |
    grep -E '^(DATABASE_URL|DATABASE_URL_OWNER|REDIS_URL|SESSION_SECRET|CRON_SECRET|[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY))=.+' |
    cut -d= -f1 || true)
  if [ -n "$leaked" ]; then
    echo "  FAIL imaj ENV'inde dolu sir degiskeni: $(echo "$leaked" | tr '\n' ' ')"
    failures=$((failures + 1))
  else
    echo "  OK   imaj ENV'inde sir yok"
  fi

  # 4) Root degil
  user=$(docker image inspect --format '{{.Config.User}}' "$img")
  uid=$(docker run --rm --entrypoint id "$img" -u 2>/dev/null || echo "?")
  if [ -z "$user" ] || [ "$uid" = "0" ] || [ "$uid" = "?" ]; then
    echo "  FAIL root olarak calisiyor (USER='${user}', uid=${uid})"
    failures=$((failures + 1))
  else
    echo "  OK   root degil (USER=${user}, uid=${uid})"
  fi

  size=$(docker image inspect --format '{{.Size}}' "$img")
  echo "  --   boyut: $((size / 1024 / 1024)) MB"
  overall=$((overall + failures))
done

[ "$overall" -eq 0 ] && echo "TUM IMAJ KONTROLLERI GECTI" || echo "$overall IMAJ KONTROLU BASARISIZ"
exit $((overall > 0))
