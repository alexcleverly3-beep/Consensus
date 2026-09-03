"use strict";

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

require("./app");
