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
import { createWalletClient, createPublicClient, http, parseAbi, maxUint256 } from 'viem';
import { polygon } from 'viem/chains';
import { config, isPolyDryRun } from '../../config';
import { query } from '../../db';
import { validateTrade, recordTradeOpened, type TradeCandidate } from './risk-gate';
import type { PolyCandidate } from './scan-polymarket';

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

// Polymarket exchange contracts that need USDC.e approval
const EXCHANGE_CONTRACTS = {
  ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`,
  negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`,
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' as `0x${string}`,
};

// ERC20 ABI for approval checks and transactions
const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

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
  // signatureType 0 = EOA: Phantom wallet signs and trades directly
  // USDC must be in the EOA address, not the Polymarket proxy wallet
  _clobClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient,
    {
      key: config.POLYMARKET_API_KEY,
      secret: config.POLYMARKET_API_SECRET,
      passphrase: config.POLYMARKET_API_PASSPHRASE,
    },
    0, // EOA: signer IS the trader
  );

  console.log(`[PolyExec] CLOB client initialized: EOA=${account.address}, signatureType=EOA`);
  return _clobClient;
}

// Track whether approvals have been verified this session
let _approvalsVerified = false;

/**
 * Check if USDC.e is approved for all Polymarket exchange contracts.
 * Returns true if all approvals are sufficient, false if any are missing.
 */
export async function checkApprovals(): Promise<{
  approved: boolean;
  details: Record<string, { allowance: number; sufficient: boolean }>;
}> {
  if (!config.POLYGON_RPC_URL || !config.POLYMARKET_WALLET_ADDRESS) {
    return { approved: false, details: {} };
  }

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(config.POLYGON_RPC_URL),
  });

  const usdcAddress = config.USDC_CONTRACT as `0x${string}`;
  const walletAddress = config.POLYMARKET_WALLET_ADDRESS as `0x${string}`;
  const details: Record<string, { allowance: number; sufficient: boolean }> = {};
  let allApproved = true;

  for (const [name, spender] of Object.entries(EXCHANGE_CONTRACTS)) {
    try {
      const allowance = await publicClient.readContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [walletAddress, spender],
      });
      const allowanceUsd = Number(allowance) / 1e6;
      const sufficient = allowanceUsd > 1000; // > $1000 means unlimited or very high
      details[name] = { allowance: allowanceUsd, sufficient };
      if (!sufficient) allApproved = false;
    } catch {
      details[name] = { allowance: 0, sufficient: false };
      allApproved = false;
    }
  }

  return { approved: allApproved, details };
}

/**
 * Approve USDC.e for all Polymarket exchange contracts.
 * Requires MATIC for gas. Sets unlimited approval (max uint256).
 * Returns true if all approvals succeeded.
 */
export async function approveUSDC(): Promise<{
  success: boolean;
  results: Record<string, { txHash?: string; error?: string }>;
}> {
  if (!config.POLYMARKET_WALLET_KEY || !config.POLYGON_RPC_URL) {
    return { success: false, results: { error: { error: 'Wallet or RPC not configured' } } };
  }

  const account = privateKeyToAccount(config.POLYMARKET_WALLET_KEY as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.POLYGON_RPC_URL),
  });

  const usdcAddress = config.USDC_CONTRACT as `0x${string}`;
  const results: Record<string, { txHash?: string; error?: string }> = {};
  let allSuccess = true;

  for (const [name, spender] of Object.entries(EXCHANGE_CONTRACTS)) {
    try {
      console.log(`[PolySetup] Approving USDC.e for ${name} (${spender.slice(0, 10)}...)`);
      const hash = await walletClient.writeContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [spender, maxUint256],
      });
      results[name] = { txHash: hash };
      console.log(`[PolySetup] Approval tx sent: ${hash}`);

      // Wait a bit between transactions
      await sleep(3000);
    } catch (err: any) {
      results[name] = { error: err.message?.substring(0, 200) };
      allSuccess = false;
      console.error(`[PolySetup] Approval failed for ${name}:`, err.message);
    }
  }

  return { success: allSuccess, results };
}

/**
 * Full wallet setup: check and approve USDC for trading.
 * Call this before first trade or from /predict setup command.
 */
export async function ensureWalletReady(): Promise<{
  ready: boolean;
  message: string;
}> {
  // Check USDC.e balance
  const balance = await getUSDCBalance();
  if (balance === null || balance < 0.50) {
    return {
      ready: false,
      message: `USDC.e balance too low: $${balance?.toFixed(2) ?? '0'}. Need USDC.e (bridged) in EOA wallet.`,
    };
  }

  // Check gas balance
  if (config.POLYGON_RPC_URL && config.POLYMARKET_WALLET_ADDRESS) {
    try {
      const res = await fetch(config.POLYGON_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_getBalance',
          params: [config.POLYMARKET_WALLET_ADDRESS, 'latest'],
        }),
      });
      const json = await res.json() as any;
      const maticBalance = json.result ? parseInt(json.result, 16) / 1e18 : 0;
      if (maticBalance < 0.005) {
        return {
          ready: false,
          message: `MATIC balance too low: ${maticBalance.toFixed(6)}. Need >= 0.01 MATIC for approval transactions.`,
        };
      }
    } catch { /* non-critical */ }
  }

  // Check approvals
  const approvalCheck = await checkApprovals();
  if (!approvalCheck.approved) {
    // Try auto-approve
    console.log('[PolySetup] Missing approvals, attempting auto-approve...');
    const result = await approveUSDC();
    if (!result.success) {
      const failed = Object.entries(result.results)
        .filter(([, v]) => v.error)
        .map(([k, v]) => `${k}: ${v.error}`)
        .join('; ');
      return { ready: false, message: `Approval failed: ${failed}` };
    }

    // Wait for confirmations
    await sleep(5000);

    // Verify approvals
    const recheck = await checkApprovals();
    if (!recheck.approved) {
      return { ready: false, message: 'Approvals sent but not confirmed. Try again in a minute.' };
    }
  }

  _approvalsVerified = true;
  return { ready: true, message: `Wallet ready. USDC.e: $${balance.toFixed(2)}` };
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

  // Ensure wallet has approvals (one-time check per session)
  if (!_approvalsVerified) {
    const walletCheck = await ensureWalletReady();
    if (!walletCheck.ready) {
      console.error(`[PolyExec] Wallet not ready: ${walletCheck.message}`);
      return { success: false, error: `Wallet setup: ${walletCheck.message}`, dryRun: false };
    }
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
