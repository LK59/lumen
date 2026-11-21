// L'ouverture, de zéro ou en reprise : ce que le journal en mesure (première image, étapes du pont) et
// ce que l'élément <video> a vécu entre-temps. Relève des faits, en JSON ; ne juge pas.
//
//   ITEM_ID JF_URL JF_TOKEN JF_USERID JF_SERVERID  [START=secondes de reprise, 0 par défaut]
import { chromium } from "playwright-core";

const { ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const START = Number(process.env.START ?? 0);
const auth = { Authorization: `MediaBrowser Token="${JF_TOKEN}"`, "Content-Type": "application/json" };
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(
  ([url, token, user, server]) => {
    localStorage.setItem("_deviceId2", "lumen-banc-ouverture");
    for (const network of ["true", "false"]) {
      localStorage.setItem(`enableautomaticbitratedetection-${network}-Video`, "false");
      localStorage.setItem(`maxbitrate-${network}-Video`, "200000000");
    }
    localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
    // Les événements de média ne remontent pas, mais la phase de capture les voit passer.
    window.__events = [];
    for (const type of ["loadstart", "loadedmetadata", "loadeddata", "canplay", "play", "playing", "waiting", "seeking", "seeked", "pause", "timeupdate"])
      document.addEventListener(type, (event) => {
        const v = event.target;
        if (type === "timeupdate" && window.__events.filter((e) => e[1] === "timeupdate").length >= 3) return;
        window.__events.push([Math.round(performance.now()), type, Math.round(v.currentTime * 100) / 100, v.readyState]);
      }, true);
  },
  [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID]
);
const page = await context.newPage();
let journal = null;
const log = [];
page.on("console", (message) => {
  if (message.text().startsWith("[Lumen]")) log.push(message.text().slice(0, 160));
});
page.on("request", (request) => {
  if (request.url().endsWith("/Lumen/Journal") && request.method() === "POST") journal = JSON.parse(request.postData() ?? "null");
});
const out = { start: START };
try {
  await fetch(`${JF_URL}/UserItems/${ITEM_ID}/UserData?userId=${JF_USERID}`, { method: "POST", headers: auth, body: JSON.stringify({ PlaybackPositionTicks: START * 1e7 }) });
  await page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
  const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
  await play.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await play.click();
  out.clickedAt = await page.evaluate(() => Math.round(performance.now()));
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 3 && !v.paused && window.__events.some((e) => e[1] === "timeupdate"); }, null, { timeout: 60_000 });
  await page.waitForTimeout(3000);
  out.events = (await page.evaluate(() => window.__events)).map(([at, ...rest]) => [at - out.clickedAt, ...rest]);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(2000);
  const entry = journal?.entry ?? journal;
  out.firstFrameMs = entry?.firstFrameMs ?? null;
  out.player = entry?.player ?? null;
  out.steps = entry?.openingSteps ?? null;
} catch (error) {
  out.error = String(error).slice(0, 200);
}
out.log = log;
console.log(JSON.stringify(out));
await browser.close();
