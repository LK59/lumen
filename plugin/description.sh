# Ce que le catalogue de plugins de Jellyfin affiche pour Lumen. Lu par package.sh (une version construite)
# et par publish.sh, qui le remet dans le manifeste publié même sans nouvelle version.
# La description est celle de Plugin.cs : Jellyfin montre celle-là une fois le plugin installé, et deux
# textes tenus à la main avaient divergé (le catalogue donnait les mesures, la page du plugin non).
OVERVIEW="Playback without server-side transcoding for the web client."
DESCRIPTION=$(sed -n 's/.*override string Description => "\(.*\)";.*/\1/p' plugin/server/Plugin.cs)
[ -n "$DESCRIPTION" ] || { echo "Description introuvable dans plugin/server/Plugin.cs" >&2; exit 1; }
