// End-to-end test for syncbuzz.html: operator + 3 players with different fake
// lag, each in its own isolated browser profile, talking over real WebRTC via
// the public PeerJS server. Every scripted press records the real moment it
// happened, and the app's order is checked against that ground truth.
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://localhost:8765/syncbuzz.html';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

async function openPage(label, hash = '') {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.label = label;
  page.on('pageerror', (e) => {
    console.log(`[${label} pageerror] ${e.message}`);
    failures++;
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${label} console.error] ${m.text()}`);
  });
  page.on('dialog', (d) => {
    if (d.type() === 'beforeunload') {
      page.sawLeaveWarning = true; // the operator's "Leave site?" guard
      d.accept();
      return;
    }
    console.log(`[${label}] unexpected dialog: ${d.message()}`);
    failures++;
    d.dismiss();
  });
  await page.goto(BASE + hash);
  return page;
}
const dbg = (page) => page.evaluate(() => window.syncbuzzDebug());
const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
async function waitFor(page, fn, arg, timeout = 30000) {
  await page.waitForFunction(fn, { timeout, polling: 50 }, arg);
}
const absNow = (page) => page.evaluate(() => performance.timeOrigin + performance.now());

// Press the buzzer at a given wall-clock moment; returns when it really happened.
function pressAt(page, absT) {
  return page.evaluate(
    (T) =>
      new Promise((res) => {
        const d = T - (performance.timeOrigin + performance.now());
        setTimeout(() => {
          const e = new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 });
          document.getElementById('buzz').dispatchEvent(e);
          res(performance.timeOrigin + e.timeStamp);
        }, Math.max(0, d));
      }),
    absT,
  );
}
const clickAt = (page, sel, absT) =>
  page.evaluate(
    (s, T) =>
      new Promise((res) => {
        setTimeout(() => {
          document.querySelector(s).click();
          res(performance.timeOrigin + performance.now());
        }, Math.max(0, T - (performance.timeOrigin + performance.now())));
      }),
    sel,
    absT,
  );

async function hostGoAbs(host) {
  const d = await dbg(host);
  return d.timeOrigin + d.round.goAt;
}
async function waitPhase(page, phase, timeout = 15000) {
  await waitFor(page, (ph) => {
    const r = window.syncbuzzDebug().round;
    return r && r.phase === ph;
  }, phase, timeout);
}

// ---------------------------------------------------------------- setup
console.log('--- setup');
const host = await openPage('host');
await host.type('#hostName', 'Operator');
await host.click('#formHost button[type=submit]');
await waitFor(host, () => document.getElementById('topStatusText').textContent === 'Room open');
const code = await host.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('host'));
console.log('room', code);

const specs = [
  { label: 'Fast', lag: 0, jitter: 0 },
  { label: 'Mid', lag: 300, jitter: 60 },
  { label: 'Slow', lag: 1200, jitter: 200 },
];
const players = [];
for (const s of specs) {
  const p = await openPage(s.label, `#join=${code}${s.lag ? `&lag=${s.lag}&jitter=${s.jitter}` : ''}`);
  await p.$eval('#joinName', (e) => {
    e.value = '';
  });
  await p.type('#joinName', s.label);
  await p.click('#formJoin button[type=submit]');
  players.push(p);
}
const [fast, mid, slow] = players;
for (const p of players) await waitFor(p, () => (window.syncbuzzDebug().samples || 0) >= 10, null, 40000);
await sleep(2500); // let the host collect a few pings of its own

const hostD = await dbg(host);
for (const p of players) {
  const d = await dbg(p);
  const trueOffset = d.timeOrigin - hostD.timeOrigin;
  const err = Math.abs(d.offset - trueOffset);
  console.log(`  ${p.label}: ping ${d.minRtt.toFixed(1)} ms, estimate error ${err.toFixed(2)} ms (worst-case bound ±${d.unc.toFixed(1)})`);
  check(err <= d.unc + 0.5, `${p.label}: true clock offset lies inside the guaranteed bound`);
  check(err < 15, `${p.label}: sync error under 15 ms`);
}
check((await text(host, '#playersTitle')).includes('4 online'), 'host sees 4 online');

// ---------------------------------------------------------------- A: laggiest presses first
async function playRound(order, label) {
  await host.click('#btnStart');
  await waitPhase(host, 'live');
  const go = await hostGoAbs(host);
  const all = { host, fast, mid, slow };
  const presses = await Promise.all(order.map(([who, at]) => pressAt(all[who], go + at).then((t) => ({ who, t }))));
  await waitPhase(host, 'results', 10000);
  const res = (await dbg(host)).results;
  const nameOf = { host: 'Operator', fast: 'Fast', mid: 'Mid', slow: 'Slow' };
  const truth = [...presses].sort((a, b) => a.t - b.t);
  const gotNames = res.map((r) => r.name);
  const wantNames = truth.map((p) => nameOf[p.who]);
  check(JSON.stringify(gotNames) === JSON.stringify(wantNames), `${label}: order ${gotNames.join(' > ')}`);
  let maxErr = 0;
  for (let i = 1; i < truth.length; i++) {
    const trueGap = truth[i].t - truth[i - 1].t;
    const r = res.find((x) => x.name === nameOf[truth[i].who]);
    if (r && r.gap != null) maxErr = Math.max(maxErr, Math.abs(r.gap - trueGap));
  }
  console.log(`  ${label}: gaps ${truth.slice(1).map((p, i) => (p.t - truth[i].t).toFixed(1)).join(', ')} ms; largest gap error ${maxErr.toFixed(2)} ms`);
  // Players see the same result
  for (const p of players) {
    await waitFor(p, (n) => {
      const r = window.syncbuzzDebug().results;
      return r && r.length === n;
    }, res.length, 8000);
    const pr = (await dbg(p)).results.map((r) => r.name);
    check(JSON.stringify(pr) === JSON.stringify(gotNames), `${label}: ${p.label} sees the same order`);
  }
  return { res, maxErr };
}

console.log('--- A: slowest connection presses first');
await playRound([['slow', 500], ['mid', 530], ['host', 560], ['fast', 590]], 'A');

// ---------------------------------------------------------------- B: random rounds
console.log('--- B: random orders, small gaps');
let worst = 0;
for (let i = 0; i < 6; i++) {
  const who = ['host', 'fast', 'mid', 'slow'].sort(() => Math.random() - 0.5);
  let at = 400;
  const order = who.map((w) => [w, (at += 3 + Math.random() * 40)]);
  const { maxErr } = await playRound(order, `B${i + 1}`);
  worst = Math.max(worst, maxErr);
}
check(worst < 20, `B: worst gap error across rounds ${worst.toFixed(2)} ms`);

// ---------------------------------------------------------------- C: End round with a press in flight
console.log('--- C: operator ends while a slow press is still on its way');
await host.click('#btnStart');
await waitPhase(host, 'live');
{
  const go = await hostGoAbs(host);
  // Mid (300 ms lag) presses 60 ms after End, before hearing that the round
  // ended: that press must be rejected as too late.
  const [tSlow, tEnd, tMid] = await Promise.all([
    pressAt(slow, go + 400),
    clickAt(host, '#btnEnd', go + 550),
    pressAt(mid, go + 610),
  ]);
  console.log(`  slow pressed ${(tEnd - tSlow).toFixed(0)} ms before End; mid pressed ${(tMid - tEnd).toFixed(0)} ms after End`);
  await waitFor(mid, () => /not counted/i.test(document.getElementById('stageTitle').textContent), null, 4000).catch(() => {});
  const midTitle = `${await text(mid, '#stageTitle')} / ${await text(mid, '#stageSub')}`;
  check(/not counted/i.test(midTitle) && /too late/i.test(midTitle), `C: mid player told the press was too late ("${midTitle}")`);
  const fastLocked = await fast.evaluate(() => document.getElementById('buzz').className);
  check(!/is-live/.test(fastLocked), 'C: fast player’s button locked after End');
  await waitPhase(host, 'results', 8000);
  const res = (await dbg(host)).results;
  check(res.length === 1 && res[0].name === 'Slow', `C: only the slow press (made before End) counts: ${res.map((r) => r.name).join(',')}`);
  const missing = await text(host, '#resultsMissing');
  check(/Fast/.test(missing) && /Mid/.test(missing), `C: non-pressers listed ("${missing}")`);
}

// ---------------------------------------------------------------- D: early press
console.log('--- D: pressing during the countdown is ignored');
await host.click('#btnStart');
await waitPhase(host, 'live');
{
  const go = await hostGoAbs(host);
  await pressAt(mid, go - 700);
  const sub = await text(mid, '#stageSub');
  check(/too early/i.test(sub), `D: early press shows "${sub}"`);
  await pressAt(mid, go + 300);
  await sleep(1200);
  const hd = await host.evaluate(() => document.getElementById('stageProgress').textContent);
  check(/1 of 4 pressed/.test(hd), `D: after GO the press counts (${hd})`);
  await host.click('#btnEnd');
  await waitPhase(host, 'results', 8000);
  const res = (await dbg(host)).results;
  check(res.length === 1 && res[0].name === 'Mid' && res[0].ms > 250, `D: result is Mid at +${res[0] && res[0].ms.toFixed(0)} ms`);
}

// ---------------------------------------------------------------- E: player reload
console.log('--- E: player reloads the page');
await mid.reload();
await waitFor(mid, () => (window.syncbuzzDebug().samples || 0) >= 3, null, 30000);
await waitFor(mid, () => {
  const r = window.syncbuzzDebug().results;
  return r && r.length === 1;
}, null, 8000).catch(() => {});
check((await text(host, '#playersTitle')).includes('4 online'), `E: still 4 online, no duplicate (${await text(host, '#playersTitle')})`);
const midResults = (await dbg(mid)).results;
check(midResults && midResults.length === 1, 'E: reloaded player sees current results again');

// ---------------------------------------------------------------- F: host reload
console.log('--- F: operator reloads the page');
await host.reload();
check(host.sawLeaveWarning === true, 'F: operator got a "Leave site?" warning while players were connected');
await waitFor(host, () => document.getElementById('topStatusText').textContent === 'Room open', null, 60000);
for (const p of players) await waitFor(p, () => (window.syncbuzzDebug().samples || 0) >= 3 && document.getElementById('topStatusText').textContent.startsWith('Connected'), null, 60000);
await sleep(2500);
check((await text(host, '#playersTitle')).includes('4 online'), `F: everyone reconnected (${await text(host, '#playersTitle')})`);
check(!(await host.$eval('#resultsCard', (e) => e.hidden)), 'F: results still shown after operator reload');
await playRound([['fast', 500], ['slow', 520], ['host', 545], ['mid', 575]], 'F-round');

// ---------------------------------------------------------------- G: abuse from a rogue peer
console.log('--- G: rogue connection sends junk');
const rogue = await openPage('rogue');
const rogueOut = await rogue.evaluate(
  (hostId) =>
    new Promise((resolve) => {
      const log = [];
      const peer = new Peer(`syncbuzz-rogue-${Math.random().toString(36).slice(2)}`);
      peer.on('open', () => {
        // 1) wrong serialization: must be refused (no reply, ever)
        const bad = peer.connect(hostId, { serialization: 'json' });
        bad.on('open', () => {
          log.push('json-conn-open');
          bad.send({ type: 'hello', v: 1, token: 'B'.repeat(24), name: 'JsonGuy' });
        });
        bad.on('data', () => log.push('json-conn-got-reply'));
        // 2) raw connection with junk
        const c = peer.connect(hostId, { serialization: 'raw' });
        c.on('open', () => {
          c.send('x'.repeat(5000));
          for (let i = 0; i < 5; i++) c.send('{not json');
          c.send(JSON.stringify({ type: 'hello', v: 1, token: 'A'.repeat(24), name: '<img src=x onerror=alert(1)>\u202Eevil\u0007' }));
          setTimeout(() => {
            for (let i = 0; i < 400; i++) c.send(JSON.stringify({ type: 'ping', n: i }));
            c.send(JSON.stringify({ type: 'press', round: 'x', t: 'y' }));
          }, 800);
        });
        c.on('data', (d) => log.push(String(d).slice(0, 60)));
        c.on('close', () => log.push('raw-conn-closed'));
        setTimeout(() => resolve(log), 6000);
      });
    }),
  `syncbuzz-${code}`,
);
console.log(`  rogue log: ${JSON.stringify(rogueOut.map((x) => x.slice(0, 30)))}`);
check(!rogueOut.includes('json-conn-got-reply'), 'G: connection with the wrong format got no reply');
check(!(await text(host, '#playersList')).includes('JsonGuy'), 'G: wrong-format connection never joined');
check(rogueOut.includes('raw-conn-closed'), 'G: flooding connection was dropped');
const listText = await text(host, '#playersList');
const imgs = await host.$$eval('#playersList img, #resultsList img', (x) => x.length);
check(imgs === 0, 'G: HTML in a name is not rendered as HTML');
check(listText.includes('<img src=x'), 'G: HTML in a name is shown as plain text');
check(!/[\u202E\u0007]/.test(listText), 'G: control and direction-override characters stripped from names');
await playRound([['mid', 500], ['host', 515], ['fast', 530], ['slow', 545]], 'G-after-abuse');

// ---------------------------------------------------------------- H: kick + lock
console.log('--- H: kick and lock');
await host.evaluate(() => {
  const li = [...document.querySelectorAll('#playersList li')].find((x) => x.textContent.includes('Fast'));
  li.querySelector('button').click();
});
await sleep(150);
await host.evaluate(() => {
  const li = [...document.querySelectorAll('#playersList li')].find((x) => x.textContent.includes('Fast'));
  li.querySelector('button').click();
});
await waitFor(fast, () => !document.getElementById('screenMsg').hidden, null, 10000);
check((await text(fast, '#msgTitle')) === 'You were removed', 'H: kicked player sees a message');
await host.click('.settings summary'); // open the Settings section
await host.click('#setLocked');
check(await host.$eval('#setLocked', (e) => e.checked), 'H: lock checkbox is on');
const late = await openPage('Latecomer', `#join=${code}`);
await late.$eval('#joinName', (e) => {
  e.value = '';
});
await late.type('#joinName', 'Latecomer');
await late.click('#formJoin button[type=submit]');
await waitFor(late, () => !document.getElementById('screenMsg').hidden, null, 30000);
check((await text(late, '#msgTitle')) === 'The room is locked', 'H: new player is refused while the room is locked');

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
await browser.close();
process.exit(failures ? 1 : 0);
