// Claims testnet ETH from the Chainlink faucet (faucets.chain.link) using an
// injected EIP-1193 provider backed by the local testnet wallet. The faucet
// only requires a wallet connection (no account, no captcha as of writing).
// Usage: node chainlink-faucet.mjs <base-sepolia|sepolia> [explore]
import puppeteer from '/home/hatch/workspace/tools/shottools/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/home/hatch/workspace/reactive-buildathon/agent/');
const { createPublicClient, createWalletClient, http, formatEther } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia, sepolia } = require('viem/chains');

const walletJson = JSON.parse(readFileSync('/home/hatch/workspace/wallets/bsc-wallet.json', 'utf8'));
const account = privateKeyToAccount(walletJson.private_key);
const ADDRESS = account.address;

const NETWORKS = {
  'base-sepolia': { chain: baseSepolia, rpc: 'https://sepolia.base.org', slug: 'base-sepolia' },
  sepolia: { chain: sepolia, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', slug: 'sepolia' },
};
const target = NETWORKS[process.argv[2] || 'base-sepolia'];
const exploreOnly = process.argv[3] === 'explore';
let currentChain = target.chain;

const publicClient = () =>
  createPublicClient({ chain: currentChain, transport: http(currentChain.id === 84532 ? NETWORKS['base-sepolia'].rpc : NETWORKS.sepolia.rpc) });

async function rpcBridge({ method, params = [] }) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [ADDRESS];
    case 'eth_chainId':
      return '0x' + currentChain.id.toString(16);
    case 'net_version':
      return String(currentChain.id);
    case 'wallet_switchEthereumChain': {
      const id = parseInt(params[0].chainId, 16);
      currentChain = id === 84532 ? baseSepolia : sepolia;
      return null;
    }
    case 'wallet_addEthereumChain':
      return null;
    case 'personal_sign': {
      const [msg, addr] = params;
      const message = msg.startsWith('0x')
        ? { raw: msg }
        : msg;
      return await account.signMessage({ message });
    }
    case 'eth_sign': {
      const [, data] = params;
      return await account.signMessage({ message: { raw: data } });
    }
    case 'eth_signTypedData_v4': {
      const td = JSON.parse(params[1]);
      return await account.signTypedData(td);
    }
    case 'eth_sendTransaction': {
      const [tx] = params;
      const wc = createWalletClient({ account, chain: currentChain, transport: http(currentChain.id === 84532 ? NETWORKS['base-sepolia'].rpc : NETWORKS.sepolia.rpc) });
      return await wc.sendTransaction({
        to: tx.to,
        value: tx.value ? BigInt(tx.value) : 0n,
        data: tx.data || '0x',
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      });
    }
    default: {
      // Forward reads to the public RPC.
      return await publicClient().request({ method, params });
    }
  }
}

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
await page.exposeFunction('__rpcBridge', async (payload) => {
  try {
    const result = await rpcBridge(payload);
    return { result: result ?? null };
  } catch (e) {
    return { error: { message: String(e && e.message || e), code: 4001 } };
  }
});
await page.evaluateOnNewDocument(() => {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    _metamask: { isUnlocked: async () => true },
    request: async ({ method, params }) => {
      const res = await window.__rpcBridge({ method, params });
      if (res && res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
      return res ? res.result : null;
    },
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    emit: (ev, ...args) => { (listeners[ev] || []).forEach((f) => f(...args)); },
  };
  Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });
  const announce = () => {
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({
        info: { uuid: '7d7a7d7a-7d7a-4d7a-8d7a-7d7a7d7a7d7a', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.metamask' },
        provider,
      }),
    }));
  };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
});

const url = `https://faucets.chain.link/${target.slug}`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, 10000));

async function dumpState(tag) {
  const s = await page.evaluate(() => {
    const btns = [];
    document.querySelectorAll('button, a').forEach((el) => {
      const t = (el.innerText || '').trim();
      if (t) btns.push(t.slice(0, 60));
    });
    return { title: document.title, buttons: btns.slice(0, 30), text: document.body.innerText.slice(0, 1200) };
  });
  console.log(`--- state [${tag}] ---`);
  console.log(JSON.stringify(s, null, 1));
  await page.screenshot({ path: `/home/hatch/workspace/.tmp/cl-${tag}.png` });
  return s;
}

await dumpState('initial');

async function clickByText(re) {
  const handle = await page.evaluateHandle((src) => {
    const rx = new RegExp(src, 'i');
    return [...document.querySelectorAll('button, a')].find((el) => rx.test(el.innerText || '')) || null;
  }, re.source);
  const el = handle.asElement();
  if (el) { await el.click(); return true; }
  return false;
}

if (await clickByText(/connect wallet/i)) {
  await new Promise((r) => setTimeout(r, 4000));
  await dumpState('connect-menu');
  if (await clickByText(/metamask/i)) {
    await new Promise((r) => setTimeout(r, 8000));
  }
}
const after = await dumpState('connected');
if (exploreOnly) { await browser.close(); process.exit(0); }

// Select the ETH drip card if not selected, then Continue.
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('div, label, button')];
  const eth = cards.find((el) => /Drips 0\.5 ETH/.test(el.innerText || '') && /Base Sepolia/.test(el.innerText || ''));
  if (eth) eth.click();
});
await new Promise((r) => setTimeout(r, 2000));
if (await clickByText(/^continue$/i)) {
  console.log('clicked Continue');
  await new Promise((r) => setTimeout(r, 8000));
}
await dumpState('after-continue');

// Look for a request/claim button for ETH.
for (const re of [/request tokens/i, /send request/i, /request/i, /claim/i, /confirm/i]) {
  if (await clickByText(re)) {
    console.log('clicked', re);
    await new Promise((r) => setTimeout(r, 20000));
    break;
  }
}
await dumpState('after-request');
await browser.close();
