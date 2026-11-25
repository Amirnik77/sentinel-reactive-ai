// Shared configuration for the Sentinel agent and ops scripts.
// The private key is loaded at runtime from the wallet file (mode 600) and
// is never printed, logged, or written anywhere.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia, sepolia } from 'viem/chains';
import { defineChain } from 'viem';

export const WALLET_FILE =
  process.env.WALLET_FILE ?? join(homedir(), 'workspace/wallets/bsc-wallet.json');

export function loadAccount(): PrivateKeyAccount {
  const raw = JSON.parse(readFileSync(WALLET_FILE, 'utf8')) as {
    address: string;
    private_key: string;
  };
  const account = privateKeyToAccount(raw.private_key as `0x${string}`);
  if (account.address.toLowerCase() !== raw.address.toLowerCase()) {
    throw new Error('wallet file address does not match private key');
  }
  return account;
}

export const DEPLOYER_ADDRESS = '0x061978d21ce915956c3B3319B507c45145125d59';

export const lasna = defineChain({
  id: 5318007,
  name: 'Reactive Lasna Testnet',
  nativeCurrency: { name: 'Lasna REACT', symbol: 'lREACT', decimals: 18 },
  rpcUrls: { default: { http: ['https://lasna-rpc.rnk.dev/'] } },
  blockExplorers: {
    default: { name: 'Reactscan Lasna', url: 'https://lasna.reactscan.net' },
  },
  testnet: true,
});

export const CHAINS = {
  baseSepolia: {
    chain: baseSepolia,
    rpc: process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
  },
  sepolia: {
    chain: sepolia,
    rpc: process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
  },
  lasna: {
    chain: lasna,
    rpc: process.env.LASNA_RPC ?? 'https://lasna-rpc.rnk.dev/',
    explorer: 'https://lasna.reactscan.net',
  },
} as const;

/** Reactive Network faucet contracts: send ETH, receive 100x lREACT on Lasna. */
export const REACTIVE_FAUCET = {
  onSepolia: '0x9b9BB25f1A81078C544C829c5EB7822d747Cf434',
  onBaseSepolia: '0x2afaFD298b23b62760711756088F75B7409f5967',
} as const;

/**
 * Base Sepolia OptimismPortal on Ethereum Sepolia — the canonical deposit
 * entry point (the L1StandardBridge is a wrapper around it).
 * NOTE: a previously configured "bridge" address (0x3154Cf16…) turned out to
 * have no code on Sepolia (an EOA — verified via eth_getCode and two
 * explorers on 2026-11-25); 0.022 testnet ETH sent there by an earlier run is
 * stuck in that EOA. Deposits therefore go through the portal directly,
 * which is verified live (emits TransactionDeposited for Base Sepolia).
 */
export const OPTIMISM_PORTAL = '0x49f53e41452C74589E85cA1677426Ba426459e85';

/** Callback proxy on Base Sepolia (Reactive Network). */
export const BASE_SEPOLIA_CALLBACK_PROXY = '0x476F44b11F5C942c58f4c8E3d0300E5710743585';

/** System contract on Lasna / Reactive mainnet. */
export const REACTIVE_SYSTEM = '0x8888888888888888888888888888888888888888';
