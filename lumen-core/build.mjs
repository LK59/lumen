// Construit `dist/` : le moteur en un module ES (plus les morceaux chargés à la demande), et à côté,
// octet pour octet, les fichiers qu'il charge par leur adresse.
//
//   docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:26-alpine node build.mjs
//
// Ce qui n'est pas empaqueté, et pourquoi. Le worker de décodage (`truehdWorker.mjs`) et les modules
// WebAssembly (`*-wasm.mjs`) sont lancés par leur adresse (`new URL("./x", import.meta.url)`) : le
// worker exécute les octets mêmes du fichier que les tests ont prouvé dans Node, pas une réécriture du
// bundler. Laterna a payé cette leçon deux fois (un worker TypeScript copié tel quel et jamais démarré,
// puis un bundler qui recompilait le worker à sa façon) ; d'où la dernière étape, qui lit ce qui a été
// émis au lieu de se contenter d'une construction qui passe.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

const OUT = "dist";

// Les fichiers servis tels quels, à plat à côté du bundle.
const RAW = ["src/engine/truehd/truehdWorker.mjs", "src/engine/truehd/truehd-wasm.mjs", "src/engine/ac3dts/ac3dts-wasm.mjs", "src/engine/aac/aac-wasm.mjs"];

/**
 * Dans les sources, ces fichiers vivent dans trois dossiers (`truehd/`, `ac3dts/`, `aac/`) et se
 * désignent par des chemins relatifs à leur dossier — c'est ainsi que Node les trouve dans les tests.
 * Dans `dist/` tout est à plat : chaque désignation devient `./<nom>`.
 *
 * - `import("./x-wasm.mjs")` (le repli sur le fil principal) : laissé hors du bundle, pour que le fil
 *   principal charge le même fichier que le worker — une seule copie du décodeur, les mêmes octets ;
 * - `new URL("../ac3dts/ac3dts-wasm.mjs", import.meta.url)` : esbuild ne touche pas à cette forme, le
 *   chemin est donc réécrit dans le texte du module avant qu'il ne le lise.
 */
const flatAssets = {
  name: "fichiers-servis-tels-quels",
  setup(b) {
    b.onResolve({ filter: /-wasm\.mjs$/ }, (args) => (args.kind === "dynamic-import" ? { path: `./${basename(args.path)}`, external: true } : null));
    b.onLoad({ filter: /truehdDecoder\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const flat = source.replaceAll('new URL("../ac3dts/ac3dts-wasm.mjs", import.meta.url)', 'new URL("./ac3dts-wasm.mjs", import.meta.url)');
      if (flat === source) throw new Error("truehdDecoder.ts ne désigne plus ac3dts-wasm.mjs comme prévu : revoir build.mjs");
      return { contents: flat, loader: "ts" };
    });
  },
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: { "lumen-core": "src/index.ts" },
  outdir: OUT,
  bundle: true,
  format: "esm",
  // Les morceaux : le décodeur FLAC et ce qui n'est importé qu'à la demande ne pèsent pas sur l'ouverture.
  splitting: true,
  chunkNames: "lumen-[name]-[hash]",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
  plugins: [flatAssets],
});

for (const file of RAW) copyFileSync(file, join(OUT, basename(file)));

// --- ce qui a été émis, lu ---------------------------------------------------------------------
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const problems = [];

// 1. Les fichiers servis tels quels le sont : mêmes octets que la source.
for (const file of RAW) if (sha(file) !== sha(join(OUT, basename(file)))) problems.push(`${basename(file)} diffère de sa source`);

// 2. Toute adresse relative que le code émis désigne existe dans dist/, et aucune n'en sort.
const emitted = readdirSync(OUT).filter((name) => name.endsWith(".js"));
const named = new Set();
for (const name of emitted) {
  const code = readFileSync(join(OUT, name), "utf8");
  for (const match of code.matchAll(/new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g)) named.add(match[1]);
  for (const match of code.matchAll(/\bimport\(\s*"(\.[^"]+)"\s*\)/g)) named.add(match[1]);
  for (const match of code.matchAll(/\bfrom\s*"(\.[^"]+)"/g)) named.add(match[1]);
}
for (const path of named) {
  if (!path.startsWith("./") || path.includes("/", 2)) problems.push(`adresse hors de dist/ : ${path}`);
  else if (!statSync(join(OUT, path), { throwIfNoEntry: false })) problems.push(`fichier désigné mais absent : ${path}`);
}
// 3. Et chacun des fichiers servis tels quels est bien désigné par le code : sinon il est mort.
for (const file of RAW) if (!named.has(`./${basename(file)}`)) problems.push(`${basename(file)} n'est désigné par aucun module émis`);
// 4. Aucun décodeur WebAssembly recopié dans un morceau : une seule copie, celle du fichier.
for (const name of emitted) if (/ENVIRONMENT_IS_WORKER/.test(readFileSync(join(OUT, name), "utf8"))) problems.push(`${name} embarque un module emscripten`);

if (problems.length > 0) {
  console.error("\nLa construction a émis autre chose que prévu :\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log("\ndist/ vérifié :");
for (const name of readdirSync(OUT).sort()) if (!name.endsWith(".map") && !name.endsWith(".txt")) console.log(`  ${String(Math.round(statSync(join(OUT, name)).size / 1024)).padStart(5)} Ko  ${name}`);
