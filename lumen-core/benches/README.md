# Benches

## Byte identity

These answer one question: **does this engine produce the same bytes as the one it comes from?** They are not
tests (they do not judge an output, they compare two) and they are skipped without their environment variables.

| Bench | What it fingerprints |
|---|---|
| `remux-hash-bench.spec.ts` | The init segments and twelve fMP4 segments from the start, then twelve after a seek to 30 % and to 60 % of the film (SHA-256 of each video and audio segment, and the end time) |
| `audio-ref-bench.spec.ts` | Per audio track, at five points of the film: the packets read (bytes and timestamps) and, for what Node can decode (AC-3, E-AC-3, DTS, FLAC, PCM, TrueHD), thirty seconds of decoded audio (Float32 planes, timestamps, channels) |
| `pistes.spec.ts` | Nothing: it lists the audio tracks in the format the previous one expects |

### Comparing with the original

`LUMEN_REF` points to the root of a copy of Laterna mounted read-only: its engine then takes the place of
`src/engine/` under the same bench (see `vitest.config.ts`). Run twice, compare.

```sh
bench() {  # $1: output name; the rest: docker options
  out=$1; shift
  docker run --rm --cpus=6 --name "lumen-bench-$out" --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PWD":/app -v "$MEDIA":"$MEDIA":ro "$@" -w /app \
    -e REMUX_FILES=/app/benches/out/titres.txt -e REMUX_OUT=/app/benches/out/remux-$out.jsonl \
    -e AR_TRACKS=/app/benches/out/pistes.tsv   -e AR_OUT=/app/benches/out/son-$out.jsonl \
    node:26-alpine npx vitest run benches/remux-hash-bench.spec.ts benches/audio-ref-bench.spec.ts
}
bench origine -e LUMEN_REF=/ref -v /path/to/laterna:/ref:ro
bench lumen

cmp benches/out/remux-origine.jsonl benches/out/remux-lumen.jsonl
diff <(jq -c 'del(.. | .ms?)' benches/out/son-origine.jsonl) <(jq -c 'del(.. | .ms?)' benches/out/son-lumen.jsonl)
```

`benches/out/titres.txt` holds one file path per line. `benches/out/pistes.tsv` is produced with
`PISTES_FILES=.../titres.txt PISTES_OUT=.../pistes.tsv npx vitest run benches/pistes.spec.ts`. `benches/out/` is
not part of the repository: its files name those of a library.

Outputs are appended (`appendFileSync`): delete those of a previous run first.

## Against Jellyfin

`jellyfin/banc.sh` plays the same scenario with the Jellyfin web client alone and with the Lumen test page
served by the same Jellyfin: first frame, 15 s of film, a seek to 40 %, a seek to 75 %. Around each run it reads
the CPU counter of the Jellyfin container (its cgroup), so the server's cost is in CPU seconds actually spent,
ffmpeg included. `jellyfin/resume.py` turns the output into a table of medians.

```sh
MEDIA_ROOT=/path/to/media tools/test-jellyfin.sh up     # from the repository root; `setup` on a fresh server
RUNS=3 lumen-core/benches/jellyfin/banc.sh
python3 lumen-core/benches/jellyfin/resume.py lumen-core/benches/out/face-a-jellyfin.jsonl
tools/test-jellyfin.sh down
```
