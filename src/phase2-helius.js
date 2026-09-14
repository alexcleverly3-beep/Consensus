"use strict";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function retryableStatus(status) {
  return status === 408 || status === 429 || status === 503 || status >= 500;
}

function createHeliusClient({ apiKey, fetchImpl = globalThis.fetch, maxRetries = 4, logger = console } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("HELIUS_API_KEY is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  const webhookBase = "https://api-mainnet.helius-rpc.com/v0/webhooks";

  async function request(url, options = {}, attempt = 0) {
    const response = await fetchImpl(url, options);
    if (response.ok) return response.status === 204 ? null : response.json();
    const body = await response.text().catch(() => "");
    const error = new Error(`Helius ${response.status}: ${body.slice(0, 300) || response.statusText}`);
    error.status = response.status;
    if (retryableStatus(response.status) && attempt < maxRetries) {
      const base = Math.min(30_000, 1_000 * (2 ** attempt));
      const jitter = Math.round(base * (0.75 + Math.random() * 0.5));
      logger.warn(`[phase2-helius] retryable response ${response.status}; retrying after backoff`);
      await sleep(jitter);
      return request(url, options, attempt + 1);
    }
    throw error;
  }

  async function rpc(method, params) {
    const payload = await request(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (payload?.error) {
      const error = new Error(`Helius RPC ${payload.error.code || "error"}: ${String(payload.error.message || "unknown error").slice(0, 300)}`);
      error.code = payload.error.code;
      throw error;
    }
    return payload?.result;
  }

  function webhookUrl(id = "") {
    const suffix = id ? `/${encodeURIComponent(id)}` : "";
    return `${webhookBase}${suffix}?api-key=${encodeURIComponent(key)}`;
  }

  return {
    rpc,
    getSignaturesForAddress(address, options = {}) {
      return rpc("getSignaturesForAddress", [address, { commitment: "confirmed", limit: 100, ...options }]);
    },
    getTransaction(signature) {
      return rpc("getTransaction", [signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    },
    listWebhooks() {
      return request(webhookUrl(), { method: "GET", headers: { accept: "application/json" } });
    },
    createWebhook(body) {
      return request(webhookUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
    updateWebhook(id, body) {
      return request(webhookUrl(id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
  };
}

module.exports = { createHeliusClient, retryableStatus };
