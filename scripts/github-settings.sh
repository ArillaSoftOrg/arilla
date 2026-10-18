#!/usr/bin/env bash
# Tek seferlik GitHub ayarları (docs/decisions/0137). Yönetici yetkili `gh` oturumu ister.
#
#   bash scripts/github-settings.sh            # yalnız göster (varsayılan, hiçbir şey yazmaz)
#   bash scripts/github-settings.sh --apply    # main kuralını ve depo ayarlarını uygula
#
# SIRA ÖNEMLİ: yalnızca karar 0137 PR'ı main'e girdikten SONRA uygulanır. `merge_group`
# tetikleyicisi ve `pr policy` durumu main'de yokken kuralı açmak tüm PR'ları kilitler; betik
# bunu denetler. Dal koruması kapatılmaz; yalnızca zorunlu kontrol listesi genişler, merge queue
# eklenir. Geri dönüş: kuralı GitHub arayüzünden düzenleyip `merge_queue` kuralını kaldırmak.
set -euo pipefail

REPO=${REPO:-ArillaSoftOrg/arilla}
RULESET_ID=${RULESET_ID:-24790202}
RULESET_FILE=${RULESET_FILE:-.github/rulesets/main.json}
mode=${1:---dry-run}

on_main() { # on_main <yol> <aranan>
  gh api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/$1?ref=main" 2>/dev/null | grep -q -- "$2"
}

ok=1
on_main .github/workflows/pr-policy.yml "pull_request_target" || { echo "EKSİK: main'de pr-policy.yml yok"; ok=0; }
on_main .github/workflows/ci.yml "merge_group" || { echo "EKSİK: main'deki ci.yml merge_group dinlemiyor"; ok=0; }
on_main .github/workflows/ci.yml "name: ci ok" || { echo "EKSİK: main'deki ci.yml 'ci ok' işi yok"; ok=0; }
on_main .github/workflows/security-checks.yml "merge_group" || { echo "EKSİK: security-checks.yml merge_group dinlemiyor"; ok=0; }

echo "== mevcut kural ($RULESET_ID)"
gh api "repos/$REPO/rulesets/$RULESET_ID" --jq '.rules[] | .type + " " + ((.parameters.required_status_checks // []) | map(.context) | join(", "))'
echo "== hedef: $RULESET_FILE"
echo "== depo: allow_auto_merge, allow_update_branch"
gh api "repos/$REPO" --jq '"mevcut: allow_auto_merge=\(.allow_auto_merge) allow_update_branch=\(.allow_update_branch)"'

if [ "$mode" != "--apply" ]; then
  echo "Yalnız gösterildi. Uygulamak için: bash scripts/github-settings.sh --apply"
  exit 0
fi
[ "$ok" = 1 ] || { echo "Ön koşullar main'de değil; önce karar 0137 PR'ı birleşmeli. Uygulanmadı."; exit 2; }

gh api -X PUT "repos/$REPO/rulesets/$RULESET_ID" --input "$RULESET_FILE" --jq '"kural güncellendi: \(.name) (\(.rules | map(.type) | join(", ")))"'
gh api -X PATCH "repos/$REPO" -F allow_auto_merge=true -F allow_update_branch=true \
  --jq '"depo: allow_auto_merge=\(.allow_auto_merge) allow_update_branch=\(.allow_update_branch)"'
