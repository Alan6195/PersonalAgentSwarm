/**
 * Predict Agent: Model Unit Tests
 *
 * Must pass BEFORE any other file imports model.ts.
 * Run: npx tsx agent-service/src/services/predict/model.test.ts
 */

import {
  kellyFraction,
  fractionalKelly,
  betSize,
  hedgeProfit,
  isHedgeable,
  lmsrProb,
  lmsrCost,
  lmsrShareCost,
  bayesUpdate,
  expectedReturn,
  rewardScore,
} from './model';

let passed = 0;
let failed = 0;

function assert(name: string, actual: number, expected: number, tolerance: number = 0.0001) {
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`  ✓ ${name}: ${actual}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

function assertBool(name: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    console.log(`  ✓ ${name}: ${actual}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

// ── Kelly Criterion Tests ────────────────────────────────────────────

console.log('\n── Kelly Criterion ──');

// kellyFraction(0.60, 2.0) = (0.60 * 1.0 - 0.40) / 1.0 = 0.20
assert('kellyFraction(0.60, 2.0)', kellyFraction(0.60, 2.0), 0.20);

// kellyFraction with no edge: p=0.50, odds=2.0 -> (0.50*1 - 0.50)/1 = 0.0
assert('kellyFraction(0.50, 2.0) no edge', kellyFraction(0.50, 2.0), 0.0);

// kellyFraction with negative edge: p=0.40, odds=2.0 -> (0.40*1 - 0.60)/1 = -0.20
assert('kellyFraction(0.40, 2.0) negative', kellyFraction(0.40, 2.0), -0.20);

// fractionalKelly(0.52, 1.95, 0.25)
// b = 1.95 - 1 = 0.95
// full kelly = (0.52 * 0.95 - 0.48) / 0.95 = (0.494 - 0.48) / 0.95 = 0.014 / 0.95 = 0.014737...
// fractional = 0.014737 * 0.25 = 0.003684...
assert('fractionalKelly(0.52, 1.95, 0.25)', fractionalKelly(0.52, 1.95, 0.25), 0.003684, 0.001);

// ── Bet Size Tests ───────────────────────────────────────────────────

console.log('\n── Bet Size ──');

// betSize(0.60, 2.0, 500)
// fractionalKelly(0.60, 2.0) = 0.20 * 0.25 = 0.05
// bet = 0.05 * 500 = 25.00
// cap = 500 * 0.05 = 25.00
// min(25, 25) = 25.00
assert('betSize(0.60, 2.0, 500)', betSize(0.60, 2.0, 500), 25.00);

// betSize with large edge that exceeds 5% cap
// kellyFraction(0.80, 2.0) = (0.80*1 - 0.20)/1 = 0.60
// fractionalKelly = 0.60 * 0.25 = 0.15
// bet = 0.15 * 500 = 75, but cap = 25
assert('betSize caps at 5%', betSize(0.80, 2.0, 500), 25.00);

// betSize with no edge returns 0
assert('betSize no edge returns 0', betSize(0.50, 2.0, 500), 0.0);

// betSize with negative edge returns 0
assert('betSize negative edge returns 0', betSize(0.40, 2.0, 500), 0.0);

// ── Hedge Detection Tests ────────────────────────────────────────────

console.log('\n── Hedge Detection ──');

// hedgeProfit(0.48, 0.49) = 1.0 - 0.97 = 0.03
assert('hedgeProfit(0.48, 0.49)', hedgeProfit(0.48, 0.49), 0.03);

// hedgeProfit(0.50, 0.50) = 1.0 - 1.0 = 0.0
assert('hedgeProfit(0.50, 0.50)', hedgeProfit(0.50, 0.50), 0.0);

// isHedgeable: 0.03 > 0.005 -> true
assertBool('isHedgeable(0.48, 0.49)', isHedgeable(0.48, 0.49), true);

// isHedgeable: 0.0 > 0.005 -> false
assertBool('isHedgeable(0.50, 0.50)', isHedgeable(0.50, 0.50), false);

// Edge case: barely hedgeable
assertBool('isHedgeable(0.497, 0.497)', isHedgeable(0.497, 0.497), true); // 0.006 > 0.005

// Edge case: not hedgeable
assertBool('isHedgeable(0.498, 0.498)', isHedgeable(0.498, 0.498), false); // 0.004 < 0.005

// ── LMSR Tests ───────────────────────────────────────────────────────

console.log('\n── LMSR ──');

// Two-outcome market: probabilities should sum to 1.0
const q2 = [100, 100];
const p0 = lmsrProb(q2, 0, 100);
const p1 = lmsrProb(q2, 1, 100);
assert('lmsrProb sum to 1.0 (equal)', p0 + p1, 1.0);

// Equal quantities -> equal probabilities
assert('lmsrProb equal quantities -> 0.50', p0, 0.50);

// Asymmetric quantities
const qAsym = [150, 100];
const pAsym0 = lmsrProb(qAsym, 0, 100);
const pAsym1 = lmsrProb(qAsym, 1, 100);
assert('lmsrProb asymmetric sum to 1.0', pAsym0 + pAsym1, 1.0);
assertBool('lmsrProb higher quantity -> higher prob', pAsym0 > pAsym1, true);

// Three-outcome market probabilities sum to 1.0
const q3 = [100, 80, 120];
const sum3 = lmsrProb(q3, 0, 50) + lmsrProb(q3, 1, 50) + lmsrProb(q3, 2, 50);
assert('lmsrProb 3-outcome sum to 1.0', sum3, 1.0);

// Cost increases when buying shares
const costBefore = lmsrCost([100, 100], 100);
const costAfter = lmsrCost([110, 100], 100);
assertBool('lmsrCost increases with more shares', costAfter > costBefore, true);

// Share cost is positive for buying
const shareCost = lmsrShareCost([100, 100], 100, 0, 10);
assertBool('lmsrShareCost positive for buying', shareCost > 0, true);

// ── Bayesian Tests ───────────────────────────────────────────────────

console.log('\n── Bayesian ──');

// Uniform prior with strong likelihood
const posterior = bayesUpdate(0.5, 0.9, 0.5);
assert('bayesUpdate strong likelihood', posterior, 0.9);

// Identity update: likelihood equals marginal
const identity = bayesUpdate(0.6, 0.5, 0.5);
assert('bayesUpdate identity (lik == marginal)', identity, 0.6);

// Zero marginal returns prior (edge case)
const zeroMarginal = bayesUpdate(0.7, 0.5, 0);
assert('bayesUpdate zero marginal returns prior', zeroMarginal, 0.7);

// ── Expected Return Tests ────────────────────────────────────────────

console.log('\n── Expected Return ──');

assert('expectedReturn positive', expectedReturn(10, 2, 50), 0.16);
assert('expectedReturn zero capital', expectedReturn(10, 2, 0), 0);
assert('expectedReturn negative', expectedReturn(2, 10, 50), -0.16);

// ── Reward Score Tests ───────────────────────────────────────────────

console.log('\n── Reward Score ──');

const score1 = rewardScore({
  edge: 0.10,
  kellyFrac: 0.05,
  liquidity: 1000,
  closeDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  volume: 5000,
});
assertBool('rewardScore positive for good market', score1 > 0, true);

// Higher edge -> higher score
const score2 = rewardScore({
  edge: 0.20,
  kellyFrac: 0.05,
  liquidity: 1000,
  closeDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  volume: 5000,
});
assertBool('rewardScore higher edge -> higher score', score2 > score1, true);

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\n✗ TESTS FAILED. Do not proceed to Phase 3.');
  process.exit(1);
} else {
  console.log('\n✓ All tests passed. Phase 3 (risk-gate.ts) is unblocked.');
}
