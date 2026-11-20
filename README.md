<img src="plugin/logo.png" alt="Lumen" width="96" align="right">

# Lumen for Jellyfin

Lumen is a Jellyfin plugin that lets the web client play files the server would otherwise have to remux or
transcode. The server sends the file as it is, by byte ranges. The browser repackages it on the fly for its own
`<video>` element and decodes only the audio it cannot play natively.

A file Lumen cannot play is handed back to the regular Jellyfin player, with the reason logged.

![Lumen settings and playback log](plugin/screenshot.png)

## What it does, step by step

When the Jellyfin web client cannot play a file directly (an MKV container, a DTS or TrueHD track), the server
starts ffmpeg to produce an HLS stream. That costs a few seconds before the first frame, a restart whenever you
seek outside what is already produced, and CPU time on the server for as long as you watch.

With Lumen, for the same file:

1. The web client asks Lumen whether it can play the file. Lumen opens it over HTTP range requests, reads the
   container header and index, and checks each track against what this browser can decode.
2. If it can, the server is asked for the raw file (`static=true`), and never starts ffmpeg.
3. In the browser, Lumen reads the Matroska or MP4 container and rewrites the samples into fragmented MP4,
   which it feeds to the `<video>` element through Media Source Extensions. The video samples are copied
   byte for byte: decoding and display are the browser's, exactly as in a direct play.
4. Audio the browser can play is copied as well. Audio it cannot play is decoded in the browser by FFmpeg
   decoders compiled to WebAssembly (in a worker), then re-encoded to AAC or Opus with the browser's own
   `AudioEncoder`.
5. Seeking reads the container index and fetches the bytes at the target. Nothing is restarted on the server.

If Lumen cannot play the file, the web client negotiates with the server as usual and its regular player takes
over, transcoding included.

## What it can play

Lumen never decodes video. A file plays through Lumen when the browser can decode its video codec and Lumen can
carry its container and audio.

| | Played through Lumen | Handed back to the regular player |
|---|---|---|
| Containers | Matroska (MKV), MP4 including fragmented MP4 | everything else (AVI, MPEG-TS, DVD and Blu-ray folders, ISO), live TV |
| Video, if the browser decodes it | H.264, HEVC 8-bit and 10-bit, AV1 | VP8, VP9, MPEG-2, MPEG-4 ASP, VC-1 |
| HDR | HDR10, and Dolby Vision with a base layer, passed to the browser and the display unchanged | Dolby Vision profile 5 (no base layer), Dolby Vision over AV1 |
| Audio copied as it is | AAC, Opus, FLAC, and AC-3 or E-AC-3 where the browser plays them | |
| Audio decoded in the browser, then re-encoded | TrueHD and MLP, DTS and DTS-HD, AC-3, E-AC-3, multichannel 24-bit FLAC, PCM | MP2 |

Details worth knowing:

- **HDR is not converted.** Lumen does no tone mapping. An HDR file on an SDR screen is shown as the browser
  shows it, or goes to the server if you rely on the server's tone mapping.
- **Multichannel audio** that had to be decoded stays multichannel after re-encoding. On Apple devices, 7.1 is
  folded to 5.1.
- **Atmos and DTS:X**: the channel bed is decoded, the objects are not rendered.
- **Audio that starts after the picture** is padded with silence so that playback starts on the first frame.
- **Changing the audio track** reopens the stream on the new track at the current position.
- **Subtitles** are the web client's own, fetched from the server as usual.
- **Quality settings** are respected: if you cap the bitrate below the file's, the server refuses direct play and
  the regular player takes over. Lumen always reads the file at its original bitrate.

## What stays Jellyfin

Lumen is a regular player of the Jellyfin web client. It extends the built-in video player and replaces only its
source. The player interface, subtitle rendering, track menus, resume position, playback reporting and the
Playback Info panel are the web client's own, on the same `<video>` element. Playback Info names the player that
is actually playing and, when it is Lumen, shows what it does with the file.

On the server, the plugin does no media processing. It serves the player's files, adds one script tag to the web
client page and one entry to its `config.json` as they are served, and keeps its settings. It modifies no file
on disk, needs no other plugin, and works alongside plugins that modify the same page (File Transformation,
JavaScript Injector, themes). Disabling it gives you back the stock web client.

## Install

In Jellyfin, open Dashboard > Plugins > Repositories > New Repository and add:

```
https://raw.githubusercontent.com/LK59/lumen/main/manifest.json
```

Then install **Lumen** from the catalog, restart Jellyfin, and reload the web client.

Requires Jellyfin 12.4. The web client must be opened over HTTPS or on `localhost`: browsers only expose the
audio encoder in a secure context.

## Settings

Dashboard > Lumen:

- **Enable the plugin**: when off, the web client is served untouched.
- **Play with Lumen**: when off, the regular player does the playing while playbacks can still be logged. Flip it
  to compare playback with and without Lumen.
- **For all users**, or only the users you select.
- **Log playbacks** (off by default): records each playback on your server, with what the viewer waited for
  (first frame, each seek, stalls) and the CPU time ffmpeg spent on the server for that file. On files played both
  ways, the page shows how many times faster one player is than the other. The log stays on your server.

The browser console also says what Lumen is doing (`[Lumen] ...`), including why it declined a file.

## Limits and status

- Lumen acts only in the Jellyfin web client. Native apps with their own player are not affected.
- It was written and tested against Jellyfin 12.4.0, with Chromium and Firefox on desktop. Safari and the mobile
  apps have not been tried yet.
- It relies on the internals of the web client's video player, which has no public extension interface. With a
  version where that player can no longer be extended, Lumen turns itself off and says so in the console.
- A network outage during playback is reported to the web client as a playback error.

## Source

| Folder | Contents |
|---|---|
| [`lumen-core/`](lumen-core/README.md) | The playback engine (TypeScript). It knows nothing about Jellyfin: a URL that honours `Range` in, a playing `<video>` out. Containers, remux, Media Source handling, audio decoding and re-encoding, with its test suite |
| [`plugin/web/`](plugin/README.md) | The bridge that makes the engine a Jellyfin web player (TypeScript) |
| [`plugin/server/`](plugin/README.md) | The Jellyfin plugin (C#, .NET 10) |
| [`docs/`](docs/pont-jellyfin-web.md) | How the bridge fits into the Jellyfin web client |
| `tools/test-jellyfin.sh` | A disposable Jellyfin for the browser tests |
| `manifest.json`, `releases/` | The plugin repository that Jellyfin reads |

Everything builds and runs through Docker; nothing is installed on the host. `plugin/package.sh` builds the
engine, the bridge and the plugin, and produces the plugin folder and its archive. The code comments and the
developer documentation are in French.

## Licenses

Lumen is the playback engine of [Laterna](https://github.com/LK59/laterna), released under AGPL-3.0.

The plugin archive includes audio decoders built from FFmpeg 7.1.5 (LGPL) compiled to WebAssembly, and libFLAC
(BSD) through `@wasm-audio-decoders/flac` (MIT). The scripts that build the FFmpeg decoders are in the Laterna
repository, under `tools/truehd-wasm`, `tools/ac3dts-wasm` and `tools/aac-wasm`.
