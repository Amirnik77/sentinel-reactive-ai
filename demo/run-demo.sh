#!/usr/bin/env bash
# Sentinel end-to-end demo run.
# Starts the AI agent, drives the "full" price scenario (calm -> downtrend ->
# panic) through the PriceFeed, waits for every decision to settle, prints the
# evidence table, and stops the agent.
#
# Prerequisites: contracts deployed (deployments.json exists), wallet funded.
# Usage: bash demo/run-demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export TMPDIR="${TMPDIR:-$HOME/workspace/.tmp}"
mkdir -p "$TMPDIR"

echo "=== Sentinel status (before) ==="
(cd agent && npx tsx src/status.ts)

echo
echo "=== Starting AI agent (log: agent/agent.out) ==="
(cd agent && nohup npx tsx src/index.ts > agent.out 2>&1 &)
sleep 6

echo
echo "=== Driving price scenario: calm -> downtrend -> panic ==="
(cd agent && npx tsx src/drive.ts full --wait)

echo
echo "=== Agent log (decisions) ==="
tail -n 40 agent/agent.out || true

# Stop the agent started above (matched by its command line; the earlier
# pid-file approach recorded the wrong pid and left the agent running).
pkill -f "tsx src/index.ts" 2>/dev/null || true

echo
echo "=== Sentinel status (after) ==="
(cd agent && npx tsx src/status.ts)

echo
echo "Evidence: demo/evidence-full.json   Agent audit log: agent/decisions.log"
