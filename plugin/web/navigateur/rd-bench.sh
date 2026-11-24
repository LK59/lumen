#!/bin/sh
# Lance un script de banc de R&D dans Playwright, sur le Jellyfin jetable.
#
#   plugin/web/navigateur/rd-bench.sh rd-ouverture.mjs "Titre"    [LATENCY_MS=40 RUNS=3 …]
set -eu
cd "$(dirname "$0")/../../.."
. "${JF_DATA:-test-jellyfin}/admin.env"
SCRIPT="$1"
TITLE="$2"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
URL="http://localhost:${JF_URL##*:}"
AUTH="Authorization: MediaBrowser Token=\"$JF_TOKEN\""
SERVER_ID=$(curl -s "$JF_URL/System/Info/Public" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Id"])')
ITEM_ID=$(curl -s "$JF_URL/Items?Recursive=true&IncludeItemTypes=Movie,Episode&UserId=$JF_USERID" -H "$AUTH" | TITLE="$TITLE" python3 -c '
import sys, json, os
items = sorted(json.load(sys.stdin)["Items"], key=lambda x: (x.get("ParentIndexNumber") or 0, x.get("IndexNumber") or 0))
for i in items:
    if (i.get("SeriesName") or i["Name"]) == os.environ["TITLE"]:
        print(i["Id"]); break
')
[ -n "$ITEM_ID" ] || { echo "titre introuvable : $TITLE" >&2; exit 1; }
# EXTRA="LOSS=1 ONLY_OPEN=1" : des variables de plus pour le script (sans espaces dans les valeurs).
set --
for pair in ${EXTRA:-}; do set -- "$@" -e "$pair"; done
docker run --rm --name lumen-banc-rd --network host --ipc host --cpus=4 --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/plugin/web:/app:ro" -w /app \
  -e ITEM_ID="$ITEM_ID" -e JF_URL="$URL" -e JF_TOKEN="$JF_TOKEN" -e JF_USERID="$JF_USERID" -e JF_SERVERID="$SERVER_ID" \
  -e LATENCY_MS="${LATENCY_MS:-0}" -e RESUME="${RESUME:-600}" -e RUNS="${RUNS:-3}" -e SCENARIOS="${SCENARIOS:-cold,warm,resume}" \
  -e DWELL_MS="${DWELL_MS:-1500}" -e SHOW_LOG="${SHOW_LOG:-}" -e SHOW_TRACE="${SHOW_TRACE:-}" -e SHOW_RANGES="${SHOW_RANGES:-}" -e DOWN_BPS="${DOWN_BPS:-50000000}" \
  -e OUT=/tmp/out.jsonl -e EXPECT="${EXPECT:-lumen}" -e INJECT=plugin -e DEVICE_ID=lumen-banc-rd "$@" \
  "$PW_IMAGE" node "navigateur/$SCRIPT"
