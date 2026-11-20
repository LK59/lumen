#!/bin/sh
# Construit le plugin et l'empaquette comme Jellyfin l'attend.
#
#   plugin/package.sh                      # depuis la racine du dépôt
#   REPO_URL=https://exemple.test/lumen plugin/package.sh   # pour un dépôt de plugins publié
#
# Produit, dans plugin/dist/ :
#   Lumen_<version>/           le dossier du plugin, à déposer tel quel dans <config>/plugins/ :
#     Lumen.dll                  le livreur (aucun calcul côté serveur)
#     web/                       le pont, le moteur, son worker et ses décodeurs
#     meta.json                  ce que Jellyfin lit pour reconnaître le plugin
#   lumen_<version>.zip        la même chose, pour un dépôt de plugins
#   manifest.json              le dépôt de plugins (une entrée, cette version) — l'adresse à donner à
#                              Jellyfin est celle de ce fichier ; `sourceUrl` est REPO_URL + le nom du zip
#
# Tout passe par Docker : Node pour le moteur et le pont, le SDK .NET de la version de Jellyfin visée
# pour l'assemblage. Rien ne s'installe sur l'hôte.
set -eu
cd "$(dirname "$0")/.."
ROOT=$PWD
VERSION=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' plugin/server/Lumen.csproj)
ABI=$(sed -n 's:.*<JellyfinVersion>\(.*\)</JellyfinVersion>.*:\1:p' plugin/server/Directory.Build.props).0
GUID=$(sed -n 's/.*Guid\.Parse("\([^"]*\)").*/\1/p' plugin/server/Plugin.cs)
DOTNET_IMAGE="${DOTNET_IMAGE:-mcr.microsoft.com/dotnet/sdk:10.0}"
REPO_URL="${REPO_URL:-https://exemple.invalid/lumen}"
# Où Jellyfin téléchargera l'archive et l'image du catalogue : à côté du manifeste, sauf indication.
ARCHIVE_URL="${ARCHIVE_URL:-$REPO_URL}"
IMAGE_URL="${IMAGE_URL:-$REPO_URL/logo.png}"
# Ce que cette version change, en une ligne : c'est ce que le catalogue de Jellyfin montre.
CHANGELOG=$(sed -n 's:.*<PackageReleaseNotes>\(.*\)</PackageReleaseNotes>.*:\1:p' plugin/server/Lumen.csproj)
ME="$(id -u):$(id -g)"
node() { docker run --rm --user "$ME" -e HOME=/tmp -e npm_config_update_notifier=false -v "$ROOT":/app -w "/app/$1" node:26-alpine sh -c "$2"; }

echo "— moteur"
node lumen-core '[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null; node build.mjs >/dev/null'
echo "— pont"
node plugin/web '[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null; node build.mjs'
echo "— assemblage ($DOTNET_IMAGE, Jellyfin ${ABI%.0})"
# Le dossier du SDK (cache NuGet compris), gardé d'une construction à l'autre. Créé ici : monté sans
# exister, Docker le créerait au nom de root et le SDK, lancé sous notre compte, ne pourrait pas y écrire.
mkdir -p plugin/.nuget
docker run --rm --user "$ME" -e HOME=/home/build -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  -v "$ROOT/plugin/server":/src -v "$ROOT/plugin/.nuget":/home/build -w /src "$DOTNET_IMAGE" \
  dotnet build -c Release -o /src/bin/out --nologo -v quiet

OUT="plugin/dist/Lumen_$VERSION"
rm -rf plugin/dist && mkdir -p "$OUT/web"
cp plugin/server/bin/out/Lumen.dll "$OUT/"
# Les cartes de source ne sont pas livrées : elles triplent le poids pour un outil que le serveur n'a pas.
find plugin/web/dist -maxdepth 1 -type f ! -name '*.map' -exec cp {} "$OUT/web/" \;
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$OUT/meta.json" <<JSON
{
  "category": "General",
  "changelog": "$CHANGELOG",
  "description": "Plays files as they are: the browser remuxes them and decodes the audio, the server only sends bytes.",
  "guid": "$GUID",
  "name": "Lumen",
  "overview": "Playback without server-side transcoding for the web client.",
  "owner": "lumen",
  "targetAbi": "$ABI",
  "timestamp": "$STAMP",
  "version": "$VERSION",
  "status": "Active",
  "autoUpdate": false,
  "assemblies": ["Lumen.dll"]
}
JSON
ZIP="lumen_$VERSION.zip"
# Le zip se fait dans un conteneur : `zip` n'est pas forcément sur l'hôte. Fichiers à la racine de l'archive.
docker run --rm --user "$ME" -v "$ROOT/plugin/dist":/d -w "/d/Lumen_$VERSION" python:3-alpine \
  python -c "import zipfile,os;z=zipfile.ZipFile('/d/$ZIP','w',zipfile.ZIP_DEFLATED);[z.write(os.path.join(r,f)) for r,_,fs in sorted(os.walk('.')) for f in sorted(fs) if f!='meta.json'];z.close()"
MD5=$(md5sum "plugin/dist/$ZIP" | cut -d' ' -f1)
cat > plugin/dist/manifest.json <<JSON
[
  {
    "guid": "$GUID",
    "name": "Lumen",
    "description": "Plays files as they are: the browser remuxes them and decodes the audio, the server only sends bytes.",
    "overview": "Playback without server-side transcoding for the web client.",
    "owner": "lumen",
    "category": "General",
    "imageUrl": "$IMAGE_URL",
    "versions": [
      {
        "version": "$VERSION",
        "changelog": "$CHANGELOG",
        "targetAbi": "$ABI",
        "sourceUrl": "$ARCHIVE_URL/$ZIP",
        "checksum": "$MD5",
        "timestamp": "$STAMP"
      }
    ]
  }
]
JSON
echo "— plugin/dist/"
du -sh "$OUT" "plugin/dist/$ZIP" | sed 's/^/  /'
