// Banc de R&D : la vérification seule (`probePlaybackPath`), hors de jellyfin-web, avec la trace du moteur
// et les requêtes qu'elle a faites. Dit ce que le verdict attend réellement du réseau.
//
//   ITEM_ID JF_URL JF_TOKEN [LATENCY_MS] [RESUME=0]
import { chromium } from "playwright-core";
const { ITEM_ID, JF_URL, JF_TOKEN } = process.env;
const LATENCY = Number(process.env.LATENCY_MS ?? 0);
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const requests = [];
let t0 = 0;
page.on("request", (r) => { requests.push({ at: Date.now(), range: (r.headers()["range"] ?? r.url().replace(/.*\//, "").slice(0, 40)).replace("bytes=", ""), url: r.url(), r }); });
page.on("requestfinished", (r) => { const q = requests.find((x) => x.r === r); if (q) q.done = Date.now(); });
await page.goto(`${JF_URL}/web/lumen-test/index.html`).catch(() => {});
if (LATENCY > 0) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: Number(process.env.DOWN_BPS ?? 50e6) / 8, uploadThroughput: 20e6 / 8 });
}
const info = await (await fetch(`${JF_URL}/Items/${ITEM_ID}/PlaybackInfo`, { headers: { Authorization: `MediaBrowser Token="${JF_TOKEN}"` } })).json();
const source = info.MediaSources[0];
t0 = Date.now();
const out = await page.evaluate(async ([url, token, id, size, etag, start]) => {
  const core = await import(`${url}/Lumen/web/lumen-core.js`);
  core.configureHost({ build: "rd", requestHeaders: () => ({ Authorization: `MediaBrowser Token="${token}"` }) });
  const from = performance.now();
  const stream = `${url}/Videos/${id}/stream?static=true&mediaSourceId=${id}`;
  const probe = await core.probePlaybackPath({ streamUrl: stream, knownSize: size, fileVersion: etag, startSeconds: start, onError: () => {} });
  const ms = Math.round(performance.now() - from);
  const trace = core.traceText();
  probe.discard();
  return { ms, trace };
}, [JF_URL, JF_TOKEN, ITEM_ID, source.Size, source.ETag, Number(process.env.RESUME ?? 0)]);
const done = Date.now();
await page.waitForTimeout(2500);
console.log(`vérification : ${out.ms} ms`);
for (const line of out.trace.split("\n")) console.log("   " + line.slice(0, 200));
for (const r of requests.filter((x) => x.at >= t0)) console.log(`  +${String(r.at - t0).padStart(5)} ms → ${r.done ? String(r.done - t0).padStart(5) : "  ?  "} ms  ${r.range}${r.at - t0 > out.ms + (done - t0 - out.ms) ? "  (après le verdict)" : ""}`);
console.log(`verdict rendu à +${done - t0} ms`);
await browser.close();
