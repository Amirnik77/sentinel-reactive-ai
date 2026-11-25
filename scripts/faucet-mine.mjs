// Drives the pk910 Sepolia PoW faucet in a real browser.
// - Waits for the Turnstile widget to verify AUTOMATICALLY (no clicking challenges).
// - If verification does not complete on its own, exits with status "captcha-blocked".
// - Mines until the session balance reaches TARGET_WEI, then claims.
import puppeteer from '/home/hatch/workspace/tools/shottools/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADDR = '0x061978d21ce915956c3B3319B507c45145125d59';
const TARGET_ETH = Number(process.argv[2] || 0.45);
const MAX_MINUTES = Number(process.argv[3] || 240);
const STATUS = '/home/hatch/workspace/.tmp/faucet-status.json';

function status(obj) {
  const s = { t: new Date().toISOString(), ...obj };
  writeFileSync(STATUS, JSON.stringify(s, null, 1));
  console.log(JSON.stringify(s));
}

const exe = execSync("find ~/.cache/puppeteer/chrome -maxdepth 3 -type f -name chrome | head -1").toString().trim();
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--ignore-certificate-errors',
    '--enable-unsafe-swiftshader',
    '--proxy-server=http://127.0.0.1:18080',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
await page.goto('https://sepolia-faucet.pk910.de/', { waitUntil: 'networkidle2', timeout: 90000 });
await page.type('input.form-control', ADDR);
status({ phase: 'waiting-turnstile' });

// Wait for automatic Turnstile verification: the hidden response input gets a token.
let verified = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  verified = await page.evaluate(() => {
    const inp = document.querySelector('input[name*="cf-chl-widget"][type="hidden"], input[id*="cf-chl-widget"]');
    return !!(inp && inp.value && inp.value.length > 20);
  });
  if (verified) break;
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 300));
  if (/success/i.test(txt) && /verif/i.test(txt)) { verified = true; break; }
}
if (!verified) {
  await page.screenshot({ path: '/home/hatch/workspace/.tmp/faucet-blocked.png' });
  status({ phase: 'captcha-blocked', note: 'Turnstile did not verify automatically within 200s' });
  await browser.close();
  process.exit(2);
}
status({ phase: 'verified' });

await page.click('button.start-action');
status({ phase: 'mining-started' });

const deadline = Date.now() + MAX_MINUTES * 60 * 1000;
let balance = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 30000));
  const snap = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/Session Balance[^0-9]*([0-9.]+)/i) || t.match(/Balance[^0-9]*([0-9.]+)\s*SepETH/i);
    const h = t.match(/([0-9.]+)\s*H\/s/i);
    return { balance: m ? Number(m[1]) : null, hashrate: h ? Number(h[1]) : null, text: t.slice(0, 400) };
  });
  if (snap.balance !== null) balance = snap.balance;
  status({ phase: 'mining', balance, hashrate: snap.hashrate, target: TARGET_ETH });
  if (balance >= TARGET_ETH) break;
}

await page.screenshot({ path: '/home/hatch/workspace/.tmp/faucet-mined.png' });
// Stop mining and claim.
const buttons = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('button').forEach((b) => out.push(b.innerText.trim()));
  return out;
});
status({ phase: 'claiming', balance, buttons });
for (const label of ['Stop Mining', 'Claim Rewards', 'Claim']) {
  const el = await page.evaluateHandle((lbl) => {
    return [...document.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith(lbl)) || null;
  }, label);
  const asEl = el.asElement();
  if (asEl) { await asEl.click(); break; }
}
await new Promise((r) => setTimeout(r, 20000));
const finalText = await page.evaluate(() => document.body.innerText.slice(0, 800));
await page.screenshot({ path: '/home/hatch/workspace/.tmp/faucet-claimed.png' });
status({ phase: 'done', balance, finalText });
await browser.close();
