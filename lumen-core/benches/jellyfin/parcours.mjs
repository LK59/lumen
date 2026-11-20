// Un titre, un lecteur, un parcours : jellyfin-web seul, ou la page de test Lumen servie par le même
// Jellyfin (`/web/lumen-test/`, donc la même origine que jellyfin-web). Lancé par `banc.sh`, qui relève
// le processeur du serveur autour de chaque passage.
//
// Le même parcours et les mêmes mesures pour les deux : première image, 15 s de film, saut à 40 %, 8 s
// de film, saut à 75 %, 8 s de film. Chaque attente porte sur ce qui se constate — une image présentée
// (`requestVideoFrameCallback`), l'horloge de l'élément qui avance — avec un plafond, jamais une durée.
//
//   PLAYER=jellyfin|lumen  ITEM='{"id":…,"name":…,"size":…,"range":…,"ticks":…}'  JF_URL  JF_TOKEN  JF_USERID
//   JF_SERVERID  DEVICE_ID  OUT
import { appendFileSync } from "node:fs";
import { chromium } from "playwright-core";

const { PLAYER, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID, DEVICE_ID, OUT } = process.env;
const item = JSON.parse(process.env.ITEM);
const duration = item.ticks / 1e7;
const row = { player: PLAYER, title: item.name, id: item.id };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
// La session de jellyfin-web, posée comme il la garde lui-même : pas d'écran de connexion à traverser.
await context.addInitScript(
  ([url, token, user, server, device]) => {
    localStorage.setItem("_deviceId2", device);
    localStorage.setItem(
      "jellyfin_credentials",
      JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] })
    );
  },
  [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID, DEVICE_ID]
);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));

// Ce que le navigateur a demandé au serveur, rangé par nature : c'est là que les deux lecteurs diffèrent.
const net = { static: 0, staticBytes: 0, hls: 0, hlsBytes: 0, progressive: 0, playlists: 0 };
page.on("response", async (response) => {
  const url = new URL(response.url());
  const size = Number(response.headers()["content-length"] ?? 0);
  if (!/^\/(Videos|Audio)\//i.test(url.pathname)) return;
  if (/\.m3u8$/i.test(url.pathname)) net.playlists += 1;
  else if (/\/hls1?\//i.test(url.pathname)) (net.hls += 1), (net.hlsBytes += size);
  else if (url.searchParams.get("static") === "true" || url.searchParams.get("Static") === "true") (net.static += 1), (net.staticBytes += size);
  else net.progressive += 1;
});

/** La première image présentée d'un élément <video> qui n'existe peut-être pas encore. `cap` en ms. */
const firstFrame = (cap) =>
  page.evaluate(
    (cap) =>
      new Promise((resolve) => {
        const until = performance.now() + cap;
        const look = () => {
          const video = document.querySelector("video");
          if (video) return video.requestVideoFrameCallback(() => resolve(true));
          if (performance.now() > until) return resolve(false);
          setTimeout(look, 10);
        };
        look();
        setTimeout(() => resolve(false), cap);
      }),
    cap
  );

/** L'horloge de l'élément a avancé de `seconds` de film ; faux au bout de `cap` ms. */
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

/**
 * Un saut, mesuré de l'ordre à la première image présentée près de la cible. Pour jellyfin-web, l'ordre
 * est celui que donne son propre lecteur quand l'élément peut sauter (`currentTime`) ; pour Lumen, celui
 * du moteur (`playback.seek`). Rend null si rien n'est arrivé près de la cible en `cap` ms.
 */
const seek = (target, cap) =>
  page.evaluate(
    ([target, cap, lumen]) =>
      new Promise((resolve) => {
        const video = document.querySelector("video");
        if (!video) return resolve(null);
        const startedAt = performance.now();
        const arrived = () => {
          if (!video.seeking && Math.abs(video.currentTime - target) < 20) return resolve(Math.round(performance.now() - startedAt));
          if (performance.now() - startedAt > cap) return resolve(null);
          video.requestVideoFrameCallback(arrived);
        };
        if (lumen) void window.lumenTest.playback.seek(target);
        else video.currentTime = target;
        video.requestVideoFrameCallback(arrived);
        setTimeout(() => resolve(null), cap);
      }),
    [target, cap, PLAYER === "lumen"]
  );

try {
  const startedAt = Date.now();
  if (PLAYER === "lumen") {
    const stream = `/Videos/${item.id}/stream?static=true&MediaSourceId=${item.id}`;
    const query = new URLSearchParams({ auto: "1", token: JF_TOKEN, url: stream, size: String(item.size), ...(item.range ? { range: item.range } : {}) });
    const clicked = Date.now();
    await page.goto(`${JF_URL}/web/lumen-test/index.html?${query}`);
    await page.waitForFunction(() => ["playing", "refused", "error"].includes(window.lumenTest?.phase), null, { timeout: 60_000 });
    row.phase = await page.evaluate(() => window.lumenTest.phase);
    if (row.phase !== "playing") row.why = await page.evaluate(() => window.lumenTest.refusal ?? window.lumenTest.error);
    // Deux mesures : celle de la page (de l'ouverture du flux à l'image), et depuis la navigation, module compris.
    row.firstFrameMs = await page.evaluate(() => window.lumenTest.firstFrameMs);
    row.firstFrameFromNavigationMs = row.phase === "playing" ? Date.now() - clicked : null;
  } else {
    await page.goto(`${JF_URL}/web/#/details?id=${item.id}&serverId=${JF_SERVERID}`);
    const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
    await play.waitFor({ state: "visible", timeout: 30_000 });
    // La page de détail finit de se charger : le clic mesure le lecteur, pas l'arrivée de la fiche.
    await page.waitForLoadState("networkidle").catch(() => {});
    const frame = firstFrame(90_000);
    const clicked = Date.now();
    await play.click();
    row.phase = (await frame) ? "playing" : "no-frame";
    row.firstFrameMs = row.phase === "playing" ? Date.now() - clicked : null;
  }

  if (row.phase === "playing") {
    row.plays = await advanced(15, 90_000);
    row.element = await page.evaluate(() => {
      const video = document.querySelector("video");
      return { duration: Math.round(video.duration), width: video.videoWidth, height: video.videoHeight, src: video.currentSrc.slice(0, 5) };
    });
    // Ce que le serveur dit faire pour cette séance — lecture directe, remux, transcodage, et pourquoi.
    const sessions = await (await fetch(`${JF_URL}/Sessions`, { headers: { Authorization: `MediaBrowser Token="${JF_TOKEN}"` } })).json();
    // Seul jellyfin-web ouvre une séance : la page de test ne rapporte rien au serveur, et une séance
    // trouvée là serait celle du passage précédent.
    const session = PLAYER === "jellyfin" ? sessions.find((s) => s.DeviceId === DEVICE_ID && s.NowPlayingItem?.Id === item.id) : null;
    row.server = session
      ? { method: session.PlayState?.PlayMethod ?? null, transcoding: session.TranscodingInfo ? { video: `${session.TranscodingInfo.VideoCodec}${session.TranscodingInfo.IsVideoDirect ? " (copie)" : ""}`, audio: `${session.TranscodingInfo.AudioCodec}${session.TranscodingInfo.IsAudioDirect ? " (copie)" : ""}`, container: session.TranscodingInfo.Container, reasons: session.TranscodingInfo.TranscodeReasons } : null }
      : null;
    row.seeks = [];
    for (const share of [0.4, 0.75]) {
      const ms = await seek(duration * share, 90_000);
      row.seeks.push({ share, ms, plays: await advanced(8, 90_000) });
    }
    row.decoded = await page.evaluate(() => {
      const video = document.querySelector("video");
      const quality = video.getVideoPlaybackQuality();
      return { frames: quality.totalVideoFrames, dropped: quality.droppedVideoFrames, audioBytes: video.webkitAudioDecodedByteCount ?? null };
    });
    if (PLAYER === "lumen") row.audio = await page.evaluate(() => window.lumenTest.playback?.diagnostics?.["Traitement audio"] ?? null);
  }
  row.wallMs = Date.now() - startedAt;
} catch (error) {
  row.failed = String(error).slice(0, 300);
}
row.net = net;
if (errors.length > 0) row.pageErrors = errors.slice(0, 5);
appendFileSync(OUT, JSON.stringify(row) + "\n");
console.log(`${PLAYER.padEnd(8)} ${String(row.phase ?? "échec").padEnd(9)} 1re image ${row.firstFrameMs ?? "—"} ms  sauts ${(row.seeks ?? []).map((s) => s.ms ?? "—").join(" / ")}  ${item.name}`);
await browser.close();
