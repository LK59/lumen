// Le pont dans le vrai jellyfin-web : ce qu'un spectateur ferait, et ce que le serveur en voit.
//
// Lancé par `pont.sh`. Le script du pont arrive de l'une de deux façons, selon INJECT :
//   - `main`   : injecté à la main dans la page avant ses scripts (aucun plugin sur le serveur) ;
//   - `plugin` : rien n'est injecté ici — c'est au plugin installé de l'avoir mis dans la page.
//
// Par titre : ouvrir la fiche, « Lire », première image ; saut par la barre de jellyfin-web ; changement
// de piste son par son menu ; sous-titres par son menu ; arrêt ; puis ce que le serveur a retenu (méthode
// de lecture, position de reprise). Chaque étape attend ce qui se constate, avec un plafond.
//
//   ITEM='{"id":…,"name":…,"ticks":…}'  EXPECT=lumen|jellyfin|off  INJECT=main|plugin
//   (EXPECT=off : « Lire avec Lumen » est décoché dans les réglages — jellyfin-web lit, sans refus à constater)
//   JF_URL JF_TOKEN JF_USERID JF_SERVERID DEVICE_ID OUT  [BRIDGE=/chemin/lumen-jellyfin.js  LUMEN_BASE=adresse]
import { appendFileSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const { EXPECT, INJECT, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID, DEVICE_ID, OUT } = process.env;
const item = JSON.parse(process.env.ITEM);
const duration = item.ticks / 1e7;
const auth = { Authorization: `MediaBrowser Token="${JF_TOKEN}"` };
const api = async (path, init = {}) => {
  const response = await fetch(`${JF_URL}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  return response.headers.get("content-type")?.includes("json") ? response.json() : null;
};
const row = { inject: INJECT, expect: EXPECT, title: item.name, checks: {} };
const check = (name, ok, detail) => {
  row.checks[name] = ok ? true : (detail ?? false);
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(
  ([url, token, user, server, device]) => {
    localStorage.setItem("_deviceId2", device);
    // Pas de mesure automatique du débit : jellyfin-web la refait à chaque page, et sur une machine occupée
    // elle rend parfois un débit si bas que le serveur ne propose plus aucune source pour un fichier un peu
    // lourd (« Unable to find a valid media source ») — un échec du banc, pas du lecteur.
    for (const network of ["true", "false"]) {
      localStorage.setItem(`enableautomaticbitratedetection-${network}-Video`, "false");
      localStorage.setItem(`maxbitrate-${network}-Video`, "200000000");
    }
    localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
  },
  [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID, DEVICE_ID]
);
if (INJECT === "main") {
  // À la main : la configuration puis le script, avant tout script de la page — ce que fera le plugin
  // avec une balise en tête de page.
  await context.addInitScript({ content: `window.LumenConfig = { base: ${JSON.stringify(process.env.LUMEN_BASE)} };\n${readFileSync(process.env.BRIDGE, "utf8")}` });
  // … et son nom dans la liste des plugins de jellyfin-web, que le plugin ajoutera côté serveur.
  await context.route("**/web/config.json", async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({ response, json: { ...config, plugins: [...config.plugins, "lumenPlayer"] } });
  });
}
const page = await context.newPage();
const errors = [];
const lumenLog = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
page.on("console", (message) => {
  if (message.text().startsWith("[Lumen]")) lumenLog.push(message.text().slice(0, 240));
});
const net = { static: 0, hls: 0, playlists: 0, subtitles: 0, tokenInUrl: 0, settings: null };
page.on("response", (response) => {
  const url = new URL(response.url());
  if (/\/Lumen\/Settings$/i.test(url.pathname)) net.settings = response.status();
  if (!/^\/Videos\//i.test(url.pathname)) return;
  if (/\/Subtitles\//i.test(url.pathname)) return void (net.subtitles += 1);
  if (/\.m3u8$/i.test(url.pathname)) net.playlists += 1;
  else if (/\/hls1?\//i.test(url.pathname)) net.hls += 1;
  else if (/static=true/i.test(url.search)) {
    net.static += 1;
    if (/api_?key=/i.test(url.search)) net.tokenInUrl += 1;
  }
});

const status = () => page.evaluate(() => window.Lumen?.status() ?? null);
const videoTime = () => page.evaluate(() => document.querySelector("video")?.currentTime ?? null);
const advanced = (seconds, cap) =>
  page.evaluate(
    ([seconds, cap]) =>
      new Promise((resolve) => {
        const video = document.querySelector("video");
        if (!video) return resolve(false);
        const from = video.currentTime;
        const until = performance.now() + cap;
        const tick = () => (video.currentTime - from >= seconds ? resolve(true) : performance.now() > until ? resolve(false) : setTimeout(tick, 100));
        tick();
      }),
    [seconds, cap]
  );
const session = async () => (await api("/Sessions")).find((s) => s.DeviceId === DEVICE_ID && s.NowPlayingItem?.Id === item.id) ?? null;
/** L'interface du lecteur se cache quand la souris ne bouge plus : un geste la ramène avant chaque clic. */
const wake = async () => {
  await page.mouse.move(600 + Math.random() * 50, 300 + Math.random() * 50);
  await page.mouse.move(640, 360);
};

try {
  // Le même état de départ à chaque passage : pas de position de reprise sur le compte du banc.
  await api(`/UserPlayedItems/${item.id}?userId=${JF_USERID}`, { method: "DELETE" });
  await page.goto(`${JF_URL}/web/#/details?id=${item.id}&serverId=${JF_SERVERID}`);
  const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
  await play.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  const frame = page.evaluate(
    () =>
      new Promise((resolve) => {
        const look = () => {
          const video = document.querySelector("video");
          if (video) return video.requestVideoFrameCallback(() => resolve(true));
          setTimeout(look, 10);
        };
        look();
        setTimeout(() => resolve(false), 90_000);
      })
  );
  const clicked = Date.now();
  await play.click();
  const shown = await frame;
  row.firstFrameMs = shown ? Date.now() - clicked : null;
  check("première image", shown);
  check("le film avance", await advanced(4, 60_000));

  const state = await status();
  row.lumen = state ? { adopted: state.adopted, playing: state.playing, verdicts: state.verdicts, audio: state.diagnostics?.["Traitement audio"] ?? null } : null;
  check("le pont est greffé sur le lecteur de jellyfin-web", state?.adopted === true, state);
  const first = await session();
  row.server = { method: first?.PlayState?.PlayMethod ?? null, transcoding: first?.TranscodingInfo ? `${first.TranscodingInfo.VideoCodec}/${first.TranscodingInfo.AudioCodec}` : null };
  if (EXPECT === "lumen") {
    check("c'est Lumen qui lit", state?.playing === true);
    check("le serveur voit une lecture directe, sans transcodage", first?.PlayState?.PlayMethod === "DirectPlay" && !first?.TranscodingInfo, row.server);
  } else if (EXPECT === "off") {
    check("Lumen ne lit pas, et n'a rien eu à refuser", state?.playing === false && state?.verdicts.length === 0, state?.verdicts);
    check("jellyfin-web lit", first !== null && first.PlayState?.PlayMethod !== undefined, row.server);
  } else {
    check("Lumen a refusé, en disant pourquoi", state?.playing === false && state?.verdicts.some((v) => v.id === item.id && v.ok === false && v.reason), state?.verdicts);
    check("jellyfin-web lit à sa place", first !== null && first.PlayState?.PlayMethod !== "DirectPlay", row.server);
  }

  // Un saut, par la barre de position de jellyfin-web (40 % du film).
  await wake();
  const target = duration * 0.4;
  const seekStarted = Date.now();
  await page.evaluate(() => {
    const slider = document.querySelector(".osdPositionSlider");
    slider.value = "40";
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const landed = await page
    .waitForFunction((target) => { const v = document.querySelector("video"); return v && !v.seeking && Math.abs(v.currentTime - target) < 30 && v.readyState >= 3; }, target, { timeout: 60_000 })
    .then(() => true, () => false);
  row.seekMs = landed ? Date.now() - seekStarted : null;
  check("le saut arrive près de 40 %", landed, await videoTime());
  check("le film avance après le saut", await advanced(3, 60_000));

  // La progression rapportée au serveur suit la lecture.
  await page.waitForTimeout(1500);
  const mid = await session();
  const reported = (mid?.PlayState?.PositionTicks ?? 0) / 1e7;
  check("la position rapportée au serveur suit le saut", Math.abs(reported - target) < 60, Math.round(reported));

  if (EXPECT === "lumen") {
    // Changement de piste son, par le menu de jellyfin-web.
    const audioCount = (await api(`/Items/${item.id}?userId=${JF_USERID}`)).MediaSources[0].MediaStreams.filter((s) => s.Type === "Audio").length;
    if (audioCount > 1) {
      const before = (await status())?.audioTrack;
      await wake();
      await page.locator(".videoOsdBottom .btnAudio").click();
      const choices = page.locator(".actionSheet .actionSheetMenuItem");
      await choices.first().waitFor({ state: "visible", timeout: 10_000 });
      // La première piste qui n'est pas celle en cours (la piste en cours porte la coche).
      const count = await choices.count();
      let picked = false;
      for (let i = 0; i < count && !picked; i++) {
        if (await choices.nth(i).locator(".actionsheetMenuItemIcon.check:not([style*='hidden'])").count()) continue;
        await choices.nth(i).click();
        picked = true;
      }
      const changed = await page.waitForFunction((before) => { const s = window.Lumen?.status(); return s?.playing && s.audioTrack !== null && s.audioTrack !== before; }, before, { timeout: 60_000 }).then(() => true, () => false);
      const after = await status();
      row.audioChange = { from: before, to: after?.audioTrack ?? null };
      check("la piste son change, toujours par Lumen", picked && changed, row.audioChange);
      check("le film avance après le changement de piste", await advanced(3, 60_000));
      const at = await videoTime();
      check("le changement de piste garde la position", Math.abs(at - target) < 90, Math.round(at));
      const still = await session();
      check("toujours en lecture directe après le changement", still?.PlayState?.PlayMethod === "DirectPlay" && !still?.TranscodingInfo, still?.PlayState?.PlayMethod);
    }

    // Sous-titres, par le menu de jellyfin-web.
    await wake();
    const subtitles = page.locator(".videoOsdBottom .btnSubtitles:not(.hide)");
    if (await subtitles.count()) {
      await subtitles.click();
      const choices = page.locator(".actionSheet .actionSheetMenuItem");
      await choices.first().waitFor({ state: "visible", timeout: 10_000 });
      // Le premier choix est « Désactivé » ; le suivant est une piste.
      await choices.nth(1).click();
      const asked = await page.waitForFunction(() => document.querySelectorAll("video track").length > 0 || document.querySelector(".videoSubtitles, .videoSubtitlesInner, canvas.libassjs-canvas, .htmlvideoplayer-subtitles") !== null, null, { timeout: 30_000 }).then(() => true, () => false);
      row.subtitles = { requests: net.subtitles };
      check("les sous-titres sont demandés et montés par jellyfin-web", asked || net.subtitles > 0, net.subtitles);
      const playing = await status();
      check("les sous-titres ne font pas quitter Lumen", playing?.playing === true);
      check("le film avance avec les sous-titres", await advanced(3, 60_000));
    }
  }

  // Arrêt : le lecteur se ferme, et le serveur garde la position.
  const stoppedAt = await videoTime();
  await wake();
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => document.querySelector("video") === null || document.querySelector("video").currentSrc === "", null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const data = (await api(`/Items/${item.id}?userId=${JF_USERID}`)).UserData;
  row.resume = Math.round((data?.PlaybackPositionTicks ?? 0) / 1e7);
  check("le serveur a gardé la position de reprise", Math.abs(row.resume - stoppedAt) < 90 && row.resume > 0, { resume: row.resume, stoppedAt: Math.round(stoppedAt ?? 0) });
  if (EXPECT === "lumen") check("le lecteur Lumen est fermé", (await status())?.playing === false);
  check("aucune requête du fichier ne porte le jeton dans son adresse", EXPECT !== "lumen" || net.tokenInUrl === 0, net.tokenInUrl);
  await api(`/UserPlayedItems/${item.id}?userId=${JF_USERID}`, { method: "DELETE" });
} catch (error) {
  row.failed = String(error).slice(0, 400);
}
row.net = net;
row.lumenLog = lumenLog.slice(0, 12);
if (errors.length > 0) row.pageErrors = errors.slice(0, 5);
const failed = Object.entries(row.checks).filter(([, value]) => value !== true);
row.ok = !row.failed && failed.length === 0;
appendFileSync(OUT, JSON.stringify(row) + "\n");
console.log(`${row.ok ? "OK   " : "ÉCHEC"} ${INJECT}/${EXPECT}  ${item.name}  — ${Object.keys(row.checks).length - failed.length}/${Object.keys(row.checks).length} constats${row.failed ? "  " + row.failed : ""}`);
for (const [name, detail] of failed) console.log(`      ✗ ${name} : ${JSON.stringify(detail)}`);
await browser.close();
