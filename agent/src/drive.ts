// Drives a price scenario into the PriceFeed and collects end-to-end loop
// evidence: for every price update, the origin tx (Base Sepolia), the
// reactive tx (Lasna), the callback tx (Base Sepolia) and the agent's
// decision tx (Base Sepolia), with per-leg latencies.
//
// Usage:
//   npx tsx src/drive.ts <calm|trend|panic|full> [--wait]
//     --wait   wait for each step's decision before pushing the next price
//              (default: push the whole phase, then wait for settlement)
//
// Writes demo/evidence-<scenario>.json and prints a summary table.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  type Hex,
} from 'viem';
import { loadAccount, CHAINS } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const FEED_ABI = parseAbi([
  'function setPrice(uint256 newPrice_) external',
  'event PriceUpdated(uint256 price, uint256 updatedAt)',
]);
const VAULT_ABI = parseAbi([
  'event DecisionRequested(uint256 indexed id, uint256 price, uint256 originTx, uint256[8] window)',
  'event ActionExecuted(uint256 indexed id, uint8 action, uint16 confidenceBps, uint256 hedgeRatioBps, uint8 state)',
  'function decisionsExecuted() external view returns (uint256)',
  'function state() external view returns (uint8)',
  'function hedgeRatioBps() external view returns (uint256)',
]);
const REACTIVE_ABI = parseAbi([
  'event Reaction(uint256 indexed originTx, uint256 price, uint256 seq)',
]);

const P = (usd: number) => BigInt(Math.round(usd * 1e8));
const SCENARIOS: Record<string, number[]> = {
  // Calm chop around $2,000 — expect HOLD decisions.
  calm: [2004, 1997, 2003, 1999, 2006, 2001, 2005, 2002],
  // Steady ~-1.2%/step decline — expect HEDGE once the window fills.
  trend: [1976, 1952, 1929, 1906, 1883, 1861, 1839, 1817],
  // Crash: -3%, -7%, -2%, -9%, -3%, -8%, -4% — expect EXIT.
  panic: [1762, 1639, 1606, 1462, 1418, 1305, 1253, 1215],
};
SCENARIOS.full = [...SCENARIOS.calm, ...SCENARIOS.trend, ...SCENARIOS.panic];

interface Step {
  seq: number;
  price: number;
  originTx?: Hex;
  originTime?: string;
  reactiveTx?: Hex;
  callbackTx?: Hex;
  requestId?: string;
  decisionTx?: Hex;
  action?: string;
  confidenceBps?: number;
  loopLatencyMs?: number;
}

async function main() {
  const scenarioName = process.argv[2] ?? 'full';
  const waitPerStep = process.argv.includes('--wait');
  const prices = SCENARIOS[scenarioName];
  if (!prices) throw new Error(`unknown scenario ${scenarioName}`);

  const deployments = JSON.parse(readFileSync(join(repoRoot, 'deployments.json'), 'utf8'));
  const account = loadAccount();
  const base = CHAINS.baseSepolia;
  const lasnaCfg = CHAINS.lasna;
  const basePub = createPublicClient({ chain: base.chain, transport: http(base.rpc) });
  const baseWal = createWalletClient({ account, chain: base.chain, transport: http(base.rpc) });
  const lasnaPub = createPublicClient({ chain: lasnaCfg.chain, transport: http(lasnaCfg.rpc) });
  const feed = deployments.priceFeed as Hex;
  const vault = deployments.decisionVault as Hex;
  const reactive = deployments.sentinelReactive as Hex;

  const baseStartBlock = await basePub.getBlockNumber();
  const lasnaStartBlock = await lasnaPub.getBlockNumber();
  const decidedBefore = await basePub.readContract({
    address: vault, abi: VAULT_ABI, functionName: 'decisionsExecuted',
  });

  const steps: Step[] = [];
  console.log(`driving scenario "${scenarioName}" (${prices.length} price updates)`);
  for (let i = 0; i < prices.length; i++) {
    const tx = await sendSetPrice(baseWal, basePub, feed, prices[i]);
    steps.push({ seq: i + 1, price: prices[i], originTx: tx, originTime: new Date().toISOString() });
    console.log(`  step ${i + 1}: price $${prices[i]}  origin tx ${tx}`);
    if (waitPerStep) {
      await waitForDecisions(basePub, vault, decidedBefore + BigInt(i + 1), 240_000);
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.log('waiting for all decisions to settle...');
  await waitForDecisions(basePub, vault, decidedBefore + BigInt(prices.length), 600_000);

  // --- collect evidence from logs -------------------------------------------
  const feedLogs = await getLogsChunked(basePub, feed, FEED_ABI[1], baseStartBlock);
  const originTimeByTx = new Map<string, number>();
  for (const l of feedLogs) {
    const block = await basePub.getBlock({ blockNumber: l.blockNumber });
    originTimeByTx.set(l.transactionHash, Number(block.timestamp) * 1000);
  }
  const reactionLogs = await getLogsChunked(lasnaPub, reactive, REACTIVE_ABI[0], lasnaStartBlock);
  const reactiveTxByOrigin = new Map<string, Hex>();
  for (const l of reactionLogs) {
    const originTx = '0x' + (l.args as { originTx: bigint }).originTx.toString(16).padStart(64, '0');
    reactiveTxByOrigin.set(originTx.toLowerCase(), l.transactionHash);
  }
  const requestLogs = await getLogsChunked(basePub, vault, VAULT_ABI[0], baseStartBlock);
  const actionLogs = await getLogsChunked(basePub, vault, VAULT_ABI[1], baseStartBlock);
  const actionById = new Map<string, (typeof actionLogs)[number]>();
  for (const l of actionLogs) actionById.set((l.args as { id: bigint }).id.toString(), l);

  const ACTION_NAMES = ['HOLD', 'HEDGE', 'EXIT'];
  for (const step of steps) {
    step.reactiveTx = reactiveTxByOrigin.get(step.originTx!.toLowerCase());
    const req = requestLogs.find(
      (l) => ('0x' + (l.args as { originTx: bigint }).originTx.toString(16).padStart(64, '0')).toLowerCase() === step.originTx!.toLowerCase()
    );
    if (req) {
      step.callbackTx = req.transactionHash;
      step.requestId = (req.args as { id: bigint }).id.toString();
      const act = actionById.get(step.requestId);
      if (act) {
        const a = act.args as { action: number; confidenceBps: number };
        step.decisionTx = act.transactionHash;
        step.action = ACTION_NAMES[a.action];
        step.confidenceBps = a.confidenceBps;
        const block = await basePub.getBlock({ blockNumber: act.blockNumber });
        const t0 = originTimeByTx.get(step.originTx!);
        if (t0) step.loopLatencyMs = Number(block.timestamp) * 1000 - t0;
      }
    }
  }

  const finalState = await basePub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'state' });
  const finalHedge = await basePub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'hedgeRatioBps' });

  const evidence = {
    scenario: scenarioName,
    generatedAt: new Date().toISOString(),
    deployments: { priceFeed: feed, sentinelReactive: reactive, decisionVault: vault },
    finalVaultState: ['Exposed', 'Hedged', 'Exited'][finalState],
    finalHedgeRatioBps: Number(finalHedge),
    steps,
  };
  const outPath = join(repoRoot, 'demo', `evidence-${scenarioName}.json`);
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log(`\nfinal vault state: ${evidence.finalVaultState}, hedge ${evidence.finalHedgeRatioBps / 100}%`);
  console.log('step | price | action | conf | loop ms');
  for (const s of steps) {
    console.log(`${String(s.seq).padStart(4)} | $${s.price} | ${s.action ?? '?'} | ${s.confidenceBps !== undefined ? (s.confidenceBps / 100).toFixed(1) + '%' : '?'} | ${s.loopLatencyMs ?? '?'}`);
  }
  console.log(`evidence written to ${outPath}`);
}

// The driver and the AI agent share one wallet, so a setPrice send can lose
// the nonce race when the agent posts a decision at the same moment. Retry
// send-time nonce failures with a fresh nonce; receipt waits are not
// retried (the tx may already be mined).
async function sendSetPrice(
  wal: { writeContract(args: unknown): Promise<Hex> },
  pub: { waitForTransactionReceipt(args: { hash: Hex }): Promise<unknown> },
  feed: Hex,
  price: number
): Promise<Hex> {
  for (let attempt = 0; ; attempt++) {
    let tx: Hex;
    try {
      tx = await wal.writeContract({
        address: feed, abi: FEED_ABI, functionName: 'setPrice', args: [P(price)],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 8 || !/nonce|already known|replacement underpriced/i.test(msg)) throw err;
      console.log(`  setPrice send hit a nonce clash (attempt ${attempt + 1}), retrying...`);
      await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    await pub.waitForTransactionReceipt({ hash: tx });
    return tx;
  }
}

// Public RPCs cap eth_getLogs ranges (Base Sepolia: 200 blocks), and a full
// demo spans far more than that — page through in 200-block windows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLogsChunked(pub: any, address: Hex, event: unknown, fromBlock: bigint) {
  const head = (await pub.getBlockNumber()) as bigint;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  for (let start = fromBlock; start <= head; start += 200n) {
    const end = start + 199n > head ? head : start + 199n;
    const logs = await pub.getLogs({ address, event, fromBlock: start, toBlock: end });
    all.push(...logs);
  }
  return all;
}

interface DecisionsReader {
  readContract(args: {
    address: Hex;
    abi: typeof VAULT_ABI;
    functionName: 'decisionsExecuted';
  }): Promise<bigint>;
}

async function waitForDecisions(
  pub: DecisionsReader,
  vault: Hex,
  target: bigint,
  timeoutMs: number
) {
  const start = Date.now();
  for (;;) {
    const n = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'decisionsExecuted' });
    if (n >= target) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for decisions: ${n}/${target} executed`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch((err) => {
  console.error('drive failed:', err);
  process.exit(1);
});
