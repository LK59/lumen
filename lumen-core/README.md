# lumen-core

The Lumen playback engine, on its own. It reads a video file **as it is** from a URL that honours `Range`,
remuxes it into fragmented MP4 for Media Source Extensions in the browser, and decodes the audio the browser
cannot play (TrueHD, DTS, AC-3, FLAC and others, in WebAssembly) before re-encoding it with the browser's own
`AudioEncoder`. The server only sends bytes.

It knows nothing about the application hosting it. What it asks of its host is in [`src/host.ts`](src/host.ts).

## What is here

| Folder | Contents |
|---|---|
| `src/index.ts` | The public API: everything a host is allowed to import |
| `src/host.ts` | What the host provides: request headers (token), the rule for an ended session, the build name, a notice when the server refuses a range, a throttled link for benches |
| `src/engine/` | The engine: containers (Matroska, MP4), remux, Media Source handling, byte source, audio |
| `src/engine/{truehd,ac3dts,aac}/` | The WebAssembly decoders (FFmpeg) and the worker that runs them |
| `src/support/` | Dependency-free modules the engine uses: browser engine detection, network state, link measurement, audio track choice |
| `tests/` | The test suite (Vitest) and its fixtures |
| `benches/` | Byte-identity benches, see [`benches/README.md`](benches/README.md), and the comparison against Jellyfin |
| `test-page/` | A page that plays a file from a URL, its byte-range server, and its scenario in a real browser |

## Commands

Nothing is installed on the host: everything runs through Docker, with the folder mounted as a volume.

```sh
run() { docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:26-alpine "$@"; }

run npm install        # once
run npx tsc --noEmit   # types
run npx vitest run     # tests
run node build.mjs     # dist/
```

`build.mjs` produces `dist/lumen-core.js` (an ES module) and its chunks, and copies next to them, **byte for
byte**, the worker and the WebAssembly modules the engine loads by URL. It then reads back what it emitted and
fails if a URL named by the code does not exist in `dist/`, if a copied file differs from its source, or if a
decoder was duplicated into a chunk. `dist/` is served as it is, flat, from a single folder.

## Using it

```js
import { configureHost, probePlaybackPath } from "./dist/lumen-core.js";

configureHost({ requestHeaders: () => ({ Authorization: `MediaBrowser Token="${token}"` }) });

try {
  const probe = await probePlaybackPath({ streamUrl, startSeconds: 0, onError: (message, kind) => { /* ... */ } });
  const playback = await probe.start(videoElement);
  await (playback.openingHold() ?? Promise.resolve());
  await videoElement.play();
  // playback.seek(s), .audioTracks, .requestAudioTrack(n), .subtitleTracks, .subtitleAt(t), .destroy()
} catch (refusal) {
  // A refusal is a named error: this file is not for this path, and the message says why.
  // It is up to the host to hand over to another player.
}
```

Three rules of the contract, all shown in [`test-page/index.html`](test-page/index.html):

- seeks go through `playback.seek()`, not `video.currentTime`;
- `requestAudioTrack()` may answer `"rebuild"`: the host then destroys the playback and reopens with
  `audioTrackNumber` (no attempt at switching tracks inside a live buffer ever held);
- the page must be a secure context (`https:` or `localhost`): without it, `AudioEncoder` does not exist.

## The test page

```sh
docker run --rm --name lumen-test-page -p 127.0.0.1:8377:8377 -v "$PWD":/app:ro -v /path/to/media:/media:ro \
  -e MEDIA_ROOT=/media -w /app node:26-alpine node test-page/serve.mjs
# then http://localhost:8377/?url=/media/film.mkv
```

`test-page/parcours.mjs` runs the same scenario unattended (Playwright): opening, first frame, two seeks, an
audio track change, and records what the browser actually loaded and decoded.

## Origin

The engine comes from [Laterna](https://github.com/LK59/laterna) (`src/lib/webcodecs/`), extracted without any
change of behaviour: the benches in `benches/` compare its output with the original's, byte for byte. The code
comments are in French and refer to Laterna documents (`DECISIONS.md §...`, `DOC-TECH.md`).

AGPL-3.0, like Laterna.
