# lumen-core

Le moteur de lecture Lumen, seul : il lit un fichier vidéo **tel qu'il est** depuis une adresse qui honore
`Range`, le remultiplexe en fMP4 pour MediaSource dans le navigateur, et décode lui-même le son que le
navigateur ne lit pas (TrueHD, DTS, AC-3, FLAC… en WebAssembly) avant de le réencoder avec l'`AudioEncoder`
du navigateur. Le serveur n'envoie que des octets.

Il ne sait rien de l'application qui l'héberge. Ce qu'il lui demande tient dans [`src/host.ts`](src/host.ts).

## Ce qu'il y a ici

| Dossier | Contenu |
|---|---|
| `src/index.ts` | L'API publique — tout ce qu'un hôte a le droit d'importer |
| `src/host.ts` | Ce que l'hôte fournit : en-têtes des requêtes (jeton), règle de fin de session, nom du build, lien bridé pour les bancs |
| `src/engine/` | Le moteur : conteneurs (Matroska, MP4), remux, MediaSource, source d'octets, son |
| `src/engine/{truehd,ac3dts,aac}/` | Les décodeurs WebAssembly (FFmpeg) et le worker qui les fait tourner |
| `src/support/` | Modules sans dépendance dont le moteur se sert : détection du moteur de rendu, état du réseau, mesure du lien, choix de la piste son |
| `tests/` | La suite (Vitest) et ses fixtures |
| `benches/` | Les bancs d'identité à l'octet — voir [`benches/README.md`](benches/README.md) |
| `test-page/` | Une page qui lit un fichier depuis une adresse, son serveur à plages d'octets, et son parcours en vrai navigateur |

## Commandes

Rien ne s'installe sur l'hôte : tout passe par Docker, le dossier monté en volume.

```sh
run() { docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:26-alpine "$@"; }

run npm install        # une fois
run npx tsc --noEmit   # types
run npx vitest run     # tests
run node build.mjs     # dist/
```

`build.mjs` produit `dist/lumen-core.js` (module ES) et ses morceaux, et copie à côté, **octet pour octet**,
le worker et les modules WebAssembly que le moteur charge par leur adresse. Il relit ensuite ce qu'il a
émis et échoue si une adresse désignée par le code n'existe pas dans `dist/`, si un fichier copié diffère de
sa source, ou si un décodeur a été recopié dans un morceau. `dist/` se sert tel quel, à plat, depuis un seul
dossier.

## L'utiliser

```js
import { configureHost, probePlaybackPath } from "./dist/lumen-core.js";

configureHost({ requestHeaders: () => ({ Authorization: `MediaBrowser Token="${token}"` }) });

try {
  const probe = await probePlaybackPath({ streamUrl, startSeconds: 0, onError: (message, kind) => { /* … */ } });
  const playback = await probe.start(videoElement);
  await (playback.openingHold() ?? Promise.resolve());
  await videoElement.play();
  // playback.seek(s), .audioTracks, .requestAudioTrack(n), .subtitleTracks, .subtitleAt(t), .destroy()
} catch (refusal) {
  // Un refus est une erreur nommée : ce fichier n'est pas pour ce chemin, et le message dit pourquoi.
  // À l'hôte de passer la main à un autre lecteur.
}
```

Trois règles du contrat, que [`test-page/index.html`](test-page/index.html) montre en entier :

- les sauts passent par `playback.seek()`, pas par `video.currentTime` ;
- `requestAudioTrack()` peut répondre `"rebuild"` : l'hôte détruit alors la lecture et rouvre avec
  `audioTrackNumber` (aucun changement de piste dans un tampon vivant n'a tenu) ;
- la page doit être un contexte sécurisé (`https:` ou `localhost`) : sans lui, `AudioEncoder` n'existe pas.

## La page de test

```sh
docker run --rm --name lumen-test-page -p 127.0.0.1:8377:8377 -v "$PWD":/app:ro -v /chemin/des/medias:/media:ro \
  -e MEDIA_ROOT=/media -w /app node:26-alpine node test-page/serve.mjs
# puis http://localhost:8377/?url=/media/film.mkv
```

`test-page/parcours.mjs` joue le même parcours sans personne (Playwright) : ouverture, première image, deux
sauts, changement de piste son, et relève ce que le navigateur a réellement chargé et décodé.

## Origine

Le moteur vient de [Laterna](https://github.com/LK59/laterna) (`src/lib/webcodecs/`), dont il est extrait
sans changement de comportement : les bancs de `benches/` comparent ses sorties à celles de l'original, à
l'octet. Les commentaires du code renvoient à des documents de Laterna (`DECISIONS.md §…`, `DOC-TECH.md`).

AGPL-3.0, comme Laterna.
