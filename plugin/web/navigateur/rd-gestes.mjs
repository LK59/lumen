// Banc de R&D : les gestes en cours de lecture — sauts lointains et changements de piste son —, mesurés
// par le journal du pont (de l'ordre à la première image), avec le nombre de négociations que le client
// web a faites avec le serveur pendant ce temps.
//
//   ITEM_ID JF_URL JF_TOKEN JF_USERID JF_SERVERID [LATENCY_MS=0] [RUNS=1]
import { chromium } from "playwright-core";

const { ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const LATENCY = Number(process.env.LATENCY_MS ?? 0);
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
for (let run = 0; run < Number(process.env.RUNS ?? 1); run += 1) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(([url, token, user, server]) => {
    localStorage.setItem("_deviceId2", "lumen-banc-rd");
    for (const network of ["true", "false"]) {
      localStorage.setItem(`enableautomaticbitratedetection-${network}-Video`, "false");
      localStorage.setItem(`maxbitrate-${network}-Video`, "200000000");
    }
    localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
  }, [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID]);
  const page = await context.newPage();
  if (LATENCY > 0) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: 50e6 / 8, uploadThroughput: 20e6 / 8 });
  }
  let journal = null;
  let negotiations = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/Lumen/Journal") && request.method() === "POST") journal = JSON.parse(request.postData() ?? "null");
    if (/PlaybackInfo/.test(request.url())) negotiations += 1;
  });
  const out = {};
  try {
    await fetch(`${JF_URL}/UserItems/${ITEM_ID}/UserData?userId=${JF_USERID}`, { method: "POST", headers: { Authorization: `MediaBrowser Token="${JF_TOKEN}"`, "Content-Type": "application/json" }, body: JSON.stringify({ PlaybackPositionTicks: 0 }) });
    await page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
    const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
    await play.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await play.click();
    await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.currentTime > 2 && !v.paused; }, null, { timeout: 90_000 });
    const status = () => page.evaluate(() => window.Lumen?.status() ?? null);
    const settled = () => page.waitForFunction(() => { const v = document.querySelector("video"); return v && !v.seeking && v.readyState >= 3; }, null, { timeout: 60_000 });
    // Trois sauts lointains, par la barre de position du client web.
    for (const fraction of [0.3, 0.6, 0.15]) {
      await page.waitForTimeout(1500);
      await page.evaluate((fraction) => {
        const slider = document.querySelector(".osdPositionSlider");
        slider.value = String(fraction * 100);
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      }, fraction);
      await page.waitForTimeout(400);
      await settled();
    }
    if (process.env.SHOW_TRACE) (out.traces ??= []).push((await page.evaluate(() => window.Lumen?.trace?.())).split("\n"));
    // Deux changements de piste son, par le menu du client web : vers une autre piste, puis retour.
    out.audio = [];
    const before = negotiations;
    for (let i = 0; i < 2; i += 1) {
      await page.waitForTimeout(2000);
      const from = (await status())?.audioTrack;
      await page.mouse.move(640, 360);
      await page.mouse.move(650, 370);
      await page.locator(".videoOsdBottom .btnAudio").click();
      const choices = page.locator(".actionSheet .actionSheetMenuItem");
      await choices.first().waitFor({ state: "visible", timeout: 10_000 });
      // La première piste qui n'est pas celle en cours (la piste en cours porte la coche).
      const count = await choices.count();
      let picked = false;
      for (let n = 0; n < count && !picked; n += 1) {
        if (await choices.nth(n).locator(".actionsheetMenuItemIcon.check:not([style*='hidden'])").count()) continue;
        // Du clic au film qui repart sur la nouvelle piste : vu de la page, sans passer par le journal.
        await page.evaluate((from) => {
          const v = document.querySelector("video");
          const started = performance.now();
          window.__resumed = null;
          let at = null;
          const look = () => {
            const s = window.Lumen?.status();
            if (s?.playing && s.audioTrack !== null && s.audioTrack !== from && !v.seeking && v.readyState >= 3) {
              if (at === null) at = v.currentTime;
              else if (v.currentTime > at + 0.1) return void (window.__resumed = Math.round(performance.now() - started));
            } else at = null;
            requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        }, from);
        await choices.nth(n).click();
        picked = true;
      }
      const changed = await page.waitForFunction((from) => { const s = window.Lumen?.status(); return s?.playing && s.audioTrack !== null && s.audioTrack !== from; }, from, { timeout: 30_000 }).then(() => true, () => false);
      await settled();
      await page.waitForFunction(() => window.__resumed !== null, null, { timeout: 30_000 }).catch(() => {});
      if (process.env.SHOW_TRACE) (out.traces ??= []).push((await page.evaluate(() => window.Lumen?.trace?.())).split("\n"));
      out.audio.push({ from, to: (await status())?.audioTrack ?? null, picked, changed, resumedMs: await page.evaluate(() => window.__resumed) });
    }
    await page.waitForTimeout(1500);
    out.negotiationsForAudio = negotiations - before;
    out.position = await page.evaluate(() => Math.round(document.querySelector("video").currentTime));
    await page.evaluate(() => history.back());
    for (let i = 0; i < 40 && !journal; i += 1) await page.waitForTimeout(100);
    const entry = journal?.entry ?? journal;
    out.seeksMs = entry?.seeksMs ?? null;
    out.streamChangesMs = entry?.streamChangesMs ?? null;
    out.errors = entry?.errors ?? null;
    out.rebuilds = entry?.rebuilds ?? null;
  } catch (error) {
    out.failed = String(error).slice(0, 300);
  }
  console.log(JSON.stringify(out));
  await context.close();
}
await browser.close();
