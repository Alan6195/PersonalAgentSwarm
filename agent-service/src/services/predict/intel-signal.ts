/**
 * Intel Signal Reader
 *
 * Reads from shared_signals table (populated by X agent intel scans).
 * Computes a decayed, aggregated sentiment summary per asset for
 * use in the Polymarket scanner's Bayesian prior update.
 *
 * Signal decay: full weight < 1 hour, half weight 1-4 hours, zero > 4 hours.
 */

import { query } from '../../db';

export interface IntelSummary {
  asset: string;
  bullishStrength: number;  // 0.0 - 1.0 net bullish signal
  bearishStrength: number;  // 0.0 - 1.0 net bearish signal
  netSentiment: number;     // -1.0 to +1.0 (positive = bullish)
  signalCount: number;
  freshestSignalAge: number; // minutes
}

/**
 * Get aggregated intel summary for a specific crypto asset.
 * Pulls from shared_signals where topic mentions the asset.
 * Signals older than 4 hours are ignored; remaining signals are decayed.
 */
export async function getIntelSummary(asset: string): Promise<IntelSummary | null> {
  const rows = await query<any>(
    `SELECT
       topic, direction, strength,
       EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 as age_minutes
     FROM shared_signals
     WHERE
       (LOWER(topic) LIKE $1 OR LOWER(topic) LIKE $2)
       AND created_at > NOW() - INTERVAL '4 hours'
     ORDER BY created_at DESC`,
    [`%${asset.toLowerCase()}%`, `%${assetFull(asset).toLowerCase()}%`]
  );

  if (rows.length === 0) return null;

  let bullishStrength = 0;
  let bearishStrength = 0;
  let freshestAge = Infinity;

  for (const row of rows) {
    const ageMinutes = parseFloat(row.age_minutes);
    const rawStrength = parseFloat(row.strength || '0.5');

    // Decay: linear from 1.0 at 0min to 0.5 at 60min to 0.0 at 240min
    let decayedStrength: number;
    if (ageMinutes < 60) {
      decayedStrength = rawStrength * (1 - ageMinutes / 120);
    } else {
      decayedStrength = rawStrength * Math.max(0, 1 - (ageMinutes - 60) / 360);
    }

    if (decayedStrength <= 0) continue;

    const isBullish = ['bullish', 'accelerating', 'positive', 'surging'].includes(row.direction?.toLowerCase());
    const isBearish = ['bearish', 'decelerating', 'negative', 'declining'].includes(row.direction?.toLowerCase());

    if (isBullish) bullishStrength = Math.min(1.0, bullishStrength + decayedStrength);
    if (isBearish) bearishStrength = Math.min(1.0, bearishStrength + decayedStrength);
    if (ageMinutes < freshestAge) freshestAge = ageMinutes;
  }

  return {
    asset,
    bullishStrength,
    bearishStrength,
    netSentiment: bullishStrength - bearishStrength,
    signalCount: rows.length,
    freshestSignalAge: freshestAge === Infinity ? 999 : freshestAge,
  };
}

function assetFull(asset: string): string {
  const map: Record<string, string> = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'xrp',
  };
  return map[asset] || asset;
}
