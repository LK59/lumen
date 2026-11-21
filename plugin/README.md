# The Jellyfin plugin

It lets the Jellyfin web client play files **as they are**: the browser remuxes them and decodes the audio
itself (`lumen-core`), and the server only sends bytes. A file Lumen cannot play is played as before, by the web
client's regular player.

Two parts:

| Folder | Language | Role |
|---|---|---|
| `web/` | TypeScript | The bridge: a script that makes Lumen a player of the Jellyfin web client. See [`docs/jellyfin-web-bridge.md`](../docs/jellyfin-web-bridge.md) |
| `server/` | C# (.NET 8, for Jellyfin 10.10 and later) | The Jellyfin plugin. **No media processing on the server**: it delivers the player's files, announces them to the web client, and keeps the settings |

## What the server plugin does

- It serves the player's files (`/Lumen/web/...`) from the `web/` folder shipped next to its assembly.
- It completes two responses of the web client as they are served: the entry page (`/web/`,
  `/web/index.html`) gets a `<script>` tag at the top, and `/web/config.json` gets the player's name in its
  `plugins` list. These responses are produced by the rest of the server and completed on the way out, so what
  other plugins did to the same page is preserved. **No file is modified on disk**: disabling or removing the
  plugin gives them back unchanged.
- It answers `/Lumen/Settings` (authenticated): does Lumen play for the user who asks, and are their playbacks
  logged?
- Its settings page (Dashboard > Lumen): the plugin on or off, Lumen playing or stepping aside, for all users or
  only some, the playback log, and a one-click update.
- It keeps the playback log when it is turned on: each playback of the web client, with what the viewer waited
  for and the CPU time ffmpeg spent on the server. Unchecking "Play with Lumen" lets the regular player play
  while still logging, which is how "with" and "without" are compared on real playbacks.

It needs no other plugin and does not patch the server in memory: it registers an `IStartupFilter`, the door
ASP.NET leaves open to any service registered at startup.

## Building

Everything runs through Docker.

```sh
plugin/package.sh                                      # -> plugin/dist/
REPO_URL=https://example.test/lumen plugin/package.sh  # for a published plugin repository
```

`plugin/dist/` holds the plugin folder (`Lumen_<version>/`), its archive, and a plugin repository
`manifest.json`. The oldest Jellyfin version served is set in `server/Directory.Build.props`: it is the version
of the `Jellyfin.Controller` and `Jellyfin.Model` NuGet packages, and the announced `targetAbi`. A single
assembly built for 10.10 runs on the later versions.

## Installing

- **From the plugin repository:** in Dashboard > Plugins > Repositories, add
  `https://raw.githubusercontent.com/LK59/lumen/main/manifest.json`, install Lumen from the catalog, restart.
- **By hand:** copy `Lumen_<version>/` into the server's plugin folder (`<data>/plugins/`), then restart
  Jellyfin.

After installing, reload the web client page. The browser console says what Lumen is doing (`[Lumen] ...`), and
`window.Lumen.status()` returns its state.

## Checking

```sh
MEDIA_ROOT=/path/to/media tools/test-jellyfin.sh plugin   # a disposable Jellyfin with the plugin installed
plugin/web/navigateur/pont.sh plugin                      # a viewer's scenario, in the real web client
tools/test-jellyfin.sh down
```

The scenario opens each title, seeks with the web client's position bar, changes the audio track and the
subtitles through its menus, stops, and records what the server saw: play method, resume position, ffmpeg
launches. `pont.sh main` runs it without the plugin, with the script injected by hand; `LUMEN_OFF=1` runs it
with "Play with Lumen" unchecked. In the same folder: `reglages.mjs` (the settings page), `sous-titres.mjs`
(when a subtitle cue appears on screen), `repli.mjs` (handover when the server refuses the file, or under a
strict Content Security Policy), `panneau.mjs` (the Playback Info panel), `saut-charge.mjs` (a seek inside what
is already loaded), `ouverture.mjs` (an opening from the start or resumed, step by step), `cas-limites.mjs` (resume, seeks in a row, track change while paused, end of file, a source
lost during playback or pause, a TV's user agent).

`tools/test-jellyfin.sh` takes `JF_IMAGE` (the Jellyfin image) and `JF_DATA` (one data folder per version
tried), and `setup` prepares a fresh server: this is how each Jellyfin version is checked before a release.

## Known limits

- Checked on Jellyfin **10.10.7, 10.11.11, 12.0, 12.2 and 12.4**. The bridge relies on the internals of the web
  client's video player; with a version where that player can no longer be extended, Lumen turns itself off,
  says so in the console, and the web client plays alone.
- Subtitles are the web client's own: for a track of the file, the server extracts it on demand. Text subtitles
  are aligned with the picture; ASS and PGS lead it by about 0.2 s.
- Apps that display the web client in a web view receive the same script. The Jellyfin iOS app has been used on
  an iPhone; in the Android app, Lumen applies when the web player is selected in the app's settings. On TVs and game consoles, recognised by their browser's user
  agent, Lumen leaves playback to the regular player.
