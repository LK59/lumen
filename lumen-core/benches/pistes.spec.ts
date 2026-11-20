// La liste des pistes son de quelques fichiers, au format qu'attend audio-ref-bench (AR_TRACKS) —
// sauté sans PISTES_FILES.
//
//   PISTES_FILES : un chemin par ligne.   PISTES_OUT : `chemin\tpiste\tcodec\tcanaux` par ligne.
import { it } from "vitest";
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { openMediaFile } from "@lumen/engine/mediaFile";
import type { ByteSource } from "@lumen/engine/byteSource";

function fileSource(path: string): ByteSource & { close: () => void } {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    async read(offset: number, length: number) {
      const n = Math.max(0, Math.min(length, size - offset));
      const buffer = new Uint8Array(n);
      let at = 0;
      while (at < n) {
        const got = readSync(fd, buffer, at, n - at, offset + at);
        if (got <= 0) break;
        at += got;
      }
      return buffer.subarray(0, at);
    },
    close: () => closeSync(fd),
  } as ByteSource & { close: () => void };
}

it.skipIf(!process.env.PISTES_FILES)("pistes son des fichiers", { timeout: 600_000 }, async () => {
  const lines: string[] = [];
  for (const path of readFileSync(process.env.PISTES_FILES!, "utf8").split("\n").filter(Boolean)) {
    const source = fileSource(path);
    try {
      const file = await openMediaFile(source);
      for (const track of file.tracks) if (track.type === "audio") lines.push([path, track.number, track.codecId, track.audio?.channels ?? "?"].join("\t"));
    } finally {
      source.close();
    }
  }
  writeFileSync(process.env.PISTES_OUT!, lines.join("\n") + "\n");
});
