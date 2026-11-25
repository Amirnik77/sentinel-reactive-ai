# Reactive Omni Buildathon — Verified Rules

Verified on 2026-11-25 from primary sources only:

- **Organizer announcement (primary):** Reactive Network blog, "Reactive Omni Buildathon:
  Thirty Days to Find Out What One Second Buys", published 2026-11-04.
  https://blog.reactive.network/reactive-omni-buildathon-thirty-days-to-find-out-what-one-second-buys/
- **Hackathon page (primary):** DoraHacks, "Reactive Omni Buildathon".
  https://dorahacks.io/hackathon/reactive-omni-buildathon/detail
- **Developer docs (primary):** https://dev.reactive.network/ (Getting Started,
  Origins & Destinations, Reactive Contracts, Callback Contracts,
  Reactive Mainnet & Lasna Testnet pages).

Both primary sources agree with each other and with the figures in the task brief.
No discrepancies found.

## Event

- Runs **November 5 – December 5, 2026**. Submission deadline **5 Dec 2026, 20:00 UTC**
  (DoraHacks event window: 2026-11-04T12:00:00Z to 2026-12-05T20:00:00Z).
- Registration and submissions run through **DoraHacks**. Free to enter.
- **No KYC, nationality, or age restriction is stated** in either primary source.
- Prizes are denominated in USD and **paid in REACT**. Total pool **$5,500**.
- Everything must be built during the event; prior work may only come in as a dependency.
- Repositories must be **public and open-source** by submission time.

## Tracks and prizes

| Track | Brief | Networks | Prizes |
|---|---|---|---|
| Every Second Counts | Time-sensitive DeFi where reaction time matters (arbitrage, stop-loss/take-profit, rebalancing vaults) | Unichain Sepolia and/or Base Sepolia as origin/destination, **Lasna testnet mandatory** for the Reactive leg | 1st $2,000, runner-up $250 |
| Set It and Forget It | Personal automations anyone can build | Any chain Reactive supports; Reactive mainnet **or** Lasna allowed | 1st $2,000, runner-up $250 |
| Reactive Meets AI | A neural network / model must be part of the **running system** — deciding what a reactive contract does next, interpreting its events, or being triggered by them. AI used only as a coding tool does **not** count (those entries belong in Set It and Forget It) | Reactive mainnet **or** Lasna allowed | 1st $1,000 (no runner-up prize) |

## Deliverables (submission must include)

1. Link to the **public repository**.
2. **Deployed contract addresses**.
3. **Transaction hashes showing the full loop** — origin event → reactive transaction →
   callback on the destination chain. (Judging "Execution" criterion: entries without
   on-chain reactive transactions and callbacks are not scored further.)
4. **Demo video under 3 minutes**.

## Judging

Judged by the Reactive team. Every entry is scored 1–5 on four equally weighted criteria:

- **Execution** — does it run; reactive transactions and the callbacks they trigger must be visible on-chain.
- **Integration** — does the reactive contract do real work, or is it bolted on?
- **Usefulness** — does it solve a problem real users have?
- **Craft** — readable code, a working demo, documentation someone else could follow.

Track-specific note (Every Second Counts): the strongest entries show **latency numbers
measured across the full loop**, not just one leg.

## Technical ground rules

- On **Base Sepolia** (200 ms blocks since the Denim upgrade), use **timestamps**, not block
  counts, for timers, cooldowns, or deadlines.
- Mainnets and testnets must not be mixed: a testnet origin requires a testnet destination.

## Network parameters (from dev.reactive.network)

| Network | Chain ID | RPC | System / Callback proxy |
|---|---|---|---|
| Reactive Lasna (testnet) | 5318007 | https://lasna-rpc.rnk.dev/ | System contract `0x8888888888888888888888888888888888888888` |
| Reactive Mainnet | 1597 | https://mainnet-rpc.rnk.dev/ | System contract `0x8888888888888888888888888888888888888888` |
| Base Sepolia | 84532 | https://sepolia.base.org | Callback proxy `0x476F44b11F5C942c58f4c8E3d0300E5710743585` |
| Ethereum Sepolia | 11155111 | — | Callback proxy `0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4` |
| Unichain Sepolia | 1301 | https://sepolia.unichain.org | Callback proxy `0x775c9B990ADe401060B78D0e98684eEf8d2466C1` |

- Lasna native token: **lREACT**. Explorer: https://lasna.reactscan.net/
- **Testnet REACT faucet (docs):** send Sepolia ETH to a faucet contract —
  Ethereum Sepolia `0x9b9BB25f1A81078C544C829c5EB7822d747Cf434` or
  Base Sepolia `0x2afaFD298b23b62760711756088F75B7409f5967` — at **1 ETH → 100 lREACT**
  (max 5 ETH per transaction), or call `request(address)` on it with value attached.

## Omni API notes (from dev.reactive.network, Reactive Contracts / Callback Contracts)

- Reactive contracts inherit `AbstractReactive`; subscribe via
  `SYSTEM.subscribe(chainId, contract, topic0, topic1, topic2, topic3)`
  (wildcard = `REACTIVE_IGNORE`); implement `react(LogRecord memory log_) external onlySystem`.
- Callbacks are requested via `SYSTEM.requestCallbackV_1_0(CallbackConfiguration_V_1_0{chainId, recipient, gasLimit, payload})`.
  The network **replaces the first 160 bits of the payload** with the requesting reactive
  contract's address — payloads must declare an `address` first parameter (pass `address(0)`).
- Destination contracts inherit `AbstractCallback(callbackProxy, reactiveContractAddress)`
  and guard callback methods with `onlyServiceProvider` + `onlyCallbackSender(reactive_)`.
- Deployment order: reactive contract first → callback contract (needs the reactive
  address, immutable) → set recipient on the reactive contract via owner setter → fund both.
- Billing: the reactive contract pays for reactive transactions in lREACT on Lasna;
  the **callback recipient pays for callback execution in the destination chain's native
  token** (Base Sepolia ETH here). A contract in debt receives nothing.
