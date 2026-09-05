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

// Install before either runtime captures child_process.execFile. Both the new
// recurrence-first scanner and the preserved longitudinal V1 runtime therefore
// share the same rolling GMGN budget, cache and in-flight deduplication.
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

// New default: breadth first. We retain all existing V1 code and tables, but
// autonomous production work now scans trending tokens for top traders and
// tallies wallet recurrence across independent tokens. Set
// CONSENSUS_DISCOVERY_MODE=legacy to run the prior evidence-first scheduler.
const mode = String(process.env.CONSENSUS_DISCOVERY_MODE || "recurrence").trim().toLowerCase();
if (mode !== "legacy") {
  console.log("[startup] Consensus discovery mode: recurrence-first");
  require("./recurrence-app").startRecurrenceApp({ gmgnGuard });
} else {
  console.log("[startup] Consensus discovery mode: preserved longitudinal V1");

  // app.js initializes the original persistent schema and scheduler.
  require("./app");
  try {
    const result = require("./evidence-observation-integrity")
      .installEvidenceObservationIntegrityAtPath();
    console.log(`[evidence] observation clock active (${result.clockRows} existing row(s) seeded)`);
  } catch (error) {
    console.warn(`[evidence] observation clock unavailable: ${error.message}`);
  }

  const dashboard = require("./progress-dashboard").startProgressDashboard({ gmgnGuard });
  require("./public-health").installPublicHealthEndpoint(dashboard);
}
