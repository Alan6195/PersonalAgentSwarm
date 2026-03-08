/**
 * Predict Agent: Learning Loop
 *
 * Hypothesis-driven self-improvement, modeled on hypothesis-engine.ts.
 * Memory hygiene baked in from day one:
 * - Dedup via DB query (NOT Claude call)
 * - Superseded hypothesis chain (never leave contradictions active)
 * - Refutation notes required
 * - Pinned model string from config
 * - Loud failure alerts to Telegram
 * - Cap injected hypotheses at 10
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { query, queryOne } from '../../db';
import { logCostEvent } from '../cost-tracker';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const MAX_ACTIVE_HYPOTHESES = 10;
const MAX_INJECTED_HYPOTHESES = 10;

// ── maybeLogHypothesis ───────────────────────────────────────────────

interface HypothesisInput {
  positionId: number;
  category: string;
  direction: string;
  edge: number;
  pnlPct: number;
  marketQuestion: string;
  intelAligned: boolean;
}

/**
 * Fire-and-forget after each resolved trade. Creates implicit hypotheses.
 * Dedup is a DB query: check if hypothesis with same variable + category exists.
 * Cap at MAX_ACTIVE_HYPOTHESES total.
 */
export async function maybeLogHypothesis(input: HypothesisInput): Promise<void> {
  const { positionId, category, edge, pnlPct, intelAligned } = input;
  const isWin = pnlPct >= 0;

  // Generate implicit hypothesis candidates from this trade
  const candidates = [
    {
      variable: `category:${category}`,
      category: 'category',
      hypothesis: `${category} markets have ${isWin ? 'above' : 'below'} average win rate`,
      prediction: isWin ? 'outperform' : 'underperform',
    },
    {
      variable: `edge_threshold:${Math.abs(edge) >= 0.10 ? 'high' : 'low'}`,
      category: 'edge',
      hypothesis: `Markets with edge ${Math.abs(edge) >= 0.10 ? '>= 10%' : '< 10%'} have ${isWin ? 'higher' : 'lower'} win rate`,
      prediction: isWin ? 'outperform' : 'underperform',
    },
    {
      variable: `intel:${intelAligned ? 'aligned' : 'not_aligned'}`,
      category: 'intel',
      hypothesis: `Intel-${intelAligned ? 'aligned' : 'unaligned'} trades have ${isWin ? 'higher' : 'lower'} win rate`,
      prediction: isWin ? 'outperform' : 'underperform',
    },
  ];

  for (const cand of candidates) {
    try {
      // Dedup: check if hypothesis with same variable + category exists in active status
      const existing = await queryOne<any>(
        `SELECT id, win_count, loss_count, evidence_position_ids
         FROM predict_hypotheses
         WHERE variable = $1 AND category = $2 AND status = 'active'`,
        [cand.variable, cand.category]
      );

      if (existing) {
        // Update existing: increment evidence
        const newWin = isWin ? existing.win_count + 1 : existing.win_count;
        const newLoss = isWin ? existing.loss_count : existing.loss_count + 1;
        const ids = existing.evidence_position_ids || [];
        if (!ids.includes(positionId)) ids.push(positionId);

        await query(
          `UPDATE predict_hypotheses
           SET win_count = $1, loss_count = $2, evidence_position_ids = $3, updated_at = NOW()
           WHERE id = $4`,
          [newWin, newLoss, ids, existing.id]
        );

        // Log evidence
        await query(
          `INSERT INTO predict_hypotheses_log (hypothesis_id, position_id, outcome, confidence_delta)
           VALUES ($1, $2, $3, $4)`,
          [existing.id, positionId, isWin ? 'supporting' : 'refuting', isWin ? 0.05 : -0.05]
        );
      } else {
        // Check cap before creating new
        const activeCount = await queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM predict_hypotheses WHERE status = 'active'`
        );
        if (parseInt(activeCount?.count || '0') >= MAX_ACTIVE_HYPOTHESES) {
          continue; // Skip: at cap
        }

        // Create new hypothesis
        const rows = await query<{ id: number }>(
          `INSERT INTO predict_hypotheses
           (hypothesis, variable, category, prediction, win_count, loss_count, evidence_position_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [cand.hypothesis, cand.variable, cand.category, cand.prediction,
           isWin ? 1 : 0, isWin ? 0 : 1, [positionId]]
        );

        if (rows[0]) {
          await query(
            `INSERT INTO predict_hypotheses_log (hypothesis_id, position_id, outcome, confidence_delta)
             VALUES ($1, $2, $3, $4)`,
            [rows[0].id, positionId, isWin ? 'supporting' : 'refuting', isWin ? 0.05 : -0.05]
          );
        }
      }
    } catch (err) {
      console.warn(`[Learn] Failed to log hypothesis for ${cand.variable}:`, (err as Error).message);
    }
  }
}

// ── getConfirmedHypotheses ───────────────────────────────────────────

/**
 * Returns markdown with MEMORY_GUARD framing for injection into Claude prompts.
 * Three sections: CONFIRMED, ACTIVE, REFUTED
 * Ranked by confidence * sqrt(win_count), capped at MAX_INJECTED_HYPOTHESES
 */
export async function getConfirmedHypotheses(): Promise<string> {
  try {
    // Confirmed: ranked by confidence * sqrt(win_count)
    const confirmed = await query<any>(
      `SELECT hypothesis, confidence, win_count, loss_count
       FROM predict_hypotheses
       WHERE status = 'confirmed'
       ORDER BY confidence * sqrt(GREATEST(win_count, 1)) DESC
       LIMIT $1`,
      [MAX_INJECTED_HYPOTHESES]
    );

    // Active: top 5 by confidence
    const active = await query<any>(
      `SELECT hypothesis, confidence, win_count, loss_count
       FROM predict_hypotheses
       WHERE status = 'active' AND confidence >= 40
       ORDER BY confidence DESC
       LIMIT 5`
    );

    // Refuted: with notes
    const refuted = await query<any>(
      `SELECT hypothesis, refutation_note
       FROM predict_hypotheses
       WHERE status = 'refuted' AND refutation_note IS NOT NULL
       ORDER BY resolved_at DESC
       LIMIT 5`
    );

    if (confirmed.length === 0 && active.length === 0 && refuted.length === 0) {
      return '';
    }

    const sections: string[] = [];

    if (confirmed.length > 0) {
      sections.push('CONFIRMED (verified by performance data; follow these):');
      for (const h of confirmed) {
        sections.push(`- [${parseFloat(h.confidence).toFixed(0)}% conf, ${h.win_count}W/${h.loss_count}L] ${h.hypothesis}`);
      }
    }

    if (active.length > 0) {
      sections.push('\nACTIVE (directional hints, weight lightly):');
      for (const h of active) {
        sections.push(`- [${parseFloat(h.confidence).toFixed(0)}% conf, ${h.win_count}W/${h.loss_count}L] ${h.hypothesis}`);
      }
    }

    if (refuted.length > 0) {
      sections.push('\nREFUTED (do not follow these even if they seem logical):');
      for (const h of refuted) {
        sections.push(`- ${h.hypothesis} (refuted: ${h.refutation_note})`);
      }
    }

    return sections.join('\n');
  } catch (err) {
    console.warn('[Learn] Failed to get hypotheses:', (err as Error).message);
    return '';
  }
}

// ── runWeeklyReview ──────────────────────────────────────────────────

/**
 * Weekly Claude-powered hypothesis review.
 * Uses pinned model from config. Loud failure on error.
 */
export async function runWeeklyReview(taskId: number): Promise<string> {
  const reviewerModel = config.PREDICT_REVIEWER_MODEL;

  // Pull 14 days of resolved trades with full reasoning
  const trades = await query<any>(
    `SELECT id, question, category, direction, p_market, p_model, edge,
            pnl, pnl_pct, intel_aligned, reasoning, status
     FROM market_positions
     WHERE closed_at > NOW() - INTERVAL '14 days'
     AND status IN ('closed_win', 'closed_loss')
     ORDER BY closed_at DESC`
  );

  if (trades.length < 3) {
    return 'Insufficient trades for weekly review (need at least 3 resolved trades in 14 days).';
  }

  // Pull active hypotheses
  const hypotheses = await query<any>(
    `SELECT id, hypothesis, variable, category, status, confidence, win_count, loss_count
     FROM predict_hypotheses
     WHERE status IN ('active', 'confirmed')
     ORDER BY status, confidence DESC`
  );

  // Format for Claude
  const tradesJson = trades.map(t => ({
    id: t.id,
    question: t.question.substring(0, 100),
    category: t.category,
    direction: t.direction,
    edge: parseFloat(t.edge),
    pnl: parseFloat(t.pnl),
    intel_aligned: t.intel_aligned,
    outcome: t.status === 'closed_win' ? 'win' : 'loss',
    reasoning_excerpt: t.reasoning?.substring(0, 200) || 'no reasoning',
  }));

  const hypothesesJson = hypotheses.map(h => ({
    id: h.id,
    hypothesis: h.hypothesis,
    variable: h.variable,
    category: h.category,
    status: h.status,
    confidence: parseFloat(h.confidence),
    win_count: h.win_count,
    loss_count: h.loss_count,
  }));

  const prompt = `You are reviewing trading performance for a prediction market agent.

RESOLVED TRADES (last 14 days):
${JSON.stringify(tradesJson, null, 2)}

ACTIVE/CONFIRMED HYPOTHESES:
${JSON.stringify(hypothesesJson, null, 2)}

For each hypothesis:
1. Find supporting or refuting trades in the data above
2. Update confidence (0-100)
3. Mark 'confirmed' if confidence > 80 with 5+ data points (win_count + loss_count >= 5)
4. Mark 'refuted' if confidence < 20 with 5+ data points
5. If two hypotheses contradict: mark the weaker one 'superseded' and explain why

Also identify 1-3 NEW hypotheses suggested by the data patterns.

For any hypothesis you refute, provide a clear refutation_note explaining why.

Output JSON only:
{
  "hypothesis_updates": [
    { "id": 123, "new_confidence": 85, "new_status": "confirmed", "reasoning": "..." }
  ],
  "supersede": [
    { "loser_id": 456, "winner_id": 123, "refutation_note": "why this was wrong" }
  ],
  "new_hypotheses": [
    { "hypothesis": "...", "variable": "...", "category": "edge", "confidence": 60, "prediction": "..." }
  ],
  "summary": "2-3 sentence summary of key findings"
}`;

  // This is the critical call; do NOT swallow errors
  const response = await anthropic.messages.create({
    model: reviewerModel,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  // Track cost
  if (response.usage) {
    try {
      const pricing = config.MODEL_PRICING[reviewerModel] || { input: 80, output: 400 };
      const costCents = Math.ceil(
        (response.usage.input_tokens * pricing.input + response.usage.output_tokens * pricing.output) / 1_000_000
      );
      await logCostEvent({
        agent_id: 'predict-agent',
        task_id: taskId,
        model: reviewerModel,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        cost_cents: costCents,
        event_type: 'predict_hypothesis_review',
      });
    } catch { /* non-critical */ }
  }

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`[Learn] Failed to parse weekly review response: ${text.substring(0, 300)}`);
  }

  const result = JSON.parse(jsonMatch[0]);

  // Apply updates
  let updatedCount = 0;

  if (result.hypothesis_updates) {
    for (const update of result.hypothesis_updates) {
      try {
        await query(
          `UPDATE predict_hypotheses
           SET confidence = $1, status = COALESCE($2, status), updated_at = NOW(),
               resolved_at = CASE WHEN $2 IN ('confirmed', 'refuted') THEN NOW() ELSE resolved_at END
           WHERE id = $3`,
          [update.new_confidence, update.new_status || null, update.id]
        );
        updatedCount++;
      } catch (err) {
        console.warn(`[Learn] Failed to update hypothesis #${update.id}:`, (err as Error).message);
      }
    }
  }

  // Apply supersede
  if (result.supersede) {
    for (const sup of result.supersede) {
      try {
        await query(
          `UPDATE predict_hypotheses
           SET status = 'superseded', superseded_by = $1, refutation_note = $2,
               resolved_at = NOW(), updated_at = NOW()
           WHERE id = $3`,
          [sup.winner_id, sup.refutation_note, sup.loser_id]
        );
      } catch (err) {
        console.warn(`[Learn] Failed to supersede hypothesis #${sup.loser_id}:`, (err as Error).message);
      }
    }
  }

  // Insert new hypotheses
  let newCount = 0;
  if (result.new_hypotheses) {
    for (const nh of result.new_hypotheses) {
      try {
        // Check cap
        const activeCount = await queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM predict_hypotheses WHERE status = 'active'`
        );
        if (parseInt(activeCount?.count || '0') >= MAX_ACTIVE_HYPOTHESES) break;

        await query(
          `INSERT INTO predict_hypotheses (hypothesis, variable, category, prediction, confidence, source)
           VALUES ($1, $2, $3, $4, $5, 'weekly_review')`,
          [nh.hypothesis, nh.variable, nh.category, nh.prediction || '', nh.confidence || 50]
        );
        newCount++;
      } catch (err) {
        console.warn(`[Learn] Failed to insert new hypothesis:`, (err as Error).message);
      }
    }
  }

  const summary = `Weekly Review: ${updatedCount} hypotheses updated, ${result.supersede?.length || 0} superseded, ${newCount} new. ${result.summary || ''}`;
  console.log(`[Learn] ${summary}`);

  return summary;
}
