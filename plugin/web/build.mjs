// Construit `dist/` : le pont (un script classique) et, à côté, le moteur tel que lumen-core l'a construit.
//
//   docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/../..":/app -w /app/plugin/web node:26-alpine node build.mjs
//
// lumen-core/dist doit exister (`node build.mjs` dans lumen-core) : il est copié octet pour octet — le
// worker et les décodeurs y sont déjà vérifiés, on ne les reconstruit pas ici.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const CORE = "../../lumen-core/dist";
if (!existsSync(`${CORE}/lumen-core.js`)) {
  console.error("lumen-core/dist est absent : construire lumen-core d'abord.");
  process.exit(1);
}
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync(CORE, "dist", { recursive: true });

await build({
  entryPoints: { "lumen-jellyfin": "src/bridge.ts" },
  outdir: "dist",
  bundle: true,
  // Un script classique, pas un module : il doit s'exécuter avant ceux de jellyfin-web pour être là
  // quand celui-ci lit sa configuration. Le moteur, lui, est un module qu'il charge à la demande.
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});

// Le pont ne doit rien avoir embarqué du moteur : seulement son adresse.
const bridge = readFileSync("dist/lumen-jellyfin.js", "utf8");
if (/probeOpened|class MseSource|HttpByteSource/.test(bridge)) {
  console.error("Le pont a embarqué du code du moteur : il ne doit en importer que les types.");
  process.exit(1);
}
console.log(`pont : ${Math.round(bridge.length / 1024)} Ko`);
