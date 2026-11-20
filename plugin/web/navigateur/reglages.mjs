// La page de réglages du plugin, dans le tableau de bord de Jellyfin : elle s'ouvre, montre les
// interrupteurs tels que le serveur les tient, et affiche le journal des lectures.
//
//   JF_URL JF_TOKEN JF_USERID JF_SERVERID  — imprime ce qu'elle montre, en JSON ; code de sortie 1 si elle est vide.
import { chromium } from "playwright-core";

const { JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID } = process.env;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await context.addInitScript(
  ([url, token, user, server]) => {
    localStorage.setItem("_deviceId2", "lumen-banc-reglages");
    localStorage.setItem("jellyfin_credentials", JSON.stringify({ Servers: [{ Id: server, Name: "banc", ManualAddress: url, manualAddressOnly: true, LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: token, UserId: user }] }));
  },
  [JF_URL, JF_TOKEN, JF_USERID, JF_SERVERID]
);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
await page.goto(`${JF_URL}/web/#/configurationpage?name=Lumen`);
await page.waitForSelector("#LumenConfigPage #LumenJournalRows table, #LumenConfigPage #LumenJournalRows:not(:empty)", { timeout: 30_000 });
const shown = await page.evaluate(() => {
  const page = document.querySelector("#LumenConfigPage");
  const rows = (selector) => [...page.querySelectorAll(`${selector} tr`)].map((tr) => [...tr.children].map((cell) => cell.textContent));
  return {
    toggles: Object.fromEntries(["LumenEnabled", "LumenPlayback", "LumenAllUsers", "LumenJournal"].map((id) => [id, page.querySelector(`#${id}`).checked])),
    users: [...page.querySelectorAll("#LumenUsers span")].map((span) => span.textContent),
    summary: rows("#LumenJournalSummary"),
    journal: rows("#LumenJournalRows"),
  };
});
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
console.log(JSON.stringify({ ...shown, journal: shown.journal.slice(0, 4), journalRows: shown.journal.length - 1, errors }, null, 1));
await browser.close();
process.exit(shown.journal.length > 1 && errors.length === 0 ? 0 : 1);
