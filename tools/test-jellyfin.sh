#!/bin/sh
# Le Jellyfin jetable des bancs : `lumen-test-jellyfin`, publié sur 127.0.0.1 seulement.
#
#   tools/test-jellyfin.sh up        # le (re)crée ; ses données restent dans $DATA/config
#   tools/test-jellyfin.sh down      # l'arrête et le retire — à faire en fin de travail
#   tools/test-jellyfin.sh plugin    # y installe plugin/dist/Lumen_* (construit par plugin/package.sh), puis up
#   tools/test-jellyfin.sh noplugin  # retire le plugin, puis up
#   tools/test-jellyfin.sh setup     # sur un serveur vierge : compte de banc, bibliothèques, premier scan
#
# JF_DATA (défaut test-jellyfin) : le dossier de données, pour garder un serveur par version essayée.
# JF_IMAGE : l'image de Jellyfin. MEDIA_ROOT : le dossier des médias sur l'hôte.
#
# Ce qu'il monte :
# - les dossiers listés dans $DATA/dossiers.txt (un chemin par ligne, sous MEDIA_ROOT), en
#   LECTURE SEULE, au même chemin sous /media : seulement les titres des bancs, pas la médiathèque ;
# - lumen-core/dist et la page de test, sous le dossier de jellyfin-web (`/web/lumen-test/`) : la page
#   a ainsi l'origine de jellyfin-web, comme l'aura le plugin — ni CORS, ni interception ;
# - le dossier de transcodage dans $DATA/transcode, sur disque. Pas en mémoire : Jellyfin, tel
#   qu'il est réglé d'origine, remuxe un fichier entier aussi vite que le disque le lit et ne supprime
#   rien avant la fin — 17 Go en deux minutes pour un film à 19 Mb/s. En mémoire (tmpfs), ces octets
#   comptent dans la limite du conteneur : au troisième titre d'un banc, le noyau tuait ffmpeg, et tous
#   les passages suivants échouaient sans autre message. Les bancs vident ce dossier entre deux passages.
#
# Processeur et mémoire bornés : un banc oublié ne prend pas la machine.
set -eu
cd "$(dirname "$0")/.."
NAME=lumen-test-jellyfin
# Le dossier de données de ce serveur. Un par version de Jellyfin essayée : sa base ne revient pas en
# arrière, et une version plus ancienne ne relit pas celle d'une plus récente.
DATA="${JF_DATA:-test-jellyfin}"
PORT="${JF_PORT:-18096}"
# Le dossier des médias, sur l'hôte : obligatoire pour créer ou préparer le serveur (il n'y a pas de bonne
# valeur par défaut), mais pas pour l'arrêter — exigé là aussi, un oubli laissait le serveur tourner.
[ "${1:-}" = down ] || MEDIA_ROOT="${MEDIA_ROOT:?MEDIA_ROOT : le dossier des médias sur l'hôte}"
# L'image de Jellyfin à essayer. Pour comparer à un serveur existant, lui donner l'empreinte de son image
# (`docker inspect <conteneur> --format '{{.Image}}'`) : la même version, quoi que `latest` vaille demain.
IMAGE="${JF_IMAGE:-lscr.io/linuxserver/jellyfin:latest}"

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    mkdir -p $DATA/config $DATA/transcode
    set --
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      set -- "$@" -v "$MEDIA_ROOT/$dir:/media/$dir:ro"
    done < $DATA/dossiers.txt
    docker run -d --name "$NAME" --cpus="${JF_CPUS:-6}" --memory=8g -p "127.0.0.1:$PORT:8096" \
      -e PUID="$(id -u)" -e PGID="$(id -g)" -e TZ=Europe/Paris \
      -v "$PWD/$DATA/config:/config" -v "$PWD/$DATA/transcode:/transcode" \
      -v "$PWD/lumen-core/test-page/index.html:/usr/share/jellyfin/web/lumen-test/index.html:ro" \
      -v "$PWD/lumen-core/dist:/usr/share/jellyfin/web/lumen-test/dist:ro" \
      "$@" "$IMAGE" >/dev/null
    # Prêt quand le vrai serveur répond. Pendant son démarrage, Jellyfin sert d'abord un serveur d'attente
    # sur le même port, qui répond 200 lui aussi, puis ferme ce port un instant avant d'ouvrir le sien :
    # un 200 ne prouve rien. Le serveur d'attente écrit ses champs en minuscules (« version »), le vrai
    # avec une majuscule — c'est ce qui les distingue. Deux fois de suite, pour enjamber la bascule.
    i=0; ok=0
    while [ "$ok" -lt 2 ]; do
      if curl -s "http://127.0.0.1:$PORT/System/Info/Public" | grep -q '"Version"'; then ok=$((ok + 1)); else ok=0; fi
      i=$((i + 1)); [ "$i" -lt 90 ] || { echo "Jellyfin ne répond pas" >&2; docker logs --tail 20 "$NAME" >&2; exit 1; }
      sleep 2
    done
    echo "$NAME : http://127.0.0.1:$PORT"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "$NAME retiré" || echo "$NAME n'existait pas"
    ;;
  plugin)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # Un seul dossier Lumen à la fois : deux versions côte à côte, et Jellyfin choisit seul laquelle charger.
    rm -rf $DATA/config/data/plugins/Lumen_* $DATA/config/data/plugins/Lumen
    mkdir -p $DATA/config/data/plugins
    cp -r plugin/dist/Lumen_* $DATA/config/data/plugins/
    exec "$0" up
    ;;
  noplugin)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf $DATA/config/data/plugins/Lumen_*
    exec "$0" up
    ;;
  setup)
    # Ce que l'assistant de premier lancement ferait à la main : un compte administrateur de banc (mot de
    # passe tiré au hasard, gardé dans $DATA/admin.env et jamais affiché), une bibliothèque de films et une
    # de séries sur les dossiers montés, sans rien écrire à côté des médias, puis le premier scan.
    B="http://127.0.0.1:$PORT"
    J='Content-Type: application/json'
    C='Authorization: MediaBrowser Client="lumen-banc", Device="banc", DeviceId="lumen-banc-1", Version="0.1.0"'
    if curl -s "$B/System/Info/Public" | grep -q '"StartupWizardCompleted":true'; then echo "déjà préparé" >&2; exit 0; fi
    PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
    curl -sf -o /dev/null -X POST "$B/Startup/Configuration" -H "$J" -H "$C" -d '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}'
    curl -sf -o /dev/null "$B/Startup/User" -H "$C"
    curl -sf -o /dev/null -X POST "$B/Startup/User" -H "$J" -H "$C" -d "{\"Name\":\"banc\",\"Password\":\"$PW\"}"
    curl -sf -o /dev/null -X POST "$B/Startup/RemoteAccess" -H "$J" -H "$C" -d '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}'
    curl -sf -o /dev/null -X POST "$B/Startup/Complete" -H "$C"
    R=$(curl -sf -X POST "$B/Users/AuthenticateByName" -H "$J" -H "$C" -d "{\"Username\":\"banc\",\"Pw\":\"$PW\"}")
    TOKEN=$(printf '%s' "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessToken"])')
    USERID=$(printf '%s' "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["User"]["Id"])')
    (umask 077; printf 'JF_URL=%s\nJF_USER=banc\nJF_PASSWORD=%s\nJF_TOKEN=%s\nJF_USERID=%s\n' "$B" "$PW" "$TOKEN" "$USERID" > "$DATA/admin.env")
    A="Authorization: MediaBrowser Token=\"$TOKEN\""
    OPTS='{"LibraryOptions":{"EnableRealtimeMonitor":false,"EnableChapterImageExtraction":false,"ExtractChapterImagesDuringLibraryScan":false,"EnableTrickplayImageExtraction":false,"SaveLocalMetadata":false,"SaveSubtitlesWithMedia":false,"SaveLyricsWithMedia":false,"SaveTrickplayWithMedia":false,"MetadataSavers":[],"PathInfos":[]}}'
    for lib in "Films movies movies" "Series tvshows tv"; do
      set -- $lib
      [ -d "$MEDIA_ROOT/$3" ] && grep -q "^$3/" "$DATA/dossiers.txt" || continue
      curl -sf -o /dev/null -X POST "$B/Library/VirtualFolders?name=$1&collectionType=$2&paths=%2Fmedia%2F$3&refreshLibrary=false" -H "$J" -H "$A" -d "$OPTS"
    done
    # Le transcodage dans le dossier monté pour lui, et pas de sous-titres d'office sur le compte du banc
    # (un sous-titre incrusté ferait transcoder l'image et fausserait toute comparaison).
    curl -sf "$B/System/Configuration/encoding" -H "$A" | python3 -c 'import sys,json;d=json.load(sys.stdin);d["TranscodingTempPath"]="/transcode";print(json.dumps(d))' | curl -sf -o /dev/null -X POST "$B/System/Configuration/encoding" -H "$J" -H "$A" -d @-
    curl -sf "$B/Users/$USERID" -H "$A" | python3 -c 'import sys,json;c=json.load(sys.stdin)["Configuration"];c["SubtitleMode"]="None";print(json.dumps(c))' | curl -sf -o /dev/null -X POST "$B/Users/Configuration?userId=$USERID" -H "$J" -H "$A" -d @- || curl -sf "$B/Users/$USERID" -H "$A" | python3 -c 'import sys,json;c=json.load(sys.stdin)["Configuration"];c["SubtitleMode"]="None";print(json.dumps(c))' | curl -sf -o /dev/null -X POST "$B/Users/$USERID/Configuration" -H "$J" -H "$A" -d @-
    # Deux scans de suite. Après le premier, Jellyfin 10.11 tient les épisodes mais ne les rattache pas
    # encore à leur série : `/Shows/{id}/Episodes` rend une liste vide, et jellyfin-web, qui la demande
    # avant de lire un épisode, répond « Unable to find a valid media source ». Le second les rattache.
    for pass in 1 2; do
      curl -sf -o /dev/null -X POST "$B/Library/Refresh" -H "$A"
      i=0
      while :; do
        state=$(curl -s "$B/ScheduledTasks" -H "$A" | python3 -c 'import sys,json;print([t["State"] for t in json.load(sys.stdin) if t["Key"]=="RefreshLibrary"][0])')
        [ "$state" = Idle ] && [ "$i" -gt 2 ] && break
        i=$((i + 1)); [ "$i" -lt 200 ] || { echo "le scan ne finit pas" >&2; exit 1; }
        sleep 3
      done
    done
    n=$(curl -s "$B/Items?Recursive=true&IncludeItemTypes=Movie,Episode&UserId=$USERID&Limit=0" -H "$A" | python3 -c 'import sys,json;print(json.load(sys.stdin)["TotalRecordCount"])')
    echo "préparé : $n films et épisodes"
    ;;
  *) echo "usage : $0 up|down|plugin|noplugin|setup" >&2; exit 2 ;;
esac
