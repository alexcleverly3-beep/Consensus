"use strict";

require("dotenv").config();

// Preserve the Railway environment names used by the original bot while the
// V1 runtime adopts a smaller, evidence-first entrypoint.
if (!process.env.DISCORD_TOKEN && process.env.DISCORD_BOT_TOKEN) {
  process.env.DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
}

// The V1 scheduler owns cooldown/backoff. Do not let the CLI independently
// retry a rate-limited request and unexpectedly spend more of the request budget.
if (process.env.GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS === undefined) {
  process.env.GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS = "0";
}

// Install before app.js captures child_process.execFile. This gives every GMGN
// path (market, trader, token-info, and seed history) one shared rolling budget,
// plus exact-request caching and in-flight deduplication.
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

// Budget diagnostics only read in-memory guard counters; they never make GMGN
// requests. Railway logs now expose whether caching is saving calls and whether
// the configured request ceiling is being approached or exhausted.
require("./runtime-diagnostics")
  .createRuntimeDiagnostics({ gmgnGuard })
  .start();

// app.js initializes the persistent SQLite schema synchronously before its
// asynchronous discovery loop begins. Starting the dashboard immediately after
// it means Railway can expose live progress from that same database without a
// second service or any wallet-identifying UI.
require("./app");
require("./progress-dashboard").startProgressDashboard({ gmgnGuard });
