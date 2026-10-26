// Checks that syncbuzz.html also works when opened straight from disk
// (file://), which is how it runs if friends just receive the file.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';

const FILE = pathToFileURL(process.argv[2]).href;
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let ok = true;
const errs = [];
async function open(hash = '') {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(FILE + hash);
  return page;
}
const host = await open();
await host.type('#hostName', 'FileHost');
await host.click('#formHost button[type=submit]');
await host.waitForFunction(() => document.getElementById('topStatusText').textContent === 'Room open', { timeout: 30000 });
const code = await host.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('host'));
const note = await host.$eval('#inviteNote', (e) => (e.hidden ? '' : e.textContent));
console.log('file:// host opened room', code, '| note shown:', !!note);
// A friend who got the file opens it and types the room code.
const p = await open();
await p.type('#joinCode', code);
await p.type('#joinName', 'FileFriend');
await p.click('#formJoin button[type=submit]');
await p.waitForFunction(() => (window.syncbuzzDebug().samples || 0) >= 5, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
const title = await host.$eval('#playersTitle', (e) => e.textContent);
console.log('host sees:', title);
ok = ok && title.includes('2 online') && !!note;
console.log('errors:', errs.length ? errs : 'none');
ok = ok && errs.length === 0;
console.log(ok ? 'FILE MODE OK' : 'FILE MODE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
