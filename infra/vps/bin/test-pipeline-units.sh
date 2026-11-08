#!/usr/bin/env bash
# Karar 0174 (PR1c): gece katalog hattinin systemd davranisi GERCEK systemd ile sinanir.
#
#   sudo bash infra/vps/bin/test-pipeline-units.sh
#
# Depodaki arilla-catalog-pipeline.service'ten test birimi URETILIR (birim degisirse test de
# izler): ExecStart'lar belirlenen kodla cikan sahte adimlara, OnFailure cagriyi dosyaya yazan
# sahte alarm birimine yonlendirilir; docker ve /opt/arilla gerekmez. Sinananlar:
#   - adim 1 cikis 75 -> adim 2 CALISMAZ, birim failed, ExecMainStatus=75, OnFailure tetiklenir
#   - adim 1 cikis 0, adim 2 cikis 75 -> ExecMainStatus=75, OnFailure tetiklenir
#   - adim 1 cikis 1 -> ExecMainStatus=1, OnFailure
#   - iki adim 0 -> birim basarili, alarm YOK
#   - arilla_healthcheck.py gercek `systemctl show` ciktisini ayristirir ve tek atlamayi BILGI sayar
# Birimler /run/systemd/system altinda gecicidir; cikista silinir. Yalniz CI runner'i ya da
# atilabilir makine icindir; uretim VPS'inde CALISTIRILMAZ.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "root gerekir: sudo bash $0" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd yok" >&2; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/../systemd/arilla-catalog-pipeline.service"
NAME=arilla-pr1c-test-pipeline
ALERT=arilla-pr1c-test-alert
UNITDIR=/run/systemd/system
WORK=$(mktemp -d)
chmod 755 "$WORK"

cleanup() {
  systemctl stop "$NAME.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$NAME.service" >/dev/null 2>&1 || true
  rm -f "$UNITDIR/$NAME.service" "$UNITDIR/$ALERT@.service"
  systemctl daemon-reload || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "BASARISIZ: $*" >&2; exit 1; }

# --- kisit 1: SuccessExitStatus=75 birime tek basina eklenmemeli (karar 0174)
if grep -q '^SuccessExitStatus' "$SRC"; then
  fail "arilla-catalog-pipeline.service SuccessExitStatus tanimliyor; kilitte similarity baslar"
fi
[ "$(grep -c '^ExecStart=' "$SRC")" = 2 ] || fail "beklenen 2 ExecStart (resolve, similarity)"
grep -q '^OnFailure=arilla-alert@%n.service$' "$SRC" || fail "OnFailure=arilla-alert@%n.service yok"

cat >"$WORK/step" <<'STEP'
#!/bin/sh
dir=$(dirname "$0")
echo "$1" >>"$dir/ran"
exit "$(cat "$dir/code-$1")"
STEP
chmod 755 "$WORK/step"

# Gercek birimden test birimi: n. ExecStart -> sahte adim n; docker bagimliligi ve /opt/arilla cikar.
awk -v work="$WORK" -v alert="$ALERT" '
  /^ExecStart=/ { n++; print "ExecStart=" work "/step " n; next }
  /^OnFailure=/ { print "OnFailure=" alert "@%n.service"; next }
  /^(Requires|After)=docker\.service$/ { next }
  /^WorkingDirectory=/ { print "WorkingDirectory=" work; next }
  { print }
' "$SRC" >"$UNITDIR/$NAME.service"

cat >"$UNITDIR/$ALERT@.service" <<UNIT
[Unit]
Description=PR1c test alarmi: %i

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo %i >>$WORK/alerts'
UNIT
systemctl daemon-reload

prop() { systemctl show "$NAME.service" -p "$1" --value; }

run_case() {  # run_case <kod1> <kod2>
  echo "$1" >"$WORK/code-1"
  echo "$2" >"$WORK/code-2"
  rm -f "$WORK/ran" "$WORK/alerts"
  systemctl reset-failed "$NAME.service" >/dev/null 2>&1 || true
  systemctl start "$NAME.service" || true
}

wait_alert() {  # OnFailure eszamansizdir
  for _ in $(seq 1 50); do
    [ -s "$WORK/alerts" ] && return 0
    sleep 0.2
  done
  return 1
}

check_failed() {  # check_failed <beklenen adimlar> <ExecMainStatus>
  local ran
  ran=$(tr '\n' ' ' <"$WORK/ran" | sed 's/ $//')
  [ "$ran" = "$1" ] || fail "calisan adimlar '$ran', beklenen '$1'"
  [ "$(prop ActiveState)" = failed ] || fail "ActiveState $(prop ActiveState), beklenen failed"
  [ "$(prop Result)" = exit-code ] || fail "Result $(prop Result), beklenen exit-code"
  [ "$(prop ExecMainStatus)" = "$2" ] || fail "ExecMainStatus $(prop ExecMainStatus), beklenen $2"
  wait_alert || fail "OnFailure alarmi tetiklenmedi"
  grep -qx "$NAME.service" "$WORK/alerts" || fail "alarm yanlis birim adiyla: $(cat "$WORK/alerts")"
}

echo "1) resolve kilit mesgul (75): similarity baslamaz, alarm tetiklenir"
run_case 75 0
check_failed "1" 75

echo "   arilla_healthcheck: gercek systemctl show ciktisi + bu kosunun skipped_locked kaydi -> BILGI"
python3 - "$HERE" "$NAME.service" <<'PY'
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, sys.argv[1])
import arilla_healthcheck as hc

collector = hc.Collector.__new__(hc.Collector)
collector.run = hc.default_runner
status, since = collector.unit_invocation(sys.argv[2])
now = datetime.now(timezone.utc)
assert status == 75, status
assert since is not None and abs((now - since).total_seconds()) < 120, since
row = {"job": "resolve", "status": "partial", "outcome": "skipped_locked", "reason": "lock_busy",
       "started": since + timedelta(seconds=1)}
level, msg = hc.classify_pipeline_failure(status, since, [row])
assert level == hc.INFO, (level, msg)
prev = dict(row, started=since - timedelta(days=1))
assert hc.classify_pipeline_failure(status, since, [row, prev])[0] == hc.CRIT
assert hc.classify_pipeline_failure(status, since, [prev])[0] == hc.CRIT  # bu kosuya ait kayit yok
print("   ok:", msg)
PY

echo "2) resolve tamam, similarity kilit mesgul (75)"
run_case 0 75
check_failed "1 2" 75

echo "3) resolve hata (1): similarity baslamaz"
run_case 1 0
check_failed "1" 1

echo "4) iki adim basarili: alarm yok"
run_case 0 0
[ "$(tr '\n' ' ' <"$WORK/ran" | sed 's/ $//')" = "1 2" ] || fail "iki adim da calismadi"
[ "$(prop Result)" = success ] || fail "Result $(prop Result), beklenen success"
[ "$(prop ActiveState)" != failed ] || fail "basarili kosuda birim failed"
sleep 2
[ ! -s "$WORK/alerts" ] || fail "basarili kosuda alarm tetiklendi"

echo "TAMAM: katalog hatti systemd davranisi karar 0174 ile uyumlu"
