// Sentinel AI agent service.
//
// Loop role: the Reactive contract on Lasna turns every PriceFeed event on
// Base Sepolia into a callback that makes the DecisionVault emit
// DecisionRequested(id, price, originTx, window). This service watches for
// those requests, classifies the price window with the neural network in
// model/weights.json, and posts the decision back on-chain with
// submitDecision(). The vault then executes the protective action.
//
// The model is part of the running system: no decision executes without it,
// and every decision is recorded on-chain with the model's confidence.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
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
import { predict, type Weights } from './model.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

interface Deployments {
  priceFeed: string;
  sentinelReactive: string;
  decisionVault: string;
  agent: string;
  deployTxs?: { decisionVault?: string };
}

function loadDeployments(): Deployments {
  const path = join(repoRoot, 'deployments.json');
  if (!existsSync(path)) {
    throw new Error('deployments.json not found — run src/deploy.ts first');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

const VAULT_ABI = parseAbi([
  'event DecisionRequested(uint256 indexed id, uint256 price, uint256 originTx, uint256[8] window)',
  'event ActionExecuted(uint256 indexed id, uint8 action, uint16 confidenceBps, uint256 hedgeRatioBps, uint8 state)',
  'function submitDecision(uint256 id_, uint8 action_, uint16 confidenceBps_) external',
  'function decisions(uint256) external view returns (uint256 price, uint256 originTx, uint8 action, uint16 confidenceBps, bool requested, bool decided)',
  'function nextId() external view returns (uint256)',
]);

const POLL_MS = Number(process.env.AGENT_POLL_MS ?? 4000);
const AUDIT_LOG = join(repoRoot, 'agent', 'decisions.log');

async function main() {
  const deployments = loadDeployments();
  const weights = JSON.parse(
    readFileSync(join(here, '..', 'model', 'weights.json'), 'utf8')
  ) as Weights;
  const account = loadAccount();
  const { chain, rpc } = CHAINS.baseSepolia;
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
  const vault = deployments.decisionVault as `0x${string}`;

  console.log(`[agent] account ${account.address}`);
  console.log(`[agent] watching DecisionVault ${vault} on Base Sepolia`);
  console.log(`[agent] model test accuracy ${(weights.testAccuracy * 100).toFixed(1)}%`);

  const handled = new Set<string>();

  // Start scanning from the vault's deployment block so requests left
  // undecided by a previous run are caught up. Every request found is
  // re-checked on-chain and skipped if it was already decided.
  let fromBlock = await publicClient.getBlockNumber();
  if (deployments.deployTxs?.decisionVault) {
    const receipt = await publicClient.getTransactionReceipt({
      hash: deployments.deployTxs.decisionVault as Hex,
    });
    fromBlock = receipt.blockNumber;
    console.log(`[agent] catch-up scan from vault deployment block ${fromBlock}`);
  }

  for (;;) {
    try {
      const head = await publicClient.getBlockNumber();
      if (head >= fromBlock) {
        // The public Base Sepolia RPC caps eth_getLogs at a 200-block
        // range; scan in chunks (matters for the startup catch-up).
        const toBlock = head - fromBlock > 199n ? fromBlock + 199n : head;
        const logs = await publicClient.getLogs({
          address: vault,
          event: VAULT_ABI[0],
          fromBlock,
          toBlock,
        });
        let resumeBlock = toBlock + 1n;
        for (const log of logs) {
          const { id, price, originTx, window } = log.args as {
            id: bigint; price: bigint; originTx: bigint; window: readonly bigint[];
          };
          const key = id.toString();
          if (handled.has(key)) continue;

          // A failed submission (e.g. a nonce clash with the price driver,
          // which shares this wallet) must not lose the request: it stays
          // unhandled and the scan resumes at its block on the next poll.
          try {
          const d = await publicClient.readContract({
            address: vault, abi: VAULT_ABI, functionName: 'decisions', args: [id],
          });
          if (d[5]) {
            console.log(`[agent] request ${id} already decided, skipping`);
            handled.add(key);
            continue;
          }

          const windowNumbers = window.map((p) => Number(p) / 1e8);
          const pred = predict(weights, windowNumbers);
          const confidenceBps = Math.round(pred.confidence * 10000);
          console.log(
            `[agent] request ${id}: price $${formatUnits(price, 8)} ` +
            `window [${windowNumbers.map((v) => v.toFixed(1)).join(', ')}] ` +
            `-> ${pred.action} @ ${(pred.confidence * 100).toFixed(1)}% ` +
            `(probs ${pred.probabilities.map((v) => v.toFixed(3)).join('/')})`
          );

          const tx = await walletClient.writeContract({
            address: vault,
            abi: VAULT_ABI,
            functionName: 'submitDecision',
            args: [id, pred.actionIndex, confidenceBps],
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
          console.log(`[agent] request ${id}: decision posted in tx ${tx} (status ${receipt.status})`);
          appendFileSync(
            AUDIT_LOG,
            JSON.stringify({
              t: new Date().toISOString(),
              requestId: key,
              originTx: '0x' + originTx.toString(16).padStart(64, '0'),
              callbackTx: log.transactionHash,
              price: Number(price) / 1e8,
              window: windowNumbers,
              action: pred.action,
              confidence: pred.confidence,
              probabilities: pred.probabilities,
              decisionTx: tx,
            }) + '\n'
          );
          handled.add(key);
          } catch (err) {
            console.error(
              `[agent] request ${key} submission failed, will retry:`,
              err instanceof Error ? err.message.split('\n')[0] : err
            );
            if (log.blockNumber < resumeBlock) resumeBlock = log.blockNumber;
          }
        }
        fromBlock = resumeBlock;
      }
    } catch (err) {
      console.error('[agent] poll error:', err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
