"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { currentConsensusEligible } = require("../src/discovery-engine");

test("consensus requires current-token evidence to be early, profitable, and strong", () => {
  assert.equal(currentConsensusEligible({ isEarly: true, isProfitable: true, tokenScore: 80 }), true);
  assert.equal(currentConsensusEligible({ isEarly: false, isProfitable: true, tokenScore: 80 }), false);
  assert.equal(currentConsensusEligible({ isEarly: true, isProfitable: false, tokenScore: 80 }), false);
  assert.equal(currentConsensusEligible({ isEarly: true, isProfitable: true, tokenScore: 44 }), false);
});

test("consensus token-score floor is configurable without weakening profitability or timing", () => {
  assert.equal(currentConsensusEligible({ isEarly: true, isProfitable: true, tokenScore: 30 }, 25), true);
  assert.equal(currentConsensusEligible({ isEarly: false, isProfitable: true, tokenScore: 90 }, 25), false);
  assert.equal(currentConsensusEligible({ isEarly: true, isProfitable: false, tokenScore: 90 }, 25), false);
});
