# Demo video — narration script (target: under 3 minutes)

Companion to `demo/run-demo.sh`, which performs the live run this narration
describes. Timings assume the run is edited down (timelapses for waits).
Word count ~330 ≈ 2:20 at a natural pace.

---

**[0:00 — Title card: "Sentinel — an AI guard for your on-chain position"]**

> "This is Sentinel. It watches a price feed around the clock and protects a
> position automatically — and the part deciding what to do is a neural
> network that runs as part of the system, not a script someone has to babysit."

**[0:15 — Architecture diagram (README) ]**

> "Three pieces. A price feed on Base Sepolia emits an event for every price
> update. A reactive contract on Lasna subscribes to those events, keeps a
> rolling window of the last eight prices, and calls back to a vault contract
> on Base Sepolia. The callback asks our AI agent for a decision, and the
> vault executes it: hold, hedge fifty percent, or exit to full protection."

**[0:40 — Terminal: agent starting; status output]**

> "Everything is already deployed and funded on testnet. Here is the agent
> starting up — it loads the trained model, ninety-nine point eight percent
> accuracy on held-out data, and starts watching the vault."

**[0:55 — Drive: calm phase]**

> "First, a calm market. Prices wobble around two thousand dollars. Every
> update travels the full loop — origin event, Lasna reaction, callback,
> agent decision — and the model says HOLD, so the vault stays fully exposed.
> Each of these transactions is real and on-chain; the hashes are in the repo."

**[1:25 — Drive: downtrend phase]**

> "Now a steady decline, about one percent per step. As the window fills with
> the downtrend, the model's classification flips to HEDGE, and the vault
> moves half the position to safety — automatically, seconds after the price
> moved, with nobody clicking anything."

**[1:55 — Drive: panic phase]**

> "Then the crash: minus seven, minus nine percent steps. The model reads
> the window as panic and answers EXIT. The vault goes to one hundred percent
> hedged. Exposed, hedged, exited — the whole protection ladder, driven by
> the network's own events."

**[2:25 — Evidence table + explorers]**

> "Here is the evidence table from the run: for every price update, the four
> transaction hashes that make up the loop, and the measured end-to-end
> latency. And here is the same trail in the explorers — the reaction on
> Lasna, the callback and the executed action on Base Sepolia."

**[2:45 — Closing card]**

> "Sentinel: Reactive Network supplies the reflexes, the neural network
> supplies the judgment. Built for the Reactive Omni Buildathon, Reactive
> Meets AI track. Code, contracts, model and evidence are all in the repo."

---

## Shot list / raw assets to capture

1. Terminal capture of `npx tsx src/status.ts` (balances + vault state).
2. Terminal capture of the agent log during `demo/run-demo.sh full --wait`
   (agent prints every classification with confidence).
3. The generated `demo/evidence-full.json` summary table (printed by drive.ts).
4. Explorer screenshots: one Lasna reaction tx (lasna.reactscan.net), one
   Base Sepolia callback tx and one ActionExecuted tx (sepolia.basescan.org).
5. The architecture diagram from README.md.
