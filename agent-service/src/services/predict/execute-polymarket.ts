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

// Token addresses on Polygon
const NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as `0x${string}`;
const BRIDGED_USDCE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;

// Uniswap V3 SwapRouter02 on Polygon
const SWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as `0x${string}`;

// ERC20 ABI for approval checks and transactions
const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

// Uniswap V3 SwapRouter02 ABI (just the function we need)
const SWAP_ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
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
 * Swap native USDC to USDC.e (bridged) via Uniswap V3 on Polygon.
 * USDC/USDC.e pools are essentially 1:1 with minimal slippage.
 * Uses 0.01% fee tier (lowest, best for stablecoin pairs).
 */
export async function swapUSDCToUSDCe(amountUsd?: number): Promise<{
  success: boolean;
  amountIn: number;
  amountOut: number;
  txHash?: string;
  error?: string;
}> {
  if (!config.POLYMARKET_WALLET_KEY || !config.POLYGON_RPC_URL) {
    return { success: false, amountIn: 0, amountOut: 0, error: 'Wallet or RPC not configured' };
  }

  const account = privateKeyToAccount(config.POLYMARKET_WALLET_KEY as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.POLYGON_RPC_URL),
  });
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(config.POLYGON_RPC_URL),
  });

  // Get native USDC balance
  const nativeBalance = await publicClient.readContract({
    address: NATIVE_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  const nativeBalanceUsd = Number(nativeBalance) / 1e6;

  if (nativeBalanceUsd < 0.50) {
    return { success: false, amountIn: 0, amountOut: 0, error: `Native USDC balance too low: $${nativeBalanceUsd.toFixed(2)}` };
  }

  // Amount to swap (default: all native USDC)
  const swapAmountUsd = amountUsd ?? nativeBalanceUsd;
  const swapAmountRaw = BigInt(Math.floor(swapAmountUsd * 1e6));

  console.log(`[PolySetup] Swapping $${swapAmountUsd.toFixed(2)} native USDC -> USDC.e via Uniswap V3`);

  // Step 1: Approve native USDC for SwapRouter
  const currentAllowance = await publicClient.readContract({
    address: NATIVE_USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, SWAP_ROUTER],
  });

  if (currentAllowance < swapAmountRaw) {
    console.log('[PolySetup] Approving native USDC for Uniswap SwapRouter...');
    const approveTx = await walletClient.writeContract({
      address: NATIVE_USDC,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [SWAP_ROUTER, maxUint256],
    });
    console.log(`[PolySetup] Approve tx: ${approveTx}`);
    // Wait for confirmation
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('[PolySetup] Approve confirmed');
  }

  // Step 2: Execute swap via exactInputSingle
  // Use 0.01% fee tier (100) for stablecoin pairs, fallback to 0.05% (500)
  // Min output: 99.5% of input (0.5% slippage tolerance for stablecoin swap)
  const minAmountOut = swapAmountRaw * 995n / 1000n;

  try {
    const swapTx = await walletClient.writeContract({
      address: SWAP_ROUTER,
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: NATIVE_USDC,
        tokenOut: BRIDGED_USDCE,
        fee: 100, // 0.01% fee tier
        recipient: account.address,
        amountIn: swapAmountRaw,
        amountOutMinimum: minAmountOut,
        sqrtPriceLimitX96: 0n,
      }],
    });

    console.log(`[PolySetup] Swap tx: ${swapTx}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });

    // Check USDC.e balance after swap
    const newBalance = await publicClient.readContract({
      address: BRIDGED_USDCE,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    });
    const newBalanceUsd = Number(newBalance) / 1e6;

    console.log(`[PolySetup] Swap complete! USDC.e balance: $${newBalanceUsd.toFixed(2)}`);
    return {
      success: receipt.status === 'success',
      amountIn: swapAmountUsd,
      amountOut: newBalanceUsd,
      txHash: swapTx,
    };
  } catch (err: any) {
    // Try 0.05% fee tier as fallback
    console.log('[PolySetup] 0.01% pool failed, trying 0.05% fee tier...');
    try {
      const swapTx = await walletClient.writeContract({
        address: SWAP_ROUTER,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [{
          tokenIn: NATIVE_USDC,
          tokenOut: BRIDGED_USDCE,
          fee: 500, // 0.05% fee tier
          recipient: account.address,
          amountIn: swapAmountRaw,
          amountOutMinimum: minAmountOut,
          sqrtPriceLimitX96: 0n,
        }],
      });

      console.log(`[PolySetup] Swap tx (0.05% pool): ${swapTx}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });

      const newBalance = await publicClient.readContract({
        address: BRIDGED_USDCE,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      });
      const newBalanceUsd = Number(newBalance) / 1e6;

      console.log(`[PolySetup] Swap complete! USDC.e balance: $${newBalanceUsd.toFixed(2)}`);
      return {
        success: receipt.status === 'success',
        amountIn: swapAmountUsd,
        amountOut: newBalanceUsd,
        txHash: swapTx,
      };
    } catch (err2: any) {
      return { success: false, amountIn: swapAmountUsd, amountOut: 0, error: err2.message?.substring(0, 200) };
    }
  }
}

/**
 * Full wallet setup: swap USDC if needed, check and approve for trading.
 * Call this before first trade or from /predict setup command.
 */
export async function ensureWalletReady(): Promise<{
  ready: boolean;
  message: string;
}> {
  // Check gas balance first
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
          message: `MATIC balance too low: ${maticBalance.toFixed(6)}. Need >= 0.01 MATIC for swap + approval transactions.`,
        };
      }
    } catch { /* non-critical */ }
  }

  // Check USDC.e balance
  let balance = await getUSDCBalance();

  // If USDC.e is too low, try to swap native USDC -> USDC.e
  if (balance === null || balance < 0.50) {
    console.log(`[PolySetup] USDC.e balance low ($${balance?.toFixed(2) ?? '0'}), checking native USDC for swap...`);

    // Check native USDC balance
    if (config.POLYGON_RPC_URL && config.POLYMARKET_WALLET_ADDRESS) {
      const publicClient = createPublicClient({
        chain: polygon,
        transport: http(config.POLYGON_RPC_URL),
      });
      try {
        const nativeBalance = await publicClient.readContract({
          address: NATIVE_USDC,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [config.POLYMARKET_WALLET_ADDRESS as `0x${string}`],
        });
        const nativeBalanceUsd = Number(nativeBalance) / 1e6;

        if (nativeBalanceUsd >= 0.50) {
          console.log(`[PolySetup] Found $${nativeBalanceUsd.toFixed(2)} native USDC. Swapping to USDC.e...`);
          const swapResult = await swapUSDCToUSDCe();

          if (!swapResult.success) {
            return { ready: false, message: `USDC swap failed: ${swapResult.error}` };
          }

          // Re-check USDC.e balance after swap
          balance = await getUSDCBalance();
          console.log(`[PolySetup] Post-swap USDC.e balance: $${balance?.toFixed(2) ?? '0'}`);
        } else {
          return {
            ready: false,
            message: `No USDC available. USDC.e: $${balance?.toFixed(2) ?? '0'}, native USDC: $${nativeBalanceUsd.toFixed(2)}`,
          };
        }
      } catch (err: any) {
        return { ready: false, message: `Balance check failed: ${err.message?.substring(0, 100)}` };
      }
    }
  }

  if (balance === null || balance < 0.50) {
    return {
      ready: false,
      message: `USDC.e balance still too low after swap: $${balance?.toFixed(2) ?? '0'}`,
    };
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
    const tickSize = parseFloat(market.tickSize || '0.01');

    // Limit price: mid-price + 2 ticks to cross the spread and get filled immediately.
    // These are 5-15 min markets; sitting at mid-price risks timeout. The 2-tick premium
    // is still well within our edge (minimum 9c net edge to reach execution).
    const midPrice = market.direction === 'YES' ? market.pYes : (1 - market.pYes);
    const limitPrice = Math.min(midPrice + 2 * tickSize, 0.99); // cap at 99c
    // Size is number of outcome shares = USDC amount / price per share
    const size = amount / limitPrice;

    console.log(`[PolyExec] Placing order: BUY ${market.direction} on "${market.question.substring(0, 60)}"`);
    console.log(`[PolyExec]   amount=$${amount.toFixed(2)}, mid=${midPrice.toFixed(4)}, limit=${limitPrice.toFixed(4)} (+2 ticks), size=${size.toFixed(2)} shares`);
    console.log(`[PolyExec]   tokenId=${tokenId.slice(0, 30)}..., negRisk=${market.negRisk}, tickSize=${market.tickSize}`);

    // Round price to tick size
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
    const dbParams = [
      'polymarket', market.id, market.url, market.question, market.category,
      market.asset, market.direction,
      market.pYes, market.pBayes, market.edge, market.kellyFrac,
      amount, fill.fillPrice,
      market.score, market.expectedRet,
      market.intelSignalId, market.intelAligned,
      market.reasoning,
      orderId,
    ];
    console.log(`[PolyExec] DB insert params: pYes=${market.pYes}, pBayes=${market.pBayes}, edge=${market.edge}, kelly=${market.kellyFrac}, amount=${amount}, fillPrice=${fill.fillPrice}, score=${market.score}, expectedRet=${market.expectedRet}, intelSigId=${market.intelSignalId}, intelAligned=${market.intelAligned}`);
    const rows = await query<{ id: number }>(
      `INSERT INTO market_positions
       (platform, market_id, market_url, question, category, asset, direction,
        p_market, p_model, edge, kelly_fraction, bet_size, fill_price,
        reward_score, expected_return, intel_signal_id, intel_aligned,
        reasoning, bet_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      dbParams
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
    const data = `0x70a08231${config.POLYMARKET_WALLET_ADDRESS.replace('0x', '').toLowerCase().padStart(64, '0')}`;
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

/**
 * Reconcile open Polymarket positions. Checks if markets have resolved
 * via the Gamma Markets API and updates position status/P&L.
 *
 * For Up/Down 5-15 min markets, resolution happens automatically after expiry.
 * Returns summary of resolved positions.
 */
export async function reconcilePolymarketPositions(): Promise<{
  checked: number;
  closed: number;
  wins: number;
  losses: number;
  totalPnl: number;
}> {
  const result = { checked: 0, closed: 0, wins: 0, losses: 0, totalPnl: 0 };

  const positions = await query<any>(
    `SELECT id, market_id, question, direction, bet_size, fill_price, edge
     FROM market_positions WHERE platform = $1 AND status = $2`,
    ['polymarket', 'open']
  );

  if (positions.length === 0) return result;

  result.checked = positions.length;
  console.log(`[PolyResolve] Checking ${positions.length} open Polymarket positions`);

  for (const pos of positions) {
    try {
      // Query Gamma Markets API for market resolution
      // conditionId is stored as market_id
      const res = await fetch(
        `https://gamma-api.polymarket.com/markets?condition_id=${pos.market_id}`
      );

      if (!res.ok) {
        console.warn(`[PolyResolve] Gamma API error for ${pos.market_id}: ${res.status}`);
        continue;
      }

      const markets = await res.json() as any[];
      if (!markets || markets.length === 0) {
        // Check if market has expired based on question text (fallback)
        // Up/Down markets have timestamps in their questions
        const expired = isMarketExpired(pos.question);
        if (expired) {
          // Market expired but no resolution data yet — mark as expired pending
          // Check again later; Gamma API may take a few minutes after expiry
          console.log(`[PolyResolve] Market expired but no resolution data: ${pos.question.substring(0, 50)}`);
        }
        continue;
      }

      const market = markets[0];

      // Check if market is resolved
      if (!market.resolved) {
        // Check if expired — some markets take a few minutes to resolve after expiry
        if (isMarketExpired(pos.question)) {
          const minutesSinceExpiry = getMinutesSinceExpiry(pos.question);
          if (minutesSinceExpiry > 30) {
            // Auto-close as loss if unresolved 30+ minutes after expiry
            console.warn(`[PolyResolve] Force-closing unresolved position (${minutesSinceExpiry.toFixed(0)}min post-expiry): ${pos.question.substring(0, 50)}`);
            await closePosition(pos.id, 'closed_loss', -parseFloat(pos.bet_size), 'Auto-closed: market expired but never resolved');
            result.closed++;
            result.losses++;
            result.totalPnl -= parseFloat(pos.bet_size);
          }
        }
        continue;
      }

      // Market resolved — determine outcome
      // resolved_to: "YES" or "NO" (or a probability for some markets)
      const resolvedTo = market.outcome || market.resolved_to || '';
      const won = (pos.direction === 'YES' && resolvedTo === 'Yes') ||
                  (pos.direction === 'NO' && resolvedTo === 'No');

      // P&L calculation:
      // Won: receive $1 per share, paid fill_price per share. Profit = shares * (1 - fill_price) - fees
      // Lost: receive $0, paid fill_price per share. Loss = -bet_size
      const fillPrice = parseFloat(pos.fill_price) || 0.50;
      const betSize = parseFloat(pos.bet_size);
      const shares = betSize / fillPrice;
      const pnl = won
        ? shares * (1 - fillPrice) * 0.975  // 2.5% fee on winnings
        : -betSize;

      const status = won ? 'closed_win' : 'closed_loss';
      await closePosition(pos.id, status, pnl, `Resolved: ${resolvedTo}`);

      result.closed++;
      if (won) result.wins++;
      else result.losses++;
      result.totalPnl += pnl;

      console.log(`[PolyResolve] ${won ? 'WIN' : 'LOSS'}: ${pos.direction} on "${pos.question.substring(0, 50)}" -> ${resolvedTo}. P&L: $${pnl.toFixed(2)}`);
    } catch (err) {
      console.warn(`[PolyResolve] Error checking position #${pos.id}:`, (err as Error).message);
    }
  }

  if (result.closed > 0) {
    console.log(`[PolyResolve] Resolved ${result.closed} positions: ${result.wins}W/${result.losses}L, P&L: $${result.totalPnl.toFixed(2)}`);
  }

  return result;
}

/**
 * Close a position with the given status and P&L.
 */
async function closePosition(positionId: number, status: string, pnl: number, notes: string): Promise<void> {
  const betSize = await query<any>(
    `SELECT bet_size FROM market_positions WHERE id = $1`, [positionId]
  ).then(r => parseFloat(r[0]?.bet_size || '0'));

  await query(
    `UPDATE market_positions
     SET status = $1, pnl = $2, pnl_pct = $3, closed_at = NOW(), notes = $4
     WHERE id = $5`,
    [status, pnl, betSize > 0 ? pnl / betSize : 0, notes, positionId]
  );

  // Update risk state
  const { recordTradeClosed, updateDailyRisk } = await import('./risk-gate');
  const bankroll = 50; // TODO: get from config or DB
  await recordTradeClosed('polymarket', betSize, bankroll).catch(() => {});
  if (pnl !== 0) {
    await updateDailyRisk('polymarket', pnl, bankroll).catch(() => {});
  }
}

/**
 * Check if a market has expired based on the question text.
 * Up/Down markets have times like "March 9, 12:15PM-12:20PM ET"
 */
function isMarketExpired(question: string): boolean {
  return getMinutesSinceExpiry(question) > 0;
}

function getMinutesSinceExpiry(question: string): number {
  // Extract end time from question like "March 9, 12:20PM ET"
  const match = question.match(/(\d{1,2}):(\d{2})(AM|PM)\s*ET$/i);
  if (!match) return -1;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const isPM = match[3].toUpperCase() === 'PM';

  if (isPM && hours !== 12) hours += 12;
  if (!isPM && hours === 12) hours = 0;

  // Convert ET to UTC (ET = UTC-4 during EDT, UTC-5 during EST)
  // March is EDT (UTC-4)
  const now = new Date();
  const nowUTC = now.getTime();

  // Build the expiry time in UTC
  const expiry = new Date(now);
  expiry.setUTCHours(hours + 4, minutes, 0, 0); // EDT = UTC-4

  return (nowUTC - expiry.getTime()) / 60000;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
