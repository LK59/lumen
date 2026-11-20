// Le panneau « Playback Info » de jellyfin-web pendant une lecture : ce qu'il affiche comme lecteur, et
// sa croix — avec Lumen, puis après avoir décoché « Play with Lumen » sans recharger l'onglet, puis après
// l'avoir recoché. Imprime ses constats en JSON.
//
//   ITEM_ID JF_URL JF_TOKEN JF_USERID JF_SERVERID
import { chromium } from "playwright-core";

const { ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(
  ([url, token, user, server]) => {
    localStorage.setItem("_deviceId2", "lumen-banc-panneau");
    localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
  },
  [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID]
);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
const wake = async () => {
  await page.mouse.move(600 + Math.random() * 50, 300);
  await page.mouse.move(640, 360);
};
const panels = () =>
  page.evaluate(() => [...document.querySelectorAll(".playerStats")].map((panel) => ({ hidden: panel.classList.contains("hide"), text: panel.querySelector(".playerStats-stats")?.innerText.replace(/\s+/g, " ").slice(0, 400) ?? "" })));

async function playAndOpenPanel() {
  await page.goto(`${JF_URL}/web/#/details?id=${ITEM_ID}&serverId=${JF_SERVERID}`);
  const play = page.locator(".itemDetailPage:not(.hide) .mainDetailButtons .btnPlay:not(.hide)").first();
  await play.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await play.click();
  await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 2, null, { timeout: 60_000 });
  await wake();
  await page.locator(".videoOsdBottom .btnVideoOsdSettings").click();
  await page.locator('.actionSheet .actionSheetMenuItem[data-id="stats"]').click();
  await page.waitForFunction(() => document.querySelector(".playerStats:not(.hide) .playerStats-stat-value") !== null, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
}

/** Bascule « Play with Lumen » dans les réglages du plugin, comme le ferait sa page. */
const setPlayback = (playback) =>
  fetch(`${JF_URL}/Plugins/6f1b0a3e52c84d0e9a7b1c7e5d9a4b20/Configuration`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `MediaBrowser Token="${JF_TOKEN}"` },
    body: JSON.stringify({ Enabled: true, Playback: playback, AllUsers: true, UserIds: [], Journal: false }),
  });

const out = {};
await setPlayback(true);
try {
  await playAndOpenPanel();
  out.lumenPlaying = await page.evaluate(() => window.Lumen?.status()?.playing ?? null);
  out.open = await panels();
  await page.locator(".playerStats:not(.hide) .playerStats-closeButton").click({ timeout: 5000 }).catch((error) => (out.closeClick = String(error).slice(0, 200)));
  await page.waitForTimeout(800);
  out.afterClose = (await panels()).map((p) => p.hidden);
  // Rouvrir, puis fermer encore : c'est après un aller-retour que la croix a été vue en panne.
  await wake();
  await page.locator(".videoOsdBottom .btnVideoOsdSettings").click();
  await page.locator('.actionSheet .actionSheetMenuItem[data-id="stats"]').click();
  await page.waitForTimeout(1500);
  out.reopened = (await panels()).map((p) => p.hidden);
  await page.locator(".playerStats:not(.hide) .playerStats-closeButton").click({ timeout: 5000 }).catch((error) => (out.closeClick2 = String(error).slice(0, 200)));
  await page.waitForTimeout(800);
  out.afterSecondClose = (await panels()).map((p) => p.hidden);
  // Le réglage basculé pendant que l'onglet reste ouvert : la lecture suivante, sans rechargement, doit
  // se faire par jellyfin-web, et le panneau doit le dire.
  await wake();
  await page.locator(".videoOsdBottom .btnVideoOsdSettings").click();
  await page.locator('.actionSheet .actionSheetMenuItem[data-id="stats"]').click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(2500);
  out.afterStop = (await panels()).map((p) => p.hidden);
  await setPlayback(false);
  await playAndOpenPanel();
  out.secondLumenPlaying = await page.evaluate(() => window.Lumen?.status()?.playing ?? null);
  out.secondPlayback = (await panels()).map((p) => `${p.hidden ? "caché" : "visible"} : ${p.text.slice(0, 70)}`);
  await page.locator(".playerStats:not(.hide) .playerStats-closeButton").first().click({ timeout: 5000 }).catch((error) => (out.closeClick3 = String(error).slice(0, 200)));
  await page.waitForTimeout(800);
  out.afterThirdClose = (await panels()).map((p) => p.hidden);
  // Et retour : Lumen rallumé, toujours dans le même onglet.
  await page.evaluate(() => history.back());
  await page.waitForTimeout(2500);
  await setPlayback(true);
  await playAndOpenPanel();
  out.thirdLumenPlaying = await page.evaluate(() => window.Lumen?.status()?.playing ?? null);
  out.thirdPlayback = (await panels()).map((p) => `${p.hidden ? "caché" : "visible"} : ${p.text.slice(0, 70)}`);
  await page.locator(".playerStats:not(.hide) .playerStats-closeButton").first().click({ timeout: 5000 }).catch((error) => (out.closeClick4 = String(error).slice(0, 200)));
  await page.waitForTimeout(800);
  out.afterFourthClose = (await panels()).map((p) => p.hidden);
} catch (error) {
  out.failed = String(error).slice(0, 300);
}
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
