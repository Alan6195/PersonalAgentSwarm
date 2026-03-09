/**
 * Predict Agent: Polymarket Trade Execution
 *
 * Uses the official @polymarket/clob-client for EIP-712 order signing,
 * L2 HMAC authentication, and order submission. The client handles all
 * cryptographic complexity (domain separators, typed data signing, etc.).
 *
 * Gated by PREDICT_POLY_DRY_RUN=true (default). When dry run,
 * logs everything but does not place orders.
 */

import { ClobClient, Side, OrderType, type TickSize } from '@polymarket/clob-client';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { config, isPolyDryRun } from '../../config';
import { query } from '../../db';
import { validateTrade, recordTradeOpened, type TradeCandidate } from './risk-gate';
import type { PolyCandidate } from './scan-polymarket';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

export interface PolyTradeResult {
  success: boolean;
  positionId?: number;
  orderId?: string;
  error?: string;
  riskRejection?: string;
  dryRun: boolean;
}

// Lazy-initialized CLOB client singleton
let _clobClient: ClobClient | null = null;

/**
 * Initialize or return the cached ClobClient instance.
 * Uses L2 auth (HMAC with API key/secret/passphrase) plus viem wallet signer.
 */
function getClobClient(): ClobClient {
  if (_clobClient) return _clobClient;

  if (!config.POLYMARKET_WALLET_KEY) {
    throw new Error('POLYMARKET_WALLET_KEY not configured');
  }
  if (!config.POLYMARKET_API_KEY || !config.POLYMARKET_API_SECRET || !config.POLYMARKET_API_PASSPHRASE) {
    throw new Error('Polymarket L2 credentials (API key, secret, passphrase) not configured');
  }

  // Create viem wallet client from private key
  const account = privateKeyToAccount(config.POLYMARKET_WALLET_KEY as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  // Initialize ClobClient with L2 credentials
  _clobClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient,
    {
      key: config.POLYMARKET_API_KEY,
      secret: config.POLYMARKET_API_SECRET,
      passphrase: config.POLYMARKET_API_PASSPHRASE,
    },
    1, // signatureType: 1 = POLY_PROXY (Phantom EOA signs, proxy wallet holds funds)
  );

  console.log('[PolyExec] CLOB client initialized with L2 auth');
  return _clobClient;
}

/**
 * Execute a trade on Polymarket (runs risk gate first)
 */
export async function executePolymarketTrade(
  market: PolyCandidate,
  bankroll: number,
): Promise<PolyTradeResult> {
  const isDryRun = isPolyDryRun();

  // Risk gate check
  // Use netEdge (absolute, fee-adjusted) for edge threshold; works for both YES and NO bets
  // Use pForDirection so risk gate sees the model probability for our chosen side
  const pForDirection = market.direction === 'YES' ? market.pBayes : (1 - market.pBayes);
  const candidate: TradeCandidate = {
    platform: 'polymarket',
    category: market.category,
    positionSizePct: market.betAmount / bankroll,
    betSize: market.betAmount,
    edge: market.netEdge,  // absolute net edge after fees (positive for both YES and NO)
    expectedReturn: market.expectedRet,
    pModel: pForDirection,
    momentumStrength: market.momentumStrength,
    intelStrength: market.intelSentiment != null ? Math.abs(market.intelSentiment) : undefined,
  };

  const riskCheck = await validateTrade(candidate, bankroll);
  if (!riskCheck.approved) {
    console.log(`[PolyExec] Risk gate BLOCKED: ${market.question.substring(0, 50)} (reason: ${riskCheck.rejectionReason})`);
    return { success: false, riskRejection: riskCheck.rejectionReason, dryRun: isDryRun };
  }

  if (isDryRun) {
    console.log(`[PolyExec] DRY RUN: Would place ${market.direction} on "${market.question.substring(0, 60)}" for $${riskCheck.betSize.toFixed(2)}`);
    console.log(`[PolyExec] DRY RUN: edge=${(market.edge * 100).toFixed(1)}c, kelly=${(market.kellyFrac * 100).toFixed(1)}%, pBayes=${market.pBayes.toFixed(4)}`);

    return { success: true, dryRun: true };
  }

  // Live execution via official CLOB client
  return await placePolymarketOrder(market, riskCheck.betSize, bankroll);
}

/**
 * Place an order on Polymarket CLOB using the official client.
 * The client handles EIP-712 signing, L2 HMAC auth, tick size validation.
 */
async function placePolymarketOrder(
  market: PolyCandidate,
  amount: number,
  bankroll: number,
): Promise<PolyTradeResult> {
  try {
    const client = getClobClient();

    const tokenId = market.direction === 'YES' ? market.yesTokenId : market.noTokenId;
    // Limit price: if buying YES, use market's YES price; if buying NO, use (1 - YES price)
    const limitPrice = market.direction === 'YES' ? market.pYes : (1 - market.pYes);
    // Size is number of outcome shares = USDC amount / price per share
    const size = amount / limitPrice;

    console.log(`[PolyExec] Placing order: BUY ${market.direction} on "${market.question.substring(0, 60)}"`);
    console.log(`[PolyExec]   amount=$${amount.toFixed(2)}, price=${limitPrice.toFixed(4)}, size=${size.toFixed(2)} shares`);
    console.log(`[PolyExec]   tokenId=${tokenId.slice(0, 30)}..., negRisk=${market.negRisk}, tickSize=${market.tickSize}`);

    // Round price to tick size
    const tickSize = parseFloat(market.tickSize || '0.01');
    const roundedPrice = Math.round(limitPrice / tickSize) * tickSize;

    // Use the official client to build, sign, and submit the order
    const resp = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size: Math.max(size, market.minOrderSize || 5), // respect min order size
        side: Side.BUY,
      },
      {
        tickSize: (market.tickSize || '0.01') as TickSize,
        negRisk: market.negRisk ?? false,
      },
      OrderType.GTC,
    );

    // The client returns the order response
    const orderId = (resp as any)?.orderID || (resp as any)?.id || 'unknown';

    if (!orderId || orderId === 'unknown') {
      console.error('[PolyExec] No order ID in response:', JSON.stringify(resp).substring(0, 500));
      return { success: false, error: 'No order ID returned from CLOB API', dryRun: false };
    }

    console.log(`[PolyExec] Order submitted: ${orderId}`);

    // Monitor fill with slippage guard
    const fill = await monitorFill(client, orderId, roundedPrice);

    if (!fill.filled) {
      console.log(`[PolyExec] Order not filled (timeout or cancelled): ${orderId}`);
      return { success: false, error: 'Order not filled within timeout', dryRun: false };
    }

    if (fill.slippageExceeded) {
      console.warn(`[PolyExec] Slippage exceeded: fill=${fill.fillPrice.toFixed(4)} vs expected=${roundedPrice.toFixed(4)}`);
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
 * Polls up to 30 seconds via the CLOB client. Cancels if not filled.
 */
async function monitorFill(
  client: ClobClient,
  orderId: string,
  expectedPrice: number,
): Promise<{ filled: boolean; slippageExceeded: boolean; fillPrice: number }> {
  for (let i = 0; i < 6; i++) {
    await sleep(5000);

    try {
      const order = await client.getOrder(orderId);
      const status = (order as any)?.status;

      if (status === 'MATCHED' || status === 'FILLED') {
        const avgPrice = parseFloat(
          (order as any)?.associate_trades?.[0]?.price ||
          (order as any)?.price ||
          '0'
        );
        const slippage = expectedPrice > 0
          ? Math.abs(avgPrice - expectedPrice) / expectedPrice
          : 0;

        if (slippage > 0.02) {
          console.error(`[PolyExec] Slippage ${(slippage * 100).toFixed(1)}% exceeds 2% limit`);
          return { filled: true, slippageExceeded: true, fillPrice: avgPrice };
        }
        return { filled: true, slippageExceeded: false, fillPrice: avgPrice };
      }

      if (status === 'CANCELLED' || status === 'EXPIRED') {
        return { filled: false, slippageExceeded: false, fillPrice: 0 };
      }
    } catch {
      // Retry on network errors
    }
  }

  // Timeout: cancel the order
  try {
    await client.cancelOrder({ orderID: orderId });
    console.log(`[PolyExec] Order cancelled after timeout: ${orderId}`);
  } catch {
    // Best effort cancellation
  }

  return { filled: false, slippageExceeded: false, fillPrice: 0 };
}

/**
 * Get USDC balance from Polygon wallet via RPC
 */
export async function getUSDCBalance(): Promise<number | null> {
  if (!config.POLYGON_RPC_URL || !config.POLYMARKET_WALLET_ADDRESS) return null;

  try {
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
