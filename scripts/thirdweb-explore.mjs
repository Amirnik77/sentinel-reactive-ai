// Explore thirdweb's chain page faucet: dump faucet-related DOM + API calls.
import puppeteer from '/home/hatch/workspace/tools/shottools/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import { execSync } from 'node:child_process';

const url = process.argv[2] || 'https://thirdweb.com/base-sepolia';
const exe = execSync("find ~/.cache/puppeteer/chrome -maxdepth 3 -type f -name chrome | head -1").toString().trim();
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader',
    '--proxy-server=http://127.0.0.1:18080',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1100 });
page.on('request', (r) => {
  const u = r.url();
  if (/faucet|drip|claim/i.test(u)) console.log('[req]', r.method(), u.slice(0, 160));
});
page.on('response', (r) => {
  const u = r.url();
  if (/faucet|drip|claim/i.test(u)) console.log('[res]', r.status(), u.slice(0, 160));
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 12000));
const info = await page.evaluate(() => {
  const matches = [];
  document.querySelectorAll('input, button').forEach((el) => {
    const t = (el.innerText || el.placeholder || el.value || '').trim();
    if (/faucet|claim|address|request|fund/i.test(t) || el.tagName === 'INPUT') {
      matches.push({ tag: el.tagName, text: t.slice(0, 80), id: el.id || '', visible: !!(el.offsetWidth || el.offsetHeight) });
    }
  });
  const bodyHit = document.body.innerText.match(/.{0,60}faucet.{0,120}/is);
  return { title: document.title, matches: matches.slice(0, 20), faucetText: bodyHit ? bodyHit[0] : null };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: '/home/hatch/workspace/.tmp/thirdweb.png' });
await browser.close();
