require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const Database = require("better-sqlite3");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// ========================= CONFIG =========================

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_ADDR_IN_TEXT = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

const DISCORD_CHANNEL_ID = String(
  process.env.DISCORD_CHANNEL_ID || ""
).trim();

const DB_PATH = String(
  process.env.DB_PATH ||
    path.join(process.cwd(), "data", "wallets.db")
).trim();

const TOP_TRADERS_LIMIT = 100;

const MAX_CANDIDATES = Math.max(
  10,
  Math.min(
    50,
    Number(process.env.MAX_CANDIDATES || 30)
  )
);

const STATS_BATCH_SIZE = 10;

const CACHE_7D_MS = 3 * 60 * 60 * 1000;
const CACHE_30D_MS = 12 * 60 * 60 * 1000;
const DISCOVERY_CACHE_MS = 15 * 60 * 1000;
const RESULT_CACHE_MS = 15 * 60 * 1000;

// Slow on purpose.
// 8 completely uncached GMGN calls = roughly 70-100 sec.
const MIN_GMGN_GAP_MS = Math.max(
  5000,
  Number(
    process.env.GMGN_MIN_REQUEST_GAP_MS || 10000
  )
);

// Secondary protection.
// The fixed 10-second gap above is the main limiter.
const RATE_UNITS_PER_SEC = Math.max(
  0.25,
  Number(
    process.env.GMGN_RATE_UNITS_PER_SEC || 1
  )
);

const RATE_CAPACITY = Math.max(
  5,
  Number(
    process.env.GMGN_RATE_CAPACITY || 5
  )
);

const RATE_LIMIT_GRACE_MS = 5000;

const MIN_30D_TOKENS = 5;
const LOW_SAMPLE_30D_TOKENS = 15;
const MIN_30D_TRACK_SCORE = 38;
const MIN_OVERALL_SCORE = 48;

const HARD_MAX_TRADES_PER_DAY = 250;
const HARD_MAX_TRADES_PER_TOKEN = 40;

const HIGH_ACTIVITY_TRADES_PER_DAY = 80;
const HIGH_ACTIVITY_TRADES_PER_TOKEN = 15;

const FAST_AVG_HOLD_SEC = 15 * 60;
const HARD_MAX_THIS_TOKEN_TX = 80;

const EXCLUDE_TAGS = new Set([
  "rat_trader",
  "bundler",
  "dex_bot",
  "dev",
]);

const sleep = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

// ========================= DATABASE =========================

fs.mkdirSync(
  path.dirname(DB_PATH),
  { recursive: true }
);

const db =
  new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_cache (
    wallet_address TEXT NOT NULL,
    period TEXT NOT NULL,
    stats_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (wallet_address, period)
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
    buy_count INTEGER,
    sell_count INTEGER,
    PRIMARY KEY (wallet_address, token_address)
  );

  CREATE TABLE IF NOT EXISTS sent_results (
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    overall_score REAL,
    PRIMARY KEY (wallet_address, token_address)
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

const qCache =
  db.prepare(`
    SELECT stats_json, updated_at
    FROM wallet_cache
    WHERE wallet_address = ?
      AND period = ?
  `);

const qPutCache =
  db.prepare(`
    INSERT INTO wallet_cache(
      wallet_address,
      period,
      stats_json,
      updated_at
    )
    VALUES (?, ?, ?, ?)

    ON CONFLICT(wallet_address, period)
    DO UPDATE SET
      stats_json = excluded.stats_json,
      updated_at = excluded.updated_at
  `);

const qTokenCache =
  db.prepare(`
    SELECT
      token_info_json,
      traders_json,
      updated_at
    FROM token_cache
    WHERE token_address = ?
  `);

const qPutTokenCache =
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
      token_info_json = excluded.token_info_json,
      traders_json = excluded.traders_json,
      updated_at = excluded.updated_at
  `);

const qBlacklist =
  db.prepare(`
    SELECT reason, expires_at
    FROM blacklist
    WHERE wallet_address = ?
  `);

const qPutBlacklist =
  db.prepare(`
    INSERT INTO blacklist(
      wallet_address,
      reason,
      expires_at
    )
    VALUES (?, ?, ?)

    ON CONFLICT(wallet_address)
    DO UPDATE SET
      reason = excluded.reason,
      expires_at = excluded.expires_at
  `);

const qDeleteBlacklist =
  db.prepare(`
    DELETE FROM blacklist
    WHERE wallet_address = ?
  `);

const qPreviousSent =
  db.prepare(`
    SELECT COUNT(*) count
    FROM sent_results
    WHERE wallet_address = ?
      AND token_address <> ?
  `);

const qPutSent =
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
      sent_at = excluded.sent_at,
      overall_score = excluded.overall_score
  `);

const qObservation =
  db.prepare(`
    INSERT INTO wallet_observations(
      wallet_address,
      token_address,
      observed_at,
      token_score,
      profit_change,
      realized_profit,
      total_profit,
      entry_delay_sec,
      buy_count,
      sell_count
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

    ON CONFLICT(
      wallet_address,
      token_address
    )
    DO UPDATE SET
      observed_at = excluded.observed_at,
      token_score = excluded.token_score,
      profit_change = excluded.profit_change,
      realized_profit = excluded.realized_profit,
      total_profit = excluded.total_profit,
      entry_delay_sec = excluded.entry_delay_sec,
      buy_count = excluded.buy_count,
      sell_count = excluded.sell_count
  `);

const qObservationSummary =
  db.prepare(`
    SELECT
      COUNT(*) observations,

      AVG(token_score)
        avg_token_score,

      SUM(
        CASE
          WHEN profit_change > 0.15
            OR realized_profit > 500
          THEN 1
          ELSE 0
        END
      ) good_results,

      SUM(
        CASE
          WHEN entry_delay_sec IS NOT NULL
            AND entry_delay_sec >= 0
            AND entry_delay_sec <= 21600
          THEN 1
          ELSE 0
        END
      ) early_results

    FROM wallet_observations

    WHERE wallet_address = ?
      AND token_address <> ?
  `);

const qMeta =
  db.prepare(`
    SELECT value
    FROM meta
    WHERE key = ?
  `);

const qPutMeta =
  db.prepare(`
    INSERT INTO meta(key, value)
    VALUES (?, ?)

    ON CONFLICT(key)
    DO UPDATE SET
      value = excluded.value
  `);

// ========================= HELPERS =========================

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

const clamp = (
  value,
  min,
  max
) =>
  Math.max(
    min,
    Math.min(max, value)
  );

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

  return (
    typeof value === "string" &&
    [
      "1",
      "true",
      "yes",
    ].includes(
      value
        .trim()
        .toLowerCase()
    )
  );
}

const short = (address) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;

function chunk(
  items,
  size
) {
  const out = [];

  for (
    let i = 0;
    i < items.length;
    i += size
  ) {
    out.push(
      items.slice(
        i,
        i + size
      )
    );
  }

  return out;
}

function tagsOf(object) {
  return [
    ...(
      Array.isArray(
        object?.tags
      )
        ? object.tags
        : []
    ),

    ...(
      Array.isArray(
        object?.maker_token_tags
      )
        ? object.maker_token_tags
        : []
    ),
  ]
    .filter(Boolean)
    .map(
      (x) =>
        String(x)
          .toLowerCase()
    );
}

function statsTags(common) {
  return [
    common?.tag,

    ...(
      Array.isArray(
        common?.tags
      )
        ? common.tags
        : []
    ),
  ]
    .filter(Boolean)
    .map(
      (x) =>
        String(x)
          .toLowerCase()
    );
}

function findSolAddress(text) {
  const matches =
    String(
      text || ""
    ).match(
      SOL_ADDR_IN_TEXT
    ) || [];

  return (
    matches.find(
      (x) =>
        SOL_ADDR.test(x)
    ) ||
    null
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ========================= DB HELPERS =========================

function getCachedStats(
  wallet,
  period
) {
  const row =
    qCache.get(
      wallet,
      period
    );

  if (!row) {
    return null;
  }

  const ttl =
    period === "7d"
      ? CACHE_7D_MS
      : CACHE_30D_MS;

  if (
    Date.now() -
      Number(row.updated_at) >
    ttl
  ) {
    return null;
  }

  return safeJsonParse(
    row.stats_json
  );
}

function putCachedStats(
  wallet,
  period,
  stats
) {
  qPutCache.run(
    wallet,
    period,
    JSON.stringify(stats),
    Date.now()
  );
}

function getCachedDiscovery(token) {
  const row =
    qTokenCache.get(token);

  if (
    !row ||
    Date.now() -
      Number(row.updated_at) >
      DISCOVERY_CACHE_MS
  ) {
    return null;
  }

  const tokenInfo =
    safeJsonParse(
      row.token_info_json
    );

  const traders =
    safeJsonParse(
      row.traders_json
    );

  if (
    !tokenInfo ||
    !Array.isArray(traders)
  ) {
    return null;
  }

  return {
    tokenInfo,
    traders,
  };
}

function putCachedDiscovery(
  token,
  tokenInfo,
  traders
) {
  qPutTokenCache.run(
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

function getBlacklist(wallet) {
  const row =
    qBlacklist.get(wallet);

  if (!row) {
    return null;
  }

  if (
    Number(
      row.expires_at
    ) <= Date.now()
  ) {
    qDeleteBlacklist.run(
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
  qPutBlacklist.run(
    wallet,
    reason,

    Date.now() +
      days *
        86400000
  );
}

function previousSentCount(
  wallet,
  token
) {
  return Number(
    qPreviousSent.get(
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
  qPutSent.run(
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
  qObservation.run(
    wallet,
    token,
    Date.now(),
    x.score,
    x.profitChange,
    x.realized,
    x.totalProfit,
    x.entryDelaySec,
    x.buyCount,
    x.sellCount
  );
}

function observationSummary(
  wallet,
  token
) {
  const row =
    qObservationSummary.get(
      wallet,
      token
    ) || {};

  return {
    observations:
      Number(
        row.observations ||
          0
      ),

    avgTokenScore:
      num(
        row.avg_token_score
      ),

    goodResults:
      Number(
        row.good_results ||
          0
      ),

    earlyResults:
      Number(
        row.early_results ||
          0
      ),
  };
}

function getMetaNumber(
  key,
  fallback = 0
) {
  const row =
    qMeta.get(key);

  const n =
    Number(
      row?.value
    );

  return Number.isFinite(n)
    ? n
    : fallback;
}

function setMetaNumber(
  key,
  value
) {
  qPutMeta.run(
    key,
    String(value)
  );
}

// ========================= GMGN RATE LIMIT =========================

let cliQueue =
  Promise.resolve();

let lastCliFinishedAt =
  0;

let rateTokens =
  RATE_CAPACITY;

let rateUpdatedAt =
  Date.now();

let gmgnBlockedUntil =
  getMetaNumber(
    "gmgn_blocked_until",
    0
  );

if (
  gmgnBlockedUntil <=
  Date.now()
) {
  gmgnBlockedUntil =
    0;

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
      /(?:"?reset_at"?|x-ratelimit-reset)\s*[:=]\s*"?(\d{10,13})/i
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
    /RATE_LIMIT_EXCEEDED|RATE_LIMIT_BANNED|IP rate limit exceeded|rate[ _-]?limit|\b429\b/i
      .test(text)
  );
}

function requestWeight(args) {
  if (
    args[0] === "token" &&
    args[1] === "traders"
  ) {
    return 5;
  }

  if (
    args[0] === "token"
  ) {
    return 1;
  }

  if (
    args[0] === "portfolio" &&
    args[1] === "stats"
  ) {
    return 3;
  }

  return 2;
}

function refillBucket() {
  const now =
    Date.now();

  rateTokens =
    Math.min(
      RATE_CAPACITY,

      rateTokens +
        (
          (
            now -
            rateUpdatedAt
          ) /
          1000
        ) *
          RATE_UNITS_PER_SEC
    );

  rateUpdatedAt =
    now;
}

async function spend(units) {
  while (true) {
    refillBucket();

    if (
      rateTokens >=
      units
    ) {
      rateTokens -=
        units;

      return;
    }

    const waitMs =
      Math.ceil(
        (
          (
            units -
            rateTokens
          ) /
          RATE_UNITS_PER_SEC
        ) *
          1000
      ) +
      100;

    await sleep(
      waitMs
    );
  }
}

async function waitForRequestGap() {
  const waitMs =
    lastCliFinishedAt +
    MIN_GMGN_GAP_MS -
    Date.now();

  if (
    waitMs > 0
  ) {
    await sleep(
      waitMs
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
              const resetAt =
                parseRateLimitReset(
                  message
                );

              gmgnBlockedUntil =
                Math.max(
                  gmgnBlockedUntil,

                  (
                    resetAt ||
                    Date.now() +
                      5 *
                        60 *
                        1000
                  ) +
                    RATE_LIMIT_GRACE_MS
                );

              // Store the cooldown in SQLite.
              // Restarting Railway will NOT bypass it.
              setMetaNumber(
                "gmgn_blocked_until",
                gmgnBlockedUntil
              );

              rateTokens =
                0;

              rateUpdatedAt =
                Date.now();
            }

            const wrapped =
              new Error(
                message ||
                  "gmgn-cli failed"
              );

            wrapped.gmgnResetAt =
              gmgnBlockedUntil ||
              null;

            return reject(
              wrapped
            );
          }

          if (
            stderr?.trim()
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
                `Unparseable gmgn-cli output: ${
                  String(
                    stdout
                  ).slice(
                    0,
                    300
                  )
                }`
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

        // Hard 10-second minimum spacing.
        await waitForRequestGap();

        // Secondary weighted limiter.
        await spend(
          requestWeight(
            args
          )
        );

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

// ========================= GMGN DATA =========================

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

// ========================= BATCH STATS PARSER =========================

function looksLikeStats(obj) {
  if (
    !obj ||
    typeof obj !==
      "object" ||
    Array.isArray(obj)
  ) {
    return false;
  }

  return (
    Object.prototype.hasOwnProperty.call(
      obj,
      "pnl_stat"
    ) ||

    Object.prototype.hasOwnProperty.call(
      obj,
      "realized_profit"
    ) ||

    Object.prototype.hasOwnProperty.call(
      obj,
      "realized_profit_pnl"
    ) ||

    Object.prototype.hasOwnProperty.call(
      obj,
      "winrate"
    ) ||

    Object.prototype.hasOwnProperty.call(
      obj,
      "buy"
    ) ||

    Object.prototype.hasOwnProperty.call(
      obj,
      "buy_count"
    ) ||

    Object.prototype.hasOwnProperty.call(
      obj,
      "sell"
    ) ||

    Object.prototype.hasOwnProperty.call(
      obj,
      "sell_count"
    )
  );
}

function statsAddress(obj) {
  if (
    !obj ||
    typeof obj !==
      "object"
  ) {
    return null;
  }

  return (
    obj.wallet_address ||
    obj.wallet ||
    obj.address ||
    obj.owner ||
    obj.account ||
    null
  );
}

/*
GMGN's multi-wallet response shape can be wrapped differently.

Instead of assuming:
  data.list
or:
  data[wallet]

we recursively walk the response and locate every object
that actually looks like a wallet-stat record.

This fixes the previous "omitted 9/10 wallets" problem.
*/
function mapStatsResponse(
  response,
  wallets
) {
  const walletSet =
    new Set(
      wallets
    );

  const out = {};
  const statsObjects = [];
  const seenObjects =
    new Set();

  function remember(
    obj,
    keyHint = null
  ) {
    if (
      !looksLikeStats(obj) ||
      seenObjects.has(obj)
    ) {
      return;
    }

    seenObjects.add(
      obj
    );

    statsObjects.push({
      obj,
      keyHint,
    });

    const explicit =
      statsAddress(
        obj
      );

    if (
      explicit &&
      walletSet.has(
        String(explicit)
      )
    ) {
      out[
        String(explicit)
      ] =
        obj;

    } else if (
      keyHint &&
      walletSet.has(
        keyHint
      )
    ) {
      out[keyHint] =
        obj;
    }
  }

  function walk(
    node,
    keyHint = null,
    depth = 0
  ) {
    if (
      node === null ||
      node === undefined ||
      depth > 7
    ) {
      return;
    }

    if (
      Array.isArray(node)
    ) {
      for (
        const item
        of node
      ) {
        walk(
          item,
          keyHint,
          depth + 1
        );
      }

      return;
    }

    if (
      typeof node !==
      "object"
    ) {
      return;
    }

    if (
      node.data &&
      typeof node.data ===
        "object" &&
      looksLikeStats(
        node.data
      )
    ) {
      remember(
        node.data,
        keyHint
      );
    }

    remember(
      node,
      keyHint
    );

    for (
      const [
        key,
        value,
      ]
      of Object.entries(
        node
      )
    ) {
      if (
        !value ||
        typeof value !==
          "object"
      ) {
        continue;
      }

      // Common shape:
      // {
      //   "walletAddress": {...stats}
      // }
      if (
        walletSet.has(
          key
        )
      ) {
        const candidate =
          (
            value.data &&
            looksLikeStats(
              value.data
            )
          )
            ? value.data
            : value;

        if (
          looksLikeStats(
            candidate
          )
        ) {
          out[key] =
            candidate;

          remember(
            candidate,
            key
          );
        }
      }

      // These belong to a single stats row.
      // They aren't separate wallets.
      if (
        [
          "pnl_stat",
          "common",
        ].includes(
          key
        )
      ) {
        continue;
      }

      walk(
        value,

        walletSet.has(
          key
        )
          ? key
          : keyHint,

        depth + 1
      );
    }
  }

  walk(
    response
  );

  /*
  Some GMGN batch responses may return an ordered
  array without putting wallet_address in every row.

  When the number of remaining rows exactly matches
  the requested wallets, map them by request order.
  */

  const missingWallets =
    wallets.filter(
      (w) =>
        !out[w]
    );

  const alreadyUsed =
    new Set(
      Object.values(
        out
      )
    );

  const unmappedRows =
    statsObjects
      .map(
        (x) =>
          x.obj
      )
      .filter(
        (obj) =>
          !alreadyUsed.has(
            obj
          )
      );

  if (
    missingWallets.length &&
    unmappedRows.length ===
      missingWallets.length
  ) {
    missingWallets.forEach(
      (
        wallet,
        i
      ) => {
        out[wallet] =
          unmappedRows[i];
      }
    );

  } else if (
    Object.keys(
      out
    ).length === 0 &&
    statsObjects.length >=
      wallets.length
  ) {
    wallets.forEach(
      (
        wallet,
        i
      ) => {
        out[wallet] =
          statsObjects[i]
            .obj;
      }
    );
  }

  return out;
}

async function getWalletStats(
  wallets,
  period,
  onProgress
) {
  const out = {};
  const missing = [];

  for (
    const wallet
    of wallets
  ) {
    const cached =
      getCachedStats(
        wallet,
        period
      );

    if (cached) {
      out[wallet] =
        cached;
    } else {
      missing.push(
        wallet
      );
    }
  }

  let completed =
    wallets.length -
    missing.length;

  await onProgress?.(
    period,
    completed,
    wallets.length,

    completed > 0
      ? "cache"
      : "start"
  );

  for (
    const batch
    of chunk(
      missing,
      STATS_BATCH_SIZE
    )
  ) {
    const args = [
      "portfolio",
      "stats",

      "--chain",
      "sol",

      "--period",
      period,
    ];

    for (
      const wallet
      of batch
    ) {
      args.push(
        "--wallet",
        wallet
      );
    }

    args.push(
      "--raw"
    );

    const r =
      await cli(
        args
      );

    const mapped =
      mapStatsResponse(
        r,
        batch
      );

    for (
      const [
        wallet,
        stats,
      ]
      of Object.entries(
        mapped
      )
    ) {
      if (
        !batch.includes(
          wallet
        )
      ) {
        continue;
      }

      out[wallet] =
        stats;

      putCachedStats(
        wallet,
        period,
        stats
      );
    }

    const omitted =
      batch.filter(
        (wallet) =>
          !mapped[wallet]
      );

    completed +=
      batch.length;

    if (
      omitted.length
    ) {
      console.warn(
        `${period}: GMGN response could not be mapped for ` +
        `${omitted.length}/${batch.length} wallets. ` +
        `Mapped ${Object.keys(mapped).length}. ` +
        `No individual fallback calls.`
      );

      /*
      Temporary debugging for the first deployment.

      This contains public wallet statistics,
      NOT your API key.
      */
      if (
        process.env
          .GMGN_DEBUG_BATCH ===
        "1"
      ) {
        console.log(
          `[GMGN batch debug ${period}] ${
            JSON.stringify(r)
              .slice(
                0,
                6000
              )
          }`
        );
      }

    } else {
      console.log(
        `${period}: mapped ${batch.length}/${batch.length} wallets successfully.`
      );
    }

    await onProgress?.(
      period,

      Math.min(
        completed,
        wallets.length
      ),

      wallets.length,
      "batch"
    );
  }

  return out;
}

async function getDiscovery(
  address,
  onProgress
) {
  const cached =
    getCachedDiscovery(
      address
    );

  if (cached) {
    await onProgress?.(
      "discovery-cache"
    );

    return cached;
  }

  await onProgress?.(
    "token-info"
  );

  const tokenInfo =
    await getTokenInfo(
      address
    );

  await onProgress?.(
    "top-traders"
  );

  const traders =
    await getTopTraders(
      address
    );

  putCachedDiscovery(
    address,
    tokenInfo,
    traders
  );

  return {
    tokenInfo,
    traders,
  };
}

// ========================= STATS =========================

function parseStats(input) {
  const s =
    input || {};

  const p =
    s.pnl_stat ||
    {};

  const buys =
    num(
      s.buy ??
      s.buy_count
    );

  const sells =
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

    unrealizedProfit:
      num(
        s.unrealized_profit
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

    buyCount:
      buys,

    sellCount:
      sells,

    trades:
      buys +
      sells,

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

function winnerRate(s) {
  if (
    !s?.tokenNum
  ) {
    return 0;
  }

  const bucketRate =
    (
      s.dist.gt5 +
      s.dist.x2to5 +
      s.dist.x0to2
    ) /
    s.tokenNum;

  return Math.max(
    clamp(
      bucketRate,
      0,
      1
    ),

    clamp(
      s.winrate,
      0,
      1
    )
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

// ========================= SCORING =========================

function trackScore(s) {
  if (
    !hasStats(s) ||
    s.tokenNum <= 0
  ) {
    return 0;
  }

  const lossDiscipline =
    1 -
    severeLossRate(s);

  const winQuality =
    clamp(
      (
        winnerRate(s) -
        0.30
      ) /
        0.40,
      0,
      1
    );

  const roiQuality =
    clamp(
      (
        s.roi +
        0.10
      ) /
        0.70,
      0,
      1
    );

  const bigWinnerQuality =
    clamp(
      bigWinnerRate(s) /
        0.20,
      0,
      1
    );

  const sampleQuality =
    clamp(
      (
        Math.log2(
          1 +
          s.tokenNum
        ) -
        2
      ) /
        4,
      0,
      1
    );

  const profitQuality =
    clamp(
      Math.log10(
        1 +
        Math.max(
          0,
          s.realizedProfit
        )
      ) /
        Math.log10(
          100001
        ),
      0,
      1
    );

  return Math.round(
    100 *
    (
      0.30 *
        lossDiscipline +

      0.22 *
        winQuality +

      0.22 *
        roiQuality +

      0.11 *
        bigWinnerQuality +

      0.10 *
        sampleQuality +

      0.05 *
        profitQuality
    )
  );
}

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
    s.tokenNum > 0
      ? s.trades /
        s.tokenNum
      : s.trades;

  const h =
    s.avgHoldSec;

  let score = 55;

  if (
    h > 0 &&
    h <
      5 * 60
  ) {
    score = 20;

  } else if (
    h > 0 &&
    h <
      15 * 60
  ) {
    score = 40;

  } else if (
    h > 0 &&
    h <
      60 * 60
  ) {
    score = 65;

  } else if (
    h > 0 &&
    h <
      6 * 60 * 60
  ) {
    score = 78;

  } else if (
    h > 0 &&
    h <
      24 * 60 * 60
  ) {
    score = 88;

  } else if (
    h >=
    24 * 60 * 60
  ) {
    score = 100;
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

  return (
    first &&
    opened &&
    first >= opened
      ? first -
        opened
      : null
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
    clamp(
      num(
        trader
          ?.sell_amount_percentage
      ),
      0,
      1
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
        0.10
      ) /
        1.60,
      0,
      1
    );

  const profitQ =
    clamp(
      Math.log10(
        1 +
        Math.max(
          0,
          realized
        )
      ) /
        Math.log10(
          50001
        ),
      0,
      1
    );

  let timingQ =
    0.45;

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
      timingQ = 0.92;

    } else if (
      entryDelaySec <=
      2 * 3600
    ) {
      timingQ = 0.80;

    } else if (
      entryDelaySec <=
      6 * 3600
    ) {
      timingQ = 0.68;

    } else if (
      entryDelaySec <=
      86400
    ) {
      timingQ = 0.52;

    } else {
      timingQ = 0.35;
    }
  }

  let athQ =
    0.5;

  const ath =
    num(
      tokenInfo
        ?.ath_price
    );

  if (
    ath > 0 &&
    avgCost > 0
  ) {
    athQ =
      clamp(
        (
          Math.log2(
            Math.max(
              1,
              ath /
                avgCost
            )
          ) +
          0.5
        ) /
          4,

        0.35,
        1
      );
  }

  let realizeQ =
    0.45;

  if (
    realized > 0 &&
    soldPct >=
      0.95
  ) {
    realizeQ = 1;

  } else if (
    realized > 0 &&
    soldPct >=
      0.40
  ) {
    realizeQ = 0.85;

  } else if (
    realized > 0
  ) {
    realizeQ = 0.70;

  } else if (
    unrealized > 0
  ) {
    realizeQ = 0.55;

  } else if (
    totalProfit < 0
  ) {
    realizeQ = 0.20;
  }

  const score =
    Math.round(
      100 *
      (
        0.38 *
          roiQ +

        0.18 *
          profitQ +

        0.18 *
          timingQ +

        0.12 *
          athQ +

        0.14 *
          realizeQ
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

function discoveryScore(
  summary
) {
  if (
    !summary.observations
  ) {
    return 50;
  }

  const goodRate =
    summary.goodResults /
    summary.observations;

  const earlyRate =
    summary.earlyResults /
    summary.observations;

  const avg =
    clamp(
      summary.avgTokenScore /
        100,
      0,
      1
    );

  const sample =
    clamp(
      summary.observations /
        8,
      0,
      1
    );

  return Math.round(
    100 *
    (
      0.45 *
        avg +

      0.30 *
        goodRate +

      0.15 *
        earlyRate +

      0.10 *
        sample
    )
  );
}

function overallScore(
  track30,
  track7,
  tokenScore,
  behavior,
  discovery,
  previousSeen,
  observations
) {
  const discoveryWeight =
    observations >= 2
      ? 0.08
      : 0;

  const normalWeight =
    1 -
    discoveryWeight;

  const base =
    normalWeight *
    (
      0.45 *
        track30 +

      0.25 *
        track7 +

      0.20 *
        tokenScore +

      0.10 *
        behavior
    ) +

    discoveryWeight *
      discovery;

  const repeatBonus =
    previousSeen
      ? clamp(
          previousSeen *
            0.8 +

          clamp(
            observations /
              5,
            0,
            1
          ) *
            2 +

          clamp(
            (
              discovery -
              50
            ) /
              40,
            0,
            1
          ) *
            2,

          0,
          5
        )
      : 0;

  return Math.round(
    clamp(
      base +
        repeatBonus,
      0,
      100
    )
  );
}

// ========================= BOT FILTERS =========================

function traderExclusion(
  trader,
  creatorAddress
) {
  const address =
    trader?.address;

  if (
    !address ||
    !SOL_ADDR.test(
      address
    )
  ) {
    return "invalid wallet";
  }

  if (
    address ===
    creatorAddress
  ) {
    return "token creator";
  }

  if (
    Number(
      trader.addr_type
    ) === 2
  ) {
    return "exchange/liquidity pool";
  }

  if (
    boolish(
      trader.is_suspicious
    )
  ) {
    return "GMGN suspicious wallet";
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
    return "transfer-only position";
  }

  const badTag =
    tagsOf(
      trader
    ).find(
      (tag) =>
        EXCLUDE_TAGS.has(
          tag
        )
    );

  if (badTag) {
    return `tag:${badTag}`;
  }

  const thisTokenTx =
    num(
      trader
        .buy_tx_count_cur
    ) +
    num(
      trader
        .sell_tx_count_cur
    );

  if (
    thisTokenTx >
    HARD_MAX_THIS_TOKEN_TX
  ) {
    return "extreme submitted-token transaction count";
  }

  return null;
}

function statsExclusion(
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
    return null;
  }

  const days =
    s === s7
      ? 7
      : 30;

  const perDay =
    s.trades /
    days;

  const perToken =
    s.tokenNum > 0
      ? s.trades /
        s.tokenNum
      : s.trades;

  if (
    perDay >
    HARD_MAX_TRADES_PER_DAY
  ) {
    return "bot-like trade frequency";
  }

  if (
    perToken >
    HARD_MAX_TRADES_PER_TOKEN
  ) {
    return "bot-like transactions/token";
  }

  if (
    s.createdTokenCount >
    0.6 *
    Math.max(
      1,
      s.tokenNum
    )
  ) {
    return "mostly token creator";
  }

  return null;
}

function candidatePriority(
  trader,
  previousSeen
) {
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

  const profit =
    Math.max(
      0,
      num(
        trader.profit
      )
    );

  const roi =
    num(
      trader
        .profit_change
    );

  const tx =
    num(
      trader
        .buy_tx_count_cur
    ) +
    num(
      trader
        .sell_tx_count_cur
    );

  return (
    Math.log10(
      1 +
      profit
    ) *
      8 +

    clamp(
      roi,
      -0.5,
      3
    ) *
      12 +

    (
      smart
        ? 20
        : 0
    ) +

    Math.min(
      previousSeen,
      5
    ) *
      5 -

    Math.max(
      0,
      tx -
        12
    ) *
      0.25
  );
}

function chooseCandidates(
  traders,
  creatorAddress,
  tokenAddress
) {
  const candidates = [];

  for (
    const trader
    of traders
  ) {
    const wallet =
      trader?.address;

    const reason =
      traderExclusion(
        trader,
        creatorAddress
      );

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
          reason ===
            "GMGN suspicious wallet" ||

          reason.startsWith(
            "tag:dex_bot"
          ) ||

          reason.startsWith(
            "tag:rat_trader"
          ) ||

          reason.startsWith(
            "tag:bundler"
          )
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

    const previousSeen =
      previousSentCount(
        wallet,
        tokenAddress
      );

    candidates.push({
      trader,
      previousSeen,

      priority:
        candidatePriority(
          trader,
          previousSeen
        ),
    });
  }

  candidates.sort(
    (a, b) =>
      b.priority -
      a.priority
  );

  return candidates.slice(
    0,
    MAX_CANDIDATES
  );
}

function qualifies(row) {
  if (
    !hasStats(
      row.s30
    )
  ) {
    return false;
  }

  if (
    row.s30.tokenNum <
    MIN_30D_TOKENS
  ) {
    return false;
  }

  if (
    row.s30
      .realizedProfit <=
    0
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
    row.overall <
    MIN_OVERALL_SCORE
  ) {
    return false;
  }

  if (
    row.s30.tokenNum >=
      10 &&
    severeLossRate(
      row.s30
    ) >
      0.45
  ) {
    return false;
  }

  return true;
}

function labelsFor(row) {
  const labels = [];

  const s =
    hasStats(
      row.s7
    )
      ? row.s7
      : row.s30;

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
    LOW_SAMPLE_30D_TOKENS
  ) {
    labels.push(
      "🆕 LOW SAMPLE"
    );
  }

  if (
    s.avgHoldSec > 0 &&
    s.avgHoldSec <
      FAST_AVG_HOLD_SEC
  ) {
    labels.push(
      "⚡ FAST"
    );
  }

  const days =
    s === row.s7
      ? 7
      : 30;

  const perDay =
    s.trades /
    days;

  const perToken =
    s.tokenNum > 0
      ? s.trades /
        s.tokenNum
      : s.trades;

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
    row.s30.tokenNum >=
      15 &&
    row.track30 >=
      60 &&
    severeLossRate(
      row.s30
    ) <=
      0.12
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
    row.token
      .entryDelaySec !==
      null &&
    row.token
      .entryDelaySec <=
      6 * 3600 &&
    row.token.score >=
      60
  ) {
    labels.push(
      "EARLY ENTRY"
    );
  }

  return labels;
}

// ========================= MAIN SCAN =========================

async function scan(
  address,
  onProgress
) {
  const {
    tokenInfo,
    traders: top,
  } =
    await getDiscovery(
      address,
      onProgress
    );

  if (!top.length) {
    return {
      tokenInfo,
      wallets: [],

      note:
        "GMGN returned no top traders for this token.",
    };
  }

  const candidates =
    chooseCandidates(
      top,

      tokenInfo
        ?.dev
        ?.creator_address ||
        null,

      address
    );

  if (
    !candidates.length
  ) {
    return {
      tokenInfo,
      wallets: [],

      note:
        "Top traders were found, but all candidates were filtered as bots/devs/pools/transfer-only wallets.",
    };
  }

  const wallets =
    candidates.map(
      (x) =>
        x.trader.address
    );

  await onProgress?.(
    "30d-start",
    wallets.length
  );

  const raw30 =
    await getWalletStats(
      wallets,
      "30d",

      async (
        period,
        done,
        total
      ) => {
        await onProgress?.(
          "stats",
          period,
          done,
          total
        );
      }
    );

  await onProgress?.(
    "7d-start",
    wallets.length
  );

  const raw7 =
    await getWalletStats(
      wallets,
      "7d",

      async (
        period,
        done,
        total
      ) => {
        await onProgress?.(
          "stats",
          period,
          done,
          total
        );
      }
    );

  await onProgress?.(
    "scoring"
  );

  const results = [];

  for (
    const candidate
    of candidates
  ) {
    const trader =
      candidate.trader;

    const wallet =
      trader.address;

    const s30 =
      parseStats(
        raw30[wallet]
      );

    const s7 =
      parseStats(
        raw7[wallet]
      );

    if (
      !hasStats(s30) &&
      !hasStats(s7)
    ) {
      continue;
    }

    const botReason =
      statsExclusion(
        s7,
        s30
      );

    if (botReason) {
      blacklist(
        wallet,
        botReason,
        14
      );

      continue;
    }

    const mergedTags = [
      ...new Set([
        ...tagsOf(
          trader
        ),

        ...statsTags(
          s7.common
        ),

        ...statsTags(
          s30.common
        ),
      ]),
    ];

    const badTag =
      mergedTags.find(
        (x) =>
          EXCLUDE_TAGS.has(
            x
          )
      );

    if (badTag) {
      if (
        [
          "dex_bot",
          "rat_trader",
          "bundler",
        ].includes(
          badTag
        )
      ) {
        blacklist(
          wallet,
          `stats tag:${badTag}`,
          30
        );
      }

      continue;
    }

    const token =
      tokenPerformance(
        trader,
        tokenInfo
      );

    const track30 =
      trackScore(
        s30
      );

    const track7 =
      hasStats(s7)
        ? trackScore(
            s7
          )
        : Math.round(
            track30 *
            0.65
          );

    const behavior =
      behaviorScore(
        s7,
        s30
      );

    const history =
      observationSummary(
        wallet,
        address
      );

    const discovery =
      discoveryScore(
        history
      );

    const overall =
      overallScore(
        track30,
        track7,
        token.score,
        behavior,
        discovery,
        candidate.previousSeen,
        history.observations
      );

    // Researched wallets improve our free local history.
    // This does NOT trigger the SEEN label.
    saveObservation(
      wallet,
      address,
      token
    );

    const row = {
      wallet,
      trader,
      s30,
      s7,
      token,
      track30,
      track7,
      behavior,
      discovery,
      history,

      previousSeen:
        candidate.previousSeen,

      overall,
    };

    row.labels =
      labelsFor(
        row
      );

    if (
      qualifies(
        row
      )
    ) {
      results.push(
        row
      );
    }
  }

  results.sort(
    (a, b) =>
      b.overall -
      a.overall
  );

  return {
    tokenInfo,

    wallets:
      results,

    note:
      results.length
        ? null
        : "Traders were found, but none passed the multi-token consistency filters.",
  };
}

// ========================= DISCORD FORMAT =========================

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

  const body =
    a >= 1e6
      ? `$${(
          a /
          1e6
        ).toFixed(1)}M`

      : a >= 1e3
        ? `$${(
            a /
            1e3
          ).toFixed(1)}K`

        : `$${a.toFixed(
            0
          )}`;

  return sign +
    body;
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

  const pct =
    n * 100;

  return (
    `${
      signed &&
      pct > 0
        ? "+"
        : ""
    }${pct.toFixed(0)}%`
  );
}

function fmtPrice(value) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    return "N/A";
  }

  if (
    n <
    0.000001
  ) {
    return `$${n.toExponential(
      2
    )}`;
  }

  if (
    n < 0.01
  ) {
    return `$${n.toPrecision(
      3
    )}`;
  }

  return `$${n.toFixed(
    4
  )}`;
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
    return `${Math.round(
      n
    )}s`;
  }

  if (
    n < 3600
  ) {
    return `${Math.round(
      n /
      60
    )}m`;
  }

  if (
    n < 86400
  ) {
    return `${(
      n /
      3600
    ).toFixed(1)}h`;
  }

  return `${(
    n /
    86400
  ).toFixed(1)}d`;
}

function positionStatus(token) {
  if (
    token.soldPct >=
    0.95
  ) {
    return "exited";
  }

  if (
    token.soldPct >
    0
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

  if (
    token.buyCount >
    0
  ) {
    return "holding";
  }

  return "position unclear";
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

  const profiles =
    row.labels.filter(
      (x) =>
        !/^[♻️🆕⚡⚠️]/u
          .test(x)
    );

  const heading = [
    `${rank}. ${short(
      row.wallet
    )} [${row.overall}/100]`,

    ...flags,
  ].join(
    " • "
  );

  const tokenParts = [
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
    row.token.avgCost >
    0
  ) {
    tokenParts.push(
      `entry ${fmtPrice(
        row.token.avgCost
      )}`
    );
  }

  if (
    row.token
      .entryDelaySec !==
    null
  ) {
    tokenParts.push(
      `${fmtHold(
        row.token
          .entryDelaySec
      )} after launch`
    );
  }

  const lines = [
    `\`${row.wallet}\``,

    `**This token:** ${
      tokenParts.join(
        " | "
      )
    }`,

    `**30d:** ${
      fmtPct(
        row.s30.winrate
      )
    } WR | ${
      fmtPct(
        row.s30.roi,
        true
      )
    } (${
      fmtUsd(
        row.s30
          .realizedProfit
      )
    }) | ${
      row.s30.tokenNum
    } tokens | avg hold ${
      fmtHold(
        row.s30
          .avgHoldSec
      )
    }`,

    `**7d:** ${
      hasStats(
        row.s7
      )
        ? `${
            fmtPct(
              row.s7.winrate
            )
          } WR | ${
            fmtPct(
              row.s7.roi,
              true
            )
          } (${
            fmtUsd(
              row.s7
                .realizedProfit
            )
          }) | ${
            row.s7.tokenNum
          } tokens`

        : "no recent stats"
    }`,

    `**Profile:** ${
      profiles.length
        ? profiles.join(
            " • "
          )
        : "MIXED PROFILE"
    }`,
  ];

  return {
    name:
      heading.slice(
        0,
        256
      ),

    value:
      lines
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
    result.tokenInfo
      ?.symbol
      ? String(
          result.tokenInfo
            .symbol
        )
      : null;

  const tokenLabel =
    symbol
      ? `${symbol} • ${short(
          address
        )} (SOL)`
      : `${short(
          address
        )} (SOL)`;

  if (
    result.note
  ) {
    return [
      new EmbedBuilder()
        .setTitle(
          "🎯 Top wallets to track"
        )

        .setDescription(
          `Token: \`${tokenLabel}\`\n${result.note}`
        )

        .setColor(
          0x00c853
        ),
    ];
  }

  const pages =
    chunk(
      result.wallets,
      6
    );

  return pages.map(
    (
      wallets,
      page
    ) => {
      const embed =
        new EmbedBuilder()

          .setTitle(
            pages.length > 1
              ? `🎯 Top wallets to track — ${page + 1}/${pages.length}`
              : "🎯 Top wallets to track"
          )

          .setDescription(
            `Token: \`${tokenLabel}\`\n` +

            `${
              result.wallets.length
            } wallet${
              result.wallets.length === 1
                ? ""
                : "s"
            } qualified.`
          )

          .setColor(
            0x00c853
          );

      wallets.forEach(
        (
          row,
          i
        ) => {
          embed.addFields(
            walletField(
              row,

              page *
                6 +
                i +
                1
            )
          );
        }
      );

      return embed;
    }
  );
}

async function sendResult(
  statusMessage,
  sourceMessage,
  address,
  result
) {
  const groups =
    chunk(
      buildEmbeds(
        address,
        result
      ),
      10
    );

  await statusMessage.edit({
    content: "",
    embeds: groups[0],
  });

  for (
    let i = 1;
    i < groups.length;
    i++
  ) {
    await sourceMessage.reply({
      embeds:
        groups[i],
    });
  }

  // SEEN counts only wallets actually
  // returned to you in Discord.
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

// ========================= DISCORD / SCAN QUEUE =========================

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

function getCachedResult(address) {
  const row =
    resultCache.get(
      address
    );

  if (!row) {
    return null;
  }

  if (
    Date.now() -
      row.at >
    RESULT_CACHE_MS
  ) {
    resultCache.delete(
      address
    );

    return null;
  }

  return row.result;
}

function putCachedResult(
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

function queueScan(fn) {
  const job =
    scanQueue.then(
      fn
    );

  scanQueue =
    job.catch(
      () => {}
    );

  return job;
}

function makeProgressUpdater(
  status,
  address
) {
  let lastText = "";

  return async (
    stage,
    a,
    b,
    c
  ) => {
    let text;

    if (
      stage ===
      "token-info"
    ) {
      text =
        `🔎 ${short(address)} — checking token info...`;

    } else if (
      stage ===
      "top-traders"
    ) {
      text =
        `🔎 ${short(address)} — finding top traders...`;

    } else if (
      stage ===
      "discovery-cache"
    ) {
      text =
        `⚡ ${short(address)} — using cached token/trader data...`;

    } else if (
      stage ===
      "30d-start"
    ) {
      text =
        `📊 ${short(address)} — checking 30d history for ${a} candidates...`;

    } else if (
      stage ===
      "7d-start"
    ) {
      text =
        `📈 ${short(address)} — checking 7d history for ${a} candidates...`;

    } else if (
      stage ===
      "stats"
    ) {
      text =
        `${
          a === "30d"
            ? "📊"
            : "📈"
        } ${short(address)} — ${a} history ${b}/${c}...`;

    } else if (
      stage ===
      "scoring"
    ) {
      text =
        `🧠 ${short(address)} — scoring wallets...`;

    } else {
      return;
    }

    if (
      text ===
      lastText
    ) {
      return;
    }

    lastText =
      text;

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
      `GMGN minimum request gap: ${MIN_GMGN_GAP_MS}ms`
    );

    console.log(
      `GMGN weighted limiter: ${RATE_UNITS_PER_SEC} units/s, capacity ${RATE_CAPACITY}`
    );

    if (
      gmgnBlockedUntil >
      Date.now()
    ) {
      console.log(
        `GMGN stored cooldown active until ${
          new Date(
            gmgnBlockedUntil
          ).toISOString()
        }`
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
      getCachedResult(
        address
      );

    if (cached) {
      const groups =
        chunk(
          buildEmbeds(
            address,
            cached
          ),
          10
        );

      await message.reply({
        content:
          "⚡ Recently scanned CA — using cached results (no new GMGN requests).",

        embeds:
          groups[0],
      });

      for (
        let i = 1;
        i < groups.length;
        i++
      ) {
        await message.reply({
          embeds:
            groups[i],
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
        `🔎 Detected Solana CA \`${short(
          address
        )}\`. Queued for a slow, rate-limit-safe scan...`
      );

    queueScan(
      async () => {
        try {
          const progress =
            makeProgressUpdater(
              status,
              address
            );

          const result =
            await scan(
              address,
              progress
            );

          putCachedResult(
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
              : String(error);

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
              "I stopped immediately and saved any wallet stats already completed." +

              (
                seconds
                  ? ` Retry this CA in about ${seconds}s.`
                  : " Retry after the GMGN cooldown clears."
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

// ========================= STARTUP =========================

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

    /*
    Current gmgn-cli supports this environment variable.

    Setting it to 0 means gmgn-cli won't sit there
    and automatically make another request after a 429.

    We want OUR bot to control the cooldown.
    */
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
