#!/bin/sh
# jellyfin-web seul face à Lumen, sur le Jellyfin jetable (`tools/test-jellyfin.sh up`).
#
#   lumen-core/benches/jellyfin/banc.sh [sortie.jsonl]     # depuis la racine du dépôt
#   ONLY="Titre exact|Autre titre"  PLAYERS="jellyfin lumen"  RUNS=1
#
# Pour chaque titre et chaque lecteur : le parcours de parcours.mjs dans un Chromium neuf, encadré par
# deux lectures du compteur de processeur du conteneur Jellyfin (cgroup, `usage_usec`) — des secondes
# de processeur réellement consommées par le serveur, ffmpeg compris, pas un pourcentage échantillonné.
# Entre deux passages, les transcodages de l'appareil du banc sont arrêtés et l'on attend que plus aucun
# ffmpeg ne tourne : le passage suivant ne paie pas le précédent.
#
# Les titres sont lus dans Jellyfin (films, et le premier épisode de chaque série).
set -eu
cd "$(dirname "$0")/../../.."
. test-jellyfin/admin.env
OUT="${1:-lumen-core/benches/out/face-a-jellyfin.jsonl}"
JF=lumen-test-jellyfin
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
URL="http://localhost:${JF_URL##*:}"
AUTH="Authorization: MediaBrowser Token=\"$JF_TOKEN\""
DEVICE=lumen-banc-navigateur
SERVER_ID=$(curl -s "$JF_URL/System/Info/Public" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Id"])')

cpu() { docker exec "$JF" sh -c 'grep usage_usec /sys/fs/cgroup/cpu.stat' | cut -d' ' -f2; }
quiet() {
  curl -s -o /dev/null -X DELETE "$JF_URL/Videos/ActiveEncodings?deviceId=$DEVICE" -H "$AUTH" || true
  i=0; while docker exec "$JF" pgrep -x ffmpeg >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || { docker exec "$JF" pkill -x ffmpeg || true; break; }; sleep 1; done
  # Ce que le transcodage a laissé : un film remuxé en entier pèse autant que le film.
  docker exec "$JF" sh -c 'rm -rf /transcode/* 2>/dev/null; true'
  # Un serveur qui ne répond plus fausserait tous les passages suivants sans le dire : on s'arrête là.
  curl -sf -o /dev/null "$JF_URL/System/Info/Public" || { echo "Jellyfin ne répond plus — banc arrêté" >&2; exit 1; }
}

curl -s "$JF_URL/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=MediaSources&UserId=$JF_USERID" -H "$AUTH" | ONLY="${ONLY:-}" python3 -c '
import sys, json, os, re
only = os.environ["ONLY"]
seen = set()
for i in sorted(json.load(sys.stdin)["Items"], key=lambda x: (x.get("SeriesName") or x["Name"], x.get("ParentIndexNumber") or 0, x.get("IndexNumber") or 0)):
    name = i.get("SeriesName") or i["Name"]
    if name in seen or (only and not re.fullmatch(only, name)): continue
    seen.add(name)
    ms = i["MediaSources"][0]
    video = next((s for s in ms["MediaStreams"] if s["Type"] == "Video"), {})
    print(json.dumps({"id": i["Id"], "name": name, "size": ms["Size"], "ticks": ms["RunTimeTicks"], "range": video.get("VideoRangeType")}, ensure_ascii=False))
' > "$OUT.titres"

# Le serveur au repos, sur la durée d'un passage : ce qu'il consomme sans que personne ne lise rien.
quiet
before=$(cpu); sleep "${IDLE_SECONDS:-35}"; after=$(cpu)
echo "{\"player\": \"repos\", \"serverCpuSeconds\": $(python3 -c "print(round(($after - $before) / 1e6, 1))"), \"passSeconds\": ${IDLE_SECONDS:-35}}" >> "$OUT"

while IFS= read -r item; do
  for player in ${PLAYERS:-jellyfin lumen}; do
    run=0
    while [ "$run" -lt "${RUNS:-1}" ]; do
      run=$((run + 1))
      quiet
      before=$(cpu); t0=$(date +%s%N)
      docker run --rm --name lumen-banc-navigateur --network host --ipc host --cpus=4 --user "$(id -u):$(id -g)" -e HOME=/tmp \
        -v "$PWD/lumen-core:/app:ro" -v "$PWD/$(dirname "$OUT"):/out" -w /app \
        -e PLAYER="$player" -e ITEM="$item" -e JF_URL="$URL" -e JF_TOKEN="$JF_TOKEN" -e JF_USERID="$JF_USERID" -e JF_SERVERID="$SERVER_ID" \
        -e DEVICE_ID="$DEVICE" -e OUT="/out/$(basename "$OUT").partiel" "$PW_IMAGE" node benches/jellyfin/parcours.mjs || true
      after=$(cpu); t1=$(date +%s%N)
      # La dernière ligne écrite par le parcours, complétée du processeur du serveur pendant ce passage.
      tail -n 1 "$OUT.partiel" | CPU=$((after - before)) NS=$((t1 - t0)) python3 -c '
import sys, json, os
row = json.loads(sys.stdin.readline())
row["serverCpuSeconds"] = round(int(os.environ["CPU"]) / 1e6, 1)
row["passSeconds"] = round(int(os.environ["NS"]) / 1e9, 1)
print(json.dumps(row, ensure_ascii=False))' >> "$OUT"
    done
  done
done < "$OUT.titres"
quiet
rm -f "$OUT.partiel"
