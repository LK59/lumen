// Banc de R&D : le temps entre le clic sur « Lire » et la première image, étape par étape, dans le vrai
// client web. Une page par passage (page froide), puis une seconde ouverture dans la même page (page
// chaude), puis une reprise en cours de film. Le réseau peut être ralenti (LATENCY_MS par requête) : sur
// la boucle locale, tout ce qui coûte un aller-retour ne se voit pas.
//
//   ITEM_ID JF_URL JF_TOKEN JF_USERID JF_SERVERID [LATENCY_MS=0] [RESUME=600] [RUNS=3] [SCENARIOS=cold,warm,resume]
import { chromium } from "playwright-core";

const { ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const LATENCY = Number(process.env.LATENCY_MS ?? 0);
const RESUME = Number(process.env.RESUME ?? 600);
const RUNS = Number(process.env.RUNS ?? 3);
const SCENARIOS = (process.env.SCENARIOS ?? "cold,warm,resume").split(",");
const auth = { Authorization: `MediaBrowser Token="${JF_TOKEN}"`, "Content-Type": "application/json" };

const position = (seconds) => fetch(`${JF_URL}/UserItems/${ITEM_ID}/UserData?userId=${JF_USERID}`, { method: "POST", headers: auth, body: JSON.stringify({ PlaybackPositionTicks: seconds * 1e7 }) });

async function session(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(
    ([url, token, user, server]) => {
      localStorage.setItem("_deviceId2", "lumen-banc-rd");
      for (const network of ["true", "false"]) {
        localStorage.setItem(`enableautomaticbitratedetection-${network}-Video`, "false");
        localStorage.setItem(`maxbitrate-${network}-Video`, "200000000");
      }
      localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
      // La première image réellement présentée après le clic, vue de la page et non du journal.
      window.__frame = null;
      window.__arm = () => {
        window.__frame = null;
        const from = performance.now();
        const watch = () => {
          const v = document.querySelector("video");
          if (!v || typeof v.requestVideoFrameCallback !== "function") return void setTimeout(watch, 5);
          const seen = (now, meta) => {
            if (v.seeking) return void v.requestVideoFrameCallback(seen);
            // L'image n'est vue qu'une fois l'élément visible : le pont la retient pendant le zoom d'ouverture.
            const frame = { ms: Math.round(performance.now() - from), mediaTime: Math.round(meta.mediaTime * 100) / 100, hidden: getComputedStyle(v).visibility !== "visible", zooming: v.closest(".videoPlayerContainer")?.getAnimations?.().length > 0 };
            const shown = () => {
              if (getComputedStyle(v).visibility !== "visible") return void requestAnimationFrame(shown);
              window.__frame = { ...frame, shownMs: Math.round(performance.now() - from), zoomingWhenShown: v.closest(".videoPlayerContainer")?.getAnimations?.().length > 0 };
            };
            shown();
          };
          v.requestVideoFrameCallback(seen);
        };
        watch();
      };
    },
    [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID]
  );
  const page = await context.newPage();
  if (LATENCY > 0) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: Number(process.env.DOWN_BPS ?? 50e6) / 8, uploadThroughput: 20e6 / 8 });
  }
  const journals = [];
  const requests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.endsWith("/Lumen/Journal") && request.method() === "POST") journals.push(JSON.parse(request.postData() ?? "null"));
    if (/\/Videos\/|PlaybackInfo|Lumen\/Settings/.test(url)) requests.push([request.method(), url.replace(JF_URL, "").replace(/\?.*/, "").slice(0, 60), request.headers()["range"] ?? "", Date.now()]);
  });
  const log = [];
  page.on("console", (message) => {
    if (message.text().startsWith("[Lumen]")) log.push(message.text().slice(0, 140));
  });
  return { context, page, journals, requests, log };
}

async function openOnce(s, label) {
  const { page, journals, requests } = s;
  const before = journals.length;
  const requestsBefore = requests.length;
  const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide), .itemDetailPage:not(.hide) .mainDetailButtons .btnResume:not(.hide)").first();
  await play.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(Number(process.env.DWELL_MS ?? 1500));
  await page.evaluate(() => window.__arm());
  await play.click();
  await page.waitForFunction(() => window.__frame !== null, null, { timeout: 60_000 });
  const frame = await page.evaluate(() => window.__frame);
  await page.waitForTimeout(1500);
  const duringOpen = requests.slice(requestsBefore);
  const standby = await page.evaluate(() => window.Lumen?.status?.()?.standby ?? null);
  const traceText = process.env.SHOW_TRACE ? await page.evaluate(() => window.Lumen?.trace?.()) : null;
  await page.evaluate(() => history.back());
  await page.waitForFunction((n) => true, before, { timeout: 1000 }).catch(() => {});
  for (let i = 0; i < 40 && journals.length === before; i += 1) await page.waitForTimeout(100);
  const entry = journals[journals.length - 1]?.entry ?? journals[journals.length - 1];
  return { label, openings: journals.length > before ? entry?.openings : null, clickToFrameMs: frame.ms, shownMs: frame.shownMs, hiddenAtFrame: frame.hidden, zoomingAtFrame: frame.zooming, zoomingWhenShown: frame.zoomingWhenShown, mediaTime: frame.mediaTime, journalMs: journals.length > before ? entry?.firstFrameMs : null, player: entry?.player ?? null, standby, steps: journals.length > before ? entry?.openingSteps : null, ...(traceText ? { trace: traceText.split("\n") } : {}), requests: duringOpen.length, ranges: duringOpen.filter((r) => r[2]).length, ...(process.env.SHOW_RANGES ? { list: duringOpen.map((r) => [r[3] - duringOpen[0][3], r[1].replace(/\/Videos\/[0-9a-f]+/, "V").replace(/\/Items\/[0-9a-f]+/, "I"), r[2].replace("bytes=", "")]) } : {}) };
}

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
for (let run = 0; run < RUNS; run += 1) {
  try {
    if (SCENARIOS.includes("cold") || SCENARIOS.includes("warm")) {
      await position(0);
      const s = await session(browser);
      await s.page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
      results.push(await openOnce(s, "cold"));
      if (SCENARIOS.includes("warm")) {
        await position(0);
        await s.page.reload();
        results.push(await openOnce(s, "reload"));
        await position(0);
        await s.page.waitForTimeout(500);
        results.push(await openOnce(s, "warm"));
      }
      if (process.env.SHOW_LOG) results.push({ log: s.log });
      await s.context.close();
    }
    if (SCENARIOS.includes("resume")) {
      await position(RESUME);
      const s = await session(browser);
      await s.page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
      results.push(await openOnce(s, "resume"));
      await s.context.close();
    }
  } catch (error) {
    results.push({ error: String(error).slice(0, 300) });
  }
}
await position(0);
for (const r of results) console.log(JSON.stringify(r));
await browser.close();
