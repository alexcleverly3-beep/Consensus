"use strict";

require("dotenv").config();

// Preserve the Railway environment names used by the original bot.
if (!process.env.DISCORD_TOKEN && process.env.DISCORD_BOT_TOKEN) {
  process.env.DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
}

// Consensus owns cooldown/backoff. Do not let the CLI independently retry a
// rate-limited request and unexpectedly spend more of the shared request budget.
if (process.env.GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS === undefined) {
  process.env.GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS = "0";
}

// Install before the recurrence runtime captures child_process.execFile so all
// GMGN work shares the same rolling budget, cache and in-flight deduplication.
let gmgnGuardState = null;
try {
  gmgnGuardState = require("./gmgn-guard-state").openGmgnGuardState();
} catch (error) {
  console.warn(`[gmgn-budget] persistent state unavailable: ${error.message}`);
}

const gmgnGuard = require("./gmgn-runtime-guard").install({
  initialState: gmgnGuardState?.load() || {},
  onStateChange: gmgnGuardState ? (state) => gmgnGuardState.save(state) : null,
});

require("./runtime-diagnostics")
  .createRuntimeDiagnostics({ gmgnGuard })
  .start();

// Phase 1 is recurrence-first only: discover trending tokens, ingest their top
// traders, and accumulate independent wallet/token observations. The obsolete
// one-shot/evidence-first scheduler is intentionally not retained as a runtime
// compatibility mode.
console.log("[startup] Consensus discovery mode: recurrence-first");
require("./recurrence-app").startRecurrenceApp({ gmgnGuard });
