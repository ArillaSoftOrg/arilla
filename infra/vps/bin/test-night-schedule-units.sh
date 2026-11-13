#!/usr/bin/env bash
# Karar 0188: gece zamanlama planinin systemd davranisi GERCEK systemd ile sinanir.
#
#   sudo bash infra/vps/bin/test-night-schedule-units.sh
#
# Depodaki arilla-feeds-daily.timer / arilla-catalog-auto.timer'dan test birimleri URETILIR (birim
# degisirse test de izler); hizmetler dosyaya yazan sahte adimlardir, docker ve /opt/arilla gerekmez.
# Sinananlar:
#   1) takvimler: systemd-analyze kabul eder, UTC'dir, Turkiye saatiyle 00:30 / 06:00 / 09:30 / 15:15
#   2) Persistent yakalama: yeni takvimin son tetigi kayitli son kosudan ESKIYSE kurulumda kosu YOK
#      (uygulama kurali); YENIYSE kurulumda hemen kosu VAR (kuralin nedeni)
#   3) geri donus: eski takvime donus ayni kuralla kosu baslatmaz
#   4) cift kosu: oneshot calisirken zamanlayici + elle baslatma tek kosu
#   5) OnSuccess: besleme 0 ile biterse katalog calisir, 1 ile biterse (partial) calismaz
#   6) catalog-auto-guard ExecCondition atlamasi: birim failed OLMAZ, OnFailure alarmi YOK
# Birimler /run/systemd/system altinda gecicidir; cikista silinir. Yalniz CI runner'i ya da atilabilir
# makine icindir; uretim VPS'inde CALISTIRILMAZ.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "root gerekir: sudo bash $0" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd yok" >&2; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
SYSTEMD_SRC="$HERE/../systemd"
P=arilla-n188-test
UNITDIR=/run/systemd/system
STAMPDIR=/var/lib/systemd/timers
WORK=$(mktemp -d)
chmod 755 "$WORK"
UNITS=()

cleanup() {
  for u in "${UNITS[@]}"; do
    systemctl stop "$u" >/dev/null 2>&1 || true
    systemctl reset-failed "$u" >/dev/null 2>&1 || true
    rm -rf "${UNITDIR:?}/$u" "${UNITDIR:?}/$u.d" "$STAMPDIR/stamp-$u"
  done
  systemctl daemon-reload || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "BASARISIZ: $*" >&2; exit 1; }

unit() {  # unit <ad> ; icerik stdin
  cat >"$UNITDIR/$1"
  UNITS+=("$1")
}

runs() { [ -f "$WORK/runs-$1" ] && wc -l <"$WORK/runs-$1" | tr -d ' ' || echo 0; }

wait_runs() {  # wait_runs <ad> <beklenen> <saniye>
  for _ in $(seq 1 $(($3 * 5))); do
    [ "$(runs "$1")" -ge "$2" ] && return 0
    sleep 0.2
  done
  return 1
}

hhmm_ago() { date -u -d "@$(($(date -u +%s) - $1 * 60))" +%H:%M:%S; }

# ------------------------------------------------------------------ 1) takvimler
echo "1) takvimler: systemd-analyze, UTC ve Turkiye saati"
expect_tr() {  # expect_tr <takvim> <TR SS:DD>
  local out tr
  out=$(TZ=Europe/Istanbul systemd-analyze calendar --iterations=1 "$1") || fail "gecersiz takvim: $1"
  echo "$out" | grep -q "Normalized form: .* UTC" || fail "UTC degil: $1"
  tr=$(echo "$out" | sed -n 's/^ *Next elapse: [A-Za-z]* [0-9-]* \([0-9:]*\) +03.*/\1/p')
  [ "${tr%:00}" = "$2" ] || fail "$1 -> TR '$tr', beklenen $2"
  echo "   $1 -> $2 TR"
}
mapfile -t FEEDS < <(sed -n 's/^OnCalendar=//p' "$SYSTEMD_SRC/arilla-feeds-daily.timer")
mapfile -t NET < <(sed -n 's/^OnCalendar=//p' "$SYSTEMD_SRC/arilla-catalog-auto.timer")
[ "${#FEEDS[@]}" = 2 ] && [ "${#NET[@]}" = 2 ] || fail "beklenen ikiser OnCalendar"
expect_tr "${FEEDS[0]}" 09:30
expect_tr "${FEEDS[1]}" 00:30
expect_tr "${NET[0]}" 15:15
expect_tr "${NET[1]}" 06:00
grep -qx 'Persistent=true' "$SYSTEMD_SRC/arilla-feeds-daily.timer" || fail "besleme Persistent degil"
grep -qx 'Persistent=true' "$SYSTEMD_SRC/arilla-catalog-auto.timer" || fail "katalog Persistent degil"

# ------------------------------------------- test hizmetleri ve depodan uretilen zamanlayici
# Adim: her kosuda bir satir yazar; sleep-<ad> kadar bekler, code-<ad> ile cikar (systemd'nin
# ExecStart icindeki $/% genislemesine takilmamak icin ayri betik).
cat >"$WORK/step" <<'STEP'
#!/bin/sh
d=$(dirname "$0")
date -u +%s >>"$d/runs-$1.service"
sleep "$(cat "$d/sleep-$1" 2>/dev/null || echo 0)"
exit "$(cat "$d/code-$1" 2>/dev/null || echo 0)"
STEP
chmod 755 "$WORK/step"

svc() {  # svc <ad> [ek [Unit] satirlari]
  unit "$1.service" <<UNIT
[Unit]
Description=0188 test: $1
${2:-}

[Service]
Type=oneshot
ExecStart=$WORK/step $1
UNIT
}

# Depodaki zamanlayicinin [Timer] bolumu korunur (Persistent dahil); OnCalendar test saatine,
# RandomizedDelaySec 0'a cekilir (belirlenebilirlik), Unit= test hizmetine yonlendirilir.
timer_from_repo() {  # timer_from_repo <depo-zamanlayici> <test-adi> <takvim...>
  local src=$1 name=$2
  shift 2
  # Boru yerine surec ikamesi: `unit` alt kabukta calisirsa UNITS'e eklenmez, temizlenmezdi.
  unit "$name.timer" < <({
    echo "[Unit]"
    echo "Description=0188 test zamanlayici ($src)"
    echo
    echo "[Timer]"
    for cal in "$@"; do echo "OnCalendar=$cal"; done
    grep -E '^(Persistent|AccuracySec)=' "$SYSTEMD_SRC/$src"
    echo "AccuracySec=1s"
    echo "RandomizedDelaySec=0"
    echo "Unit=$name.service"
  })
}

install_timer() {  # install_timer <ad> <son-kosu-dk-once> ; kayitli son tetik = damga dosyasi
  touch -d "@$(($(date -u +%s) - $2 * 60))" "$STAMPDIR/stamp-$1.timer"
  systemctl daemon-reload
  systemctl restart "$1.timer"
}

mkdir -p "$STAMPDIR"

# ------------------------------------------------- 2) Persistent yakalama ve uygulama kurali
echo "2a) uygulama kurali: yeni takvimin son tetigi (60 dk once) kayitli son kosudan (10 dk once) ESKI -> kosu YOK"
svc "$P-feeds"
timer_from_repo arilla-feeds-daily.timer "$P-feeds" "*-*-* $(hhmm_ago 60) UTC"
install_timer "$P-feeds" 10
sleep 4
[ "$(runs "$P-feeds.service")" = 0 ] || fail "kurulumda yakalama kosusu basladi (kural ihlal)"
systemctl show "$P-feeds.timer" -p NextElapseUSecRealtime --value | grep -q . || fail "sonraki tetik yok"

echo "2b) kural ihlali: yeni takvimin son tetigi (60 dk once) kayitli son kosudan (120 dk once) YENI -> HEMEN kosu"
systemctl stop "$P-feeds.timer"
install_timer "$P-feeds" 120
wait_runs "$P-feeds.service" 1 10 || fail "Persistent yakalama kosusu baslamadi"
[ "$(runs "$P-feeds.service")" = 1 ] || fail "yakalama tek kosu olmali: $(runs "$P-feeds.service")"

# ------------------------------------------------------------------------- 3) geri donus
echo "3) geri donus: eski takvim (30 dk once) yeniden kurulur, son kosu (yukaridaki, ~0 dk) daha yeni -> kosu YOK"
systemctl stop "$P-feeds.timer"
timer_from_repo arilla-feeds-daily.timer "$P-feeds" "*-*-* $(hhmm_ago 30) UTC"
systemctl daemon-reload
systemctl restart "$P-feeds.timer"
sleep 4
[ "$(runs "$P-feeds.service")" = 1 ] || fail "geri donus kurulumu kosu baslatti: $(runs "$P-feeds.service")"

# ---------------------------------------------------------------------------- 4) cift kosu
echo "4) cift kosu: hizmet calisirken zamanlayici tetigi + elle baslatma -> tek kosu"
rm -f "$WORK/runs-$P-feeds.service"
echo 6 >"$WORK/sleep-$P-feeds"
systemctl start --no-block "$P-feeds.service"
wait_runs "$P-feeds.service" 1 5 || fail "hizmet baslamadi"
systemctl start --no-block "$P-feeds.service"
systemctl stop "$P-feeds.timer"
install_timer "$P-feeds" 120  # yakalama tetigi calisan hizmete denk gelir
sleep 8
[ "$(runs "$P-feeds.service")" = 1 ] || fail "calisan oneshot ikinci kez basladi: $(runs "$P-feeds.service")"
rm -f "$WORK/sleep-$P-feeds"
systemctl stop "$P-feeds.timer"

# ------------------------------------------------------------------------------ 5) OnSuccess
echo "5) OnSuccess (karar 0164 drop-in metni): besleme 0 -> katalog calisir; 1 (partial) -> calismaz"
svc "$P-catalog"
svc "$P-daily" "OnFailure=$P-alert@%n.service"
unit "$P-alert@.service" <<UNIT
[Unit]
Description=0188 test alarmi: %i

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo %i >>$WORK/alerts'
UNIT
mkdir -p "$UNITDIR/$P-daily.service.d"
# catalog-auto-timers'in yazdigi drop-in ile ayni bicim (birim adi test birimine yonlendirilir).
grep -q "OnSuccess=\$UNIT.service" "$HERE/catalog-auto-timers" || fail "catalog-auto-timers OnSuccess drop-in'i yazmiyor"
printf '%s\n' '[Unit]' "OnSuccess=$P-catalog.service" >"$UNITDIR/$P-daily.service.d/catalog-auto.conf"
systemctl daemon-reload
echo 0 >"$WORK/code-$P-daily"
systemctl start "$P-daily.service"
wait_runs "$P-catalog.service" 1 10 || fail "basarili beslemeden sonra katalog calismadi"
echo 1 >"$WORK/code-$P-daily"
systemctl start "$P-daily.service" || true
sleep 3
[ "$(runs "$P-catalog.service")" = 1 ] || fail "partial (1) beslemeden sonra katalog calisti"
[ -s "$WORK/alerts" ] || fail "partial beslemede OnFailure alarmi yok (karar 0184 siniflandirir)"
systemctl reset-failed "$P-daily.service" || true

# ------------------------------------------------------------- 6) ExecCondition (guard) atlamasi
echo "6) catalog-auto-guard bos disk esiginin altinda: atlar, failed degil, alarm yok"
rm -f "$WORK/alerts"
unit "$P-guarded.service" <<UNIT
[Unit]
Description=0188 test: guard
OnFailure=$P-alert@%n.service

[Service]
Type=oneshot
Environment=ARILLA_ROOT=$WORK START_FREE_GB=999999
ExecCondition=$HERE/catalog-auto-guard
ExecStart=$WORK/step $P-guarded
UNIT
systemctl daemon-reload
systemctl start "$P-guarded.service" || true
sleep 2
[ "$(runs "$P-guarded.service")" = 0 ] || fail "guard atlamadi"
[ "$(systemctl show "$P-guarded.service" -p ActiveState --value)" != failed ] || fail "atlama failed sayildi"
[ ! -s "$WORK/alerts" ] || fail "atlama alarm uretti"
journalctl -u "$P-guarded.service" --no-pager -o cat 2>/dev/null | grep -q "atlandi: bos disk" \
  || echo "   (not: guard mesaji gunlukte henuz gorunmedi; davranis dogrulandi)"

echo "TAMAM: gece zamanlama plani systemd davranisi karar 0188 ile uyumlu"
