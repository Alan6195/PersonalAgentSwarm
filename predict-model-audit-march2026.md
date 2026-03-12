# Predict Model Crypto Audit -- March 2026

## Summary

The prediction model has structural issues that must be fixed before deploying real USDC on Polymarket 5/15-minute crypto markets. The bayesUpdate function is mathematically incorrect and can produce probabilities above 1.0 in edge cases. Volume and liquidity data are not being persisted to the database, so the reward scoring and any future liquidity gating are operating on zeros. The intel signal pipeline (shared_signals) is completely empty; no X agent signals have ever been written, so the entire intel branch of the Bayesian pipeline contributes nothing. The momentum signal branch is functional but untested in production (price feed only recently connected). Polymarket taker fees on 15-minute markets are up to 3%, which significantly erodes the current 6-cent edge threshold. These issues are individually addressable; none require an architectural redesign.

## Critical Issues (fix before going live)

### C1: bayesUpdate is mathematically incorrect

**File:** `model.ts:54-57`

```typescript
export function bayesUpdate(prior: number, likelihood: number, marginal: number): number {
  if (marginal === 0) return prior;
  return (likelihood * prior) / marginal;
}
```

The function implements `P(H|E) = P(E|H) * P(H) / P(E)` but the caller always passes `marginal = 0.50` (a fixed base rate). The true marginal should be computed as:

```
P(E) = P(E|Up) * P(Up) + P(E|Down) * P(Down)
```

With the current implementation, when both `likelihood` and `prior` are above 0.50, the output exceeds 1.0. For example: `bayesUpdate(0.55, 0.65, 0.50) = 0.715` when the correct posterior is approximately 0.613.

For near-50/50 markets (which most crypto Up/Down markets are), the error is small (1-3%) because `prior` stays near 0.50. But when chaining two signals (momentum then intel), the second update uses the already-shifted posterior, amplifying the error.

**Fix:** Replace with log-odds form that cannot produce invalid probabilities:

```typescript
export function bayesUpdate(prior: number, likelihoodUp: number, likelihoodDown?: number): number {
  prior = Math.max(0.01, Math.min(0.99, prior));
  const lDown = likelihoodDown ?? (1 - likelihoodUp);
  const priorOdds = prior / (1 - prior);
  const lr = likelihoodUp / lDown;
  const postOdds = priorOdds * lr;
  return Math.max(0.01, Math.min(0.99, postOdds / (1 + postOdds)));
}
```

### C2: Volume and liquidity not persisted to DB

**File:** `scan-polymarket.ts:370-371`

The scanner writes `volume_usd = 0` and `liquidity_usd = 0` to every market_scans row. The `fetchOrderBook()` function does extract `totalLiquidity` and `volume24h` from the CLOB, but these values are stored locally in the `analyzed` array and then overwritten with zeros in the INSERT:

```typescript
// Line 370-371 of the INSERT:
a.platform, a.id, a.url, a.question, a.category, a.pYes, 0, 0,  // <-- hardcoded zeros
```

This means:
1. `rewardScore()` gets `liquidity = 0` and `volume = 0`, making `liqFactor = 0` and `volFactor = 0`, which multiplies the entire score to 0. The only reason scores aren't all zero is that `Math.log10(Math.max(1, 0))` evaluates to `log10(1) = 0`, and then `(liqFactor + volFactor)` = 0, making all scores 0.
2. No liquidity-based filtering is possible without this data.

**Fix:** Pass `a.totalLiquidity` (or a new field from the analyzed candidate) instead of `0` for volume_usd and liquidity_usd. Currently the PolyCandidate interface doesn't store these; add them.

### C3: Taker fees not accounted for in edge calculation

Polymarket charges taker fees on 15-minute crypto markets. Research indicates fees up to 3% at the 50% probability point (where most Up/Down markets trade). The fee structure is dynamic and highest near 50/50.

Current edge threshold: 6 cents. With a 3% fee on a $0.50 contract:
- Fee per contract: $0.015
- Net edge after fee: 6c - 1.5c = 4.5c
- This is barely above the noise floor

For a $2.50 position (5% of $50 bankroll), the fee is $0.075 (3% of $2.50). The gross edge is $0.15 (6c * $2.50). Net profit: $0.075. This is a 50% haircut.

**Fix:** Either:
- (a) Raise minimum edge to 9-10 cents for Polymarket 15-min markets, or
- (b) Subtract estimated fee from edge before comparing to threshold, or
- (c) Query the actual fee rate from `https://clob.polymarket.com/neg-risk-adapter` and compute net edge dynamically

Option (b) is recommended. Add `POLY_TAKER_FEE_PCT = 0.03` to config and compute `netEdge = absEdge - takerFee` before the threshold check.

## Recommended Tuning (improve edge quality)

### R1: LMSR b parameter may be too large for most markets

With `b = 100,000`, the LMSR probability barely deviates from market price for typical order books. Analysis of 530 recent scans:

- 190 scans (36%): p_lmsr == market_prob (zero deviation)
- For markets near 50/50: average deviation is 0.0005 (0.05 cents)
- For markets with skewed books (near expiry): deviation reaches 3-7%

The LMSR is currently a near-passthrough for the market price. It only adds signal for markets with extremely skewed order books.

**Recommendation:** Reduce `b` to 1,000-5,000 for 5/15-minute markets. This will make LMSR more responsive to order book imbalance. Test with `b = 2,000` and monitor p_lmsr dispersion; target 1-3% typical deviation from market price.

However: given that the Bayesian update has its own calibration issues (C1 above), fixing bayesUpdate should come first. Then re-evaluate whether LMSR tuning is needed.

### R2: Momentum signal has no history yet

All momentum values in the DB are "neutral" with 0 return. The price feed was only recently connected and hasn't accumulated enough ticks to compute meaningful momentum.

- `strong_up` (0.65), `up` (0.58) thresholds appear aggressive for 5-minute crypto windows
- Backtesting literature suggests 55-60% win rate for momentum models on BTC 5-min candles
- The 15-minute dampening factor (0.6x) reduces `strong_up` to `0.50 + 0.15 * 0.6 = 0.59`

**Recommendation:**
- Reduce `strong_up` from 0.65 to 0.62
- Keep `up` at 0.58 (aligns with backtesting literature)
- Increase 15-min dampening from 0.6 to 0.75 (momentum is more predictive over 15 min than 5 min; 0.6 dampens too much)
- Wait for 50+ scans with real momentum data before further tuning

### R3: Intel signal pipeline provides zero value

The `shared_signals` table has **zero rows**. The X agent intelligence scanner is wired to write signals but has never produced any. This means:
- `getIntelSummary()` always returns null or signalCount=0
- The intel branch of the Bayesian update never fires
- `intelAligned` is always false

This is not a model calibration issue; it's a pipeline issue. The X agent either:
1. Never writes to shared_signals (check x-intelligence.ts bridge code), or
2. Writes signals that don't match the expected schema, or
3. Is not running scans that produce crypto-relevant signals

**Recommendation:** Before going live, either:
- Fix the X agent to write crypto signals to shared_signals (preferred), or
- Remove the intel branch from the Bayesian pipeline entirely (it adds code complexity for zero signal)

If the pipeline is fixed, the current calibration (+/-12% max shift, 0.8x for 15-min, 0.5x for 5-min) should be reduced:
- Max shift: 8% for 15-min, 5% for 5-min (sentiment rarely moves 15-min crypto price more than 1-2%)
- Exception: breaking news (exchange hacks, regulatory) should have higher weight. Add `signal_type` check.

### R4: Reward score is always zero due to missing liquidity

Because volume and liquidity are both zero in the DB (C2), the reward score formula:

```typescript
return Math.abs(edge) * kellyFrac * timeDecay * (liqFactor + volFactor) * 100;
```

produces `... * (0 + 0) * 100 = 0` for every candidate. Markets are currently ranked by insertion order, not by quality. This means the "best" candidate is arbitrary.

Fix C2 first, then verify that reward scores produce meaningful differentiation.

## Deferred (post-live improvements)

### D1: Market timing filter

Current scans include markets with as little as 5 minutes remaining. For 5-minute markets, a market with 5 minutes remaining is about to close. By the time a CLOB order is placed and filled, the market may have resolved.

**Recommendation:** Add minimum time-remaining filter:
- 5-min markets: skip if < 2 min remaining
- 15-min markets: skip if < 3 min remaining

This requires parsing the window end time from the market title or using the `endDate` field from Gamma. The data shows `mins_remaining` ranges from 5.0 to 15.0 in current scans, suggesting the scanner already avoids near-expiry markets to some degree, but no hard cutoff exists.

### D2: Minimum liquidity gate

No liquidity-based filtering exists. Even after fixing C2 to persist liquidity data, a minimum threshold should be enforced:
- Reject markets with total order book depth < $500
- For the current $50 bankroll with $2.50 max bet, a $500 liquidity floor means max 0.5% market impact

This is deferred because the current dry-run mode doesn't execute trades on Polymarket; it only records what it would have done. But once live, this is essential.

### D3: VaR95 check uses point estimate

The VaR check in risk-gate.ts computes:

```typescript
const var95 = pModel - 1.645 * Math.sqrt(pModel * (1 - pModel));
```

This uses the binomial standard deviation, which assumes `pModel` is the true probability. But `pModel` is itself an estimate with uncertainty. The VaR should incorporate model uncertainty:

```
var95 = pModel - 1.645 * sqrt(pModel * (1-pModel) + model_uncertainty^2)
```

Deferred because the current 5% Kelly fraction and $2.50 max bet provide sufficient protection.

### D4: Kelly fraction recalibration after 30 trades

The 15% fractional Kelly for Polymarket is reasonable for a new model with unknown edge quality. After 30+ resolved trades, recalculate optimal Kelly from empirical data:

```
f* = (empirical_win_rate * avg_odds - (1 - empirical_win_rate)) / avg_odds
fractional = 0.15 * f*
```

If win rate > 60%, consider increasing to 20%. If < 52%, reduce to 10% or pause.

### D5: checkSystemPause uses Manifold risk limits for Polymarket

In `risk-gate.ts:135`, `checkSystemPause()` uses `RISK_LIMITS` (Manifold limits) instead of `getRiskLimits(platform)`:

```typescript
if (Math.abs(today.daily_loss) >= bankroll * RISK_LIMITS.dailyLossPausePct) {
```

This should use `getRiskLimits(platform)` for platform-specific limits. Currently both have the same thresholds (8% daily loss, 15% drawdown) so it doesn't matter, but it would break if platform-specific limits diverge.

## Parameters: Current vs Recommended

| Parameter | Current | Recommended | Rationale |
|---|---|---|---|
| LMSR b | 100,000 | 2,000-5,000 | Current b produces <0.05% deviation from market price for most markets. Needs more sensitivity to order book imbalance. |
| bayesUpdate formula | `(L*P)/M` with fixed M=0.50 | Log-odds form | Current formula can produce p > 1.0. Log-odds is numerically stable and correct. CRITICAL FIX. |
| strong_up likelihood | 0.65 | 0.62 | Backtesting literature suggests 55-60% momentum WR on BTC 5m. 0.65 is aggressive. |
| up likelihood | 0.58 | 0.58 (keep) | Aligns with empirical data. |
| 15min momentum dampening | 0.60 | 0.75 | 0.60 over-dampens. Momentum is more predictive over 15m than 5m; increase factor. |
| intel max shift | +/-12% | +/-8% (15m), +/-5% (5m) | Sentiment rarely moves crypto >1-2% in 15 min. Exception: breaking news should be higher. |
| min edge threshold (Poly) | 6c | 9c (or 6c with fee subtraction) | Taker fees up to 3% at 50% prob. 6c gross = ~3c net after fees. Need higher gross or fee-adjusted threshold. |
| Kelly fraction (Poly) | 15% | 15% (keep) | Appropriate for new model. Recalibrate after 30 trades. |
| min liquidity | none | $500 total depth | Prevent trading illiquid markets where $2.50 bet moves price. Deferred until volume/liquidity data persisted. |
| min time remaining | none | 2 min (5m), 3 min (15m) | Prevent orders placed after market resolution. Deferred. |
| volume_usd/liquidity_usd in DB | hardcoded 0 | actual values from CLOB | Reward score, liquidity gating, and audit capability all depend on this data. CRITICAL FIX. |

## Appendix: Raw Data Samples

### LMSR Deviation Distribution (530 scans)
- 36% of scans: zero deviation (LMSR == market price)
- Near-50/50 markets: avg deviation 0.0005 (0.05c)
- Skewed markets (near expiry): max deviation up to 33c

### Momentum Signal Distribution
- 100% of signals: "neutral" (price feed recently connected)
- Zero "up", "down", "strong_up", or "strong_down" signals recorded

### Market Timing (20 most recent scans)
- Scan minute: all at :15 past the hour
- Minutes remaining: 5.0 to 15.0
- 5-minute markets scanned with 5.0 min remaining (borderline)
- 15-minute markets scanned with 15.0 min remaining (fine)

### Trade Statistics (Manifold only)
- 5 total trades, avg bet M$40.75, max M$50.00
- Avg Kelly fraction: 7.1%, max: 13.65%
- No Polymarket trades (dry-run mode)

### Intel Signals
- shared_signals table: 0 rows (empty)
- Intel branch of Bayesian update never fires
