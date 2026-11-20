#!/bin/sh
# Le pont dans le vrai jellyfin-web, sur le Jellyfin jetable (`tools/test-jellyfin.sh up`).
#
#   plugin/web/navigateur/pont.sh main      # le script injecté à la main (aucun plugin sur le serveur)
#   plugin/web/navigateur/pont.sh plugin    # le plugin installé l'a mis dans la page
#   ONLY="Titre|Autre"   EXPECT_JELLYFIN="Titre que Lumen doit refuser|…"
#   LUMEN_OFF=1 : « Lire avec Lumen » est décoché dans les réglages du plugin — jellyfin-web lit tout
#
# EXPECT_JELLYFIN : les titres que ce navigateur-ci ne peut pas lire par Lumen, et pour lesquels on
# vérifie donc l'autre moitié du contrat — le refus nommé, et jellyfin-web qui lit à la place.
set -eu
cd "$(dirname "$0")/../../.."
. "${JF_DATA:-test-jellyfin}/admin.env"
INJECT="${1:-main}"
OUT="${OUT:-lumen-core/benches/out/pont-$INJECT.jsonl}"
JF=lumen-test-jellyfin
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
URL="http://localhost:${JF_URL##*:}"
AUTH="Authorization: MediaBrowser Token=\"$JF_TOKEN\""
DEVICE=lumen-banc-pont
SERVER_ID=$(curl -s "$JF_URL/System/Info/Public" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Id"])')
# Aucun par défaut : sans cette liste, tout titre est attendu par Lumen (ce motif ne correspond à aucun nom).
EXPECT_JELLYFIN="${EXPECT_JELLYFIN:-^\$^}"

quiet() {
  curl -s -o /dev/null -X DELETE "$JF_URL/Videos/ActiveEncodings?deviceId=$DEVICE" -H "$AUTH" || true
  i=0; while docker exec "$JF" pgrep -x ffmpeg >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || { docker exec "$JF" pkill -x ffmpeg || true; break; }; sleep 1; done
  # Ce que le transcodage a laissé : un film remuxé en entier pèse autant que le film.
  docker exec "$JF" sh -c 'rm -rf /transcode/* 2>/dev/null; true'
  # Un serveur qui ne répond plus fausserait tous les passages suivants sans le dire : on s'arrête là.
  curl -sf -o /dev/null "$JF_URL/System/Info/Public" || { echo "Jellyfin ne répond plus — banc arrêté" >&2; exit 1; }
}

rm -f "$OUT"
curl -s "$JF_URL/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=MediaSources&UserId=$JF_USERID" -H "$AUTH" | ONLY="${ONLY:-}" python3 -c '
import sys, json, os, re
only = os.environ["ONLY"]
seen = set()
for i in sorted(json.load(sys.stdin)["Items"], key=lambda x: (x.get("SeriesName") or x["Name"], x.get("ParentIndexNumber") or 0, x.get("IndexNumber") or 0)):
    name = i.get("SeriesName") or i["Name"]
    if name in seen or (only and not re.fullmatch(only, name)): continue
    seen.add(name)
    print(json.dumps({"id": i["Id"], "name": name, "ticks": i["MediaSources"][0]["RunTimeTicks"]}, ensure_ascii=False))
' > "$OUT.titres"

failures=0
while IFS= read -r item; do
  name=$(printf '%s' "$item" | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"])')
  if [ -n "${LUMEN_OFF:-}" ]; then expect=off; elif printf '%s' "$name" | grep -Eqx "$EXPECT_JELLYFIN"; then expect=jellyfin; else expect=lumen; fi
  quiet
  # `grep -c` écrit déjà « 0 » quand il ne trouve rien, tout en sortant en échec : sur un serveur neuf,
  # un « || echo 0 » ici donnait « 0 0 », que le calcul plus bas refusait, et le parcours s'arrêtait là.
  ffmpeg_before=$(docker exec "$JF" sh -c 'ls /config/log 2>/dev/null | grep -c FFmpeg || true')
  docker run --rm --name lumen-banc-pont --network host --ipc host --cpus=4 --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PWD/plugin/web:/app:ro" -v "$PWD/$(dirname "$OUT"):/out" -w /app \
    -e ITEM="$item" -e EXPECT="$expect" -e INJECT="$INJECT" -e JF_URL="$URL" -e JF_TOKEN="$JF_TOKEN" -e JF_USERID="$JF_USERID" \
    -e JF_SERVERID="$SERVER_ID" -e DEVICE_ID="$DEVICE" -e OUT="/out/$(basename "$OUT")" \
    -e BRIDGE=/app/dist/lumen-jellyfin.js -e LUMEN_BASE="$URL/web/lumen-test/dist/" \
    "$PW_IMAGE" node navigateur/pont.mjs || failures=$((failures + 1))
  ffmpeg_after=$(docker exec "$JF" sh -c 'ls /config/log 2>/dev/null | grep -c FFmpeg || true')
  # Chaque lancement de ffmpeg par Jellyfin laisse un journal : leur nombre pendant le passage.
  echo "      ffmpeg lancés par le serveur pendant ce titre : $((ffmpeg_after - ffmpeg_before))"
done < "$OUT.titres"
quiet
grep -c '"ok": *true\|"ok":true' "$OUT" | sed "s|^|titres conformes : |; s|\$| / $(wc -l < "$OUT")|"
