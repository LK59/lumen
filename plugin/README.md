# Le plugin Jellyfin « Lumen »

Il fait lire à jellyfin-web les fichiers **tels qu'ils sont** : le navigateur remuxe et décode le son lui-même
(`lumen-core`), et le serveur n'envoie que des octets. Un fichier que Lumen ne sait pas lire est lu comme avant,
par le lecteur ordinaire de jellyfin-web.

Deux parties :

| Dossier | Langage | Rôle |
|---|---|---|
| `web/` | TypeScript | Le pont : un script qui fait de Lumen un lecteur de jellyfin-web. Voir [`docs/pont-jellyfin-web.md`](../docs/pont-jellyfin-web.md) |
| `server/` | C# (.NET 8, pour Jellyfin 10.10 et suivants) | Le plugin Jellyfin. **Aucun calcul côté serveur** : il livre les fichiers du lecteur, les annonce à jellyfin-web, et tient les réglages |

## Ce que fait le plugin serveur

- Il sert les fichiers du lecteur (`/Lumen/web/…`) depuis le dossier `web/` livré à côté de son assemblage.
- Il sert deux fichiers du client web avec ce qu'il faut pour que Lumen y soit un lecteur : la page d'entrée
  (`/web/`, `/web/index.html`) avec une balise `<script>` en tête, et `/web/config.json` avec le nom du lecteur
  dans sa liste `plugins`. Les fichiers du client web ne sont **jamais modifiés sur le disque** : désactiver ou
  retirer le plugin les rend tels quels.
- Il répond à `/Lumen/Settings` (authentifié) : Lumen lit-il pour le compte qui demande, et ses lectures
  sont-elles journalisées ?
- Sa page de réglages (Tableau de bord → Plugins → Lumen, en anglais) : le plugin activé ou non, Lumen qui lit
  ou qui laisse lire, pour tous les comptes ou seulement certains, et le journal des lectures.
- Il tient ce journal quand on l'allume : chaque lecture du client web, avec ce que le spectateur a attendu et
  le processeur que ffmpeg a consommé sur le serveur. Décocher « Play with Lumen » laisse jellyfin-web lire seul
  tout en journalisant : c'est ainsi qu'on compare « avec » et « sans », sur les lectures réelles.

Il n'utilise aucun autre plugin (ni *File Transformation*, ni *JavaScript Injector*) et ne modifie pas le code
du serveur en mémoire : il inscrit un `IStartupFilter`, la porte qu'ASP.NET laisse à tout service inscrit au
démarrage.

## Construire

Tout passe par Docker.

```sh
plugin/package.sh                                    # → plugin/dist/
REPO_URL=https://exemple.test/lumen plugin/package.sh   # pour un dépôt de plugins publié
```

`plugin/dist/` contient le dossier du plugin (`Lumen_<version>/`), son archive, et un `manifest.json` de dépôt de
plugins. La version de Jellyfin visée est dans `server/Directory.Build.props` : c'est celle des paquets NuGet
`Jellyfin.Controller` et `Jellyfin.Model`, et du `targetAbi` annoncé.

## Installer

- **À la main** : copier `Lumen_<version>/` dans le dossier des plugins du serveur (`<données>/plugins/`), puis
  redémarrer Jellyfin.
- **Par le dépôt de plugins** : dans Tableau de bord → Plugins → Dépôts, ajouter
  `https://raw.githubusercontent.com/LK59/lumen/main/manifest.json`, puis installer Lumen depuis le catalogue et
  redémarrer. `plugin/publish.sh --push` y publie une nouvelle version (le manifeste et l'archive seulement).

Après l'installation, recharger la page du client web. La console du navigateur dit ce que fait Lumen
(`[Lumen] prêt`, `[Lumen] lecture — …`, `[Lumen] refus, lecture par jellyfin-web — <motif>`), et
`window.Lumen.status()` rend son état.

## Vérifier

```sh
tools/test-jellyfin.sh plugin            # un Jellyfin jetable avec le plugin installé
plugin/web/navigateur/pont.sh plugin     # le parcours d'un spectateur, dans le vrai jellyfin-web
tools/test-jellyfin.sh down
```

Le parcours ouvre chaque titre, saute par la barre de jellyfin-web, change de piste son et de sous-titres par ses
menus, arrête, et relève ce que le serveur en a vu : méthode de lecture, position de reprise, lancements de
ffmpeg. `pont.sh main` joue le même parcours sans plugin, le script injecté à la main ; `LUMEN_OFF=1` le joue
quand « Play with Lumen » est décoché. `navigateur/reglages.mjs` ouvre la page de réglages et rend ce qu'elle
montre.

## Limites connues

- Vérifié sur Jellyfin **10.10.7, 10.11.11, 12.0, 12.2 et 12.4** (`lumen-core/benches/` et
  `plugin/web/navigateur/`). Le pont s'appuie sur le fonctionnement interne du lecteur
  vidéo de jellyfin-web ; avec une version où il ne se laisse plus étendre, Lumen se désactive en le disant dans
  la console, et jellyfin-web lit seul.
- Les sous-titres restent ceux de jellyfin-web : pour une piste du fichier, le serveur l'extrait à la demande.
  Les sous-titres texte sont calés sur l'image ; ASS et PGS la devancent d'environ 0,2 s.
- Les applications qui affichent jellyfin-web dans une vue web reçoivent le même script ; elles n'ont pas été
  essayées.
