// Ce qui arrive quand Lumen ne peut pas, ou ne peut plus : la lecture doit continuer par jellyfin-web,
// sans écran d'erreur. Deux situations que le parcours ordinaire ne provoque pas.
//
//   CASE=panne   le serveur cesse de servir le fichier brut en pleine lecture Lumen (réponses 500), puis saut
//   CASE=csp     la page est servie sous une politique de sécurité stricte (ni worker blob:, ni WebAssembly)
//
//   ITEM_ID JF_URL JF_TOKEN JF_USERID JF_SERVERID — imprime ses constats en JSON.
import { chromium } from "playwright-core";

const { CASE, ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const DEVICE = "lumen-banc-repli";
const auth = { Authorization: `MediaBrowser Token="${JF_TOKEN}"` };
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(
  ([url, token, user, server, device]) => {
    localStorage.setItem("_deviceId2", device);
    localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
  },
  [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID, DEVICE]
);
if (CASE === "csp") {
  // Ce qu'un proxy prudent poserait : tout vient du serveur, les médias peuvent être des blob: (hls.js et
  // MediaSource en ont besoin), mais ni worker blob:, ni compilation de WebAssembly.
  const policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'";
  await context.route(/\/web\/(index\.html)?(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
  });
}
const page = await context.newPage();
const errors = [];
const lumenLog = [];
const blocked = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));
page.on("console", (message) => {
  const text = message.text();
  if (text.startsWith("[Lumen]")) lumenLog.push(text.slice(0, 200));
  if (/Content Security Policy/i.test(text)) blocked.push(text.replace(/\s+/g, " ").slice(0, 150));
});
const state = async () => {
  const session = (await (await fetch(`${JF_URL}/Sessions`, { headers: auth })).json()).find((s) => s.DeviceId === DEVICE && s.NowPlayingItem);
  return page.evaluate((method) => {
    const video = document.querySelector("video");
    const dialog = document.querySelector(".dialogContainer .dialog:not(.actionSheet), .toast");
    return { lumen: window.Lumen?.status()?.playing ?? null, time: video ? Math.round(video.currentTime) : null, paused: video?.paused ?? null, method, dialog: dialog ? dialog.innerText.replace(/\s+/g, " ").slice(0, 120) : null };
  }, session?.PlayState?.PlayMethod ?? null);
};
const advances = (seconds, cap) =>
  page.evaluate(
    ([seconds, cap]) =>
      new Promise((resolve) => {
        const video = document.querySelector("video");
        if (!video) return resolve(false);
        const from = video.currentTime;
        const until = performance.now() + cap;
        const tick = () => (document.querySelector("video")?.currentTime - from >= seconds ? resolve(true) : performance.now() > until ? resolve(false) : setTimeout(tick, 200));
        tick();
      }),
    [seconds, cap]
  );

const out = { case: CASE };
try {
  // Du début : pas de position de reprise laissée par un passage précédent.
  await fetch(`${JF_URL}/UserPlayedItems/${ITEM_ID}?userId=${JF_USERID}`, { method: "DELETE", headers: auth });
  await page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
  const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
  await play.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  const clicked = Date.now();
  await play.click();
  out.started = await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 2, null, { timeout: 90_000 }).then(() => true, () => false);
  out.startMs = Date.now() - clicked;
  out.opening = await state();
  if (CASE === "panne" && out.opening.lumen) {
    // Le fichier brut n'est plus servi ; un saut au loin oblige le moteur à redemander au serveur.
    await context.route(/\/Videos\/[^/]+\/stream\?static=true/i, (route) => route.fulfill({ status: 500, body: "" }));
    const duration = await page.evaluate(() => document.querySelector("video").duration);
    await page.mouse.move(600, 300);
    await page.mouse.move(640, 360);
    await page.waitForSelector(".osdPositionSlider", { state: "attached", timeout: 20_000 });
    const failedAt = Date.now();
    await page.evaluate(() => {
      const slider = document.querySelector(".osdPositionSlider");
      slider.value = "62";
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    out.timeline = [];
    for (let i = 0; i < 26; i++) {
      await page.waitForTimeout(5000);
      const now = { afterS: Math.round((Date.now() - failedAt) / 1000), ...(await state()) };
      out.timeline.push(now);
      // Rendu à jellyfin-web et reparti : c'est ce qu'on attend.
      if (now.lumen === false && now.method && now.method !== "DirectPlay" && (await advances(2, 15_000))) {
        out.recovered = { afterS: Math.round((Date.now() - failedAt) / 1000), near: Math.abs(now.time - duration * 0.62) < 120, ...(await state()) };
        break;
      }
    }
  } else {
    out.plays = await advances(4, 30_000);
    out.after = await state();
  }
} catch (error) {
  out.failed = String(error).slice(0, 300);
}
out.lumenLog = lumenLog.slice(0, 12);
out.cspBlocked = [...new Set(blocked)].slice(0, 6);
out.errors = errors.slice(0, 5);
console.log(JSON.stringify(out));
await browser.close();
