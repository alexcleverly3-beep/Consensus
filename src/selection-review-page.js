"use strict";
function escape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
const fixed = (n, suffix = "") => Number.isFinite(n) ? `${n.toFixed(2)}${suffix}` : "Unknown";
const date = (n) => n ? new Date(n).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "Not yet";
function renderReviewPage(progress, reports, diagnostics = []) {
  const cards = reports.map((r, i) => {
    const a = r.assessment;
    return `<article><h2>${i + 1}. Candidate for your review</h2><p class="address"><a href="https://solscan.io/account/${encodeURIComponent(r.wallet)}" target="_blank" rel="noreferrer">${escape(r.wallet)}</a></p>
      <p>${a.twoX}/${a.tokens} selections produced sustained 2× opportunities; ${a.threeX} reached sustained 3×. Median screened opportunity: ${fixed(a.medianMultiple, "×")}.</p>
      <p class="muted">${a.measured} measured · ${a.unknown} unknown · entries span ${fixed(a.spanDays)} days · frozen ${date(r.savedAt)} · discovery group ${r.groupId}</p>
      <details><summary>See every selection, including failures and missing evidence</summary><div class="table"><table><thead><tr><th>Token</th><th>Purchase / USD spent</th><th>Entry price</th><th>Sustained opportunity</th><th>Raw peak / end</th><th>Worst price / entry</th><th>Time to 2×</th><th>Evidence</th></tr></thead><tbody>
      ${r.evidence.map((b) => `<tr><td><a href="https://solscan.io/token/${encodeURIComponent(b.token)}" target="_blank" rel="noreferrer">${escape(b.symbol || b.token)}</a><br><small>${escape(b.token)}</small></td>
        <td><a href="https://solscan.io/tx/${encodeURIComponent(b.tx)}" target="_blank" rel="noreferrer">${date(b.at)}</a><br>$${fixed(b.cost)}</td>
        <td>${b.price > 0 ? escape(b.price.toPrecision(6)) : "Unverified"}</td><td>${fixed(b.outcome.sustainedMultiple, "×")}</td>
        <td>${fixed(b.outcome.peakMultiple, "×")} / ${fixed(b.outcome.endMultiple, "×")}</td><td>${fixed(b.outcome.worstMultiple, "×")}</td>
        <td>${fixed(b.outcome.timeToTwoXHours, "h")}</td><td>${escape(b.outcome.reason || b.outcome.status)}</td></tr>`).join("")}
      </tbody></table></div></details><p class="muted">${r.limitations.map(escape).join(". ")}. Shared funding: ${escape(r.fundingAddress || "unknown; independence is not established")}.</p></article>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Consensus · Manual selection review</title>
    <style>:root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;background:#0d1117;color:#e6edf3}main{max-width:1100px;margin:auto;padding:30px 20px}a{color:#79c0ff}h1{margin-bottom:8px}.muted,small{color:#9da7b3}article,.panel{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin:20px 0}.big{font-size:34px;font-weight:700}.address{overflow-wrap:anywhere}.table{overflow:auto}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:12px;border-bottom:1px solid #30363d;vertical-align:top}small{font-size:10px}summary{cursor:pointer;padding:10px 0}.status{display:flex;gap:30px;flex-wrap:wrap}</style></head>
    <body><main><nav><a href="/">Progress dashboard</a> · <a href="/wallets">Existing wallet list</a> · <a href="/api/review-wallets">Download evidence JSON</a></nav>
    <h1>Manual selection review</h1><p class="muted">A separate selection-first experiment. Your existing scanner, scores and alerts are unchanged.</p>
    <section class="panel"><div class="status"><div class="big">${progress.saved} / ${progress.target} saved</div><div>${progress.discovered} unique candidates discovered<br>${progress.completedGroups} groups of ${progress.groupSize} assessed</div></div>
    <p>Each completed 100-wallet group is ranked using the same fixed criteria. Only qualifying candidates are saved, up to ten in this first review queue. No weak fillers. Once ten are saved, this experiment pauses; normal Consensus scanning continues.</p>
    <p class="muted">Last successful review request: ${date(progress.lastSuccess)}. Deferred request errors: ${progress.errored}. The experiment uses spare API capacity only, so progress may be slow.</p></section>
    <section><h2>What qualifies?</h2><p>At least 20 distinct meaningful purchases across 14+ days; a complete seven-day outcome window for every selection; at least 80% measurable histories; 40% sustained 2× opportunities; three sustained 3× opportunities; median screened upside at least 1.5×; and a conservative repeatability check.</p>
    <p class="muted">A sustained opportunity requires two consecutive hourly closing prices with at least $5,000 volume in each hour. Selling at a loss does not disqualify a selection. Missing outcomes count against the hit rate. These are provisional research criteria—not proof of future performance. Longer-horizon skill, historical liquidity and matched-market comparisons remain unvalidated.</p></section>
    ${cards || '<article><h2>No candidates saved yet</h2><p>Collecting and validating evidence. Existing “strong” wallets are not automatically copied into this list.</p></article>'}
    <details><summary>Validation queue and rejection reasons</summary><div class="table"><table><thead><tr><th>Wallet</th><th>State</th><th>History pages</th><th>Reason / last error</th></tr></thead><tbody>${diagnostics.map((r) => `<tr><td class="address">${escape(r.wallet)}</td><td>${escape(r.state)}</td><td>${r.pages}</td><td>${escape(r.last_error || (r.assessment_json ? JSON.parse(r.assessment_json).reasons.join(", ") : "Evidence pending"))}</td></tr>`).join("")}</tbody></table></div></details>
    </main></body></html>`;
}
module.exports = { renderReviewPage };
