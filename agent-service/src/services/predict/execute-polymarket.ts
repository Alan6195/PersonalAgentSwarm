/**
 * Predict Agent: Polymarket Trade Execution
 *
 * Phase 2: Real USDC on Polymarket CLOB.
 * Handles order placement, fill monitoring with slippage guard,
 * and position tracking.
 *
 * Gated by PREDICT_POLY_DRY_RUN=true (default). When dry run,
 * logs everything but does not place orders.
 */

import { config } from '../../config';
import { query } from '../../db';
import { validateTrade, recordTradeOpened, type TradeCandidate } from './risk-gate';
import type { PolyCandidate } from './scan-polymarket';

const CLOB_BASE = 'https://clob.polymarket.com';

export interface PolyTradeResult {
  success: boolean;
  positionId?: number;
  orderId?: string;
  error?: string;
  riskRejection?: string;
  dryRun: boolean;
}

interface FillResult {
  filled: boolean;
  slippageExceeded: boolean;
  fillPrice: number;
}

/**
 * Execute a trade on Polymarket (runs risk gate first)
 */
export async function executePolymarketTrade(
  market: PolyCandidate,
  bankroll: number,
): Promise<PolyTradeResult> {
  const isDryRun = config.PREDICT_POLY_DRY_RUN;

  // Risk gate check
  const candidate: TradeCandidate = {
    platform: 'polymarket',
    category: market.category,
    positionSizePct: market.betAmount / bankroll,
    betSize: market.betAmount,
    edge: market.edge,
    expectedReturn: market.expectedRet,
    pModel: market.pBayes,
  };

  const riskCheck = await validateTrade(candidate, bankroll);
  if (!riskCheck.approved) {
    console.log(`[PolyExec] Risk gate BLOCKED: ${market.question.substring(0, 50)} (reason: ${riskCheck.rejectionReason})`);
    return { success: false, riskRejection: riskCheck.rejectionReason, dryRun: isDryRun };
  }

  if (isDryRun) {
    console.log(`[PolyExec] DRY RUN: Would place ${market.direction} on "${market.question.substring(0, 60)}" for $${riskCheck.betSize.toFixed(2)}`);
    console.log(`[PolyExec] DRY RUN: edge=${(market.edge * 100).toFixed(1)}c, kelly=${(market.kellyFrac * 100).toFixed(1)}%, pBayes=${market.pBayes.toFixed(4)}`);

    // Record as dry run scan (not a real position)
    return { success: true, dryRun: true };
  }

  // Live execution
  return await placePolymarketOrder(market, riskCheck.betSize, bankroll);
}

/**
 * Place an order on Polymarket CLOB
 */
async function placePolymarketOrder(
  market: PolyCandidate,
  amount: number,
  bankroll: number,
): Promise<PolyTradeResult> {
  if (!config.POLYMARKET_API_KEY || !config.POLYMARKET_WALLET_KEY) {
    return { success: false, error: 'Polymarket credentials not configured', dryRun: false };
  }

  const tokenId = market.direction === 'YES' ? market.yesTokenId : market.noTokenId;
  const limitPrice = market.direction === 'YES' ? market.pYes : (1 - market.pYes);

  console.log(`[PolyExec] Placing order: ${market.direction} on "${market.question.substring(0, 60)}" for $${amount.toFixed(2)} @ ${limitPrice.toFixed(4)}`);

  try {
    // Size in USDC (6 decimals on Polygon)
    const sizeUsdc = Math.floor(amount * 1_000_000);

    const orderPayload = {
      tokenID: tokenId,
      price: limitPrice.toFixed(4),
      size: sizeUsdc,
      side: 'BUY',
      feeRateBps: 0,
      nonce: Date.now().toString(),
      expiration: 0, // GTC
    };

    // Sign the order with the Polygon wallet
    const signedPayload = await signOrder(orderPayload);

    const res = await fetch(`${CLOB_BASE}/order`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.POLYMARKET_API_KEY}`,
        'Content-Type': 'application/json',
        'POLY-ADDRESS': config.POLYMARKET_WALLET_ADDRESS,
        'POLY-SIGNATURE': signedPayload.signature,
        'POLY-TIMESTAMP': signedPayload.timestamp,
        'POLY-NONCE': signedPayload.nonce,
      },
      body: JSON.stringify(orderPayload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[PolyExec] Order failed: ${res.status} ${errText}`);
      return { success: false, error: `CLOB API ${res.status}: ${errText.substring(0, 200)}`, dryRun: false };
    }

    const order = await res.json() as any;
    const orderId = order.orderID || order.id;

    // Monitor fill with slippage guard
    const fill = await monitorFill(orderId, limitPrice);

    if (!fill.filled) {
      console.log(`[PolyExec] Order not filled (timeout or cancelled): ${orderId}`);
      return { success: false, error: 'Order not filled within timeout', dryRun: false };
    }

    if (fill.slippageExceeded) {
      console.warn(`[PolyExec] Slippage exceeded on fill: ${orderId}, price=${fill.fillPrice.toFixed(4)} vs expected=${limitPrice.toFixed(4)}`);
    }

    // Record position in DB
    const rows = await query<{ id: number }>(
      `INSERT INTO market_positions
       (platform, market_id, market_url, question, category, asset, direction,
        p_market, p_model, edge, kelly_fraction, bet_size, fill_price,
        reward_score, expected_return, intel_signal_id, intel_aligned,
        reasoning, bet_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        'polymarket', market.id, market.url, market.question, market.category,
        market.asset, market.direction,
        market.pYes, market.pBayes, market.edge, market.kellyFrac,
        amount, fill.fillPrice,
        market.score, market.expectedRet,
        market.intelSignalId, market.intelAligned,
        market.reasoning,
        orderId,
      ]
    );

    const positionId = rows[0]?.id;

    // Update risk state
    await recordTradeOpened('polymarket', amount, bankroll);

    // Mark intel signals as consumed
    if (market.intelSignalId) {
      await query(
        `UPDATE shared_signals SET consumed_by_predict = true WHERE id = $1`,
        [market.intelSignalId]
      ).catch(() => {});
    }

    console.log(`[PolyExec] Trade opened: position #${positionId}, ${market.direction} @ ${fill.fillPrice.toFixed(4)}, $${amount.toFixed(2)}`);

    return { success: true, positionId, orderId, dryRun: false };
  } catch (err) {
    console.error(`[PolyExec] Order error:`, (err as Error).message);
    return { success: false, error: (err as Error).message, dryRun: false };
  }
}

/**
 * Monitor order fill with slippage guard.
 * Polls up to 30 seconds. Cancels if not filled.
 */
async function monitorFill(orderId: string, expectedPrice: number): Promise<FillResult> {
  for (let i = 0; i < 6; i++) {
    await sleep(5000);

    try {
      const res = await fetch(`${CLOB_BASE}/order/${orderId}`, {
        headers: { 'Authorization': `Bearer ${config.POLYMARKET_API_KEY}` },
      });

      if (!res.ok) continue;

      const status = await res.json() as any;

      if (status.status === 'MATCHED' || status.status === 'FILLED') {
        const avgPrice = parseFloat(status.associate_trades?.[0]?.price || status.price || '0');
        const slippage = expectedPrice > 0 ? Math.abs(avgPrice - expectedPrice) / expectedPrice : 0;

        if (slippage > 0.02) {
          console.error(`[PolyExec] Slippage ${(slippage * 100).toFixed(1)}% exceeds 2% limit`);
          return { filled: true, slippageExceeded: true, fillPrice: avgPrice };
        }
        return { filled: true, slippageExceeded: false, fillPrice: avgPrice };
      }

      if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
        return { filled: false, slippageExceeded: false, fillPrice: 0 };
      }
    } catch {
      // Retry on network errors
    }
  }

  // Timeout: cancel the order
  try {
    await fetch(`${CLOB_BASE}/order/${orderId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${config.POLYMARKET_API_KEY}` },
    });
  } catch {
    // Best effort cancellation
  }

  return { filled: false, slippageExceeded: false, fillPrice: 0 };
}

/**
 * Sign a Polymarket order with the Polygon wallet.
 * Uses EIP-712 typed data signing.
 *
 * TODO: Implement proper EIP-712 signing with ethers.js when wallet is set up.
 * For now, returns a placeholder that allows the API structure to compile.
 */
async function signOrder(order: any): Promise<{ signature: string; timestamp: string; nonce: string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = order.nonce || Date.now().toString();

  // Placeholder: real implementation needs ethers.js + wallet private key
  // import { Wallet } from 'ethers';
  // const wallet = new Wallet(config.POLYMARKET_WALLET_KEY);
  // const signature = await wallet.signTypedData(domain, types, order);

  if (!config.POLYMARKET_WALLET_KEY) {
    throw new Error('POLYMARKET_WALLET_KEY not configured');
  }

  // This will be replaced with actual EIP-712 signing
  // For dry run mode this is never reached
  console.warn('[PolyExec] Order signing not yet implemented. Set PREDICT_POLY_DRY_RUN=true.');
  return { signature: '', timestamp, nonce };
}

/**
 * Get USDC balance from Polygon wallet
 */
export async function getUSDCBalance(): Promise<number | null> {
  if (!config.POLYGON_RPC_URL || !config.POLYMARKET_WALLET_ADDRESS) return null;

  try {
    // ERC-20 balanceOf call
    const data = `0x70a08231000000000000000000000000${config.POLYMARKET_WALLET_ADDRESS.replace('0x', '').padStart(64, '0')}`;
    const res = await fetch(config.POLYGON_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: config.USDC_CONTRACT, data }, 'latest'],
      }),
    });

    const json = await res.json() as any;
    if (json.result) {
      // USDC has 6 decimals
      return parseInt(json.result, 16) / 1_000_000;
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
