// Exploratory: load the pk910 Sepolia PoW faucet and dump its interactive state.
import puppeteer from '/home/hatch/workspace/tools/shottools/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

import { execSync } from 'node:child_process';
const exe = execSync("find ~/.cache/puppeteer/chrome -maxdepth 3 -type f -name chrome | head -1").toString().trim();
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: ['--no-sandbox', '--ignore-certificate-errors', '--proxy-server=http://127.0.0.1:18080'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto('https://sepolia-faucet.pk910.de/', { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 8000));

const info = await page.evaluate(() => {
  const els = [];
  document.querySelectorAll('input, button, select, textarea, a.btn').forEach((el) => {
    els.push({
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      id: el.id || '',
      cls: (el.className || '').toString().slice(0, 60),
      text: (el.innerText || el.value || el.placeholder || '').slice(0, 80),
      visible: !!(el.offsetWidth || el.offsetHeight),
      disabled: !!el.disabled,
    });
  });
  return { title: document.title, els, bodyText: document.body.innerText.slice(0, 2500) };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: '/home/hatch/workspace/.tmp/faucet1.png', fullPage: false });
await browser.close();
