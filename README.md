# Lumen for Jellyfin

Lumen makes the Jellyfin web client play files as they are. The browser remuxes the file for MediaSource and
decodes the audio it cannot play natively (TrueHD, DTS, AC-3, FLAC and others, in WebAssembly), so the server
only sends bytes: no ffmpeg, no transcoding, instant seeks. A file Lumen cannot play is played as before, by the
regular Jellyfin player.

This repository is the plugin repository: it holds the manifest and the plugin archives.

## Install

In Jellyfin, open Dashboard > Plugins > Repositories > New Repository and add:

```
https://raw.githubusercontent.com/LK59/lumen/main/manifest.json
```

Then install **Lumen** from the catalog, restart Jellyfin, and reload the web client.

Requires Jellyfin 12.4.

## Settings

Dashboard > Plugins > Lumen:

- **Enable the plugin**: when off, the web client is served untouched.
- **Play with Lumen**: when off, the regular player does the playing while playbacks can still be logged. Flip it
  to compare playback with and without Lumen.
- **For all users**, or only the users you select.
- **Log playbacks** (off by default): records each playback on your server, with what the viewer waited for
  (first frame, seeks, stalls) and the CPU time ffmpeg spent on the server. The log never leaves your server.

## What to expect

- Lumen runs in the Jellyfin web client. Native apps with their own player are not affected.
- Whether a file is played by Lumen depends on the browser: a browser that cannot decode the video codec
  (HEVC on some of them) gets the regular player, exactly as without the plugin.
- The browser console says what Lumen is doing (`[Lumen] ...`).
- This is an early version, written and tested against Jellyfin 12.4.0.

## Licenses

Lumen is the playback engine of [Laterna](https://github.com/LK59/laterna), released under AGPL-3.0.

The archive includes audio decoders built from FFmpeg 7.1.5 (LGPL) compiled to WebAssembly, and libFLAC
(BSD) through `@wasm-audio-decoders/flac` (MIT). The scripts that build the FFmpeg decoders are in the Laterna
repository, under `tools/truehd-wasm`, `tools/ac3dts-wasm` and `tools/aac-wasm`.
