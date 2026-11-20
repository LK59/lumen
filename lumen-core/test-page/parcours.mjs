// Le parcours de la page de test dans un vrai navigateur (Playwright) : ouvrir, première image, deux
// sauts, changement de piste son — une ligne JSON par fichier.
//
//   docker run --rm --name lumen-parcours --ipc host --user "$(id -u):$(id -g)" -e HOME=/tmp \
//     -v "$PWD":/app:ro -v <médias>:/media:ro -v <sorties>:/out -w /app \
//     -e PROFILE=chromium -e FILES=/out/fichiers.txt -e OUT=/out/parcours.jsonl \
//     mcr.microsoft.com/playwright:v1.63.0-noble node test-page/parcours.mjs
//
// FILES : un chemin par ligne, relatif à /media. Le serveur de la page tourne dans ce même conteneur,
// sur `localhost` : un contexte sécurisé, sans lequel `AudioEncoder` n'existe pas — et aucun port publié.
// Le jeton est exigé par le serveur : un fichier qui joue prouve que l'en-tête part sur chaque plage.
//
// Chaque étape attend ce qu'elle peut constater (l'horloge avance), avec un plafond — jamais une durée.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import * as playwright from "playwright-core";

const PROFILE = process.env.PROFILE ?? "chromium";
const PORT = 8377;
const TOKEN = "jeton-de-banc";
const OUT = process.env.OUT ?? "/out/parcours.jsonl";
const files = readFileSync(process.env.FILES, "utf8").split("\n").filter(Boolean);

const server = spawn("node", ["test-page/serve.mjs"], { env: { ...process.env, PORT: String(PORT), TOKEN }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => server.stdout.once("data", resolve));

const browser = await playwright[PROFILE].launch({
  // Sans geste d'utilisateur, play() avec le son est refusé : le banc n'a pas de doigt.
  args: PROFILE === "chromium" ? ["--autoplay-policy=no-user-gesture-required"] : [],
  firefoxUserPrefs: PROFILE === "firefox" ? { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 } : undefined,
});

/** Attend que l'horloge de l'élément ait avancé de `seconds` de film, `cap` ms au plus. */
const advanced = (page, seconds, cap) =>
  page.evaluate(
    ([seconds, cap]) =>
      new Promise((resolve) => {
        const video = document.querySelector("video");
        const from = video.currentTime;
        const until = performance.now() + cap;
        const tick = () => (video.currentTime - from >= seconds ? resolve(true) : performance.now() > until ? resolve(false) : setTimeout(tick, 100));
        tick();
      }),
    [seconds, cap]
  );

try {
  for (const file of files) {
    const row = { profile: PROFILE, file };
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
    // Les requêtes du fichier : toutes doivent porter le jeton, et aucune ne doit le mettre dans l'adresse.
    const media = { requests: 0, withToken: 0, statuses: {} };
    // Ce que la page a chargé de `dist/` : le worker et le module WebAssembly doivent y figurer quand le
    // son est décodé ici — sinon c'est le repli sur le fil principal qui a joué, et le banc ne le dirait pas.
    const dist = {};
    const workers = [];
    page.on("worker", (worker) => workers.push(worker.url().slice(0, 5)));
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/dist/") && !path.endsWith(".map")) dist[path.slice(6).replace(/-[A-Z0-9]{8}\.js$/, ".js")] = response.status();
      if (!path.startsWith("/media/")) return;
      media.requests += 1;
      if (response.request().headers().authorization === `MediaBrowser Token="${TOKEN}"`) media.withToken += 1;
      media.statuses[response.status()] = (media.statuses[response.status()] ?? 0) + 1;
    });
    try {
      await page.goto(`http://localhost:${PORT}/?auto=1&token=${TOKEN}&url=${encodeURIComponent("/media/" + file.split("/").map(encodeURIComponent).join("/"))}`);
      await page.waitForFunction(() => ["playing", "refused", "error"].includes(window.lumenTest?.phase), null, { timeout: 60_000 });
      row.phase = await page.evaluate(() => window.lumenTest.phase);
      if (row.phase === "playing") {
        row.firstFrameMs = await page.evaluate(() => window.lumenTest.firstFrameMs);
        row.plays = await advanced(page, 2, 30_000);
        const facts = () =>
          page.evaluate(() => {
            const video = document.querySelector("video");
            const p = window.lumenTest.playback;
            return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, audioTracks: p.audioTracks.map((t) => `${t.number}:${t.codecId}:${t.channels ?? "?"}`), current: p.currentAudioTrack, subtitles: p.subtitleTracks.length };
          });
        Object.assign(row, await facts());
        row.seeks = [];
        for (const share of [0.4, 0.75]) {
          const ms = await page.evaluate((to) => window.lumenTest.seek(to), row.duration * share);
          const plays = await advanced(page, 1.5, 30_000);
          const at = await page.evaluate(() => window.lumenTest.playback.position);
          row.seeks.push({ share, ms, plays, landedWithin: Math.round(Math.abs(at - row.duration * share)) });
        }
        // L'autre piste son, s'il y en a une : la page reconstruit quand le moteur le demande.
        const other = await page.evaluate(() => {
          const p = window.lumenTest.playback;
          return p.audioTracks.find((t) => t.number !== p.currentAudioTrack && p.canCarryAudio(t.number))?.number ?? null;
        });
        if (other !== null) {
          await page.selectOption("#audio", String(other));
          // La mesure n'est écrite qu'une fois la piste voulue ouverte et sa première image montrée.
          await page.waitForFunction(() => window.lumenTest.audioChanges.length > 0 || ["refused", "error"].includes(window.lumenTest.phase), null, { timeout: 60_000 }).catch(() => {});
          row.audioChange = await page.evaluate(() => ({ ...window.lumenTest.audioChanges[0], now: window.lumenTest.playback?.currentAudioTrack ?? null, phase: window.lumenTest.phase }));
          row.audioChange.plays = await advanced(page, 1.5, 30_000);
        }
        // Ce que l'élément a réellement décodé : des images, et du son (Chromium le compte en octets).
        row.decoded = await page.evaluate(() => {
          const video = document.querySelector("video");
          return { frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null, audioBytes: video.webkitAudioDecodedByteCount ?? null };
        });
        row.diagnostics = await page.evaluate(() => window.lumenTest.playback?.diagnostics ?? null);
        // Où le son a été décodé (worker ou fil principal), tel que le journal de l'ouverture le dit.
        row.decoderTrace = await page.evaluate(() => window.lumenTest.traceText().split("\n").filter((line) => /worker|fil principal|WebAssembly|décodeur/i.test(line)).slice(0, 6));
      } else {
        row.why = await page.evaluate(() => window.lumenTest.refusal ?? window.lumenTest.error);
      }
      row.events = await page.evaluate(() => window.lumenTest.events.filter((e) => ["error", "stall", "warning", "refus", "play refusé"].includes(e.name)));
    } catch (error) {
      row.failed = String(error).slice(0, 300);
      row.trace = await page.evaluate(() => window.lumenTest?.traceText().split("\n").slice(-25)).catch(() => null);
    }
    row.media = media;
    row.dist = dist;
    row.workers = workers;
    if (errors.length > 0) row.pageErrors = errors;
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    console.log(`${PROFILE}  ${row.phase ?? "échec"}  ${file.split("/").pop()}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}
