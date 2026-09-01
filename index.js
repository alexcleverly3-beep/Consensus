require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const Database = require("better-sqlite3");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} = require("discord.js");

// ============================================================
// CONFIG
// ============================================================

const SOL_ADDR =
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const SOL_ADDR_IN_TEXT =
  /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

const DISCORD_CHANNEL_ID =
  String(
    process.env.DISCORD_CHANNEL_ID || ""
  ).trim();

const DB_PATH =
  String(
    process.env.DB_PATH ||
      path.join(
        process.cwd(),
        "data",
        "wallets.db"
      )
  ).trim();

const TOP_TRADERS_LIMIT = 100;

const MAX_CANDIDATES =
  clampInt(
    process.env.MAX_CANDIDATES,
    20,
    5,
    30
  );

const MAX_7D_CHECKS =
  clampInt(
    process.env.MAX_7D_CHECKS,
    6,
    1,
    10
  );

const MAX_ACTIVITY_CHECKS =
  clampInt(
    process.env.MAX_ACTIVITY_CHECKS,
    4,
    1,
    6
  );

const ACTIVITY_SAMPLE =
  clampInt(
    process.env.ACTIVITY_SAMPLE,
    50,
    20,
    100
  );

// Main GMGN protection.
// Every REAL GMGN request is separated by this gap.
const MIN_GMGN_GAP_MS =
  clampInt(
    process.env.GMGN_MIN_REQUEST_GAP_MS,
    8000,
    3000,
    30000
  );

const RATE_LIMIT_GRACE_MS = 5000;

// Cache windows.
const CACHE_30D_MS =
  12 * 60 * 60 * 1000;

const CACHE_7D_MS =
  3 * 60 * 60 * 1000;

const CACHE_ACTIVITY_MS =
  3 * 60 * 60 * 1000;

const CACHE_DISCOVERY_MS =
  10 * 60 * 1000;

const CACHE_RESULT_MS =
  10 * 60 * 1000;

// Quality thresholds.
const MIN_30D_TOKENS = 8;
const PREFERRED_30D_TOKENS = 15;

const MIN_30D_TRACK_SCORE = 54;
const MIN_7D_TRACK_SCORE = 46;
const MIN_FINAL_SCORE = 64;

// Bot/high-frequency protection.
const HARD_MAX_TRADES_PER_DAY = 250;
const HARD_MAX_TRADES_PER_TOKEN = 40;

const HIGH_ACTIVITY_TRADES_PER_DAY = 80;
const HIGH_ACTIVITY_TRADES_PER_TOKEN = 15;

const FAST_AVG_HOLD_SEC =
  15 * 60;

const HARD_MAX_THIS_TOKEN_TX = 80;

// These are not useful wallets to track manually.
const HARD_TAGS =
  new Set([
    "rat_trader",
    "bundler",
    "dex_bot",
    "dev",
    "arbitrager",
    "mev_bot",
  ]);

// ============================================================
// BASIC HELPERS
// ============================================================

function clampInt(
  value,
  fallback,
  min,
  max
) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.max(
    min,
    Math.min(
      max,
      Math.floor(n)
    )
  );
}

const sleep = (ms) =>
  new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );

const clamp = (
  value,
  min,
  max
) =>
  Math.max(
    min,
    Math.min(
      max,
      value
    )
  );

function num(
  value,
  fallback = 0
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function boolish(value) {
  if (
    typeof value === "boolean"
  ) {
    return value;
  }

  if (
    typeof value === "number"
  ) {
    return value !== 0;
  }

  if (
    typeof value !== "string"
  ) {
    return false;
  }

  return [
    "1",
    "true",
    "yes",
  ].includes(
    value
      .trim()
      .toLowerCase()
  );
}

function short(address) {
  return (
    `${address.slice(0, 4)}` +
    `…` +
    `${address.slice(-4)}`
  );
}

function findSolAddress(text) {
  return (
    (
      String(
        text || ""
      ).match(
        SOL_ADDR_IN_TEXT
      ) ||
      []
    ).find(
      (x) =>
        SOL_ADDR.test(x)
    ) ||
    null
  );
}

function tagsOf(obj) {
  return [
    ...(
      Array.isArray(
        obj?.tags
      )
        ? obj.tags
        : []
    ),

    ...(
      Array.isArray(
        obj
          ?.maker_token_tags
      )
        ? obj.maker_token_tags
        : []
    ),

    ...(
      Array.isArray(
        obj?.common?.tags
      )
        ? obj.common.tags
        : []
    ),

    obj?.common?.tag,
  ]
    .filter(Boolean)
    .map(
      (x) =>
        String(x)
          .toLowerCase()
    );
}

function median(values) {
  if (!values.length) {
    return null;
  }

  const a =
    [...values].sort(
      (x, y) =>
        x - y
    );

  const i =
    Math.floor(
      a.length / 2
    );

  return (
    a.length % 2
      ? a[i]
      : (
          a[i - 1] +
          a[i]
        ) / 2
  );
}

// ============================================================
// SQLITE DATABASE
// ============================================================

fs.mkdirSync(
  path.dirname(DB_PATH),
  {
    recursive: true,
  }
);

const db =
  new Database(DB_PATH);

db.pragma(
  "journal_mode = WAL"
);

db.pragma(
  "synchronous = NORMAL"
);

db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_cache (
  wallet_address TEXT NOT NULL,
  period TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    wallet_address,
    period
  )
);

  CREATE TABLE IF NOT EXISTS token_cache (
    token_address TEXT PRIMARY KEY,
    token_info_json TEXT NOT NULL,
    traders_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallet_observations (
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    token_score REAL,
    profit_change REAL,
    realized_profit REAL,
    total_profit REAL,
    entry_delay_sec REAL,
    PRIMARY KEY (
      wallet_address,
      token_address
    )
  );

  CREATE TABLE IF NOT EXISTS sent_results (
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    overall_score REAL,
    PRIMARY KEY (
      wallet_address,
      token_address
    )
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    wallet_address TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sent_wallet
    ON sent_results(wallet_address);

  CREATE INDEX IF NOT EXISTS idx_obs_wallet
    ON wallet_observations(wallet_address);
`);

const stmtGetCache =
  db.prepare(`
    SELECT
      stats_json,
      updated_at

    FROM wallet_cache

    WHERE wallet_address = ?
      AND period = ?
  `);

const stmtPutCache =
  db.prepare(`
    INSERT INTO wallet_cache(
      wallet_address,
      period,
      stats_json,
      updated_at
    )
    VALUES (?, ?, ?, ?)

    ON CONFLICT(
      wallet_address,
      period
    )

    DO UPDATE SET
      stats_json =
        excluded.stats_json,

      updated_at =
        excluded.updated_at
  `);

const stmtGetTokenCache =
  db.prepare(`
    SELECT
      token_info_json,
      traders_json,
      updated_at

    FROM token_cache

    WHERE token_address = ?
  `);

const stmtPutTokenCache =
  db.prepare(`
    INSERT INTO token_cache(
      token_address,
      token_info_json,
      traders_json,
      updated_at
    )
    VALUES (?, ?, ?, ?)

    ON CONFLICT(token_address)

    DO UPDATE SET
      token_info_json =
        excluded.token_info_json,

      traders_json =
        excluded.traders_json,

      updated_at =
        excluded.updated_at
  `);

const stmtPrevSent =
  db.prepare(`
    SELECT COUNT(*) AS count

    FROM sent_results

    WHERE wallet_address = ?
      AND token_address <> ?
  `);

const stmtMarkSent =
  db.prepare(`
    INSERT INTO sent_results(
      wallet_address,
      token_address,
      sent_at,
      overall_score
    )
    VALUES (?, ?, ?, ?)

    ON CONFLICT(
      wallet_address,
      token_address
    )

    DO UPDATE SET
      sent_at =
        excluded.sent_at,

      overall_score =
        excluded.overall_score
  `);

const stmtObservation =
  db.prepare(`
    INSERT INTO wallet_observations(
      wallet_address,
      token_address,
      observed_at,
      token_score,
      profit_change,
      realized_profit,
      total_profit,
      entry_delay_sec
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)

    ON CONFLICT(
      wallet_address,
      token_address
    )

    DO UPDATE SET
      observed_at =
        excluded.observed_at,

      token_score =
        excluded.token_score,

      profit_change =
        excluded.profit_change,

      realized_profit =
        excluded.realized_profit,

      total_profit =
        excluded.total_profit,

      entry_delay_sec =
        excluded.entry_delay_sec
  `);

const stmtObservationSummary =
  db.prepare(`
    SELECT
      COUNT(*) AS observations,

      AVG(token_score)
        AS avg_token_score,

      SUM(
        CASE
          WHEN
            profit_change > 0.15
            OR realized_profit > 500
          THEN 1
          ELSE 0
        END
      ) AS good_results,

      SUM(
        CASE
          WHEN
            entry_delay_sec
              IS NOT NULL
            AND entry_delay_sec >= 0
            AND entry_delay_sec <= 21600
          THEN 1
          ELSE 0
        END
      ) AS early_results

    FROM wallet_observations

    WHERE wallet_address = ?
      AND token_address <> ?
  `);

const stmtGetBlacklist =
  db.prepare(`
    SELECT
      reason,
      expires_at

    FROM blacklist

    WHERE wallet_address = ?
  `);

const stmtPutBlacklist =
  db.prepare(`
    INSERT INTO blacklist(
      wallet_address,
      reason,
      expires_at
    )
    VALUES (?, ?, ?)

    ON CONFLICT(wallet_address)

    DO UPDATE SET
      reason =
        excluded.reason,

      expires_at =
        excluded.expires_at
  `);

const stmtDeleteBlacklist =
  db.prepare(`
    DELETE FROM blacklist
    WHERE wallet_address = ?
  `);

const stmtGetMeta =
  db.prepare(`
    SELECT value
    FROM meta
    WHERE key = ?
  `);

const stmtPutMeta =
  db.prepare(`
    INSERT INTO meta(
      key,
      value
    )
    VALUES (?, ?)

    ON CONFLICT(key)

    DO UPDATE SET
      value =
        excluded.value
  `);

// ============================================================
// DATABASE HELPERS
// ============================================================

function cacheTtl(kind) {
  if (
    kind === "30d"
  ) {
    return CACHE_30D_MS;
  }

  if (
    kind === "7d"
  ) {
    return CACHE_7D_MS;
  }

  if (
    kind === "activity"
  ) {
    return CACHE_ACTIVITY_MS;
  }

  return 0;
}

function getWalletCache(
  wallet,
  kind
) {
  const row =
    stmtGetCache.get(
      wallet,
      kind
    );

  if (
    !row ||
    Date.now() -
      Number(
        row.updated_at
      ) >
      cacheTtl(kind)
  ) {
    return null;
  }

  try {
    return JSON.parse(
      row.data_json
    );

  } catch {
    return null;
  }
}

function putWalletCache(
  wallet,
  kind,
  data
) {
  stmtPutCache.run(
    wallet,
    kind,
    JSON.stringify(data),
    Date.now()
  );
}

function getDiscoveryCache(
  token
) {
  const row =
    stmtGetTokenCache.get(
      token
    );

  if (
    !row ||
    Date.now() -
      Number(
        row.updated_at
      ) >
      CACHE_DISCOVERY_MS
  ) {
    return null;
  }

  try {
    const tokenInfo =
      JSON.parse(
        row.token_info_json
      );

    const traders =
      JSON.parse(
        row.traders_json
      );

    if (
      !Array.isArray(
        traders
      )
    ) {
      return null;
    }

    return {
      tokenInfo,
      traders,
    };

  } catch {
    return null;
  }
}

function putDiscoveryCache(
  token,
  tokenInfo,
  traders
) {
  stmtPutTokenCache.run(
    token,
    JSON.stringify(
      tokenInfo || {}
    ),
    JSON.stringify(
      traders || []
    ),
    Date.now()
  );
}

function previousSentCount(
  wallet,
  token
) {
  return Number(
    stmtPrevSent.get(
      wallet,
      token
    )?.count ||
      0
  );
}

function markSent(
  wallet,
  token,
  score
) {
  stmtMarkSent.run(
    wallet,
    token,
    Date.now(),
    score
  );
}

function saveObservation(
  wallet,
  token,
  x
) {
  stmtObservation.run(
    wallet,
    token,
    Date.now(),
    x.score,
    x.profitChange,
    x.realized,
    x.totalProfit,
    x.entryDelaySec
  );
}

function observationSummary(
  wallet,
  token
) {
  const r =
    stmtObservationSummary.get(
      wallet,
      token
    ) ||
    {};

  return {
    observations:
      Number(
        r.observations ||
          0
      ),

    avgTokenScore:
      num(
        r.avg_token_score
      ),

    goodResults:
      Number(
        r.good_results ||
          0
      ),

    earlyResults:
      Number(
        r.early_results ||
          0
      ),
  };
}

function getBlacklist(wallet) {
  const row =
    stmtGetBlacklist.get(
      wallet
    );

  if (!row) {
    return null;
  }

  if (
    Number(
      row.expires_at
    ) <= Date.now()
  ) {
    stmtDeleteBlacklist.run(
      wallet
    );

    return null;
  }

  return row;
}

function blacklist(
  wallet,
  reason,
  days
) {
  stmtPutBlacklist.run(
    wallet,
    reason,
    Date.now() +
      days *
        86400000
  );
}

function getMetaNumber(
  key,
  fallback = 0
) {
  const n =
    Number(
      stmtGetMeta.get(
        key
      )?.value
    );

  return Number.isFinite(n)
    ? n
    : fallback;
}

function setMetaNumber(
  key,
  value
) {
  stmtPutMeta.run(
    key,
    String(value)
  );
}

// ============================================================
// GMGN RATE-LIMIT PROTECTION
// ============================================================

let cliQueue =
  Promise.resolve();

let lastCliFinishedAt = 0;

let gmgnBlockedUntil =
  getMetaNumber(
    "gmgn_blocked_until",
    0
  );

if (
  gmgnBlockedUntil <=
  Date.now()
) {
  gmgnBlockedUntil = 0;

  setMetaNumber(
    "gmgn_blocked_until",
    0
  );
}

function parseRateLimitReset(
  message
) {
  const text =
    String(
      message || ""
    );

  const unix =
    text.match(
      /(?:x-ratelimit-reset|"?reset_at"?)\s*[:=]\s*"?(\d{10,13})/i
    );

  if (unix) {
    const n =
      Number(
        unix[1]
      );

    return n < 1e12
      ? n * 1000
      : n;
  }

  const exact =
    text.match(
      /Rate limit resets at (.+?)(?=\s+\(~?\d+s remaining\)|\.\s|$)/i
    );

  if (exact) {
    const t =
      Date.parse(
        exact[1]
          .trim()
      );

    if (
      Number.isFinite(t)
    ) {
      return t;
    }
  }

  const seconds =
    text.match(
      /~?(\d+)s remaining/i
    );

  return seconds
    ? Date.now() +
        Number(
          seconds[1]
        ) *
          1000
    : null;
}

function isRateLimitError(
  error
) {
  const text =
    error instanceof Error
      ? error.message
      : String(
          error || ""
        );

  return (
    /RATE_LIMIT_EXCEEDED|RATE_LIMIT_BANNED|IP rate limit exceeded|\b429\b|rate[ _-]?limit/i
      .test(text)
  );
}

async function waitForGap() {
  const wait =
    lastCliFinishedAt +
    MIN_GMGN_GAP_MS -
    Date.now();

  if (
    wait > 0
  ) {
    await sleep(
      wait
    );
  }
}

function rawCli(args) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      execFile(
        "gmgn-cli",
        args,

        {
          shell: false,
          windowsHide: true,

          maxBuffer:
            20 *
            1024 *
            1024,

          timeout:
            60000,

          env:
            process.env,
        },

        (
          err,
          stdout,
          stderr
        ) => {
          if (err) {
            const message =
              [
                stderr,
                stdout,
                err.message,
              ]
                .filter(Boolean)
                .map(String)
                .map(
                  (x) =>
                    x.trim()
                )
                .filter(Boolean)
                .join("\n");

            if (
              isRateLimitError(
                message
              )
            ) {
              const reset =
                parseRateLimitReset(
                  message
                );

              gmgnBlockedUntil =
                Math.max(
                  gmgnBlockedUntil,

                  (
                    reset ||
                    Date.now() +
                      5 *
                        60 *
                        1000
                  ) +
                    RATE_LIMIT_GRACE_MS
                );

              setMetaNumber(
                "gmgn_blocked_until",
                gmgnBlockedUntil
              );
            }

            const wrapped =
              new Error(
                message ||
                  "gmgn-cli failed"
              );

            wrapped.gmgnResetAt =
              gmgnBlockedUntil ||
              null;

            reject(
              wrapped
            );

            return;
          }

          if (
            stderr?.trim() &&
            process.env
              .GMGN_DEBUG ===
              "1"
          ) {
            console.warn(
              stderr.trim()
            );
          }

          try {
            resolve(
              JSON.parse(
                stdout
              )
            );

          } catch {
            reject(
              new Error(
                "Unparseable gmgn-cli output: " +
                String(
                  stdout
                ).slice(
                  0,
                  400
                )
              )
            );
          }
        }
      );
    }
  );
}

function cli(args) {
  for (
    const arg
    of args
  ) {
    if (
      typeof arg !==
        "string" ||
      /[;&|`$()<>"'\\\n]/
        .test(arg)
    ) {
      return Promise.reject(
        new Error(
          `Rejected unsafe CLI arg: ${arg}`
        )
      );
    }
  }

  const job =
    cliQueue.then(
      async () => {
        if (
          Date.now() <
          gmgnBlockedUntil
        ) {
          const seconds =
            Math.max(
              1,

              Math.ceil(
                (
                  gmgnBlockedUntil -
                  Date.now()
                ) /
                  1000
              )
            );

          const e =
            new Error(
              `GMGN cooldown active. Retry in about ${seconds}s.`
            );

          e.gmgnResetAt =
            gmgnBlockedUntil;

          throw e;
        }

        await waitForGap();

        try {
          return await rawCli(
            args
          );

        } finally {
          lastCliFinishedAt =
            Date.now();
        }
      }
    );

  cliQueue =
    job.catch(
      () => {}
    );

  return job;
}

// ============================================================
// GMGN DATA
// ============================================================

async function getTokenInfo(
  address
) {
  const r =
    await cli([
      "token",
      "info",

      "--chain",
      "sol",

      "--address",
      address,

      "--raw",
    ]);

  return (
    r?.data ??
    r ??
    {}
  );
}

async function getTopTraders(
  address
) {
  const r =
    await cli([
      "token",
      "traders",

      "--chain",
      "sol",

      "--address",
      address,

      "--order-by",
      "profit",

      "--direction",
      "desc",

      "--limit",
      String(
        TOP_TRADERS_LIMIT
      ),

      "--raw",
    ]);

  const p =
    r?.data ??
    r ??
    {};

  const list =
    Array.isArray(p)
      ? p
      : (
        p.list ||
        r?.list ||
        []
      );

  return Array.isArray(
    list
  )
    ? list
    : [];
}

// IMPORTANT:
// Wallet stats are now ONE wallet per GMGN request.
// No broken batch request.
// No individual fallback storm.
function unwrapSingleStats(
  response,
  wallet
) {
  const p =
    response?.data ??
    response;

  if (
    !p ||
    typeof p !==
      "object"
  ) {
    return null;
  }

  if (
    Array.isArray(p)
  ) {
    const row =
      p.find(
        (x) =>
          (
            x?.wallet_address ||
            x?.wallet ||
            x?.address
          ) === wallet
      ) ||
      p[0];

    return (
      row?.data &&
      typeof row.data ===
        "object"
        ? row.data
        : row ||
          null
    );
  }

  if (
    p[wallet] &&
    typeof p[wallet] ===
      "object"
  ) {
    return p[wallet];
  }

  if (
    Array.isArray(
      p.list
    )
  ) {
    const row =
      p.list.find(
        (x) =>
          (
            x?.wallet_address ||
            x?.wallet ||
            x?.address
          ) === wallet
      ) ||
      p.list[0];

    return (
      row?.data &&
      typeof row.data ===
        "object"
        ? row.data
        : row ||
          null
    );
  }

  if (
    p.wallet_address ||
    p.pnl_stat ||
    p.realized_profit !==
      undefined
  ) {
    return p;
  }

  return null;
}

async function getStatsOne(
  wallet,
  period
) {
  const cached =
    getWalletCache(
      wallet,
      period
    );

  if (cached) {
    return {
      data:
        cached,

      cached:
        true,
    };
  }

  const r =
    await cli([
      "portfolio",
      "stats",

      "--chain",
      "sol",

      "--period",
      period,

      "--wallet",
      wallet,

      "--raw",
    ]);

  const stats =
    unwrapSingleStats(
      r,
      wallet
    );

  if (!stats) {
    throw new Error(
      `${period} stats returned no usable data for ${wallet}`
    );
  }

  putWalletCache(
    wallet,
    period,
    stats
  );

  return {
    data:
      stats,

    cached:
      false,
  };
}

async function getActivityOne(
  wallet
) {
  const cached =
    getWalletCache(
      wallet,
      "activity"
    );

  if (cached) {
    return {
      data:
        cached,

      cached:
        true,
    };
  }

  const r =
    await cli([
      "portfolio",
      "activity",

      "--chain",
      "sol",

      "--wallet",
      wallet,

      "--limit",
      String(
        ACTIVITY_SAMPLE
      ),

      "--raw",
    ]);

  const p =
    r?.data ??
    r ??
    {};

  const activities =
    Array.isArray(p)
      ? p
      : (
        p.activities ||
        p.list ||
        []
      );

  const rows =
    Array.isArray(
      activities
    )
      ? activities
      : [];

  putWalletCache(
    wallet,
    "activity",
    rows
  );

  return {
    data:
      rows,

    cached:
      false,
  };
}

async function getDiscovery(
  address,
  progress
) {
  const cached =
    getDiscoveryCache(
      address
    );

  if (cached) {
    await progress?.(
      `⚡ ${short(address)} — using cached token/trader data...`
    );

    return cached;
  }

  await progress?.(
    `🔎 ${short(address)} — checking token info...`
  );

  const tokenInfo =
    await getTokenInfo(
      address
    );

  await progress?.(
    `🔎 ${short(address)} — finding top traders...`
  );

  const traders =
    await getTopTraders(
      address
    );

  putDiscoveryCache(
    address,
    tokenInfo,
    traders
  );

  return {
    tokenInfo,
    traders,
  };
}

// ============================================================
// NORMALISE WALLET STATS
// ============================================================

function parseStats(input) {
  const s =
    input ||
    {};

  const p =
    s.pnl_stat ||
    {};

  const buyCount =
    num(
      s.buy ??
      s.buy_count
    );

  const sellCount =
    num(
      s.sell ??
      s.sell_count
    );

  return {
    winrate:
      num(
        p.winrate ??
        s.winrate
      ),

    realizedProfit:
      num(
        s.realized_profit
      ),

    roi:
      num(
        s.realized_profit_pnl ??
        s.pnl ??
        p.pnl
      ),

    avgHoldSec:
      num(
        p.avg_holding_period ??
        s.avg_holding_period
      ),

    tokenNum:
      num(
        p.token_num ??
        s.token_num
      ),

    buyCount,

    sellCount,

    trades:
      buyCount +
      sellCount,

    createdTokenCount:
      num(
        s.common
          ?.created_token_count
      ),

    common:
      s.common ||
      {},

    dist: {
      gt5:
        num(
          p.pnl_gt_5x_num ??
          s.pnl_gt_5x_num
        ),

      x2to5:
        num(
          p.pnl_2x_5x_num ??
          s.pnl_2x_5x_num
        ),

      x0to2:
        num(
          p.pnl_0x_2x_num ??
          s.pnl_0x_2x_num
        ),

      n50to0:
        num(
          p.pnl_nd5_0x_num ??
          s.pnl_nd5_0x_num
        ),

      lt50:
        num(
          p.pnl_lt_nd5_num ??
          s.pnl_lt_nd5_num
        ),
    },
  };
}

function hasStats(s) {
  return (
    !!s &&
    (
      s.tokenNum > 0 ||
      s.trades > 0 ||
      s.realizedProfit !== 0
    )
  );
}

function severeLossRate(s) {
  return (
    s?.tokenNum > 0
      ? clamp(
          s.dist.lt50 /
            s.tokenNum,
          0,
          1
        )
      : 1
  );
}

function bigWinnerRate(s) {
  return (
    s?.tokenNum > 0
      ? clamp(
          (
            s.dist.gt5 +
            s.dist.x2to5
          ) /
            s.tokenNum,

          0,
          1
        )
      : 0
  );
}

function positiveBucketRate(s) {
  return (
    s?.tokenNum > 0
      ? clamp(
          (
            s.dist.gt5 +
            s.dist.x2to5 +
            s.dist.x0to2
          ) /
            s.tokenNum,

          0,
          1
        )
      : 0
  );
}

// ============================================================
// MULTI-TOKEN PERFORMANCE SCORE
// ============================================================

function trackScore(s) {
  if (
    !hasStats(s) ||
    s.tokenNum <= 0
  ) {
    return 0;
  }

  const win =
    clamp(
      (
        s.winrate -
        0.25
      ) /
        0.5,

      0,
      1
    );

  const positive =
    clamp(
      (
        positiveBucketRate(s) -
        0.35
      ) /
        0.55,

      0,
      1
    );

  const roi =
    clamp(
      (
        s.roi +
        0.1
      ) /
        1.1,

      0,
      1
    );

  const lossDiscipline =
    1 -
    severeLossRate(s);

  const bigWins =
    clamp(
      bigWinnerRate(s) /
        0.18,

      0,
      1
    );

  const avgProfitPerToken =
    s.realizedProfit /
    Math.max(
      1,
      s.tokenNum
    );

  const profitQuality =
    clamp(
      (
        Math.log10(
          Math.max(
            1,
            avgProfitPerToken
          )
        ) -
        1.5
      ) /
        2.2,

      0,
      1
    );

  const sample =
    clamp(
      (
        Math.log2(
          1 +
          s.tokenNum
        ) -
        2.5
      ) /
        4.5,

      0,
      1
    );

  return Math.round(
    100 *
    (
      0.23 *
        roi +

      0.22 *
        lossDiscipline +

      0.16 *
        positive +

      0.12 *
        win +

      0.11 *
        bigWins +

      0.10 *
        profitQuality +

      0.06 *
        sample
    )
  );
}

// ============================================================
// HOLDING / COPYABILITY
// ============================================================

function behaviorScore(
  s7,
  s30
) {
  const s =
    hasStats(s7)
      ? s7
      : s30;

  if (
    !hasStats(s)
  ) {
    return 45;
  }

  const days =
    s === s7
      ? 7
      : 30;

  const perDay =
    s.trades /
    days;

  const perToken =
    s.trades /
    Math.max(
      1,
      s.tokenNum
    );

  let score = 60;

  if (
    s.avgHoldSec > 0
  ) {
    if (
      s.avgHoldSec <
      5 * 60
    ) {
      score = 20;

    } else if (
      s.avgHoldSec <
      15 * 60
    ) {
      score = 38;

    } else if (
      s.avgHoldSec <
      60 * 60
    ) {
      score = 62;

    } else if (
      s.avgHoldSec <
      6 * 3600
    ) {
      score = 76;

    } else if (
      s.avgHoldSec <
      24 * 3600
    ) {
      score = 88;

    } else {
      score = 96;
    }
  }

  score -=
    clamp(
      (
        perDay -
        25
      ) /
        100,

      0,
      1
    ) *
    25;

  score -=
    clamp(
      (
        perToken -
        6
      ) /
        25,

      0,
      1
    ) *
    20;

  return Math.round(
    clamp(
      score,
      0,
      100
    )
  );
}

// ============================================================
// PERFORMANCE ON SUBMITTED CA
// ============================================================

function entryDelay(
  trader,
  tokenInfo
) {
  const first =
    num(
      trader
        ?.start_holding_at
    );

  const opened =
    num(
      tokenInfo
        ?.open_timestamp ||
      tokenInfo
        ?.creation_timestamp
    );

  if (
    !first ||
    !opened ||
    first < opened
  ) {
    return null;
  }

  return (
    first -
    opened
  );
}

function normalizeFraction(
  value
) {
  const n =
    num(value);

  if (
    n > 1 &&
    n <= 100
  ) {
    return n / 100;
  }

  return clamp(
    n,
    0,
    1
  );
}

function tokenPerformance(
  trader,
  tokenInfo
) {
  const realized =
    num(
      trader
        ?.realized_profit
    );

  const unrealized =
    num(
      trader
        ?.unrealized_profit
    );

  const totalProfit =
    num(
      trader?.profit,
      realized +
        unrealized
    );

  const profitChange =
    num(
      trader
        ?.profit_change,

      num(
        trader
          ?.realized_pnl
      )
    );

  const buyCount =
    num(
      trader
        ?.buy_tx_count_cur
    );

  const sellCount =
    num(
      trader
        ?.sell_tx_count_cur
    );

  const soldPct =
    normalizeFraction(
      trader
        ?.sell_amount_percentage
    );

  const avgCost =
    num(
      trader
        ?.avg_cost
    );

  const entryDelaySec =
    entryDelay(
      trader,
      tokenInfo
    );

  const roiQ =
    clamp(
      (
        profitChange +
        0.1
      ) /
        1.6,

      0,
      1
    );

  const profitQ =
    clamp(
      Math.log10(
        1 +
        Math.max(
          0,
          totalProfit
        )
      ) /
        Math.log10(
          50001
        ),

      0,
      1
    );

  const tx =
    buyCount +
    sellCount;

  const simplicityQ =
    clamp(
      1 -
        Math.max(
          0,
          tx -
            12
        ) /
          70,

      0,
      1
    );

  let timingQ = 0.45;

  if (
    entryDelaySec !==
    null
  ) {
    if (
      entryDelaySec <=
      5 * 60
    ) {
      timingQ = 1;

    } else if (
      entryDelaySec <=
      30 * 60
    ) {
      timingQ = 0.93;

    } else if (
      entryDelaySec <=
      2 * 3600
    ) {
      timingQ = 0.82;

    } else if (
      entryDelaySec <=
      6 * 3600
    ) {
      timingQ = 0.70;

    } else if (
      entryDelaySec <=
      24 * 3600
    ) {
      timingQ = 0.52;

    } else {
      timingQ = 0.35;
    }
  }

  const score =
    Math.round(
      100 *
      (
        0.40 *
          roiQ +

        0.25 *
          profitQ +

        0.25 *
          timingQ +

        0.10 *
          simplicityQ
      )
    );

  return {
    score,

    realized,

    unrealized,

    totalProfit,

    profitChange,

    buyCount,

    sellCount,

    soldPct,

    avgCost,

    entryDelaySec,
  };
}

// ============================================================
// RECENT ACTIVITY / EARLY-ENTRY ANALYSIS
// ============================================================

function activityType(row) {
  return String(
    row?.event_type ||
    row?.type ||
    ""
  ).toLowerCase();
}

function activityTokenAddress(
  row
) {
  return (
    row?.token?.address ||
    row?.token_address ||
    row?.address ||
    null
  );
}

function activityPrice(row) {
  return num(
    row?.price_usd ??
    row?.price
  );
}

function analyseActivity(rows) {
  const byToken =
    new Map();

  for (
    const row
    of rows || []
  ) {
    const type =
      activityType(
        row
      );

    if (
      type !== "buy" &&
      type !== "sell"
    ) {
      continue;
    }

    const token =
      activityTokenAddress(
        row
      );

    if (!token) {
      continue;
    }

    if (
      !byToken.has(
        token
      )
    ) {
      byToken.set(
        token,
        []
      );
    }

    byToken
      .get(token)
      .push(row);
  }

  const captures = [];
  const holds = [];

  let fastPairs = 0;

  for (
    const events
    of byToken.values()
  ) {
    events.sort(
      (a, b) =>
        num(
          a.timestamp
        ) -
        num(
          b.timestamp
        )
    );

    const firstBuy =
      events.find(
        (x) =>
          activityType(x) ===
            "buy" &&
          activityPrice(x) > 0
      );

    if (!firstBuy) {
      continue;
    }

    const buyTs =
      num(
        firstBuy.timestamp
      );

    const buyPrice =
      activityPrice(
        firstBuy
      );

    const sells =
      events.filter(
        (x) =>
          activityType(x) ===
            "sell" &&
          num(
            x.timestamp
          ) >= buyTs &&
          activityPrice(x) > 0
      );

    if (
      !sells.length
    ) {
      continue;
    }

    const firstSellTs =
      num(
        sells[0]
          .timestamp
      );

    const bestSellPrice =
      Math.max(
        ...sells.map(
          activityPrice
        )
      );

    if (
      buyPrice <= 0 ||
      bestSellPrice <= 0
    ) {
      continue;
    }

    // This is deliberately relative price behaviour,
    // not a fixed market-cap threshold.
    //
    // If the first observed buy was much cheaper
    // than later sells, that is evidence the wallet
    // got in before meaningful upside.
    captures.push(
      bestSellPrice /
      buyPrice
    );

    if (
      firstSellTs >
      buyTs
    ) {
      const hold =
        firstSellTs -
        buyTs;

      holds.push(
        hold
      );

      if (
        hold <=
        5 * 60
      ) {
        fastPairs += 1;
      }
    }
  }

  const pairedTokens =
    captures.length;

  const upside15Rate =
    pairedTokens
      ? captures.filter(
          (x) =>
            x >= 1.5
        ).length /
        pairedTokens
      : 0;

  const upside2xRate =
    pairedTokens
      ? captures.filter(
          (x) =>
            x >= 2
        ).length /
        pairedTokens
      : 0;

  const lossRate =
    pairedTokens
      ? captures.filter(
          (x) =>
            x < 0.8
        ).length /
        pairedTokens
      : 0;

  const fastFlipRate =
    holds.length
      ? fastPairs /
        holds.length
      : 0;

  const medianHoldSec =
    median(
      holds
    );

  const medianCapture =
    median(
      captures
    );

  let score = 35;

  if (
    pairedTokens
  ) {
    const sampleQ =
      clamp(
        pairedTokens /
          8,

        0,
        1
      );

    const holdQ =
      medianHoldSec ===
      null
        ? 0.5

        : medianHoldSec <
          5 * 60
          ? 0.15

          : medianHoldSec <
            30 * 60
            ? 0.45

            : medianHoldSec <
              6 * 3600
              ? 0.75

              : 1;

    score =
      Math.round(
        100 *
        (
          0.38 *
            upside15Rate +

          0.18 *
            upside2xRate +

          0.20 *
            (
              1 -
              lossRate
            ) +

          0.12 *
            (
              1 -
              fastFlipRate
            ) +

          0.07 *
            holdQ +

          0.05 *
            sampleQ
        )
      );
  }

  return {
    score,

    pairedTokens,

    upside15Rate,

    upside2xRate,

    lossRate,

    fastFlipRate,

    medianHoldSec,

    medianCapture,
  };
}

// ============================================================
// HARD FILTERING
// ============================================================

function traderExclusion(
  trader,
  creatorAddress
) {
  const wallet =
    trader?.address;

  if (
    !wallet ||
    !SOL_ADDR.test(
      wallet
    )
  ) {
    return "invalid wallet";
  }

  if (
    wallet ===
    creatorAddress
  ) {
    return "token creator";
  }

  if (
    Number(
      trader.addr_type
    ) === 2
  ) {
    return (
      "exchange/liquidity pool"
    );
  }

  if (
    boolish(
      trader
        .is_suspicious
    )
  ) {
    return (
      "GMGN suspicious"
    );
  }

  const badTag =
    tagsOf(
      trader
    ).find(
      (tag) =>
        HARD_TAGS.has(
          tag
        )
    );

  if (badTag) {
    return `tag:${badTag}`;
  }

  const tx =
    num(
      trader
        .buy_tx_count_cur
    ) +
    num(
      trader
        .sell_tx_count_cur
    );

  if (
    tx >
    HARD_MAX_THIS_TOKEN_TX
  ) {
    return (
      "extreme token transaction count"
    );
  }

  if (
    boolish(
      trader.transfer_in
    ) &&
    num(
      trader
        .buy_tx_count_cur
    ) === 0 &&
    num(
      trader
        .buy_volume_cur
    ) <= 0
  ) {
    return "transfer-only";
  }

  return null;
}

function statsExclusion(
  s,
  rawStats
) {
  if (
    !hasStats(s)
  ) {
    return "no stats";
  }

  const badTag =
    tagsOf(
      rawStats
    ).find(
      (tag) =>
        HARD_TAGS.has(
          tag
        )
    );

  if (badTag) {
    return `tag:${badTag}`;
  }

  const perDay =
    s.trades /
    30;

  const perToken =
    s.trades /
    Math.max(
      1,
      s.tokenNum
    );

  if (
    perDay >
    HARD_MAX_TRADES_PER_DAY
  ) {
    return (
      "bot-like trades/day"
    );
  }

  if (
    perToken >
    HARD_MAX_TRADES_PER_TOKEN
  ) {
    return (
      "bot-like trades/token"
    );
  }

  if (
    s.createdTokenCount >
    0.6 *
    Math.max(
      1,
      s.tokenNum
    )
  ) {
    return (
      "mostly token creator"
    );
  }

  return null;
}

// ============================================================
// CANDIDATE SELECTION
// ============================================================

function candidatePriority(
  trader,
  tokenInfo,
  tokenAddress
) {
  const token =
    tokenPerformance(
      trader,
      tokenInfo
    );

  const seen =
    previousSentCount(
      trader.address,
      tokenAddress
    );

  const tags =
    tagsOf(
      trader
    );

  const smart =
    tags.includes(
      "smart_degen"
    ) ||
    tags.includes(
      "renowned"
    ) ||
    tags.includes(
      "kol"
    );

  return {
    trader,

    token,

    previousSeen:
      seen,

    priority:
      token.score *
        0.65 +

      Math.log10(
        1 +
        Math.max(
          0,
          token.totalProfit
        )
      ) *
        5 +

      Math.min(
        5,
        seen
      ) *
        3 +

      (
        smart
          ? 8
          : 0
      ),
  };
}

function chooseCandidates(
  traders,
  tokenInfo,
  tokenAddress
) {
  const creator =
    tokenInfo
      ?.dev
      ?.creator_address ||
    null;

  const out = [];

  for (
    const trader
    of traders
  ) {
    const reason =
      traderExclusion(
        trader,
        creator
      );

    const wallet =
      trader?.address;

    if (reason) {
      if (
        wallet &&
        SOL_ADDR.test(
          wallet
        )
      ) {
        if (
          reason ===
          "exchange/liquidity pool"
        ) {
          blacklist(
            wallet,
            reason,
            180
          );

        } else if (
          /dex_bot|rat_trader|bundler|arbitrager|mev_bot/
            .test(reason)
        ) {
          blacklist(
            wallet,
            reason,
            30
          );
        }
      }

      continue;
    }

    if (
      getBlacklist(
        wallet
      )
    ) {
      continue;
    }

    const candidate =
      candidatePriority(
        trader,
        tokenInfo,
        tokenAddress
      );

    // Submitted-token performance matters.
    // We don't waste a 30d request researching
    // an actual loser on the discovery token.
    if (
      candidate
        .token
        .totalProfit <=
        0 &&
      candidate
        .token
        .profitChange <=
        0
    ) {
      continue;
    }

    out.push(
      candidate
    );
  }

  out.sort(
    (a, b) =>
      b.priority -
      a.priority
  );

  return out.slice(
    0,
    MAX_CANDIDATES
  );
}

// ============================================================
// QUALIFICATION STAGES
// ============================================================

function passes30d(row) {
  const s =
    row.s30;

  if (
    !hasStats(s)
  ) {
    return false;
  }

  if (
    s.tokenNum <
    MIN_30D_TOKENS
  ) {
    return false;
  }

  if (
    s.realizedProfit <=
      0 ||
    s.roi <= 0
  ) {
    return false;
  }

  if (
    row.track30 <
    MIN_30D_TRACK_SCORE
  ) {
    return false;
  }

  if (
    severeLossRate(s) >
    0.34
  ) {
    return false;
  }

  // Low win rate can still survive if the
  // wallet regularly catches large winners.
  if (
    s.winrate <
      0.28 &&
    bigWinnerRate(s) <
      0.10
  ) {
    return false;
  }

  return true;
}

function passes7d(row) {
  const s =
    row.s7;

  if (
    !hasStats(s)
  ) {
    return false;
  }

  if (
    s.tokenNum < 3
  ) {
    // Very small recent sample:
    // only survive with exceptional 30d history.
    return (
      row.track30 >=
      70
    );
  }

  if (
    row.track7 <
    MIN_7D_TRACK_SCORE
  ) {
    return false;
  }

  if (
    s.roi <
      -0.15 &&
    s.realizedProfit <
      0
  ) {
    return false;
  }

  if (
    severeLossRate(s) >
    0.40
  ) {
    return false;
  }

  return true;
}

function preActivityScore(row) {
  const history =
    row.history;

  const historyBonus =
    history.observations >= 2
      ? clamp(
          (
            history
              .avgTokenScore -
            55
          ) /
            20,

          0,
          1
        ) *
        4

      : 0;

  const seenBonus =
    Math.min(
      4,
      row.previousSeen *
        1.2
    );

  return Math.round(
    clamp(
      0.50 *
        row.track30 +

      0.23 *
        row.track7 +

      0.20 *
        row.token.score +

      0.07 *
        row.behavior +

      historyBonus +
      seenBonus,

      0,
      100
    )
  );
}

function finalScore(row) {
  const history =
    row.history;

  const historyBonus =
    history.observations >= 2
      ? clamp(
          (
            history
              .avgTokenScore -
            55
          ) /
            25,

          0,
          1
        ) *
        4

      : 0;

  const repeatBonus =
    Math.min(
      5,
      row.previousSeen *
        1.25
    );

  return Math.round(
    clamp(
      0.38 *
        row.track30 +

      0.20 *
        row.track7 +

      0.18 *
        row.token.score +

      0.17 *
        row.activity.score +

      0.07 *
        row.behavior +

      historyBonus +
      repeatBonus,

      0,
      100
    )
  );
}

// The wallet must show some actual evidence
// of getting in before meaningful upside.
function hasEarlyEvidence(row) {
  // Recent activity across multiple tokens.
  if (
    row.activity
      .pairedTokens >=
      3 &&
    row.activity
      .upside15Rate >=
      0.35
  ) {
    return true;
  }

  // Our own growing cross-CA history.
  if (
    row.history
      .earlyResults >=
      2 &&
    row.history
      .goodResults >=
      2
  ) {
    return true;
  }

  // Smaller activity sample, but also got
  // into this submitted token early.
  if (
    row.activity
      .pairedTokens >=
      2 &&

    row.activity
      .upside15Rate >=
      0.50 &&

    row.token
      .entryDelaySec !==
      null &&

    row.token
      .entryDelaySec <=
      6 * 3600
  ) {
    return true;
  }

  return false;
}

function qualifiesFinal(row) {
  if (
    row.overall <
    MIN_FINAL_SCORE
  ) {
    return false;
  }

  if (
    row.track30 <
    MIN_30D_TRACK_SCORE
  ) {
    return false;
  }

  if (
    row.s30.tokenNum <
    MIN_30D_TOKENS
  ) {
    return false;
  }

  // 8-14 tokens can qualify,
  // but only with unusually strong evidence.
  if (
    row.s30.tokenNum <
      PREFERRED_30D_TOKENS &&
    row.overall <
      72
  ) {
    return false;
  }

  if (
    !passes7d(row)
  ) {
    return false;
  }

  if (
    row.activity
      .pairedTokens >=
      2 &&
    row.activity
      .fastFlipRate >
      0.45
  ) {
    return false;
  }

  if (
    row.activity
      .pairedTokens >=
      3 &&
    row.activity.score <
      48
  ) {
    return false;
  }

  if (
    !hasEarlyEvidence(
      row
    )
  ) {
    return false;
  }

  return true;
}

// ============================================================
// PROFILE LABELS
// ============================================================

function labelsFor(row) {
  const labels = [];

  if (
    row.previousSeen >
    0
  ) {
    labels.push(
      `♻️ SEEN ${row.previousSeen}x`
    );
  }

  if (
    row.s30.tokenNum <
    PREFERRED_30D_TOKENS
  ) {
    labels.push(
      "🆕 LOW SAMPLE"
    );
  }

  const s =
    hasStats(
      row.s7
    )
      ? row.s7
      : row.s30;

  const days =
    s === row.s7
      ? 7
      : 30;

  const perDay =
    s.trades /
    days;

  const perToken =
    s.trades /
    Math.max(
      1,
      s.tokenNum
    );

  if (
    s.avgHoldSec > 0 &&
    s.avgHoldSec <
      FAST_AVG_HOLD_SEC
  ) {
    labels.push(
      "⚡ FAST"
    );
  }

  if (
    perDay >
      HIGH_ACTIVITY_TRADES_PER_DAY ||
    perToken >
      HIGH_ACTIVITY_TRADES_PER_TOKEN
  ) {
    labels.push(
      "⚠️ HIGH ACTIVITY"
    );
  }

  if (
    row.track30 >=
      65 &&
    severeLossRate(
      row.s30
    ) <=
      0.15
  ) {
    labels.push(
      "CONSISTENT"
    );
  }

  if (
    s.avgHoldSec >=
    6 * 3600
  ) {
    labels.push(
      "LONGER HOLDER"
    );
  }

  if (
    hasEarlyEvidence(
      row
    )
  ) {
    labels.push(
      "EARLY FINDER"
    );
  }

  return labels;
}

// ============================================================
// MAIN QUALITY-FIRST FUNNEL
// ============================================================

async function scan(
  address,
  progress
) {
  const {
    tokenInfo,
    traders,
  } =
    await getDiscovery(
      address,
      progress
    );

  if (
    !traders.length
  ) {
    return {
      tokenInfo,

      wallets: [],

      note:
        "GMGN returned no top traders for this token.",
    };
  }

  const candidates =
    chooseCandidates(
      traders,
      tokenInfo,
      address
    );

  if (
    !candidates.length
  ) {
    return {
      tokenInfo,

      wallets: [],

      note:
        "No suitable trader candidates remained after the bot/dev/junk filter.",
    };
  }

  // Store submitted-token observations.
  // This costs zero extra API requests.
  for (
    const candidate
    of candidates
  ) {
    saveObservation(
      candidate
        .trader
        .address,

      address,

      candidate.token
    );
  }

  // ==========================================================
  // STAGE 1 — 30D
  // ==========================================================

  await progress?.(
    `📊 ${short(address)} — 30d consistency checks: 0/${candidates.length}...`
  );

  const thirtyDaySurvivors = [];

  let done30 = 0;

  for (
    const candidate
    of candidates
  ) {
    const wallet =
      candidate
        .trader
        .address;

    try {
      const {
        data,
        cached,
      } =
        await getStatsOne(
          wallet,
          "30d"
        );

      const s30 =
        parseStats(
          data
        );

      const exclusion =
        statsExclusion(
          s30,
          data
        );

      if (exclusion) {
        if (
          /arbitrager|dex_bot|rat_trader|bundler|mev_bot|bot-like/
            .test(
              exclusion
            )
        ) {
          blacklist(
            wallet,
            exclusion,
            14
          );
        }

      } else {
        const row = {
          ...candidate,

          wallet,

          raw30:
            data,

          s30,

          track30:
            trackScore(
              s30
            ),

          history:
            observationSummary(
              wallet,
              address
            ),
        };

        if (
          passes30d(
            row
          )
        ) {
          thirtyDaySurvivors.push(
            row
          );
        }
      }

      done30 += 1;

      await progress?.(
        `📊 ${short(address)} — 30d consistency ${done30}/${candidates.length} • ${thirtyDaySurvivors.length} survived${cached ? " • cache" : ""}`
      );

    } catch (error) {
      if (
        isRateLimitError(
          error
        )
      ) {
        throw error;
      }

      done30 += 1;

      console.warn(
        `30d failed for ${wallet}:`,
        error.message ||
          error
      );

      await progress?.(
        `📊 ${short(address)} — 30d consistency ${done30}/${candidates.length} • ${thirtyDaySurvivors.length} survived`
      );
    }
  }

  if (
    !thirtyDaySurvivors.length
  ) {
    return {
      tokenInfo,

      wallets: [],

      note:
        "0 wallets met the 30d consistency criteria.",
    };
  }

  // Consistency comes first.
  thirtyDaySurvivors.sort(
    (a, b) =>
      b.track30 -
        a.track30 ||
      b.token.score -
        a.token.score
  );

  // Only the strongest 30d wallets cost us a 7d request.
  const recentCandidates =
    thirtyDaySurvivors.slice(
      0,
      MAX_7D_CHECKS
    );

  // ==========================================================
  // STAGE 2 — 7D
  // ==========================================================

  await progress?.(
    `📈 ${short(address)} — recent-form checks: 0/${recentCandidates.length}...`
  );

  const recentSurvivors = [];

  let done7 = 0;

  for (
    const row
    of recentCandidates
  ) {
    try {
      const {
        data,
        cached,
      } =
        await getStatsOne(
          row.wallet,
          "7d"
        );

      row.raw7 =
        data;

      row.s7 =
        parseStats(
          data
        );

      row.track7 =
        trackScore(
          row.s7
        );

      row.behavior =
        behaviorScore(
          row.s7,
          row.s30
        );

      row.preScore =
        preActivityScore(
          row
        );

      if (
        passes7d(
          row
        )
      ) {
        recentSurvivors.push(
          row
        );
      }

      done7 += 1;

      await progress?.(
        `📈 ${short(address)} — 7d form ${done7}/${recentCandidates.length} • ${recentSurvivors.length} survived${cached ? " • cache" : ""}`
      );

    } catch (error) {
      if (
        isRateLimitError(
          error
        )
      ) {
        throw error;
      }

      done7 += 1;

      console.warn(
        `7d failed for ${row.wallet}:`,
        error.message ||
          error
      );

      await progress?.(
        `📈 ${short(address)} — 7d form ${done7}/${recentCandidates.length} • ${recentSurvivors.length} survived`
      );
    }
  }

  if (
    !recentSurvivors.length
  ) {
    return {
      tokenInfo,

      wallets: [],

      note:
        "0 wallets met both the 30d consistency and recent-form criteria.",
    };
  }

  recentSurvivors.sort(
    (a, b) =>
      b.preScore -
      a.preScore
  );

  // Only these wallets get an activity request.
  const deepCandidates =
    recentSurvivors.slice(
      0,
      MAX_ACTIVITY_CHECKS
    );

  // ==========================================================
  // STAGE 3 — EARLY-ENTRY / ACTIVITY
  // ==========================================================

  await progress?.(
    `🧭 ${short(address)} — early-entry checks: 0/${deepCandidates.length}...`
  );

  const finalists = [];

  let doneActivity = 0;

  for (
    const row
    of deepCandidates
  ) {
    try {
      const {
        data,
        cached,
      } =
        await getActivityOne(
          row.wallet
        );

      row.activity =
        analyseActivity(
          data
        );

      row.overall =
        finalScore(
          row
        );

      row.labels =
        labelsFor(
          row
        );

      if (
        qualifiesFinal(
          row
        )
      ) {
        finalists.push(
          row
        );
      }

      doneActivity += 1;

      await progress?.(
        `🧭 ${short(address)} — early-entry ${doneActivity}/${deepCandidates.length} • ${finalists.length} qualified${cached ? " • cache" : ""}`
      );

    } catch (error) {
      if (
        isRateLimitError(
          error
        )
      ) {
        throw error;
      }

      doneActivity += 1;

      console.warn(
        `Activity failed for ${row.wallet}:`,
        error.message ||
          error
      );

      await progress?.(
        `🧭 ${short(address)} — early-entry ${doneActivity}/${deepCandidates.length} • ${finalists.length} qualified`
      );
    }
  }

  finalists.sort(
    (a, b) =>
      b.overall -
      a.overall
  );

  return {
    tokenInfo,

    wallets:
      finalists,

    note:
      finalists.length
        ? null
        : "0 wallets met the full consistency + early-entry criteria.",
  };
}

// ============================================================
// DISCORD FORMATTING
// ============================================================

function fmtUsd(value) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {
    return "N/A";
  }

  const sign =
    n > 0
      ? "+"
      : n < 0
        ? "-"
        : "";

  const a =
    Math.abs(n);

  if (
    a >= 1e6
  ) {
    return (
      `${sign}$` +
      `${(
        a / 1e6
      ).toFixed(1)}M`
    );
  }

  if (
    a >= 1e3
  ) {
    return (
      `${sign}$` +
      `${(
        a / 1e3
      ).toFixed(1)}K`
    );
  }

  return (
    `${sign}$` +
    `${a.toFixed(0)}`
  );
}

function fmtPct(
  value,
  signed = false
) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {
    return "N/A";
  }

  const p =
    n * 100;

  return (
    `${
      signed &&
      p > 0
        ? "+"
        : ""
    }${p.toFixed(0)}%`
  );
}

function fmtHold(seconds) {
  const n =
    Number(seconds);

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    return "N/A";
  }

  if (
    n < 60
  ) {
    return (
      `${Math.round(n)}s`
    );
  }

  if (
    n < 3600
  ) {
    return (
      `${Math.round(
        n / 60
      )}m`
    );
  }

  if (
    n < 86400
  ) {
    return (
      `${(
        n / 3600
      ).toFixed(1)}h`
    );
  }

  return (
    `${(
      n / 86400
    ).toFixed(1)}d`
  );
}

function positionStatus(
  token
) {
  if (
    token.soldPct >=
    0.95
  ) {
    return "exited";
  }

  if (
    token.soldPct > 0
  ) {
    return (
      `holding ${
        Math.round(
          (
            1 -
            token.soldPct
          ) *
          100
        )
      }%`
    );
  }

  return (
    token.buyCount > 0
      ? "holding"
      : "position unclear"
  );
}

function walletField(
  row,
  rank
) {
  const flags =
    row.labels.filter(
      (x) =>
        /^[♻️🆕⚡⚠️]/u
          .test(x)
    );

  const profile =
    row.labels.filter(
      (x) =>
        !/^[♻️🆕⚡⚠️]/u
          .test(x)
    );

  const activity =
    row.activity;

  const thisToken = [
    `${fmtUsd(
      row.token.realized
    )} realized`,

    `${fmtUsd(
      row.token.unrealized
    )} unrealized`,

    `${fmtPct(
      row.token.profitChange,
      true
    )} ROI`,

    `${row.token.buyCount}B/${row.token.sellCount}S`,

    positionStatus(
      row.token
    ),
  ];

  if (
    row.token
      .entryDelaySec !==
    null
  ) {
    thisToken.push(
      `${fmtHold(
        row.token
          .entryDelaySec
      )} after launch`
    );
  }

  const earlyLine =
    activity.pairedTokens
      ? (
          `${fmtPct(
            activity
              .upside15Rate
          )} caught 1.5x+ upside` +

          ` | ${activity.pairedTokens} sampled tokens` +

          ` | median hold ${fmtHold(
            activity
              .medianHoldSec
          )}`
        )

      : "limited recent buy/sell pairs";

  return {
    name:
      (
        `${rank}. ${short(
          row.wallet
        )} [${row.overall}/100]` +

        (
          flags.length
            ? ` • ${flags.join(" • ")}`
            : ""
        )
      ).slice(
        0,
        256
      ),

    value:
      [
        `\`${row.wallet}\``,

        `**This token:** ${thisToken.join(" | ")}`,

        (
          `**30d:** ${fmtPct(
            row.s30.winrate
          )} WR` +

          ` | ${fmtPct(
            row.s30.roi,
            true
          )} (${fmtUsd(
            row.s30
              .realizedProfit
          )})` +

          ` | ${row.s30.tokenNum} tokens` +

          ` | avg hold ${fmtHold(
            row.s30
              .avgHoldSec
          )}`
        ),

        (
          `**7d:** ${fmtPct(
            row.s7.winrate
          )} WR` +

          ` | ${fmtPct(
            row.s7.roi,
            true
          )} (${fmtUsd(
            row.s7
              .realizedProfit
          )})` +

          ` | ${row.s7.tokenNum} tokens`
        ),

        `**Early behavior:** ${earlyLine}`,

        (
          `**Profile:** ${
            profile.length
              ? profile.join(
                  " • "
                )
              : "STRONG MULTI-TOKEN HISTORY"
          }`
        ),
      ]
        .join("\n")
        .slice(
          0,
          1024
        ),
  };
}

function buildEmbeds(
  address,
  result
) {
  const symbol =
    result
      .tokenInfo
      ?.symbol
      ? String(
          result
            .tokenInfo
            .symbol
        )
      : null;

  const tokenLabel =
    symbol
      ? `${symbol} • ${short(address)} (SOL)`
      : `${short(address)} (SOL)`;

  if (
    !result.wallets.length
  ) {
    return [
      new EmbedBuilder()

        .setTitle(
          "🎯 Top wallets to track"
        )

        .setDescription(
          `Token: \`${tokenLabel}\`\n\n` +
          `${
            result.note ||
            "0 wallets met the criteria."
          }`
        )

        .setColor(
          0x00c853
        ),
    ];
  }

  const embeds = [];

  for (
    let i = 0;
    i <
    result.wallets.length;
    i += 5
  ) {
    const page =
      result.wallets.slice(
        i,
        i + 5
      );

    const embed =
      new EmbedBuilder()

        .setTitle(
          result.wallets.length >
            5
            ? (
                "🎯 Top wallets to track — " +
                `${Math.floor(i / 5) + 1}/` +
                `${Math.ceil(result.wallets.length / 5)}`
              )
            : "🎯 Top wallets to track"
        )

        .setDescription(
          `Token: \`${tokenLabel}\`\n` +

          `${result.wallets.length} wallet${
            result.wallets.length === 1
              ? ""
              : "s"
          } met the full tracking criteria.`
        )

        .setColor(
          0x00c853
        );

    page.forEach(
      (
        row,
        j
      ) => {
        embed.addFields(
          walletField(
            row,
            i + j + 1
          )
        );
      }
    );

    embeds.push(
      embed
    );
  }

  return embeds;
}

async function sendResult(
  status,
  sourceMessage,
  address,
  result
) {
  const embeds =
    buildEmbeds(
      address,
      result
    );

  await status.edit({
    content:
      "",

    embeds: [
      embeds[0],
    ],
  });

  for (
    let i = 1;
    i <
    embeds.length;
    i++
  ) {
    await sourceMessage.reply({
      embeds: [
        embeds[i],
      ],
    });
  }

  // SEEN only counts wallets that were
  // actually shown in Discord.
  for (
    const row
    of result.wallets
  ) {
    markSent(
      row.wallet,
      address,
      row.overall
    );
  }
}

// ============================================================
// DISCORD
// ============================================================

const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,

      GatewayIntentBits.GuildMessages,

      GatewayIntentBits.MessageContent,
    ],
  });

const resultCache =
  new Map();

const queuedAddresses =
  new Set();

let scanQueue =
  Promise.resolve();

function getResultCache(
  address
) {
  const row =
    resultCache.get(
      address
    );

  if (
    !row ||
    Date.now() -
      row.at >
      CACHE_RESULT_MS
  ) {
    resultCache.delete(
      address
    );

    return null;
  }

  return row.result;
}

function putResultCache(
  address,
  result
) {
  resultCache.set(
    address,
    {
      at:
        Date.now(),

      result,
    }
  );

  if (
    resultCache.size >
    100
  ) {
    resultCache.delete(
      resultCache
        .keys()
        .next()
        .value
    );
  }
}

function enqueueScan(fn) {
  const job =
    scanQueue.then(fn);

  scanQueue =
    job.catch(
      () => {}
    );

  return job;
}

function makeProgress(
  status
) {
  let last = "";

  return async (
    text
  ) => {
    if (
      !text ||
      text === last
    ) {
      return;
    }

    last = text;

    await status
      .edit({
        content:
          text,

        embeds: [],
      })
      .catch(
        () => {}
      );
  };
}

client.once(
  "clientReady",

  () => {
    console.log(
      `Logged in as ${client.user.tag}`
    );

    console.log(
      `Wallet DB: ${DB_PATH}`
    );

    console.log(
      `Listening in channel: ${DISCORD_CHANNEL_ID}`
    );

    console.log(
      `MAX_CANDIDATES=${MAX_CANDIDATES}, ` +
      `MAX_7D_CHECKS=${MAX_7D_CHECKS}, ` +
      `MAX_ACTIVITY_CHECKS=${MAX_ACTIVITY_CHECKS}`
    );

    console.log(
      `GMGN minimum request gap: ${MIN_GMGN_GAP_MS}ms`
    );

    if (
      gmgnBlockedUntil >
      Date.now()
    ) {
      console.log(
        "Stored GMGN cooldown until " +
        new Date(
          gmgnBlockedUntil
        ).toISOString()
      );
    }
  }
);

client.on(
  "messageCreate",

  async (message) => {
    if (
      message.author.bot
    ) {
      return;
    }

    if (
      !DISCORD_CHANNEL_ID ||
      message.channelId !==
        DISCORD_CHANNEL_ID
    ) {
      return;
    }

    const address =
      findSolAddress(
        message.content
      );

    if (!address) {
      return;
    }

    const cached =
      getResultCache(
        address
      );

    if (cached) {
      const embeds =
        buildEmbeds(
          address,
          cached
        );

      await message.reply({
        content:
          "⚡ Recently scanned CA — cached result, no new GMGN requests.",

        embeds: [
          embeds[0],
        ],
      });

      for (
        let i = 1;
        i <
        embeds.length;
        i++
      ) {
        await message.reply({
          embeds: [
            embeds[i],
          ],
        });
      }

      return;
    }

    if (
      queuedAddresses.has(
        address
      )
    ) {
      await message.reply(
        "⏳ That CA is already queued/scanning."
      );

      return;
    }

    queuedAddresses.add(
      address
    );

    const status =
      await message.reply(
        `🔎 Detected \`${short(address)}\`. Starting quality-first wallet scan...`
      );

    enqueueScan(
      async () => {
        try {
          const progress =
            makeProgress(
              status
            );

          const result =
            await scan(
              address,
              progress
            );

          putResultCache(
            address,
            result
          );

          await sendResult(
            status,
            message,
            address,
            result
          );

        } catch (error) {
          console.error(
            error
          );

          const raw =
            error instanceof Error
              ? error.message
              : String(
                  error
                );

          let text =
            raw;

          if (
            isRateLimitError(
              error
            ) ||
            /cooldown active/i
              .test(raw)
          ) {
            const resetAt =
              error
                ?.gmgnResetAt ||

              gmgnBlockedUntil ||

              parseRateLimitReset(
                raw
              );

            const seconds =
              resetAt
                ? Math.max(
                    1,

                    Math.ceil(
                      (
                        resetAt -
                        Date.now()
                      ) /
                        1000
                    )
                  )

                : null;

            text =
              "GMGN rate-limited the scan. " +
              "I stopped immediately; successful wallet checks are cached." +

              (
                seconds
                  ? ` Retry this CA in about ${seconds}s.`
                  : " Retry after the cooldown clears."
              );
          }

          await status
            .edit({
              content:
                `⚠️ Scan failed: ${text.slice(
                  0,
                  700
                )}`,

              embeds: [],
            })
            .catch(
              () => {}
            );

        } finally {
          queuedAddresses.delete(
            address
          );
        }
      }
    );
  }
);

// ============================================================
// STARTUP
// ============================================================

function requireEnv(name) {
  const value =
    String(
      process.env[name] ||
      ""
    ).trim();

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}`
    );
  }

  return value;
}

(async () => {
  try {
    requireEnv(
      "GMGN_API_KEY"
    );

    requireEnv(
      "DISCORD_BOT_TOKEN"
    );

    requireEnv(
      "DISCORD_CHANNEL_ID"
    );

    // Don't let gmgn-cli retry a 429
    // behind our own rate limiter.
    if (
      process.env
        .GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS ===
      undefined
    ) {
      process.env
        .GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS =
        "0";
    }

    await client.login(
      process.env
        .DISCORD_BOT_TOKEN
    );

    await client
      .application
      ?.commands
      ?.set([])
      .catch(
        () => {}
      );

  } catch (error) {
    console.error(
      `Startup failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );

    process.exitCode =
      1;
  }
})();
