"use strict";

function finite(value) {
  if (value == null || value === "" || typeof value === "boolean" || typeof value === "object") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function selectionTokenInfo(info = {}) {
  const price = finite(info.price?.price ?? info.price_usd ?? info.price);
  const supply = finite(info.circulating_supply);
  return { ...info, price,
    market_cap: finite(info.market_cap ?? info.marketcap) ?? (price != null && supply != null ? price * supply : null),
    liquidity: finite(info.liquidity ?? info.pool?.liquidity),
    holder_count: finite(info.holder_count ?? info.stat?.holder_count),
    volume_24h: finite(info.price?.volume_24h ?? info.volume_24h),
    insider_rate: finite(info.insider_rate ?? info.stat?.top_rat_trader_percentage),
    bundler_rate: finite(info.bundler_rate ?? info.stat?.top_bundler_trader_percentage),
    entrapment_ratio: finite(info.entrapment_ratio ?? info.stat?.top_entrapment_trader_percentage),
    top_10_holder_rate: finite(info.top_10_holder_rate ?? info.stat?.top_10_holder_rate),
    dev_team_hold_rate: finite(info.dev_team_hold_rate ?? info.stat?.dev_team_hold_rate),
  };
}
module.exports = { selectionTokenInfo };
