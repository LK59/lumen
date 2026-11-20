# The Jellyfin web bridge

How Lumen becomes a player of the Jellyfin web client, and what that relies on.

The web client has no public interface for players. Everything below describes its internal behaviour, read in
the client shipped with Jellyfin 12.4.0 (`main.jellyfin.bundle.js` and `htmlVideoPlayer-plugin.*.chunk.js`) and
exercised on the versions listed at the end. The bridge checks each assumption at run time. When one does not
hold, it steps aside, says so in the browser console, and the web client plays as it does without Lumen.

## What the web client does

**It loads its plugins by name.** The list comes from `config.json` (`plugins`). For each name: if it exists in
`window`, `window[name]` must be a function (possibly async) returning the plugin class, which is constructed with
`{ events, playbackManager, ServerConnections, appSettings, ... }`. Otherwise the client imports its own file.
Apps that embed the web client add their names through `window.NativeShell.getPlugins()`.

**It picks a player by priority.** Plugins of type `mediaplayer` are sorted by ascending `priority`. For an item,
the first local player whose `canPlayMediaType(type)` and then `canPlayItem(item)` (when defined) return true is
used. The built-in video player (`htmlvideoplayer`) has priority 1 and no `canPlayItem`.

**It negotiates playback with the chosen player's profile.** It calls `player.getDeviceProfile(item)` (async),
then asks the server for `PlaybackInfo`. If the server accepts direct play, the address is
`Videos/{id}/stream.{container}?Static=true&mediaSourceId=...` and `playMethod` is `DirectPlay`; otherwise it is
a transcoding address. Then it calls `player.play(streamInfo)`.

**The video player sets the source in `setCurrentSrc(element, streamInfo)`:** hls.js for HLS, otherwise
`element.src = url` followed by `element.play()`. Before that, the same method prepares subtitles, the audio
track, and the state the rest of the player reads back.

**After a playback error it renegotiates** (`onPlaybackError`). If the server can transcode the file, it asks
again for `getDeviceProfile(item, { isRetry: true })` and for a stream with `EnableDirectPlay: false` (and, for a
local file, without copying the video), then calls `play` again.

**A seek** calls `player.currentTime(ms)` when `player.seekable()` returns true. **An audio track change** calls
`player.setAudioStreamIndex` if `canSetAudioStreamIndex()` returns true; otherwise it renegotiates the stream at
the current position with the wanted track and calls `play` again. **Progress** is reported to the server by the
playback manager, from the player's events (`timeupdate`, `pause`, `stopped`...) and from `currentTime()`.

## What the bridge does

A classic script (`lumen-jellyfin.js`), executed before the web client's own scripts.

1. **It announces itself.** It defines `window.lumenPlayer`. The name is added to the `plugins` list of
   `config.json` by the server plugin, as the file is served. The bridge does not go through `NativeShell`: its
   mere presence makes the web client believe an app embeds it, and it then asks that app for its device profile,
   its name and its fullscreen handling.
2. **It extends the built-in video player.** That class is exported nowhere and may not be loaded yet when the
   plugin is constructed. So the Lumen player is born empty, and grafts itself onto `htmlvideoplayer` the first
   time it is asked what it can play (its prototype is replaced and the constructor is replayed on the object).
   It has priority -1, and its `canPlayItem` only accepts video files of the library.
3. **It decides in `getDeviceProfile`.** It asks the engine, on the file itself (`probePlaybackPath`, then
   `discard`). If the engine accepts, the profile announces direct play of everything and the server answers with
   the raw file. If it declines, the profile is the web client's own and everything happens as without Lumen.
   The verdict is kept for ten minutes.
4. **It replaces the source in `setCurrentSrc`.** The original method is called on an element with two gestures
   diverted: setting `src` does nothing, and `play()` opens Lumen on the real element. Everything else
   (interface, subtitles, volume, fullscreen, reporting) is the web client's code.
5. **Seeks** go through `playback.seek`. **Audio track:** `canSetAudioStreamIndex()` returns false while Lumen is
   playing, so the web client renegotiates and calls `setCurrentSrc` again, which reopens on the wanted track.
   This is the rebuild the engine requires anyway.
6. **It hands over.** A file declined at the check needs nothing: the regular player plays it. A failure when
   opening, or an engine that gives up during playback, is a playback error for the web client, which
   renegotiates a transcode and resumes at the same position.

It also measures every playback it is chosen for, whether Lumen or the regular player does the playing, and
sends the result to the plugin when its playback log is on.

## Design choices

- **Subtitles are the web client's own.** For a file in direct play, the server extracts the requested track and
  the web client displays it. The engine can read the file's subtitles itself; wiring that in would remove this
  last use of ffmpeg, at the cost of a second subtitle display to maintain.
- **Text subtitles are shifted to match the picture.** The remux puts the picture on the element's clock with a
  fixed delay relative to the file's clock (frames are reordered before display: about 0.2 s). Subtitles the web
  client receives from the server are timed on the file's clock. The bridge therefore shifts each cue placed in a
  browser text track by that delay. ASS and PGS subtitles are drawn by the web client's own renderers on their
  own clock, and keep that lead.
- **A server that refuses the file is not a missing network.** The engine cannot tell the two apart and waits
  for the network to come back. The bridge is told of each refusal (`rangeRefused`) and hands over to the web
  client at the fourth refusal in a row, since the web client can transcode. A real outage keeps the engine's
  patience (48 seconds), after which it is reported as a playback error.
- **The audio track Jellyfin designates** is found by its rank among the file's audio streams. Jellyfin's stream
  indexes and the container's track numbers do not match.
- **The token** is sent as a header (`Authorization: MediaBrowser Token="..."`) on every request, and never put
  in the address.

## What the server plugin does

No media processing. It serves the player's files under `/Lumen/web/`, completes two responses of the web client
as they pass (a script tag at the top of the page, the player's name in `config.json`), answers `/Lumen/Settings`
for the user who asks, and keeps the playback log.

The two responses are produced by the rest of the server as usual and completed on the way out. They are not
re-read from disk, so whatever other plugins did to the same page is preserved. No file is modified.

## Jellyfin versions

The bridge and the plugin were run on a fresh server of each version, with the same scenario (playback, seek,
audio track, subtitles, resume, declined file): **10.10.7, 10.11.11, 12.0, 12.2 and 12.4**. A single assembly,
built for 10.10 (.NET 8), loads on all of them: what the plugin asks of the server has not changed shape, and a
.NET 8 assembly runs on the later runtimes. Versions before 10.10 have not been tried.

## Under a strict Content Security Policy

Decoding audio needs `worker-src blob:` and `script-src 'wasm-unsafe-eval'`. Without them (tried with a policy
that only allows the server's own origin), the engine declines the files whose audio must be decoded, with a
named reason, and the web client plays them. Files whose audio can be copied are still played by Lumen.
