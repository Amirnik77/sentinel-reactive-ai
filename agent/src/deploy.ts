// Deploys the full Sentinel stack and wires it together:
//   1. PriceFeed          (Base Sepolia)  — origin event source
//   2. SentinelReactive   (Lasna)         — subscribes to the feed, funded with lREACT
//   3. DecisionVault      (Base Sepolia)  — callback recipient, funded with ETH
//   4. setVault()         (Lasna)         — completes the loop wiring
// Writes deployments.json at the repo root.
// Usage: npx tsx src/deploy.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  parseAbi,
  parseGwei,
  type Hex,
} from 'viem';
import { loadAccount, CHAINS } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

// Lasna's fee market: base fee ~100 gwei and viem's EIP-1559 estimation
// returns 0-fee fields against the Lasna RPC, which the node rejects
// ("Missing or invalid parameters"). Send Lasna txs as legacy txs with an
// explicit gas price instead.
const LASNA_GAS_PRICE = parseGwei('150');

const REACTIVE_FUNDING = parseEther(process.env.REACTIVE_FUNDING_ETH ?? '5'); // lREACT
const VAULT_FUNDING = parseEther(process.env.VAULT_FUNDING_ETH ?? '0.02'); // Base Sepolia ETH
const INITIAL_PRICE = 2000n * 10n ** 8n; // $2,000.00000000

function artifact(name: string) {
  const path = join(repoRoot, 'out', `${name}.sol`, `${name}.json`);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

async function main() {
  const account = loadAccount();
  const base = CHAINS.baseSepolia;
  const lasnaCfg = CHAINS.lasna;
  const basePub = createPublicClient({ chain: base.chain, transport: http(base.rpc) });
  const baseWal = createWalletClient({ account, chain: base.chain, transport: http(base.rpc) });
  const lasnaPub = createPublicClient({ chain: lasnaCfg.chain, transport: http(lasnaCfg.rpc) });
  const lasnaWal = createWalletClient({ account, chain: lasnaCfg.chain, transport: http(lasnaCfg.rpc) });

  const baseBal = await basePub.getBalance({ address: account.address });
  const lasnaBal = await lasnaPub.getBalance({ address: account.address });
  console.log(`deployer ${account.address}`);
  console.log(`  Base Sepolia: ${formatEther(baseBal)} ETH`);
  console.log(`  Lasna:        ${formatEther(lasnaBal)} lREACT`);
  // Headroom above the vault funding covers both deployments and all demo
  // gas; Base Sepolia gas is ~0.006 gwei, so 0.002 ETH is ample margin.
  if (baseBal < VAULT_FUNDING + parseEther('0.002')) {
    console.error('INSUFFICIENT Base Sepolia ETH — fund the wallet first (see README "Funding").');
    process.exit(3);
  }
  if (lasnaBal < REACTIVE_FUNDING) {
    console.error('INSUFFICIENT Lasna lREACT — convert Sepolia ETH via src/fund.ts first.');
    process.exit(3);
  }

  // 1. PriceFeed on Base Sepolia
  const feed = artifact('PriceFeed');
  const feedTx = await baseWal.deployContract({ abi: feed.abi, bytecode: feed.bytecode, args: [INITIAL_PRICE] });
  const feedReceipt = await basePub.waitForTransactionReceipt({ hash: feedTx });
  const feedAddr = feedReceipt.contractAddress!;
  console.log(`PriceFeed        ${feedAddr}  tx ${feedTx}`);

  // 2. SentinelReactive on Lasna (constructor subscribes to the feed)
  const reactive = artifact('SentinelReactive');
  const reactiveTx = await lasnaWal.deployContract({
    abi: reactive.abi, bytecode: reactive.bytecode, args: [feedAddr], value: REACTIVE_FUNDING,
    gasPrice: LASNA_GAS_PRICE,
  });
  const reactiveReceipt = await lasnaPub.waitForTransactionReceipt({ hash: reactiveTx });
  const reactiveAddr = reactiveReceipt.contractAddress!;
  console.log(`SentinelReactive ${reactiveAddr}  tx ${reactiveTx}  (funded ${formatEther(REACTIVE_FUNDING)} lREACT)`);

  // 3. DecisionVault on Base Sepolia (needs the reactive address immutably)
  const vault = artifact('DecisionVault');
  const vaultTx = await baseWal.deployContract({
    abi: vault.abi, bytecode: vault.bytecode, args: [reactiveAddr, account.address], value: VAULT_FUNDING,
  });
  const vaultReceipt = await basePub.waitForTransactionReceipt({ hash: vaultTx });
  const vaultAddr = vaultReceipt.contractAddress!;
  console.log(`DecisionVault    ${vaultAddr}  tx ${vaultTx}  (funded ${formatEther(VAULT_FUNDING)} ETH)`);

  // 4. Wire the vault into the reactive contract
  const setVaultTx = await lasnaWal.writeContract({
    address: reactiveAddr,
    abi: parseAbi(['function setVault(address vault_) external']),
    functionName: 'setVault',
    args: [vaultAddr],
    gasPrice: LASNA_GAS_PRICE,
  });
  await lasnaPub.waitForTransactionReceipt({ hash: setVaultTx });
  console.log(`setVault         tx ${setVaultTx}`);

  const deployments = {
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    networks: {
      baseSepolia: { chainId: 84532, rpc: base.rpc, explorer: base.explorer },
      lasna: { chainId: 5318007, rpc: lasnaCfg.rpc, explorer: lasnaCfg.explorer },
    },
    priceFeed: feedAddr,
    sentinelReactive: reactiveAddr,
    decisionVault: vaultAddr,
    agent: account.address,
    deployTxs: { priceFeed: feedTx, sentinelReactive: reactiveTx, decisionVault: vaultTx, setVault: setVaultTx },
  };
  writeFileSync(join(repoRoot, 'deployments.json'), JSON.stringify(deployments, null, 2));
  console.log('deployments.json written');
}

main().catch((err) => {
  console.error('deploy failed:', err);
  process.exit(1);
});
