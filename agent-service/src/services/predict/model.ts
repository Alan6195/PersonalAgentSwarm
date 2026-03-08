/**
 * Predict Agent: Core Math Module
 *
 * All formula evaluation is pure TypeScript. Zero Claude calls.
 * Deterministic, stateless, no side effects.
 *
 * Claude handles qualitative probability estimation only (in scan.ts).
 * This module handles: LMSR, Bayesian updates, Kelly sizing, hedge detection, reward scoring.
 */

// ── LMSR (Logarithmic Market Scoring Rule) ───────────────────────────

/**
 * LMSR cost function: C(q) = b * ln(sum(e^(qi/b)))
 * @param quantities Array of outstanding shares per outcome
 * @param b Liquidity parameter (higher = more liquid, less price impact)
 */
export function lmsrCost(quantities: number[], b: number): number {
  const maxQ = Math.max(...quantities);
  // Numerically stable: factor out max to avoid overflow
  const sumExp = quantities.reduce((sum, qi) => sum + Math.exp((qi - maxQ) / b), 0);
  return b * (maxQ / b + Math.log(sumExp));
}

/**
 * LMSR implied probability for outcome i
 * p_i = e^(q_i/b) / sum(e^(q_j/b))
 */
export function lmsrProb(quantities: number[], i: number, b: number): number {
  const maxQ = Math.max(...quantities);
  const expQ = quantities.map(qi => Math.exp((qi - maxQ) / b));
  const sumExp = expQ.reduce((s, v) => s + v, 0);
  return expQ[i] / sumExp;
}

/**
 * Cost to buy `shares` of outcome `i` in an LMSR market
 * = C(q with q_i + shares) - C(q)
 */
export function lmsrShareCost(quantities: number[], b: number, outcomeIndex: number, shares: number): number {
  const before = lmsrCost(quantities, b);
  const after = lmsrCost(
    quantities.map((q, idx) => idx === outcomeIndex ? q + shares : q),
    b
  );
  return after - before;
}

// ── Bayesian Updates ─────────────────────────────────────────────────

/**
 * Bayesian posterior update: P(H|E) = P(E|H) * P(H) / P(E)
 */
export function bayesUpdate(prior: number, likelihood: number, marginal: number): number {
  if (marginal === 0) return prior;
  return (likelihood * prior) / marginal;
}

/**
 * Log-space posterior for numerical stability with multiple signals
 */
export function logPosterior(logPrior: number, logLikelihoods: number[]): number {
  return logPrior + logLikelihoods.reduce((s, l) => s + l, 0);
}

// ── Kelly Criterion ──────────────────────────────────────────────────

/**
 * Full Kelly fraction: f* = (p*b - q) / b
 * where b = decimal odds - 1, q = 1 - p
 * @param winProb Estimated probability of winning
 * @param decimalOdds Decimal odds (e.g., 2.0 for even money)
 * @returns Fraction of bankroll to bet (can be negative = don't bet)
 */
export function kellyFraction(winProb: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  const q = 1 - winProb;
  if (b <= 0) return 0;
  return (winProb * b - q) / b;
}

/**
 * Fractional Kelly (default 25%) to reduce variance
 */
export function fractionalKelly(winProb: number, decimalOdds: number, fraction: number = 0.25): number {
  return kellyFraction(winProb, decimalOdds) * fraction;
}

/**
 * Final bet size with hard cap at 5% of bankroll
 * Returns 0 if Kelly is negative (no edge)
 */
export function betSize(winProb: number, decimalOdds: number, bankroll: number): number {
  const f = fractionalKelly(winProb, decimalOdds);
  if (f <= 0) return 0;
  return Math.min(f * bankroll, bankroll * 0.05);
}

// ── Hedge Detection ──────────────────────────────────────────────────

/**
 * Hedge profit: pi = 1 - (pYes + pNo)
 * If both sides fill and pYes + pNo < 1, locked profit
 */
export function hedgeProfit(pYes: number, pNo: number): number {
  return 1.0 - (pYes + pNo);
}

/**
 * Is the market hedgeable? Requires > 0.5c locked profit
 */
export function isHedgeable(pYes: number, pNo: number): boolean {
  return hedgeProfit(pYes, pNo) > 0.005;
}

// ── Reward Scoring ───────────────────────────────────────────────────

/**
 * Reward score for ranking scanned markets
 * Composite of edge, Kelly sizing, time decay, and liquidity
 */
export function rewardScore(params: {
  edge: number;
  kellyFrac: number;
  liquidity: number;
  closeDate: Date;
  volume: number;
}): number {
  const { edge, kellyFrac, liquidity, closeDate, volume } = params;

  // Time decay: markets closing sooner get higher scores
  const daysToClose = Math.max(1, (closeDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const timeDecay = 1 / Math.sqrt(daysToClose);

  // Liquidity factor: log scale, normalized
  const liqFactor = Math.log10(Math.max(1, liquidity)) / 5;

  // Volume factor: log scale
  const volFactor = Math.log10(Math.max(1, volume)) / 5;

  // Composite: edge is dominant, modulated by sizing and market quality
  return Math.abs(edge) * kellyFrac * timeDecay * (liqFactor + volFactor) * 100;
}

// ── Expected Return ──────────────────────────────────────────────────

/**
 * Expected return: E[R] = (Rewards - FillLoss) / CapitalAtRisk
 * Only enter if E[R] > 0
 */
export function expectedReturn(rewards: number, fillLoss: number, capitalAtRisk: number): number {
  if (capitalAtRisk <= 0) return 0;
  return (rewards - fillLoss) / capitalAtRisk;
}

/**
 * Simple edge-based expected return for Manifold (no fill risk)
 * E[R] = edge * kellyFraction
 */
export function simpleExpectedReturn(edge: number, kellyFrac: number): number {
  return Math.abs(edge) * kellyFrac;
}
