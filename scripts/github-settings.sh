#!/usr/bin/env bash
# main kural seti (docs/decisions/0198). Yönetici yetkili `gh` oturumu ister.
#
#   bash scripts/github-settings.sh            # yalnız göster (varsayılan, hiçbir şey yazmaz)
#   bash scripts/github-settings.sh --apply    # .github/rulesets/main.json'u uygula
#
# Kural seti yalnız silmeyi ve force-push'u (non_fast_forward) yasaklar; PR/merge queue/zorunlu
# kontrol yoktur (karar 0198).
set -euo pipefail

REPO=${REPO:-ArillaSoftOrg/arilla}
RULESET_ID=${RULESET_ID:-24790202}
RULESET_FILE=${RULESET_FILE:-.github/rulesets/main.json}
mode=${1:---dry-run}

echo "== mevcut kural ($RULESET_ID)"
gh api "repos/$REPO/rulesets/$RULESET_ID" --jq '.rules | map(.type) | join(", ")'
echo "== hedef: $RULESET_FILE"
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rules.map((r) => r.type).join(", "))' "$RULESET_FILE"

if [ "$mode" != "--apply" ]; then
  echo "Yalnız gösterildi. Uygulamak için: bash scripts/github-settings.sh --apply"
  exit 0
fi
gh api -X PUT "repos/$REPO/rulesets/$RULESET_ID" --input "$RULESET_FILE" --jq '"kural güncellendi: \(.name) (\(.rules | map(.type) | join(", ")))"'
