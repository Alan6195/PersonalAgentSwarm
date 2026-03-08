/**
 * Predict Agent: Performance Context
 *
 * Builds the performance brief injected into each Claude scan cycle.
 * Shows top/bottom performers with full reasoning, plus computed PATTERN line.
 *
 * Memory hygiene: PATTERN line requires minimum 10 resolved trades.
 * Below 10, injects explicit insufficient-data message.
 */

import { query } from '../../db';

const MIN_TRADES_FOR_PATTERN = 10;

/**
 * Build performance brief for Claude probability estimation context
 */
export async function buildPerformanceBrief(): Promise<string> {
  try {
    // Get recent resolved trades with reasoning
    const trades = await query<any>(
      `SELECT id, question, direction, p_market, p_model, edge, pnl, pnl_pct,
              intel_aligned, reasoning, category, status
       FROM market_positions
       WHERE closed_at > NOW() - INTERVAL '14 days'
       AND status IN ('closed_win', 'closed_loss')
       ORDER BY closed_at DESC
       LIMIT 50`
    );

    if (trades.length === 0) return '';

    // Top performers (best P&L)
    const sorted = [...trades].sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
    const top = sorted.slice(0, 3);
    const bottom = sorted.slice(-3).reverse();

    const sections: string[] = [];

    sections.push('TOP PERFORMERS (last 14 days):');
    for (let i = 0; i < top.length; i++) {
      const t = top[i];
      const pnl = parseFloat(t.pnl);
      const edge = parseFloat(t.edge);
      sections.push(`${i + 1}. "${t.question.substring(0, 60)}" ${t.direction} @ ${parseFloat(t.p_market).toFixed(2)} -> ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | edge: ${(edge * 100).toFixed(0)}c | intel: ${t.intel_aligned ? 'aligned' : 'not aligned'}`);
      if (t.reasoning) {
        sections.push(`   reasoning: "${t.reasoning.substring(0, 150)}"`);
      }
    }

    sections.push('\nBOTTOM PERFORMERS:');
    for (let i = 0; i < bottom.length; i++) {
      const t = bottom[i];
      const pnl = parseFloat(t.pnl);
      const edge = parseFloat(t.edge);
      sections.push(`${i + 1}. "${t.question.substring(0, 60)}" ${t.direction} @ ${parseFloat(t.p_market).toFixed(2)} -> ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | edge: ${(edge * 100).toFixed(0)}c | intel: ${t.intel_aligned ? 'aligned' : 'not aligned'}`);
      if (t.reasoning) {
        sections.push(`   reasoning: "${t.reasoning.substring(0, 150)}"`);
      }
    }

    // PATTERN line: requires minimum trades
    if (trades.length >= MIN_TRADES_FOR_PATTERN) {
      const pattern = computePattern(trades);
      sections.push(`\nPATTERN: ${pattern}`);
    } else {
      sections.push(`\nPATTERN: Insufficient data (${trades.length}/${MIN_TRADES_FOR_PATTERN} trades resolved). Pattern analysis pending.`);
    }

    return sections.join('\n');
  } catch (err) {
    console.warn('[Context] Failed to build performance brief:', (err as Error).message);
    return '';
  }
}

/**
 * Compute pattern line from trade data.
 * Only called when trades.length >= MIN_TRADES_FOR_PATTERN.
 */
function computePattern(trades: any[]): string {
  const patterns: string[] = [];

  // Intel alignment correlation
  const intelAligned = trades.filter(t => t.intel_aligned);
  const intelNotAligned = trades.filter(t => !t.intel_aligned);

  if (intelAligned.length >= 2) {
    const alignedWins = intelAligned.filter(t => t.status === 'closed_win').length;
    const alignedRate = (alignedWins / intelAligned.length * 100).toFixed(0);
    patterns.push(`Intel-aligned ${alignedWins}/${intelAligned.length} wins (${alignedRate}%)`);
  }

  if (intelNotAligned.length >= 2) {
    const notAlignedWins = intelNotAligned.filter(t => t.status === 'closed_win').length;
    const notAlignedRate = (notAlignedWins / intelNotAligned.length * 100).toFixed(0);
    patterns.push(`Non-aligned ${notAlignedWins}/${intelNotAligned.length} wins (${notAlignedRate}%)`);
  }

  // Edge threshold analysis
  const highEdge = trades.filter(t => Math.abs(parseFloat(t.edge)) >= 0.08);
  const lowEdge = trades.filter(t => Math.abs(parseFloat(t.edge)) < 0.08);

  if (highEdge.length >= 2) {
    const highWins = highEdge.filter(t => t.status === 'closed_win').length;
    patterns.push(`Edge >= 8c: ${highWins}/${highEdge.length} wins`);
  }

  if (lowEdge.length >= 2) {
    const lowWins = lowEdge.filter(t => t.status === 'closed_win').length;
    patterns.push(`Edge < 8c: ${lowWins}/${lowEdge.length} wins`);
  }

  // Category breakdown
  const categories = new Map<string, { wins: number; total: number }>();
  for (const t of trades) {
    const cat = t.category || 'other';
    const entry = categories.get(cat) || { wins: 0, total: 0 };
    entry.total++;
    if (t.status === 'closed_win') entry.wins++;
    categories.set(cat, entry);
  }

  for (const [cat, data] of categories) {
    if (data.total >= 3) {
      patterns.push(`${cat}: ${data.wins}/${data.total} wins`);
    }
  }

  return patterns.join('. ') + '.';
}
