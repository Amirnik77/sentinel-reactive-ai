// Funding helpers (testnet only):
//   npx tsx src/fund.ts convert <ethAmount> [base|sepolia]
//       Send ETH to Reactive's faucet contract; receive 100x lREACT on Lasna.
//   npx tsx src/fund.ts bridge <ethAmount>
//       Bridge Sepolia ETH to Base Sepolia via the OptimismPortal deposit.
//   npx tsx src/fund.ts balances
//       Print the wallet balance on all three networks.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  parseAbi,
} from 'viem';
import { loadAccount, CHAINS, REACTIVE_FAUCET, OPTIMISM_PORTAL } from './config.js';

const account = loadAccount();

function clients(kind: 'baseSepolia' | 'sepolia' | 'lasna') {
  const cfg = CHAINS[kind];
  return {
    pub: createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) }),
    wal: createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpc) }),
  };
}

export async function printBalances() {
  for (const kind of ['sepolia', 'baseSepolia', 'lasna'] as const) {
    const { pub } = clients(kind);
    const bal = await pub.getBalance({ address: account.address });
    const sym = kind === 'lasna' ? 'lREACT' : 'ETH';
    console.log(`${kind.padEnd(12)} ${formatEther(bal)} ${sym}`);
  }
}

async function convert(amountEth: string, from: 'base' | 'sepolia') {
  const kind = from === 'base' ? 'baseSepolia' : 'sepolia';
  const { pub, wal } = clients(kind);
  const lasna = clients('lasna');
  const before = await lasna.pub.getBalance({ address: account.address });
  const faucet = from === 'base' ? REACTIVE_FAUCET.onBaseSepolia : REACTIVE_FAUCET.onSepolia;
  const value = parseEther(amountEth);
  const tx = await wal.writeContract({
    address: faucet,
    abi: parseAbi(['function request(address to_) external payable']),
    functionName: 'request',
    args: [account.address],
    value,
  });
  console.log(`faucet request tx (${kind}): ${tx}`);
  await pub.waitForTransactionReceipt({ hash: tx });
  // lREACT arrives via a reactive transaction on Lasna; poll briefly.
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const now = await lasna.pub.getBalance({ address: account.address });
    if (now > before) {
      console.log(`received ${formatEther(now - before)} lREACT on Lasna (balance ${formatEther(now)})`);
      return;
    }
  }
  console.log('lREACT not yet visible after 2 minutes — check Lasna explorer for the wallet address.');
}

async function bridge(amountEth: string) {
  const { pub, wal } = clients('sepolia');
  const value = parseEther(amountEth);
  // Deposit via the OptimismPortal directly (canonical OP Stack deposit;
  // mints the same amount of ETH to the same address on Base Sepolia).
  const tx = await wal.writeContract({
    address: OPTIMISM_PORTAL,
    abi: parseAbi([
      'function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) external payable',
    ]),
    functionName: 'depositTransaction',
    args: [account.address, value, 200000n, false, '0x'],
    value,
  });
  console.log(`portal deposit tx (Sepolia): ${tx}`);
  await pub.waitForTransactionReceipt({ hash: tx });
  console.log('deposit confirmed; Base Sepolia credit usually lands within a few minutes.');
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, amount, from] = process.argv.slice(2);
  if (cmd === 'balances') await printBalances();
  else if (cmd === 'convert' && amount) await convert(amount, from === 'sepolia' ? 'sepolia' : 'base');
  else if (cmd === 'bridge' && amount) await bridge(amount);
  else {
    console.log('usage: fund.ts balances | convert <eth> [base|sepolia] | bridge <eth>');
    process.exit(2);
  }
}
