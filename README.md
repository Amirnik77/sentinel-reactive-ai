# Sentinel — an AI guard for on-chain positions

**Reactive Omni Buildathon · Track: Reactive Meets AI**

Sentinel watches a price feed around the clock and protects a position
automatically. A Reactive contract turns every price update into a decision
request; a **neural network** — running as part of the system, triggered by
the events themselves — classifies the market regime from the recent price
window and decides what the vault does next: **HOLD**, **HEDGE 50%**, or
**EXIT to full protection**. Every step of the loop executes on public
testnets and leaves a transaction hash.

## The problem

Positions on-chain are only protected while someone is watching. Stop-loss
bots and keeper scripts are single points of failure: they sleep, crash, run
out of gas, or react to one price tick with no sense of the pattern around
it. A single wick can trigger a naive stop; a slow grind down can slip past
a threshold that was set for a crash. What you actually want is a guard that
(1) is awake for *every* event, by construction, and (2) judges the *shape*
of the move — calm, trending, or panic — before acting.

## How it works

```
 Base Sepolia                     Lasna (Reactive)                Base Sepolia
┌────────────┐  PriceUpdated   ┌──────────────────┐  callback   ┌──────────────┐
│ PriceFeed  │ ──────────────► │ SentinelReactive │ ──────────► │ DecisionVault│
│ (origin)   │     event       │ rolling window   │ requestDec. │ DecisionReq. │
└────────────┘                 └──────────────────┘             └──────┬───────┘
                                                                     │ event
                                                              ┌──────▼───────┐
                                                              │  AI agent    │
                                                              │  (MLP neural │
                                                              │   network)   │
                                                              └──────┬───────┘
                                                submitDecision()     │
                                                ◄────────────────────┘
                                                vault executes HOLD /
                                                HEDGE / EXIT on-chain
```

1. **PriceFeed** (Base Sepolia) — a mock oracle. `setPrice()` emits
   `PriceUpdated(price, timestamp)`. It stands in for any real event source
   (DEX pool, oracle, lending market).
2. **SentinelReactive** (Lasna) — subscribes to the feed's events in its
   constructor via the Reactive system contract. On every event it updates
   an on-chain rolling window of the last 8 prices and requests a callback
   to the vault carrying the window and the origin tx hash. It does real
   work — state, sequencing, traceability — not just forwarding.
3. **DecisionVault** (Base Sepolia) — a callback contract
   (`AbstractCallback`). The callback opens a decision request and emits
   `DecisionRequested(id, price, originTx, window)`. It holds the mock
   position: state `Exposed → Hedged → Exited`, hedge ratio 0% → 50% → 100%.
4. **AI agent** (off-chain TypeScript service) — watches for
   `DecisionRequested`, extracts 12 return-based features from the window,
   runs the MLP (12 → 24 → 12 → 3, trained on synthetic market regimes,
   99.8% held-out accuracy), and posts `submitDecision(id, action,
   confidence)` signed by its key. The vault executes the action and emits
   `ActionExecuted`. The model's confidence is recorded on-chain with every
   decision.

The loop is fully event-driven: no cron, no polling of the price, no human
in the loop. The agent is only ever *triggered by* the chain.

### Why the AI is genuinely part of the system

The track rule is that the model must participate in the running system.
Here, no protective action can happen without the model: the vault has no
threshold logic of its own, it only executes what the network classifies.
The same window of prices can mean HOLD (choppy but directionless) or EXIT
(structured crash) — the distinction is the model's, made at runtime, per
event, with its confidence stored on-chain.

## Networks

| Role | Network | Chain ID |
|---|---|---|
| Origin + destination | Base Sepolia | 84532 |
| Reactive | Lasna testnet | 5318007 |

Key system addresses: Reactive system contract
`0x8888888888888888888888888888888888888888` (Lasna); Base Sepolia callback
proxy `0x476F44b11F5C942c58f4c8E3d0300E5710743585`.

## Deployed contracts & proof of the loop

Deployed and demo-run end-to-end on 2026-11-25 from the wallet
`0x061978d21ce915956c3B3319B507c45145125d59` (see `deployments.json`).

| Contract | Network | Address | Deploy tx |
|---|---|---|---|
| PriceFeed | Base Sepolia | `0x29f91c152b5632bce298181af8e857a3ede94e07` | `0x2c65a7b6b36c38baf19849345d6a3c597074444b5032c2018b36f869697f84e7` |
| SentinelReactive | Lasna | `0x95496865f5b3b313939a3b595c02f86b802427ec` | `0x03582053df33acb1f3853585d627ce3123af261e3ca7438c3ce2b00bb32d144a` |
| DecisionVault | Base Sepolia | `0x922a6186a383cbac790d1d02ec213ab4145be65f` | `0x66e95a7c59f93bbfb01143c89352960ddaba1a2ee6ebed9b03383f7515b705f9` |

Explorers: [Base Sepolia](https://sepolia.basescan.org) ·
[Lasna (Reactscan)](https://lasna.reactscan.net). Wiring transaction
(`setVault` on Lasna): `0x1b9911d095a43f02d9f0d4dae7ddbc56515b2b1a2051584e2b01f4c6036da1ef`.

**Demo result** (`bash demo/run-demo.sh`, log in `demo/run-demo-output.log`):
24 price updates driven calm → downtrend → panic. The model answered
**HOLD** for the calm phase (steps 1–10), **HEDGE** once the downtrend
filled the window (steps 11–17), and **EXIT** in the crash (steps 18–24).
Final vault state: **Exited, hedge 100%**; 46 reactions on Lasna, 46
decisions executed, zero callback debt on either contract. Every one of
the 24 steps has a complete hash chain in `demo/evidence-full.json`
(origin tx → Lasna reaction tx → callback tx → agent decision tx, with
loop latencies of ~3–8 s after the first). Representative steps:

| Step | Price | Action (confidence) | Origin tx (Base Sepolia) | Reaction tx (Lasna) | Callback tx (Base Sepolia) | Decision tx (Base Sepolia) |
|---|---|---|---|---|---|---|
| 1 | $2,004 | HOLD (99.99%) | `0x3a67555589797d2f7df30e2be5efc4eccac9f84631dc59949dbf938a80fb4ac9` | `0x78d97cbb682c55bfaaee166c05bde2d33870986a4ef9b5fefd0ce6064ce9d8e5` | `0xdf48fab7a4c403aed3c50d544b3a11bfc181ad004a62c6ab3ba3f91dd04c2436` | `0x3cc65e148f6e8442e0ea4c4c34ac38cf2a2e54913f319408ce5695c890e20d6b` |
| 11 | $1,929 | HEDGE (95.6%) | `0x6ccbc4a12b0870eb135a9d86b36b0695e5b1e1b14c15ee9885c8b7b4bb2a51a9` | `0x7ba3c44aee31d845cd1c9c6668fc9daa4c72bf0d2d62448e674186ee37b36122` | `0x12869f681c1eab25f982f708df3d27203e28dacf4f9614602ab5ef37380dbcce` | `0xafe86085089416c1fb484f43f5f3714c3ad7f4e6d20ab9ec265bd4ddaccf53ee` |
| 18 | $1,639 | EXIT (99.97%) | `0xb6e901ae4934dc099425eeef63ed4649d88054e11b81928caeddf8972430c9b7` | `0xdfe6c4c502a33d0217abf3fba55381a2f4382bcaff69141860523e5302c74c10` | `0xa5f8c944d1985d9211198aeae084e5f75fe3908bdfbe96caf086d02fdfa7cc22` | `0x64c3f0974dbd443b840944a8a9339af1895186e7dde09e6d2f36355b4afe970d` |

Full-loop evidence (per price update: origin tx → Lasna reaction tx →
callback tx → agent decision tx, with latencies) is generated by
`agent/src/drive.ts` into `demo/evidence-full.json`; the agent's own audit
trail is in `agent/decisions.log`.

## Run it yourself

Prerequisites: Node 22+, Foundry, a wallet file at
`~/workspace/wallets/bsc-wallet.json` (`{address, private_key}`), testnet
funds as described below.

```bash
forge build                                   # compile contracts
cd agent && npm install                       # agent + ops scripts
npx tsx src/train.ts                          # (re)train the model -> model/weights.json
npx tsx src/fund.ts balances                  # check Sepolia / Base Sepolia / Lasna balances
npx tsx src/fund.ts convert 0.05 base         # ETH -> lREACT via Reactive's faucet contract (100:1)
npx tsx src/deploy.ts                         # deploy + wire all three contracts
npx tsx src/index.ts                          # start the AI agent (terminal 1)
npx tsx src/drive.ts full                     # drive calm -> downtrend -> panic (terminal 2)
npx tsx src/status.ts                         # balances, vault state, debts
# or everything at once:
bash demo/run-demo.sh
```

### Funding (testnet only, no real money)

The deployer wallet needs:
- **Base Sepolia ETH** — deployments, price updates, callback billing
  reserve inside the vault, agent decision transactions. ~0.1 ETH is ample.
- **lREACT on Lasna** — the reactive contract pays for its reactions.
  Obtained by sending Base Sepolia (or Ethereum Sepolia) ETH to Reactive's
  faucet contract (`request(address)`, 1 ETH → 100 lREACT):
  `npx tsx src/fund.ts convert <ethAmount> base`.
- Sepolia ETH can be bridged to Base Sepolia with
  `npx tsx src/fund.ts bridge <ethAmount>` (an OptimismPortal
  `depositTransaction` — the canonical OP Stack deposit).

#### Funding status

Funded and run on 2026-11-25. The wallet
(`0x061978d21ce915956c3B3319B507c45145125d59`) received 0.05 Sepolia ETH;
0.02 ETH was converted to 2.1 lREACT via the Reactive faucet contract on
Sepolia (tx `0x8beeb37a915b7ae8c73cac793f4248f8f6fc07d0316b295e8e2a58500906f660`),
and 0.006 ETH was deposited to Base Sepolia via the OptimismPortal
(tx `0x7e8378173713e5fdfaf917ebc5b6e8f8087b0696945445bba45338554bdf71fc`).

One mishap worth recording: the bridge address originally configured for
this repo (`0x3154Cf16ccdb4C6d922629664174b904d80F2C35`) has **no code** on
Ethereum Sepolia — it is an externally owned account, verified via
`eth_getCode` and two independent explorers. 0.022 testnet ETH sent there
by the first bridge attempt (tx
`0xaa9b633c808f7d3e44f1ea40af5f4433262100cab4bd3250faa9194464f41de3`) is
stuck in that account (testnet funds, no real value). `fund.ts` now
deposits through the OptimismPortal directly.

Final balances after deployment and the full demo: Sepolia 0.002 ETH,
Base Sepolia ~0.00297 ETH (plus 0.00295 ETH held by the vault), Lasna
0.472 lREACT in the wallet and 0.626 lREACT in SentinelReactive, with zero
debt on both Reactive contracts — enough headroom to re-run the demo.

## The model

- Features (12, all scale-free): total/mean/last returns, volatility, max
  drawdown, last-3 return, down-step fraction, worst step, momentum, range,
  acceleration, consecutive down steps.
- MLP 12 → 24 → 12 → 3 (tanh, softmax), trained from scratch in TypeScript
  (`agent/src/train.ts`, no ML libraries) on 4,200 synthetic windows across
  five regimes: calm/uptrend/chop → HOLD, downtrend → HEDGE, panic → EXIT.
  Held-out accuracy 99.8%. Weights: `agent/model/weights.json`.

## Repo layout

```
src/            Solidity: PriceFeed, SentinelReactive, DecisionVault
lib/reactive/   Reactive Network SDK (reactive-lib-omni), vendored
agent/src/      model.ts (features + inference), train.ts, index.ts (agent),
                deploy.ts, fund.ts, drive.ts, status.ts, config.ts
agent/model/    trained weights.json
docs/RULES.md   buildathon rules as verified from primary sources
demo/           NARRATION.md (video script), run-demo.sh, evidence-*.json
scripts/        browser tooling used for faucet research (proxy, claims)
deployments.json  written by deploy.ts (addresses + deploy txs)
```

## Rules & judging notes

Verified rules, track briefs, deliverables and judging criteria are recorded
in [docs/RULES.md](docs/RULES.md). Sentinel targets **Reactive Meets AI**
($1,000 first place); its always-on automation also fits the spirit of
"Set It and Forget It", but the entry is submitted to one track:
Reactive Meets AI.
