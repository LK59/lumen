#!/bin/sh
# Le Jellyfin jetable des bancs : `lumen-test-jellyfin`, publié sur 127.0.0.1 seulement.
#
#   tools/test-jellyfin.sh up        # le (re)crée ; ses données restent dans test-jellyfin/config
#   tools/test-jellyfin.sh down      # l'arrête et le retire — à faire en fin de travail
#   tools/test-jellyfin.sh plugin    # y installe plugin/dist/Lumen_* (construit par plugin/package.sh), puis up
#   tools/test-jellyfin.sh noplugin  # retire le plugin, puis up
#
# Ce qu'il monte :
# - les dossiers listés dans test-jellyfin/dossiers.txt (un chemin par ligne, sous MEDIA_ROOT), en
#   LECTURE SEULE, au même chemin sous /media : seulement les titres des bancs, pas la médiathèque ;
# - lumen-core/dist et la page de test, sous le dossier de jellyfin-web (`/web/lumen-test/`) : la page
#   a ainsi l'origine de jellyfin-web, comme l'aura le plugin — ni CORS, ni interception ;
# - le dossier de transcodage dans test-jellyfin/transcode, sur disque. Pas en mémoire : Jellyfin, tel
#   qu'il est réglé d'origine, remuxe un fichier entier aussi vite que le disque le lit et ne supprime
#   rien avant la fin — 17 Go en deux minutes pour un film à 19 Mb/s. En mémoire (tmpfs), ces octets
#   comptent dans la limite du conteneur : au troisième titre d'un banc, le noyau tuait ffmpeg, et tous
#   les passages suivants échouaient sans autre message. Les bancs vident ce dossier entre deux passages.
#
# Processeur et mémoire bornés : un banc oublié ne prend pas la machine.
set -eu
cd "$(dirname "$0")/.."
NAME=lumen-test-jellyfin
PORT="${JF_PORT:-18096}"
# Le dossier des médias, sur l'hôte : obligatoire, il n'y a pas de bonne valeur par défaut.
MEDIA_ROOT="${MEDIA_ROOT:?MEDIA_ROOT : le dossier des médias sur l'hôte}"
# L'image de Jellyfin à essayer. Pour comparer à un serveur existant, lui donner l'empreinte de son image
# (`docker inspect <conteneur> --format '{{.Image}}'`) : la même version, quoi que `latest` vaille demain.
IMAGE="${JF_IMAGE:-lscr.io/linuxserver/jellyfin:latest}"

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    mkdir -p test-jellyfin/config test-jellyfin/transcode
    set --
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      set -- "$@" -v "$MEDIA_ROOT/$dir:/media/$dir:ro"
    done < test-jellyfin/dossiers.txt
    docker run -d --name "$NAME" --cpus="${JF_CPUS:-6}" --memory=8g -p "127.0.0.1:$PORT:8096" \
      -e PUID="$(id -u)" -e PGID="$(id -g)" -e TZ=Europe/Paris \
      -v "$PWD/test-jellyfin/config:/config" -v "$PWD/test-jellyfin/transcode:/transcode" \
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
    rm -rf test-jellyfin/config/data/plugins/Lumen_* test-jellyfin/config/data/plugins/Lumen
    mkdir -p test-jellyfin/config/data/plugins
    cp -r plugin/dist/Lumen_* test-jellyfin/config/data/plugins/
    exec "$0" up
    ;;
  noplugin)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf test-jellyfin/config/data/plugins/Lumen_*
    exec "$0" up
    ;;
  *) echo "usage : $0 up|down|plugin|noplugin" >&2; exit 2 ;;
esac
