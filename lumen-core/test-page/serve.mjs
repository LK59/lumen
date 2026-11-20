// Le serveur de la page de test : la page, `dist/`, et des fichiers servis par plages d'octets.
//
//   docker run --rm --name lumen-test-page -p 127.0.0.1:8377:8377 -v "$PWD":/app:ro -v <médias>:/media:ro \
//     -w /app node:26-alpine node test-page/serve.mjs
//
// Rien que ce dont le moteur a besoin d'un serveur : HEAD avec `Content-Length`, GET avec `Range`
// (206 et `Content-Range`), 416 hors du fichier. C'est le contrat de `/Videos/{id}/stream?static=true`
// de Jellyfin, sans Jellyfin — de quoi dire d'un défaut s'il vient du moteur ou du serveur.
//
// TOKEN (facultatif) : exige `Authorization: MediaBrowser Token="<TOKEN>"` sur `/media/`, comme Jellyfin,
// pour vérifier dans un vrai navigateur que les en-têtes de l'hôte partent sur chaque requête.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 8377);
const MEDIA = resolve(process.env.MEDIA_ROOT ?? "/media");
const APP = resolve(process.env.APP_ROOT ?? ".");
const TOKEN = process.env.TOKEN ?? "";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt" };

/** Le fichier demandé sous `root`, ou null s'il en sort (`..`) ou n'existe pas. */
function under(root, relative) {
  const full = normalize(join(root, relative));
  if (full !== root && !full.startsWith(root + sep)) return null;
  const stat = statSync(full, { throwIfNoEntry: false });
  return stat?.isFile() ? { full, size: stat.size } : null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);
  let file = null;
  if (path === "/") file = under(APP, "test-page/index.html");
  else if (path.startsWith("/dist/")) file = under(join(APP, "dist"), path.slice(6));
  else if (path.startsWith("/media/")) {
    if (TOKEN && req.headers.authorization !== `MediaBrowser Token="${TOKEN}"`) {
      res.writeHead(401).end();
      return;
    }
    file = under(MEDIA, path.slice(7));
  }
  if (!file || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(404).end();
    return;
  }
  const headers = { "Content-Type": TYPES[extname(file.full)] ?? "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (!range) {
    res.writeHead(200, { ...headers, "Content-Length": file.size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file.full).pipe(res);
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] === "" ? file.size - 1 : Number(range[2]), file.size - 1);
  if (start >= file.size || end < start) {
    res.writeHead(416, { "Content-Range": `bytes */${file.size}` }).end();
    return;
  }
  res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${file.size}`, "Content-Length": end - start + 1 });
  if (req.method === "HEAD") res.end();
  else createReadStream(file.full, { start, end }).pipe(res);
}).listen(PORT, () => console.log(`page de test : http://localhost:${PORT}/  (médias : ${MEDIA}${TOKEN ? ", jeton exigé" : ""})`));
