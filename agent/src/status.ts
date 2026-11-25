// Prints wallet balances and the live state of the deployed Sentinel stack,
// including each contract's Reactive debt (a contract in debt stops working).
// Usage: npx tsx src/status.ts
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, formatEther, type Hex } from 'viem';
import { loadAccount, CHAINS, REACTIVE_SYSTEM, BASE_SEPOLIA_CALLBACK_PROXY } from './config.js';
import { printBalances } from './fund.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const account = loadAccount();
await printBalances();

const depPath = join(repoRoot, 'deployments.json');
if (!existsSync(depPath)) {
  console.log('\n(no deployments.json yet — nothing deployed)');
  process.exit(0);
}
const d = JSON.parse(readFileSync(depPath, 'utf8'));
const base = CHAINS.baseSepolia;
const lasnaCfg = CHAINS.lasna;
const basePub = createPublicClient({ chain: base.chain, transport: http(base.rpc) });
const lasnaPub = createPublicClient({ chain: lasnaCfg.chain, transport: http(lasnaCfg.rpc) });

const IPAYABLE = parseAbi(['function debt(address contract_) external view returns (uint256)']);
const VAULT = parseAbi([
  'function state() external view returns (uint8)',
  'function hedgeRatioBps() external view returns (uint256)',
  'function decisionsExecuted() external view returns (uint256)',
  'function nextId() external view returns (uint256)',
]);
const REACTIVE = parseAbi([
  'function reactions() external view returns (uint256)',
  'function lastPrice() external view returns (uint256)',
  'function vault() external view returns (address)',
]);

const vaultState = await basePub.readContract({ address: d.decisionVault, abi: VAULT, functionName: 'state' });
const hedge = await basePub.readContract({ address: d.decisionVault, abi: VAULT, functionName: 'hedgeRatioBps' });
const executed = await basePub.readContract({ address: d.decisionVault, abi: VAULT, functionName: 'decisionsExecuted' });
const nextId = await basePub.readContract({ address: d.decisionVault, abi: VAULT, functionName: 'nextId' });
const vaultBal = await basePub.getBalance({ address: d.decisionVault });
const vaultDebt = await basePub.readContract({
  address: BASE_SEPOLIA_CALLBACK_PROXY as Hex, abi: IPAYABLE, functionName: 'debt', args: [d.decisionVault],
});
const reactions = await lasnaPub.readContract({ address: d.sentinelReactive, abi: REACTIVE, functionName: 'reactions' });
const reactiveBal = await lasnaPub.getBalance({ address: d.sentinelReactive });
const reactiveDebt = await lasnaPub.readContract({
  address: REACTIVE_SYSTEM as Hex, abi: IPAYABLE, functionName: 'debt', args: [d.sentinelReactive],
});

console.log('\nDecisionVault (Base Sepolia)');
console.log(`  state: ${['Exposed', 'Hedged', 'Exited'][vaultState]}  hedge: ${Number(hedge) / 100}%`);
console.log(`  decisions executed: ${executed}  (next request id ${nextId})`);
console.log(`  balance: ${formatEther(vaultBal)} ETH   callback debt: ${formatEther(vaultDebt)} ETH`);
console.log('SentinelReactive (Lasna)');
console.log(`  reactions: ${reactions}`);
console.log(`  balance: ${formatEther(reactiveBal)} lREACT   debt: ${formatEther(reactiveDebt)} lREACT`);
