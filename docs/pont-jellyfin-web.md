# Le pont jellyfin-web

Comment Lumen devient un lecteur de jellyfin-web, et sur quoi cela repose. Tout ce qui suit a été **lu dans le
client web livré avec Jellyfin 12.4.0** (`/usr/share/jellyfin/web`, fichiers `main.jellyfin.bundle.js` et
`htmlVideoPlayer-plugin.*.chunk.js`) : jellyfin-web n'a pas d'API publique pour les lecteurs, c'est son
fonctionnement interne. Une autre version peut différer ; le pont vérifie chaque hypothèse à l'exécution et se
retire en le disant dans la console quand l'une tombe.

## Ce que fait jellyfin-web

**Il charge ses plugins par leur nom.** La liste vient de `config.json` (`plugins`), demandée par `fetch`. Pour
chaque nom : s'il existe dans `window`, `window[nom]` doit être une fonction (éventuellement asynchrone) qui rend
la classe du plugin, construite avec `{ events, playbackManager, ServerConnections, appSettings, … }` ; sinon il
importe son propre fichier. Les applications qui embarquent jellyfin-web ajoutent leurs noms par
`window.NativeShell.getPlugins()`.

**Il choisit un lecteur par ordre de priorité.** Les plugins de type `mediaplayer` sont triés par `priority`
croissante. Pour un élément, le premier lecteur local dont `canPlayMediaType(type)` puis `canPlayItem(item)` (si
elle existe) répondent vrai est pris. Le lecteur vidéo de jellyfin-web (`htmlvideoplayer`) a la priorité 1 et pas
de `canPlayItem`.

**Il négocie la lecture avec le profil du lecteur choisi.** `lecteur.getDeviceProfile(item)` (asynchrone), puis
`PlaybackInfo` auprès du serveur. Si le serveur accepte la lecture directe, l'adresse est
`Videos/{id}/stream.{conteneur}?Static=true&mediaSourceId=…&deviceId=…&ApiKey=…` et `playMethod` vaut
`DirectPlay` ; sinon c'est l'adresse de transcodage. Puis `lecteur.play(streamInfo)`.

**Le lecteur vidéo pose la source dans `setCurrentSrc(élément, streamInfo)`** : hls.js pour du HLS, sinon
`élément.src = adresse` puis `élément.play()`. Avant cela, la même méthode prépare les sous-titres, la piste son
et l'état que le reste du lecteur relit.

**Après une erreur de lecture, il renégocie** (`onPlaybackError`) : si le serveur sait transcoder ce fichier, il
redemande `getDeviceProfile(item, { isRetry: true })` et un flux avec `EnableDirectPlay: false` — et, pour un
fichier local, sans copie de la vidéo — puis rappelle `play`.

**Un saut** appelle `lecteur.currentTime(ms)` quand `lecteur.seekable()` répond vrai. **Un changement de piste
son** appelle `lecteur.setAudioStreamIndex` si `canSetAudioStreamIndex()` répond vrai ; sinon il renégocie le flux
à la position courante avec la piste voulue et rappelle `play`. **La progression** est rapportée au serveur par le
gestionnaire de lecture, à partir des événements du lecteur (`timeupdate`, `pause`, `stopped`…) et de
`currentTime()`.

## Ce que fait le pont

Un script classique (`lumen-jellyfin.js`), exécuté avant ceux de jellyfin-web.

1. **Il s'inscrit** en ajoutant son nom à la réponse de `config.json` et en définissant `window.lumenPlayer`.
   Pas par `NativeShell` : sa seule présence fait croire à jellyfin-web qu'une application l'embarque (il lui
   demande alors son profil d'appareil, son nom, son plein écran).
2. **Il hérite du lecteur vidéo de jellyfin-web.** Sa classe n'est exportée nulle part et n'est pas forcément
   chargée quand le plugin est construit : le lecteur Lumen naît donc vide, et se greffe sur `htmlvideoplayer` la
   première fois qu'on lui demande ce qu'il lit (prototype remplacé, constructeur rejoué sur l'objet). Priorité
   −1, et `canPlayItem` ne dit oui qu'aux fichiers vidéo de la bibliothèque.
3. **Il décide dans `getDeviceProfile`.** Il pose la question au moteur, sur le fichier (`probePlaybackPath`, puis
   `discard`). Accepté : le profil annonce la lecture directe de tout, et le serveur répond par le fichier brut.
   Refusé : c'est le profil de jellyfin-web, et tout se passe comme sans Lumen. Le verdict est gardé dix minutes.
4. **Il remplace la source dans `setCurrentSrc`.** La méthode d'origine est appelée sur un élément dont deux
   gestes sont détournés : poser `src` ne fait rien, et `play()` ouvre Lumen sur le vrai élément. Le reste —
   interface, sous-titres, volume, plein écran, rapports — est le code de jellyfin-web.
5. **Sauts** : `currentTime(ms)` passe par `playback.seek`. **Piste son** : `canSetAudioStreamIndex()` répond non
   pendant une lecture Lumen ; jellyfin-web renégocie et rappelle `setCurrentSrc`, qui rouvre sur la piste voulue
   — la reconstruction que le moteur exige de toute façon.
6. **Il rend la main.** Refus à la vérification : rien à faire, c'est le lecteur ordinaire. Échec à l'ouverture,
   ou moteur qui renonce en cours de film : erreur de lecture pour jellyfin-web, qui renégocie un transcodage.

## Les choix qui se discutent

- **Les sous-titres sont ceux de jellyfin-web.** Pour un fichier en lecture directe, le serveur extrait la piste
  demandée (un passage de ffmpeg sans décodage, puis mise en cache) et jellyfin-web l'affiche. Le moteur sait
  lire les sous-titres du fichier lui-même ; le brancher supprimerait ce dernier appel à ffmpeg, au prix d'un
  second affichage de sous-titres à maintenir.
- **L'image a ~0,2 s de retard sur l'horloge de l'élément** (décalage de présentation du remux), et les
  sous-titres que jellyfin-web reçoit du serveur sont datés sur l'horloge du fichier. Le pont décale donc de ce
  retard chaque réplique posée dans une piste de texte du navigateur. Les sous-titres ASS et PGS, dessinés par
  les moteurs de jellyfin-web sur leur propre horloge, gardent cette avance.
- **Un serveur qui refuse le fichier n'est pas un réseau absent.** Le moteur ne fait pas la différence et attend
  48 s que le réseau revienne. Le pont, prévenu de chaque refus (`rangeRefused`), rend la main à jellyfin-web au
  quatrième refus rapproché : il sait transcoder, lui. Une vraie coupure garde la patience du moteur, puis est
  rendue à jellyfin-web comme une erreur de lecture.
- **La piste son désignée par Jellyfin** est retrouvée par son rang parmi les flux son du fichier (les index de
  Jellyfin et les numéros de piste du conteneur ne se correspondent pas).

## Le jeton

Le flux `Videos/{id}/stream?static=true` est servi **sans authentification** par Jellyfin 12.4.0 (mesuré : 206
sans aucun en-tête). Le pont envoie tout de même `Authorization: MediaBrowser Token="…"` sur chaque requête, et
ne met jamais le jeton dans l'adresse.

## Versions de Jellyfin

Le pont et le plugin ont été essayés sur un serveur vierge de chaque version, avec le même parcours (lecture,
saut, piste son, sous-titres, reprise, refus) : **10.10.7, 10.11.11, 12.0, 12.2 et 12.4**. Un seul assemblage,
compilé pour 10.10 (.NET 8), se charge sur toutes : ce que le plugin demande au serveur n'a pas changé de forme,
et un assemblage .NET 8 tourne sous les .NET suivants. Les versions antérieures à 10.10 n'ont pas été essayées.

## Sous une politique de sécurité stricte

Le décodage du son demande `worker-src blob:` et `script-src 'wasm-unsafe-eval'`. Sans eux (essayé avec une
politique qui n'autorise que l'origine du serveur), le moteur refuse les fichiers dont le son doit être décodé,
avec un motif nommé, et jellyfin-web les lit ; ceux dont le son se copie restent lus par Lumen.

