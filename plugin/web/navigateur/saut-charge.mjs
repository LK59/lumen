// Un saut dans ce qui est déjà chargé : +10 s par la barre de jellyfin-web, une fois vingt secondes
// d'avance en mémoire. Relève le délai jusqu'à l'image, les requêtes du fichier parties pendant le saut,
// les vidages de tampon, et les étapes de l'ouverture que le journal a reçues. Imprime ses constats en JSON.
//
//   ITEM_ID JF_URL JF_TOKEN JF_USERID JF_SERVERID
import { chromium } from "playwright-core";

const { ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(
  ([url, token, user, server]) => {
    localStorage.setItem("_deviceId2", "lumen-banc-saut");
    localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
  },
  [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID]
);
// Chaque vidage d'un tampon est compté : c'est ce qu'un saut servi de mémoire ne fait pas.
await context.addInitScript(() => {
  window.__removes = 0;
  for (const name of ["SourceBuffer", "ManagedSourceBuffer"]) {
    const proto = window[name]?.prototype;
    if (!proto) continue;
    const remove = proto.remove;
    proto.remove = function (start, end) {
      if (end - start > 5) window.__removes += 1;
      return remove.call(this, start, end);
    };
  }
});
const page = await context.newPage();
let ranges = 0;
let journal = null;
page.on("request", (request) => {
  if (/\/Videos\/[^/]+\/stream/.test(request.url()) && request.headers().range) ranges += 1;
  if (request.url().endsWith("/Lumen/Journal") && request.method() === "POST") journal = JSON.parse(request.postData() ?? "null");
});
const out = {};
try {
  await page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
  const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
  await play.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await play.click();
  // Vingt secondes d'avance sous la tête avant de sauter.
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.currentTime > 2 && v.buffered.length > 0 && v.buffered.end(v.buffered.length - 1) - v.currentTime > 20; }, null, { timeout: 90_000 });
  out.lumenPlaying = await page.evaluate(() => window.Lumen?.status().playing ?? false);
  out.seeks = [];
  for (let i = 0; i < 3; i += 1) {
    await page.waitForTimeout(1500);
    const before = ranges;
    const result = await page.evaluate(async () => {
      const v = document.querySelector("video");
      const from = v.currentTime;
      const removes = window.__removes;
      const started = performance.now();
      const frame = new Promise((resolve) => setTimeout(() => v.requestVideoFrameCallback(() => resolve(performance.now() - started)), 0));
      // Dix secondes plus loin, par la barre de position de jellyfin-web.
      const slider = document.querySelector(".osdPositionSlider");
      slider.value = String(((from + 10) / v.duration) * 100);
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      const ms = await frame;
      return { from: Math.round(from * 10) / 10, to: Math.round(v.currentTime * 10) / 10, ms: Math.round(ms), flushes: window.__removes - removes };
    });
    await page.waitForTimeout(300);
    out.seeks.push({ ...result, rangesDuring: ranges - before });
  }
  await page.evaluate(() => history.back());
  await page.waitForTimeout(3000);
  out.openingSteps = journal?.openingSteps ?? null;
  out.firstFrameMs = journal?.firstFrameMs ?? null;
  out.journalSeeks = journal?.seeksMs ?? null;
} catch (error) {
  out.failed = String(error).slice(0, 300);
}
console.log(JSON.stringify(out));
await browser.close();
