// Sonde : quels événements le client web émet-il à l'affichage d'une fiche, et avec quels détails ?
import { chromium } from "playwright-core";
const { ITEM_ID, JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript(([url, token, user, server]) => {
  localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
  window.__seen = [];
  for (const type of ["viewshow", "viewbeforeshow", "pageshow", "hashchange", "popstate"])
    (type === "hashchange" || type === "popstate" ? window : document).addEventListener(type, (e) => window.__seen.push([type, location.hash.slice(0, 60), JSON.stringify(e.detail ?? null).slice(0, 300), e.target?.className?.slice?.(0, 60) ?? ""]), true);
}, [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID]);
const page = await context.newPage();
await page.goto(`${JF_URL}/web/#/home`);
await page.waitForTimeout(4000);
await page.evaluate((id) => document.querySelector(`[data-id="${id}"] a, a[href*="details?id="]`)?.click(), ITEM_ID);
await page.waitForTimeout(3000);
await page.evaluate(() => history.back());
await page.waitForTimeout(2000);
for (const e of await page.evaluate(() => window.__seen)) console.log(JSON.stringify(e));
await browser.close();
