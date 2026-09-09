"use strict";

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rows(response) {
  const payload = response?.data ?? response ?? {};
  const list = Array.isArray(payload) ? payload : payload?.list || payload?.activities || payload?.items || response?.list || [];
  return Array.isArray(list) ? list : [];
}

function timestamp(row) {
  const raw = row?.timestamp ?? row?.time ?? row?.created_at ?? row?.createdAt ?? row?.block_time ?? row?.blockTime;
  const n = num(raw, 0);
  if (n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function token(row) {
  const values = [row?.token_address, row?.tokenAddress, row?.token?.address, row?.token?.token_address, row?.base_token_address, row?.baseTokenAddress, row?.mint, row?.token_mint];
  return values.find((value) => SOL_ADDR.test(String(value || ""))) || null;
}

function side(row) {
  const kind = String(row?.event_type ?? row?.eventType ?? row?.type ?? row?.side ?? row?.action ?? row?.event ?? "").toLowerCase();
  if (/(^|[^a-z])buy([^a-z]|$)|swap_buy|token_buy/.test(kind)) return "buy";
  if (/(^|[^a-z])sell([^a-z]|$)|swap_sell|token_sell/.test(kind)) return "sell";
  const buyAmount = num(row?.buy_amount ?? row?.buyAmount, 0);
  const sellAmount = num(row?.sell_amount ?? row?.sellAmount, 0);
  if (buyAmount > 0 && sellAmount <= 0) return "buy";
  if (sellAmount > 0 && buyAmount <= 0) return "sell";
  const flag = row?.is_buy ?? row?.isBuy;
  if (flag === true || flag === 1 || String(flag).toLowerCase() === "true" || String(flag) === "1") return "buy";
  return "other";
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function scoreWalletActivity(response, recurrence = {}) {
  const activity = rows(response).map((row) => ({ row, token: token(row), side: side(row), at: timestamp(row) }))
    .filter((item) => item.token && item.at > 0)
    .sort((a, b) => a.at - b.at);

  const buys = activity.filter((item) => item.side === "buy");
  const sells = activity.filter((item) => item.side === "sell");
  const distinctBought = new Set(buys.map((item) => item.token));
  const byToken = new Map();
  for (const item of activity) {
    if (!byToken.has(item.token)) byToken.set(item.token, []);
    byToken.get(item.token).push(item);
  }

  const holds = [];
  let rapidFlips = 0;
  for (const tokenEvents of byToken.values()) {
    const firstBuy = tokenEvents.find((item) => item.side === "buy");
    if (!firstBuy) continue;
    const firstSell = tokenEvents.find((item) => item.side === "sell" && item.at >= firstBuy.at);
    if (!firstSell) continue;
    const holdSec = Math.max(0, (firstSell.at - firstBuy.at) / 1000);
    holds.push(holdSec);
    if (holdSec < 300) rapidFlips += 1;
  }

  const firstAt = activity[0]?.at || 0;
  const lastAt = activity[activity.length - 1]?.at || 0;
  const spanDays = firstAt && lastAt ? Math.max(1, (lastAt - firstAt) / 86400000) : 1;
  const txPerDay = activity.length / spanDays;
  const medianHoldSec = median(holds);
  const rapidFlipRate = holds.length ? rapidFlips / holds.length : null;
  const recurrenceDistinct = Math.max(0, num(recurrence.distinctTokens));
  const recurrenceTop10 = Math.max(0, num(recurrence.top10Tokens));
  const recurrenceTop10Rate = recurrenceDistinct ? recurrenceTop10 / recurrenceDistinct : 0;

  let score = 0;
  score += clamp(distinctBought.size / 20, 0, 1) * 22;
  score += holds.length ? clamp((medianHoldSec || 0) / 3600, 0, 1) * 16 : 4;
  score += rapidFlipRate == null ? 4 : (1 - clamp(rapidFlipRate, 0, 1)) * 10;
  score += clamp(recurrenceDistinct / 8, 0, 1) * 20;
  score += clamp(recurrenceTop10Rate, 0, 1) * 10;
  score += activity.length >= 20 ? 8 : clamp(activity.length / 20, 0, 1) * 8;
  score += txPerDay <= 80 ? 8 : txPerDay <= 150 ? 4 : 0;
  if (recurrence.everCreator) score -= 12;
  if (recurrence.everInsider) score -= 8;
  score = Math.round(clamp(score, 0, 100));

  const evidenceUnits = Math.min(50, activity.length) + Math.min(20, holds.length * 2) + Math.min(30, recurrenceDistinct * 4);
  const confidence = Math.round(clamp(evidenceUnits, 0, 100));
  const reasons = [];
  if (distinctBought.size < 5) reasons.push("limited-recent-token-breadth");
  if (rapidFlipRate != null && rapidFlipRate > 0.4) reasons.push("rapid-flip-pattern");
  if (txPerDay > 150) reasons.push("very-high-frequency-activity");
  if (recurrenceDistinct === 0) reasons.push("no-phase1-recurrence-evidence-yet");
  if (recurrence.everCreator) reasons.push("creator-tag-seen");
  if (recurrence.everInsider) reasons.push("insider-tag-seen");
  if (confidence < 40) reasons.push("low-evidence-confidence");

  return {
    version: "phase2-lab-v0.1",
    score,
    confidence,
    status: confidence >= 60 ? "usable" : confidence >= 35 ? "limited" : "thin-data",
    metrics: {
      activityRows: activity.length,
      buys: buys.length,
      sells: sells.length,
      distinctBoughtTokens: distinctBought.size,
      pairedHoldTokens: holds.length,
      medianHoldSec,
      rapidFlipRate,
      txPerDay: Number(txPerDay.toFixed(1)),
      recurrenceDistinctTokens: recurrenceDistinct,
      recurrenceTop10Tokens: recurrenceTop10,
      recurrenceTop10Rate: recurrenceDistinct ? Number(recurrenceTop10Rate.toFixed(3)) : 0,
      everCreator: Boolean(recurrence.everCreator),
      everInsider: Boolean(recurrence.everInsider),
    },
    reasons,
  };
}

function initPhase2WalletLab(db, { now = () => Date.now() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS phase2_wallet_lab (
      wallet_address TEXT PRIMARY KEY,
      analyzed_at INTEGER NOT NULL,
      score INTEGER NOT NULL,
      confidence INTEGER NOT NULL,
      status TEXT NOT NULL,
      human_label TEXT NOT NULL DEFAULT 'unsure',
      analysis_json TEXT NOT NULL
    );
  `);
  const recurrenceStmt = db.prepare(`
    SELECT COUNT(*) AS distinct_tokens,
      SUM(CASE WHEN best_rank <= 10 THEN 1 ELSE 0 END) AS top10_tokens,
      MAX(is_creator) AS ever_creator,
      MAX(is_insider) AS ever_insider
    FROM recurrence_wallet_tokens WHERE wallet_address = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO phase2_wallet_lab(wallet_address, analyzed_at, score, confidence, status, human_label, analysis_json)
    VALUES (?, ?, ?, ?, ?, COALESCE((SELECT human_label FROM phase2_wallet_lab WHERE wallet_address = ?), 'unsure'), ?)
    ON CONFLICT(wallet_address) DO UPDATE SET analyzed_at=excluded.analyzed_at, score=excluded.score,
      confidence=excluded.confidence, status=excluded.status, analysis_json=excluded.analysis_json
  `);
  const labelStmt = db.prepare("UPDATE phase2_wallet_lab SET human_label = ? WHERE wallet_address = ?");
  const listStmt = db.prepare("SELECT * FROM phase2_wallet_lab ORDER BY analyzed_at DESC LIMIT ?");
  const getStmt = db.prepare("SELECT * FROM phase2_wallet_lab WHERE wallet_address = ?");

  function recurrence(walletAddress) {
    const row = recurrenceStmt.get(walletAddress) || {};
    return {
      distinctTokens: num(row.distinct_tokens), top10Tokens: num(row.top10_tokens),
      everCreator: Boolean(row.ever_creator), everInsider: Boolean(row.ever_insider),
    };
  }

  return {
    analyze(walletAddress, response) {
      const wallet = String(walletAddress || "").trim();
      if (!SOL_ADDR.test(wallet)) throw new Error("valid Solana wallet address is required");
      const analysis = scoreWalletActivity(response, recurrence(wallet));
      upsert.run(wallet, now(), analysis.score, analysis.confidence, analysis.status, wallet, JSON.stringify(analysis));
      return { walletAddress: wallet, ...analysis, humanLabel: getStmt.get(wallet)?.human_label || "unsure" };
    },
    label(walletAddress, label) {
      const wallet = String(walletAddress || "").trim();
      const value = ["good", "bad", "unsure"].includes(String(label)) ? String(label) : "unsure";
      if (!SOL_ADDR.test(wallet)) throw new Error("valid Solana wallet address is required");
      labelStmt.run(value, wallet);
      return { walletAddress: wallet, humanLabel: value };
    },
    list(limit = 50) {
      return listStmt.all(Math.max(1, Math.min(200, Number(limit) || 50))).map((row) => ({
        walletAddress: row.wallet_address, analyzedAt: row.analyzed_at, score: row.score,
        confidence: row.confidence, status: row.status, humanLabel: row.human_label,
        analysis: JSON.parse(row.analysis_json),
      }));
    },
  };
}

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function renderPhase2WalletLab(items, csrfToken = "", notice = "") {
  const cards = items.length ? items.map((item) => {
    const m = item.analysis.metrics;
    return `<article class="wallet"><div class="score">${item.score}<span>/100</span></div><div class="body"><a class="addr" href="https://solscan.io/account/${encodeURIComponent(item.walletAddress)}" target="_blank" rel="noreferrer">${esc(item.walletAddress)}</a><div class="meta">Confidence ${item.confidence}% · ${esc(item.status)} · ${m.distinctBoughtTokens} recent tokens · ${m.recurrenceDistinctTokens} Phase 1 recurrences</div><div class="metrics"><span>Median hold ${m.medianHoldSec == null ? "—" : Math.round(m.medianHoldSec/60)+"m"}</span><span>Rapid flips ${m.rapidFlipRate == null ? "—" : Math.round(m.rapidFlipRate*100)+"%"}</span><span>Tx/day ${m.txPerDay}</span></div><form method="post" action="/actions/phase2/label"><input type="hidden" name="csrf" value="${esc(csrfToken)}"><input type="hidden" name="wallet" value="${esc(item.walletAddress)}"><button name="label" value="good" class="${item.humanLabel === "good" ? "sel" : ""}">Good</button><button name="label" value="bad" class="${item.humanLabel === "bad" ? "sel bad" : "bad"}">Bad</button><button name="label" value="unsure" class="${item.humanLabel === "unsure" ? "sel" : ""}">Unsure</button></form></div></article>`;
  }).join("") : '<div class="empty">No wallets analysed yet.</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Consensus Phase 2 Lab</title><style>:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#080d14;color:#edf4fa}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:32px 20px}a{color:#69b5ff}h1{margin:0;font-size:30px}.sub{color:#8fa2b7;margin:8px 0 22px}.notice{background:#10271b;border:1px solid #285f41;padding:10px 12px;border-radius:10px;margin-bottom:16px}.analyze{display:flex;gap:10px;background:#111923;border:1px solid #253243;padding:16px;border-radius:14px;margin-bottom:22px}.analyze input{flex:1;background:#091019;color:#fff;border:1px solid #34465a;border-radius:9px;padding:12px}.analyze button,form button{background:#18304a;color:#fff;border:1px solid #355675;border-radius:8px;padding:8px 11px;cursor:pointer}.wallet{display:flex;gap:18px;border:1px solid #263443;background:#101720;border-radius:14px;padding:18px;margin:12px 0}.score{font-size:38px;font-weight:800;min-width:100px}.score span{font-size:13px;color:#899bad}.body{flex:1}.addr{font-family:ui-monospace,monospace}.meta{color:#97a9bb;margin:7px 0 10px;font-size:13px}.metrics{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.metrics span{background:#0b121a;border:1px solid #243240;border-radius:999px;padding:5px 8px;font-size:12px}.sel{border-color:#4bbf79!important}.bad{color:#ffadb5}.sel.bad{border-color:#d45c67!important}.empty{color:#8fa2b7;padding:30px;text-align:center}@media(max-width:650px){.analyze,.wallet{flex-direction:column}.score{min-width:0}}</style></head><body><main><h1>Phase 2 — Wallet Lab</h1><p class="sub">Manual calibration workspace. Scores are provisional research scores, not trusted-wallet promotion.</p>${notice ? `<div class="notice">${esc(notice)}</div>` : ""}<form class="analyze" method="post" action="/actions/phase2/analyze"><input type="hidden" name="csrf" value="${esc(csrfToken)}"><input name="wallet" maxlength="44" placeholder="Paste Solana wallet address" required><button type="submit">Analyse wallet</button></form>${cards}</main></body></html>`;
}

module.exports = { initPhase2WalletLab, renderPhase2WalletLab, scoreWalletActivity };
