"use strict";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = finite(value);
    if (n != null) return n;
  }
  return null;
}

function normalizeTokenSnapshot(tokenInfo = {}) {
  const price = firstFinite(
    tokenInfo.price,
    tokenInfo.price_usd,
    tokenInfo.current_price,
    tokenInfo.usd_price
  );
  const marketCap = firstFinite(
    tokenInfo.market_cap,
    tokenInfo.marketcap,
    tokenInfo.market_cap_usd,
    tokenInfo.fdv
  );
  const liquidity = firstFinite(
    tokenInfo.liquidity,
    tokenInfo.liquidity_usd,
    tokenInfo.pool?.liquidity,
    tokenInfo.pool?.liquidity_usd
  );

  return { price, marketCap, liquidity };
}

function ratio(current, baseline) {
  if (current == null || baseline == null || baseline <= 0) return null;
  return current / baseline;
}

function classifyOutcome({
  baseline,
  current,
  maxPrice,
  ageMs = 0,
  minAgeMs = 6 * 60 * 60 * 1000,
} = {}) {
  if (!baseline || !current) {
    return { status: "unknown", score: null, multiple: null, liquidityRatio: null };
  }

  const currentMultiple = ratio(current.price, baseline.price);
  const peakMultiple = ratio(maxPrice, baseline.price);
  const marketCapMultiple = ratio(current.marketCap, baseline.marketCap);
  const liquidityRatio = ratio(current.liquidity, baseline.liquidity);
  const bestMultiple = Math.max(
    currentMultiple == null ? 0 : currentMultiple,
    peakMultiple == null ? 0 : peakMultiple,
    marketCapMultiple == null ? 0 : marketCapMultiple
  ) || null;

  if (ageMs < minAgeMs) {
    return { status: "immature", score: null, multiple: bestMultiple, liquidityRatio };
  }

  const collapsedPrice = currentMultiple != null && currentMultiple <= 0.2;
  const collapsedMarketCap = marketCapMultiple != null && marketCapMultiple <= 0.2;
  const drainedLiquidity = liquidityRatio != null && liquidityRatio <= 0.2;
  if ((collapsedPrice || collapsedMarketCap) && (drainedLiquidity || bestMultiple == null || bestMultiple < 1.5)) {
    return { status: "bad", score: 0, multiple: bestMultiple, liquidityRatio };
  }

  if (bestMultiple != null && bestMultiple >= 5) {
    return { status: "excellent", score: 100, multiple: bestMultiple, liquidityRatio };
  }
  if (bestMultiple != null && bestMultiple >= 3) {
    return { status: "strong", score: 85, multiple: bestMultiple, liquidityRatio };
  }
  if (bestMultiple != null && bestMultiple >= 1.5) {
    return { status: "positive", score: 68, multiple: bestMultiple, liquidityRatio };
  }
  if (bestMultiple != null && bestMultiple < 0.5) {
    return { status: "weak", score: 20, multiple: bestMultiple, liquidityRatio };
  }

  return { status: "flat", score: 45, multiple: bestMultiple, liquidityRatio };
}

function initTokenOutcomes(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_outcomes (
      token_address TEXT PRIMARY KEY,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      first_price REAL,
      first_market_cap REAL,
      first_liquidity REAL,
      current_price REAL,
      current_market_cap REAL,
      current_liquidity REAL,
      max_price REAL,
      snapshot_count INTEGER NOT NULL DEFAULT 0,
      outcome_status TEXT NOT NULL DEFAULT 'unknown',
      outcome_score REAL,
      best_multiple REAL,
      liquidity_ratio REAL
    );
  `);

  const getStmt = db.prepare("SELECT * FROM token_outcomes WHERE token_address = ?");
  const insertStmt = db.prepare(`
    INSERT INTO token_outcomes (
      token_address, first_observed_at, last_observed_at,
      first_price, first_market_cap, first_liquidity,
      current_price, current_market_cap, current_liquidity,
      max_price, snapshot_count, outcome_status, outcome_score,
      best_multiple, liquidity_ratio
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'immature', NULL, NULL, NULL)
  `);
  const updateStmt = db.prepare(`
    UPDATE token_outcomes SET
      last_observed_at = ?,
      current_price = COALESCE(?, current_price),
      current_market_cap = COALESCE(?, current_market_cap),
      current_liquidity = COALESCE(?, current_liquidity),
      max_price = CASE
        WHEN ? IS NULL THEN max_price
        WHEN max_price IS NULL OR ? > max_price THEN ?
        ELSE max_price
      END,
      snapshot_count = snapshot_count + 1,
      outcome_status = ?, outcome_score = ?, best_multiple = ?, liquidity_ratio = ?
    WHERE token_address = ?
  `);

  const recordSnapshot = db.transaction(({ tokenAddress, tokenInfo = {}, observedAt = Date.now() }) => {
    if (!tokenAddress) throw new Error("tokenAddress is required");
    const snapshot = normalizeTokenSnapshot(tokenInfo);
    const now = Number.isFinite(Number(observedAt)) ? Number(observedAt) : Date.now();
    let row = getStmt.get(tokenAddress);

    if (!row) {
      insertStmt.run(
        tokenAddress, now, now,
        snapshot.price, snapshot.marketCap, snapshot.liquidity,
        snapshot.price, snapshot.marketCap, snapshot.liquidity,
        snapshot.price
      );
      return getStmt.get(tokenAddress);
    }

    const baseline = {
      price: row.first_price,
      marketCap: row.first_market_cap,
      liquidity: row.first_liquidity,
    };
    const current = {
      price: snapshot.price ?? row.current_price,
      marketCap: snapshot.marketCap ?? row.current_market_cap,
      liquidity: snapshot.liquidity ?? row.current_liquidity,
    };
    const maxPrice = Math.max(
      row.max_price == null ? 0 : row.max_price,
      current.price == null ? 0 : current.price
    ) || null;
    const outcome = classifyOutcome({
      baseline,
      current,
      maxPrice,
      ageMs: Math.max(0, now - row.first_observed_at),
    });

    updateStmt.run(
      now,
      snapshot.price,
      snapshot.marketCap,
      snapshot.liquidity,
      snapshot.price, snapshot.price, snapshot.price,
      outcome.status,
      outcome.score == null ? null : clamp(outcome.score, 0, 100),
      outcome.multiple,
      outcome.liquidityRatio,
      tokenAddress
    );
    return getStmt.get(tokenAddress);
  });

  return {
    recordSnapshot,
    getOutcome(tokenAddress) {
      return getStmt.get(tokenAddress) || null;
    },
  };
}

module.exports = {
  initTokenOutcomes,
  normalizeTokenSnapshot,
  classifyOutcome,
};
