// Les sous-titres à l'écran : sont-ils affichés, et à quel instant du film ?
//
// Le parcours (pont.mjs) constate qu'une piste est demandée et montée. Ici on regarde ce qui est écrit à
// l'écran : on prend une réplique de la piste choisie, on saute quelques secondes avant, et on relève
// l'instant du film où son texte apparaît. Imprime ses constats en JSON.
//
//   ITEM_ID JF_URL JF_TOKEN JF_USERID JF_SERVERID
import { chromium } from "playwright-core";

const { ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const DEVICE = "lumen-banc-sous-titres";
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
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
const wake = async () => {
  await page.mouse.move(600 + Math.random() * 50, 300);
  await page.mouse.move(640, 360);
};
const out = {};
try {
  await page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
  const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
  await play.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await play.click();
  await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 2, null, { timeout: 90_000 });
  out.lumen = await page.evaluate(() => window.Lumen?.status()?.playing ?? null);

  // Une piste de sous-titres, par le menu de jellyfin-web (le premier choix est « Désactivé »).
  await wake();
  await page.locator(".videoOsdBottom .btnSubtitles:not(.hide)").click();
  const choices = page.locator(".actionSheet .actionSheetMenuItem");
  await choices.first().waitFor({ state: "visible", timeout: 10_000 });
  out.menu = await choices.allInnerTexts().then((texts) => texts.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 40)));
  await choices.nth(Number(process.env.CHOICE ?? 1)).click();
  await page.waitForTimeout(2500);

  // La piste choisie : le menu suit l'ordre des flux de sous-titres de l'élément (le serveur, lui, n'apprend
  // le choix qu'au rapport de progression suivant, jusqu'à dix secondes plus tard).
  const item = await (await fetch(`${JF_URL}/Items/${ITEM_ID}?userId=${JF_USERID}`, { headers: auth })).json();
  const index = item.MediaSources[0].MediaStreams.filter((s) => s.Type === "Subtitle")[Number(process.env.CHOICE ?? 1) - 1]?.Index;
  out.track = index;
  out.stillLumen = await page.evaluate(() => window.Lumen?.status()?.playing ?? null);
  const vtt = await (await fetch(`${JF_URL}/Videos/${ITEM_ID}/${ITEM_ID}/Subtitles/${index}/Stream.vtt`, { headers: auth })).text();
  const seconds = (t) => t.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
  const cues = [...vtt.matchAll(/(\d[\d:.]+) --> (\d[\d:.]+)[^\n]*\n([\s\S]*?)(?:\n\n|$)/g)].map((m) => ({ start: seconds(m[1]), end: seconds(m[2]), text: m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() }));
  out.cues = cues.length;
  // Une réplique loin du début, précédée de trois secondes de silence : rien d'autre ne sera à l'écran.
  const duration = await page.evaluate(() => document.querySelector("video").duration);
  const picks = cues.filter((cue, i) => cue.start > 120 && cue.start < duration - 60 && cue.text.length > 6 && cue.end - cue.start > 1 && (i === 0 || cue.start - cues[i - 1].end > 3)).slice(0, 3);
  out.measures = [];
  for (const cue of picks) {
    await wake();
    await page.evaluate((percent) => {
      const slider = document.querySelector(".osdPositionSlider");
      slider.value = String(percent);
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }, ((cue.start - 5) / duration) * 100);
    // Ce qui est écrit à l'écran, relevé à chaque image : le texte, et l'instant du film à ce moment-là.
    const seen = await page.evaluate(
      ([needle, cap]) =>
        new Promise((resolve) => {
          const video = document.querySelector("video");
          const norm = (s) => s.replace(/\s+/g, " ").trim();
          const shown = () => {
            const custom = [...document.querySelectorAll(".videoSubtitlesInner, .videoSubtitles")].map((e) => e.innerText).join(" ");
            const native = [...video.textTracks].filter((t) => t.mode === "showing").flatMap((t) => [...(t.activeCues ?? [])].map((c) => c.text)).join(" ");
            return norm(`${custom} ${native}`.replace(/<[^>]+>/g, ""));
          };
          const until = performance.now() + cap;
          const tick = () => {
            if (shown().includes(needle)) {
              const position = window.Lumen?.status()?.position;
              return resolve({ film: typeof position === "number" ? position : video.currentTime, element: video.currentTime, how: document.querySelector(".videoSubtitlesInner") ? "élément de jellyfin-web" : "piste native" });
            }
            if (performance.now() > until) return resolve(null);
            requestAnimationFrame(tick);
          };
          tick();
        }),
      [cue.text.slice(0, 24), 40_000]
    );
    out.measures.push({ element: seen ? Math.round(seen.element * 1000) / 1000 : null, cue: Math.round(cue.start * 1000) / 1000, appearedAtFilm: seen ? Math.round(seen.film * 1000) / 1000 : null, offsetMs: seen ? Math.round((seen.film - cue.start) * 1000) : null, how: seen?.how ?? null });
  }
} catch (error) {
  out.failed = String(error).slice(0, 300);
}
out.errors = errors;
console.log(JSON.stringify(out));
await browser.close();
