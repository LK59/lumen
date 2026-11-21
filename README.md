<img src="plugin/logo.png" alt="Lumen" width="96" align="right">

# Lumen for Jellyfin

[![tests](https://github.com/LK59/lumen/actions/workflows/tests.yml/badge.svg)](https://github.com/LK59/lumen/actions/workflows/tests.yml)

Lumen is the playback engine of [Laterna](https://github.com/LK59/laterna), plugged into the Jellyfin web client.
How the engine is built is told on [laterna.fr](https://laterna.fr/en/lumen/).

Most libraries are MKV, and most browsers do not take Matroska in a `<video>` element. So when the Jellyfin web
client plays such a file, the server runs ffmpeg to repackage it, even when the browser could decode the video as
it is. Often the audio has to be transcoded too: no browser decodes DTS or TrueHD, and only some play AC-3 and
E-AC-3.

Lumen does both in the browser:

- **Remuxing.** The server sends the file as it is, by byte ranges, and the browser repackages it on the fly for
  its own `<video>` element. The video stays exactly as it is in the file.
- **Audio transcoding.** Audio the browser cannot play is decoded in the browser and re-encoded with the
  browser's own encoder, to AAC or Opus.

For these files the server only serves bytes:

- **Playback starts sooner**, because nothing waits for ffmpeg to start.
- **Seeking is faster**, because there is no stream to restart on the server.
- **Changing the audio track is faster**, for the same reason: Lumen reopens its own stream on the new track,
  in the browser.
- **The server's CPU stays free**: no ffmpeg runs for the video or the audio. The saving is largest on files
  whose audio the server had to transcode; where it only repackaged the file, the gain is in the start and the
  seeks.

Anything else is played by the regular Jellyfin player, as before. The reason is shown in the browser console
and in the playback log.

![Lumen settings](plugin/screenshot.png)

## Measured

On files the server would otherwise repackage or transcode, Lumen showed the first frame 2 to 4 times sooner,
seeked 3 to 4 times faster, and changed audio track about 8 times faster.

Each figure is Lumen against the regular player on the same files, as a median, taken from the plugin's own
playback log on a real library. Each device is measured on its own:

| | iPhone, Jellyfin iOS app | Chrome on Windows |
|---|---|---|
| First frame | 1.0 s against 3.8 s (4 times sooner) | 1.7 s against 3.6 s (2 times sooner) |
| Seek | 1.0 s against 2.7 s (3 times faster) | 0.5 s against 2.2 s (4 times faster) |
| Audio track change | 0.7 s against 6.1 s (8 times faster) | 0.6 s against 5.0 s (8 times faster) |
| ffmpeg CPU on the server, per playback | 0.6 s against 7.5 s | none against 5.6 s |
| Measured on | 8 files, 24 playbacks, 58 seeks, 17 track changes | 6 files, 19 playbacks, 66 seeks, 16 track changes |

What the server was doing for the regular player makes the difference:

- **Files that only needed a new container** (five on the iPhone, HEVC with Dolby audio it plays natively, some
  in Dolby Vision): the first frame came 4 times sooner and seeks were twice as fast. The server spent little
  CPU either way, since it was copying streams.
- **Files whose audio the server had to transcode** (DTS and TrueHD on the iPhone; the six files on Chrome,
  which plays no Dolby or DTS audio): the first frame came 2 to 2.5 times sooner, seeks were 4 to 4.5 times
  faster, and ffmpeg's CPU time went to none.
- **Files the regular player already plays as they are** (two more on Chrome, with no ffmpeg at all): the two
  players are equivalent, as there is nothing to save.

Over these tests Lumen played 48 playbacks, 123 seeks and 32 audio track changes without an error and without
handing a playback back to the regular player.

The figures depend on the server, the network and the files. The playback log gives you the same comparison on
your own library and devices.

## A complete engine, light on the client

Lumen handles the whole chain that feeds the `<video>` element. It reads the file by byte ranges, demuxes
Matroska and MP4, writes fragmented MP4, manages the Media Source buffers (seeks, buffer limits per browser,
recovery after a decode error) and runs its own audio pipeline. That is about 20,000 lines of TypeScript with a
test suite of the same size.

The engine is not new. It comes from [Laterna](https://github.com/LK59/laterna), a self-hosted cinema front end
for Jellyfin, where it is the player. There it has played more than 3,000 sessions of over 800 titles for 25
viewers since September 2026, about 650 hours: on iPhone, iPad, Mac, Windows and Android, in Safari, Chrome,
Firefox and Edge.

On the viewer's device it stays light:

- **The browser decodes the video.** Lumen copies the video samples byte for byte, and the browser's own
  `<video>` element decodes and displays them with its hardware decoder, exactly as in a direct play.
- **The CPU work is the audio, and only when needed.** Copying samples costs next to nothing. When an audio
  track has to be transcoded, the FFmpeg decoders run in a worker, off the page's main thread, and the encoding
  is done by the browser's own encoder.
- **The download is small.** The browser loads about 450 KB of script before the first playback. The audio
  decoders are separate files of 0.5 to 1 MB each, fetched only when a file needs them. The whole plugin archive
  is 1.3 MB.

## How it works

1. The web client asks Lumen whether it can play the file. Lumen opens it over HTTP range requests, reads the
   container header and index, and checks each track against what this browser can decode.
2. If it can, the server is asked for the raw file, and starts no ffmpeg for the video or the audio.
3. Lumen reads the Matroska or MP4 container and rewrites the samples into fragmented MP4, fed to the
   `<video>` element through Media Source Extensions. Video samples are copied byte for byte.
4. Audio the browser can play is copied too. Audio it cannot play is decoded by FFmpeg decoders compiled to
   WebAssembly, in a worker, then re-encoded to AAC or Opus with the browser's own `AudioEncoder`.
5. A seek reads the container index and fetches the bytes at the target.

If Lumen cannot play the file, the web client negotiates with the server as usual and its regular player takes
over, transcoding included. If playback breaks midway, for instance when a phone closes the page's media source
in the background, Lumen reopens the file at the same position; if that keeps failing, the regular player takes
over there.

## Where it applies

- Lumen acts in the Jellyfin web client: Chrome, Edge, Firefox and Safari.
- It also acts in the Jellyfin mobile apps, which play through the same web player: the iOS app as it is, and
  the Android app once the web player is selected in its settings. Apps that play with their own native player
  are not affected.
- On TVs and game consoles, playback stays with the regular player. Their Jellyfin apps show the same web
  client, but these devices already play most files as they are.
- Lumen plugs into the web client's own video player and checks that it has the methods it relies on. If a
  future version of the web client changes in a way Lumen does not recognise, it steps aside, says so in the
  console, and the web client plays as usual.
- If the server refuses the file during playback, Lumen hands over to the regular player within seconds. During
  a network outage it waits for the network to come back and resumes by itself. After 48 seconds without it,
  Lumen reopens the file at the same position once the network is back, and leaves it to the regular player
  if that fails.

## What it can play

A file plays through Lumen when the browser can decode its video codec and Lumen can carry its container and
audio. The video is always decoded by the browser.

| | Played through Lumen | Handed back to the regular player |
|---|---|---|
| Containers | Matroska (MKV), MP4 including fragmented MP4 | everything else (AVI, MPEG-TS, DVD and Blu-ray folders, ISO), live TV |
| Video, if the browser decodes it | H.264, HEVC 8-bit and 10-bit, AV1 | VP8, VP9, MPEG-2, MPEG-4 ASP, VC-1 |
| HDR | HDR10. Dolby Vision over HEVC: as Dolby Vision where the browser accepts it, otherwise on its HDR10 base layer | Dolby Vision without a base layer (profile 5), where the browser does not accept Dolby Vision |
| Audio copied as it is | AAC, Opus, FLAC, AC-3 and E-AC-3, each where the browser accepts it | |
| Audio decoded in the browser, then re-encoded | TrueHD and MLP, DTS and DTS-HD, and AC-3, E-AC-3 or FLAC where the browser does not accept them | MP2, MP3, Vorbis, PCM |

What happens to a given file depends on the browser, and Lumen asks the browser rather than assuming. Safari
plays AC-3, E-AC-3 and HEVC natively, so Lumen copies those as they are. Chrome does not play the Dolby audio
formats, so Lumen decodes them. A browser without an HEVC decoder gets the regular player for HEVC files.

Details:

- **HDR on an SDR screen** is converted by the browser and the system, as for any HDR video they play. Lumen
  helps them on one point: on Chrome and Edge under Windows or Linux with an SDR screen, it lowers the peak
  brightness the file announces, so that a title announcing a very high peak is not shown too dark.
- **Multichannel audio** that had to be decoded stays multichannel after re-encoding: 5.1 stays 5.1, and 7.1 is
  kept where the browser's encoder produces eight channels and folded to 5.1 elsewhere (always on Apple
  systems). For Atmos and DTS:X, you get the channel bed. Re-encoding is lossy, as a server transcode is.
- **Audio that starts well after the picture** is padded with silence, so playback starts on the first frame.
- **Changing the audio track** reopens the stream on the new track at the current position.
- **Subtitles** are the web client's own. As usual, the server extracts an embedded track when you select one.
  Text subtitles are aligned with the picture; ASS and image subtitles (PGS) are drawn by the web client's own
  renderers and can lead the picture by about 0.2 s.
- **Quality settings** are respected. Lumen always reads the file at its original bitrate, so if you cap the
  bitrate below the file's, the regular player takes over.

## What stays Jellyfin

Lumen registers as a player in the Jellyfin web client. It extends the built-in video player and replaces only its
source. The player interface, subtitles, track menus, resume position, playback reporting and the Playback Info
panel are the web client's own. Playback Info names the player that is actually playing and, when it is Lumen,
shows what it does with the file.

On the server, the plugin does no media processing. It serves the player's files, adds its script to the web
client page and one entry to its `config.json` as they are served, and keeps its settings. It modifies no file
on disk, needs no other plugin, and works alongside plugins and themes that modify the same page. Disabling it
gives you back the stock web client.

## Install

In Jellyfin, open Dashboard > Plugins > Repositories > New Repository and add:

```
https://raw.githubusercontent.com/LK59/lumen/main/manifest.json
```

Then install **Lumen** from the catalog, restart Jellyfin, and reload the web client.

- **Jellyfin 10.10 or later.** Checked on 10.10.7, 10.11.11, 12.0, 12.2 and 12.4.
- Open the web client over **HTTPS** or on `localhost`. Browsers only expose the audio encoder in a secure
  context: over plain HTTP, files whose audio must be transcoded go to the regular player.
- Transcoding audio needs a browser with an audio encoder, which in Safari means version 26 or later.
- If your reverse proxy sets a Content Security Policy, decoding audio needs `worker-src blob:` and
  `script-src 'wasm-unsafe-eval'`. Without them Lumen still plays the files whose audio it can copy and hands
  the others back.

To check that it works, play a file and open Playback Info in the player's settings menu: it names the player,
"Lumen" or the regular one, and what Lumen does with the file.

To update, open the Lumen page: it shows the running version and the latest one, with a button that installs it
and restarts Jellyfin. To remove it, uninstall it from Dashboard > Plugins and restart; the playback log, if you
used it, stays in the server's data folder under `lumen/`.

## Settings

Dashboard > Lumen:

- **Enable the plugin**: when off, the web client is served untouched.
- **Play with Lumen**: when off, the regular player plays while playbacks can still be logged. Turn it off to
  compare playback with and without Lumen.
- **For all users**, or only the users you select.
- **Log playbacks** (off by default): records each playback on your server, with the user, the title, what the
  viewer waited for (first frame, each seek, stalls) and, on Linux servers, the CPU time ffmpeg spent for that
  file. On files played both ways, the page shows how many times faster one player is than the other. The log
  stays on your server and is visible to administrators only.

The browser console also says what Lumen is doing (`[Lumen] ...`), including why it declined a file. The
messages are in English; the reason the engine gives for declining a file is in French.

## Source

| Folder | Contents |
|---|---|
| [`lumen-core/`](lumen-core/README.md) | The playback engine (TypeScript). It knows nothing about Jellyfin: a URL that honours `Range` in, a playing `<video>` out. Containers, remux, Media Source handling, audio decoding and re-encoding, with its test suite |
| [`plugin/web/`](plugin/README.md) | The bridge that makes the engine a Jellyfin web player (TypeScript) |
| [`plugin/server/`](plugin/README.md) | The Jellyfin plugin (C#) |
| [`docs/`](docs/jellyfin-web-bridge.md) | How the bridge fits into the Jellyfin web client |
| `tools/test-jellyfin.sh` | A disposable Jellyfin for the browser tests |
| `manifest.json`, `releases/` | The plugin repository that Jellyfin reads |

Everything builds and runs through Docker; nothing is installed on the host. The engine's and the bridge's tests
run on GitHub at every publication, and the plugin is built there (`.github/workflows/tests.yml`).
`plugin/package.sh` builds the engine, the bridge and the plugin, and produces the plugin folder and its
archive. The code comments are in French.

## Licenses

Lumen is released under AGPL-3.0, like [Laterna](https://github.com/LK59/laterna), which it comes from.

The plugin archive includes audio decoders built from FFmpeg 7.1.5 (LGPL) compiled to WebAssembly, and libFLAC
(BSD) through `@wasm-audio-decoders/flac` (MIT). The scripts that build the FFmpeg decoders are in the Laterna
repository, under `tools/truehd-wasm`, `tools/ac3dts-wasm` and `tools/aac-wasm`.
