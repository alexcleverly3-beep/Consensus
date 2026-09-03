"use strict";

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

class RequestBudget {
  constructor({ maxFreshCalls = 18 } = {}) {
    this.maxFreshCalls = clampInt(maxFreshCalls, 18, 1, 1000);
    this.freshCalls = 0;
    this.cacheHits = 0;
    this.coalesced = 0;
    this.skipped = 0;
  }

  canSpend(cost = 1) {
    return this.freshCalls + cost <= this.maxFreshCalls;
  }

  spend(cost = 1) {
    const safeCost = clampInt(cost, 1, 1, 1000);
    if (!this.canSpend(safeCost)) {
      this.skipped += 1;
      return false;
    }
    this.freshCalls += safeCost;
    return true;
  }

  hitCache() {
    this.cacheHits += 1;
  }

  hitCoalesced() {
    this.coalesced += 1;
  }

  snapshot() {
    return {
      maxFreshCalls: this.maxFreshCalls,
      freshCalls: this.freshCalls,
      remaining: Math.max(0, this.maxFreshCalls - this.freshCalls),
      cacheHits: this.cacheHits,
      coalesced: this.coalesced,
      skipped: this.skipped,
    };
  }
}

class RequestCoalescer {
  constructor() {
    this.inflight = new Map();
  }

  run(key, fn, onCoalesced) {
    if (this.inflight.has(key)) {
      onCoalesced?.();
      return this.inflight.get(key);
    }

    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }
}

module.exports = {
  RequestBudget,
  RequestCoalescer,
};
