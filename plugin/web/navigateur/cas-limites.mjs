// Les gestes que le parcours ordinaire (`pont.mjs`) ne fait pas : reprise à une position, piste son
// changée pendant la pause, saut donné pendant qu'un flux se rouvre, deux « avance rapide » coup sur
// coup, et la fin du fichier. Relève des faits, en JSON ; ne juge pas.
//
//   ITEM_ID JF_URL JF_TOKEN JF_USERID JF_SERVERID  [USER_AGENT]  [BLOCK_SCRIPT=1]  [ONLY_OPEN=1 | ONLY_FORWARD=1]
import { chromium } from "playwright-core";

const { ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const auth = { Authorization: `MediaBrowser Token="${JF_TOKEN}"`, "Content-Type": "application/json" };
const api = async (path, init = {}) => {
  const response = await fetch(`${JF_URL}${path}`, { ...init, headers: auth });
  return response.headers.get("content-type")?.includes("json") ? response.json() : null;
};
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
// USER_AGENT : se présenter comme un autre appareil (un téléviseur, que Lumen doit laisser à jellyfin-web).
// BLOCK_SCRIPT=1 : le script de Lumen n'arrive pas (navigateur trop ancien pour le lire, filtre) alors que
// son nom est dans la liste des plugins — le client web doit lire comme si de rien n'était.
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(process.env.USER_AGENT ? { userAgent: process.env.USER_AGENT } : {}) });
if (process.env.BLOCK_SCRIPT) await context.route("**/Lumen/web/**", (route) => route.abort());
await context.addInitScript(
  ([url, token, user, server]) => {
    localStorage.setItem("_deviceId2", "lumen-banc-limites");
    for (const network of ["true", "false"]) {
      localStorage.setItem(`enableautomaticbitratedetection-${network}-Video`, "false");
      localStorage.setItem(`maxbitrate-${network}-Video`, "200000000");
    }
    localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
  },
  [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID]
);
const page = await context.newPage();
const log = [];
const errors = [];
let hls = 0;
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
page.on("console", (message) => {
  if (message.text().startsWith("[Lumen]")) log.push(message.text().slice(0, 200));
});
page.on("request", (request) => {
  if (/\.m3u8/.test(request.url())) hls += 1;
});
const facts = () =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const s = window.Lumen?.status();
    return { t: v ? Math.round(v.currentTime * 10) / 10 : null, paused: v?.paused ?? null, lumen: s?.playing ?? null, track: s?.audioTrack ?? null };
  });
const wake = async () => {
  await page.mouse.move(600 + Math.random() * 50, 300 + Math.random() * 50);
  await page.mouse.move(640, 360);
};
const advancing = (cap = 30_000) =>
  page.evaluate(
    (cap) =>
      new Promise((resolve) => {
        const v = document.querySelector("video");
        if (!v) return resolve(false);
        const from = v.currentTime;
        const until = performance.now() + cap;
        const tick = () => (v.currentTime - from >= 2 ? resolve(true) : performance.now() > until ? resolve(false) : setTimeout(tick, 100));
        tick();
      }),
    cap
  );
const slide = (seconds) =>
  page.evaluate((seconds) => {
    const v = document.querySelector("video");
    const slider = document.querySelector(".osdPositionSlider");
    slider.value = String((seconds / v.duration) * 100);
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  }, seconds);
const pickOtherAudio = async () => {
  await wake();
  await page.locator(".videoOsdBottom .btnAudio").click();
  const choices = page.locator(".actionSheet .actionSheetMenuItem");
  await choices.first().waitFor({ state: "visible", timeout: 10_000 });
  for (let i = 0; i < (await choices.count()); i++) {
    if (await choices.nth(i).locator(".actionsheetMenuItemIcon.check:not([style*='hidden'])").count()) continue;
    await choices.nth(i).click();
    return;
  }
};

const out = {};
try {
  // 1. Reprise : le compte a une position, « Lire » doit y reprendre.
  await api(`/UserItems/${ITEM_ID}/UserData?userId=${JF_USERID}`, { method: "POST", body: JSON.stringify({ PlaybackPositionTicks: 600 * 1e7 }) });
  await page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
  const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
  await play.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await play.click();
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 3, null, { timeout: 60_000 });
  out.resume = { asked: 600, moves: await advancing(), ...(await facts()) };
  const duration = await page.evaluate(() => document.querySelector("video").duration);
  out.duration = Math.round(duration);
  if (process.env.ONLY_OPEN) throw new Error("ouverture seule");

  // 2. Deux « avance rapide » coup sur coup : la seconde doit s'ajouter à la première.
  await wake();
  const before = (await facts()).t;
  await page.evaluate(() => {
    const button = document.querySelector(".btnFastForward");
    button.click();
    button.click();
  });
  await page.waitForTimeout(4000);
  out.doubleForward = { from: before, moves: await advancing(), ...(await facts()) };
  if (process.env.ONLY_FORWARD) throw new Error("avance seule");

  // 3. Piste son changée pendant la pause : le film doit rester en pause.
  await wake();
  await page.evaluate(() => document.querySelector("video").pause());
  await page.waitForTimeout(500);
  const pausedAt = await facts();
  await pickOtherAudio();
  await page.waitForFunction((track) => { const s = window.Lumen?.status(); return s?.playing && s.audioTrack !== null && s.audioTrack !== track; }, pausedAt.track, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  out.audioWhilePaused = { before: pausedAt, after: await facts() };
  await page.evaluate(() => document.querySelector("video").play().catch(() => {}));

  // 4. Un saut donné pendant que le flux se rouvre (changement de piste) : il ne doit pas se perdre.
  await page.waitForTimeout(1500);
  const track = (await facts()).track;
  await pickOtherAudio();
  await slide(1500);
  await page.waitForFunction((track) => { const s = window.Lumen?.status(); return s?.playing && s.audioTrack !== track; }, track, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  out.seekWhileReopening = { asked: 1500, moves: await advancing(), ...(await facts()) };

  // 5. La fin du fichier : le lecteur doit se fermer (ou enchaîner), et le serveur marquer l'élément vu.
  await wake();
  await slide(duration - 6);
  const ended = await page.waitForFunction((id) => { const v = document.querySelector("video"); return !v || v.ended || v.currentSrc === "" || !location.hash.includes("video"); }, ITEM_ID, { timeout: 60_000 }).then(() => true, () => false);
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => ({ hash: location.hash.slice(0, 40), video: document.querySelector("video") !== null, lumen: window.Lumen?.status().playing ?? null, t: document.querySelector("video")?.currentTime ?? null }));
  const data = (await api(`/Items/${ITEM_ID}?userId=${JF_USERID}`)).UserData;
  out.end = { ended, ...after, played: data?.Played ?? null, resumeLeft: Math.round((data?.PlaybackPositionTicks ?? 0) / 1e7) };
} catch (error) {
  out.failed = String(error).slice(0, 300);
}
out.hlsRequests = hls;
out.log = log.slice(-14);
if (errors.length) out.pageErrors = errors.slice(0, 5);
console.log(JSON.stringify(out, null, 1));
await api(`/UserPlayedItems/${ITEM_ID}?userId=${JF_USERID}`, { method: "DELETE" });
await browser.close();
