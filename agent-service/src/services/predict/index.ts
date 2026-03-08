/**
 * Predict Agent: Barrel Exports
 *
 * Re-exports from all predict service modules for convenient importing.
 */

// Core math
export { lmsrCost, lmsrProb, lmsrShareCost, bayesUpdate, logPosterior, kellyFraction, fractionalKelly, betSize, hedgeProfit, isHedgeable, rewardScore, expectedReturn, simpleExpectedReturn } from './model';

// Risk gate
export { validateTrade, checkSystemPause, updateDailyRisk, recordTradeOpened, recordTradeClosed, resetDailyRisk, RISK_LIMITS } from './risk-gate';
export type { TradeCandidate, RiskCheck } from './risk-gate';

// Scanner
export { scanManifold, analyzeMarkets, validateModelAccess } from './scan';
export type { AnalyzedMarket } from './scan';

// Execution
export { executeTrade, reconcilePositions, getManifoldBalance, getCurrentBankroll, getTradeStats } from './execute';
export type { TradeResult, ReconcileResult } from './execute';

// Learning
export { maybeLogHypothesis, getConfirmedHypotheses, runWeeklyReview } from './learn';

// Performance context
export { buildPerformanceBrief } from './context';

// Cron handlers
export { handleManifoldScan, handleEquitySnapshot, handleDailyRiskReset, handleResolutionCheck, handleHypothesisReview } from './cron';

// Telegram commands
export { handlePredictCommand } from './telegram';
