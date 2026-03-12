# Polymarket Order Flow Trading Agent: Technical Breakdown

## Overview

Autonomous trading agent that trades Polymarket's 5-minute and 15-minute crypto Up/Down binary markets (BTC, ETH, SOL, XRP). The core edge comes from detecting Order Flow Imbalance (OFI) in the final 60-90 seconds before a window closes, then entering a position on the next window before the market prices it in.

All decisions are deterministic (no LLM calls). 5-minute windows are too fast for an LLM roundtrip.

---

## Architecture

```
                         +---------------------------+
                         |   Coinbase WebSocket       |
                         |   (BTC/ETH/SOL/XRP prices) |
                         +------------+--------------+
                                      |
                                      v
                         +---------------------------+
                         |   Price Feed Service       |
                         |   20min rolling history    |
                         |   Momentum signals         |
                         +------------+--------------+
                                      |
+---------------------------+         |         +---------------------------+
|   Polymarket CLOB WS      |         |         |   X/Twitter Intel Scan    |
|   (live trade stream)      |         |         |   (shared_signals table)  |
+------------+--------------+         |         +------------+--------------+
             |                        |                      |
             v                        v                      v
+---------------------------+  +-------------+  +---------------------------+
|   Order Flow Scanner       |  | Bayesian    |  |   Intel Signal Reader     |
|   OFI computation (10s)    |  | Prior Update|  |   30min decay window      |
|   PRE_WINDOW / NEW_WINDOW  |  +------+------+  +------------+--------------+
+------------+--------------+         |                      |
             |                        |                      |
             v                        v                      v
+------------------------------------------------------------+
|                    Signal Handler                           |
|   Merges OFI direction + momentum + intel sentiment        |
+-----------------------------+------------------------------+
                              |
                              v
+------------------------------------------------------------+
|                     Risk Gate                               |
|   Position sizing, exposure limits, drawdown checks        |
+-----------------------------+------------------------------+
                              |
                              v
+------------------------------------------------------------+
|                CLOB Execution (EIP-712 signed orders)      |
|   @polymarket/clob-client, limit orders, GTC               |
+-----------------------------+------------------------------+
                              |
                              v
+------------------------------------------------------------+
|              Post-Trade Lifecycle                           |
|   Resolution check (2min) -> Reconciliation -> CTF Redeem  |
|   -> Bankroll sync to on-chain USDC.e balance              |
+------------------------------------------------------------+
```

---

## Data Sources (3 Input Streams)

### 1. Polymarket CLOB WebSocket (Primary Signal)
- **URL:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- **Data:** Real-time `last_trade_price` events for all watched YES tokens
- **Fields per trade:** assetId, side (BUY/SELL), size (shares), price (0-1), timestamp
- **BUY side** = aggressive buyer of YES tokens = bullish
- **SELL side** = aggressive seller of YES tokens = bearish
- Keeps 120 seconds of rolling trade history per token in memory

### 2. Coinbase Advanced Trade WebSocket (Price Momentum)
- **Pairs:** BTC-USD, ETH-USD, SOL-USD, XRP-USD
- **Fallback:** Binance streams if Coinbase fails
- Maintains 20-minute rolling history of 10-second price snapshots (120 per asset)
- Computes: 1m/5m/15m returns, 5m volatility, momentum classification
- Momentum levels: `strong_up`, `up`, `neutral`, `down`, `strong_down`
- Flushes to `price_signals` table every 30 seconds for the dashboard

### 3. X/Twitter Intel Signals (Sentiment)
- Populated by the social media agent's intel scan
- Stored in `shared_signals` table with topic, direction, strength
- **Decay window:** Full weight < 10 min, linear decay 10-30 min, zero after 30 min
- Produces per-asset `IntelSummary`: bullishStrength (0-1), bearishStrength (0-1), netSentiment (-1 to +1)

---

## Market Discovery

Markets are discovered every 30 minutes via slug-based lookups against the Polymarket Gamma API.

**Slug pattern:** `{asset}-updown-{duration}-{windowStartUnix}`
- Example: `btc-updown-5m-1772942700`
- Assets: BTC, ETH, SOL, XRP
- Durations: 5m, 15m
- Checks the current window + next 3 upcoming windows per asset per duration

**Per discovery cycle:** ~32 active markets (4 assets x 2 durations x 4 windows)

Each discovered market provides: conditionId, yesTokenId, noTokenId, midPrice, endTime, question text.

---

## Signal Generation: Order Flow Scanner

The core edge detection system. Runs as a singleton service (`OrderFlowService`).

### OFI Computation (every 10 seconds)

For each watched market, computes Order Flow Imbalance over three time windows:

```
OFI = (aggressive_buy_volume - aggressive_sell_volume) / total_volume
```

- **OFI30s:** Last 30 seconds (confirmation signal)
- **OFI60s:** Last 60 seconds (primary signal)
- **OFI90s:** Last 90 seconds (trend context)

Range: -1.0 (all sells) to +1.0 (all buys)

### Signal Classification

| OFI60s Value | 30s Confirms? | Classification |
|---|---|---|
| > +0.30 | Yes | `strong_yes` |
| > +0.10 | Any | `yes` |
| -0.10 to +0.10 | Any | `neutral` |
| < -0.10 | Any | `no` |
| < -0.30 | Yes | `strong_no` |

### Signal Strength (0.0 to 1.0)

```
baseStrength = if 30s confirms 60s direction:
                 min(1.0, |OFI60s| * 2)       // amplified
               else:
                 min(0.5, |OFI60s|)            // capped at 0.5

signalStrength = if large_trade_detected:
                   min(1.0, baseStrength + 0.2)  // boosted
                 else:
                   baseStrength
```

**Large trade threshold:** Any single trade > 500 shares in the last 30 seconds.

### Two-Phase Signal Pipeline

**Phase 1: PRE_WINDOW (60-90 seconds before window closes)**
- Captures early positioner flow
- If `signalStrength >= 0.40` and signal is non-neutral, logs PRE_WINDOW and stores as pending entry

**Phase 2: NEW_WINDOW (0-60 seconds after window closes)**
- Recomputes signal on the same market
- **Confirmation required:** strength still >= 0.40 AND direction hasn't flipped
- If confirmed: finds the NEXT window for the same asset, fires signal to handler
- If direction flipped or strength dropped: signal CANCELLED, no trade
- Deduplication: if a 5m and 15m window expire simultaneously for the same asset, only one signal fires

### The Edge (Why This Works)

Large/informed traders position 30-60 seconds before a window closes. The OFI captures this directional bias. We don't trade the closing window (too late); we enter the NEXT window, betting the momentum continues. The market hasn't fully priced in the signal yet because the next window just opened.

---

## Execution Pipeline

### Signal Handler Flow

```
OrderFlowSignal fires
  -> Early mid-price check (reject if mid > 0.85 or < 0.15; market already decided)
  -> Compute bankroll (on-chain USDC.e balance)
  -> Compute bet size: max(0.50, min(bankroll * kellyProxy, bankroll * 0.05))
     where kellyProxy = min(0.20, signalStrength * 0.20)
  -> Compute pModel: 0.50 +/- (OFI60s * 0.25)  // max shift of +/-25% from 50%
  -> Risk gate validation
  -> Fetch fresh midPrice from CLOB API (discovery price may be 30+ min stale)
  -> Compute limit price:
     YES bet: min(currentMid + 0.02, 0.65)
     NO bet:  min((1 - currentMid) + 0.02, 0.65)
  -> Submit via @polymarket/clob-client (EIP-712 signed, GTC limit order)
  -> Record position in market_positions table
  -> Update risk state (exposure, trade count)
```

### Order Signing

- Uses `@polymarket/clob-client` with L2 HMAC authentication
- EOA signing (signatureType=0): Phantom wallet signs and trades directly
- EIP-712 typed data signatures for on-chain order validity
- All orders are GTC (Good Till Cancelled) limit orders

### Limit Price Logic

The 0.02 buffer above mid gives enough room to fill while the 0.65 cap prevents overpaying on 50/50 markets. These are binary markets, so prices should hover near 0.50.

---

## Risk Gate

All deterministic. No LLM involvement.

### Polymarket Limits

| Parameter | Value | Description |
|---|---|---|
| maxPositionPct | 5% | Max single trade as % of bankroll |
| maxCategoryPct | 50% | Max exposure in one category (all trades are crypto) |
| maxTotalExposurePct | 60% | Max total deployed capital |
| dailyLossPausePct | 100% | Disabled (was 25%) |
| drawdownPausePct | 30% | Hard stop if drawdown from peak exceeds 30% |
| minEdge | 6c | Minimum net edge after taker fees |
| minBet | $0.50 | Minimum bet size |

### Checks (all must pass)

1. `edge_sufficient`: edge >= 0.06
2. `min_bet`: betSize >= $0.50
3. `max_position`: betSize <= bankroll * 5%
4. `expected_return_positive`: expected return > 0
5. `signal_quality`: momentum >= 0.35 OR intel >= 0.50 OR both >= 0.20/0.30
6. `daily_loss_ok`: disabled (set to 100%)
7. `drawdown_ok`: drawdown from peak < 30%
8. `category_exposure_ok`: category exposure + bet <= bankroll * 50%
9. `total_exposure_ok`: total exposure + bet <= bankroll * 60%
10. `trading_not_paused`: manual pause flag not set

### Daily Risk State

Tracked in `daily_risk_state` table per platform per day:
- starting_bankroll, current_bankroll, peak_bankroll
- daily_pnl, daily_loss (losses only), current_drawdown
- trades_opened, trades_closed, current_exposure
- trading_paused flag + pause_reason
- Resets daily at 6am MT (13:00 UTC)

---

## Post-Trade Lifecycle

### Resolution Check (every 2 minutes)

1. Query all `status = 'open'` positions from `market_positions`
2. For each, fetch market data from Polymarket CLOB API
3. Check if market has resolved (winning outcome determined)
4. If resolved:
   - Mark position as `closed_win` or `closed_loss`
   - Calculate P&L: win = (1/fill_price * bet_size) - bet_size; loss = -bet_size
   - Update `daily_risk_state` with P&L
   - Record trade closed (exposure reduction)

### Token Redemption (runs after resolution check)

Polymarket uses the Gnosis Conditional Token Framework (CTF). Winning positions are ERC-1155 tokens that must be explicitly redeemed for USDC.e collateral.

**CTF Contract:** `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`

```
redeemPositions(
  collateralToken: USDC.e (0x2791Bca1...),
  parentCollectionId: bytes32(0),
  conditionId: <from market>,
  indexSets: [1, 2]  // both YES and NO outcomes for binary markets
)
```

**Flow:**
1. Query `closed_win` positions where `metadata->>'redeemed'` is null
2. Group by conditionId (dedup: multiple positions on same condition)
3. Fetch CLOB market data for token IDs
4. Check ERC-1155 balance on-chain via `CTF.balanceOf(wallet, tokenId)`
5. If balance > 0: call `CTF.redeemPositions()`, record tx hash in metadata
6. If balance = 0 AND position age > 1 hour: mark as redeemed (nothing to claim)
7. If balance = 0 AND position age < 1 hour: skip, retry next cycle (CLOB settlement is batched)

### Bankroll Sync

After redemption, reads actual on-chain USDC.e balance and syncs `daily_risk_state.current_bankroll` if drift > $0.01. This prevents the risk gate from using stale numbers.

---

## Cron Schedule

| Job | Interval | Description |
|---|---|---|
| Resolution Check | Every 2 min | Poll open positions, reconcile, redeem, sync bankroll |
| Market Discovery | Every 30 min | Refresh active Up/Down markets for order flow scanner |
| Polymarket Scan | Every 3 min | Backup scanner (momentum/intel triggered, not OFI) |
| Equity Snapshot | Every 15 min | Record bankroll, positions, win rate to equity_snapshots |
| Health Monitor | Every 5 min | Check price feed, intel freshness, USDC balance, gas |
| Daily Risk Reset | 6am MT | Reset daily loss/PnL counters, refresh bankroll |
| Daily Summary | 9am MT | Aggregate stats, send to Telegram |

### Always-On Services (not cron)

| Service | Description |
|---|---|
| Order Flow Scanner | WebSocket connection to Polymarket CLOB, OFI check every 10s |
| Price Feed | WebSocket to Coinbase (fallback Binance), 10s snapshots |
| Momentum Watcher | 60s interval, triggers Polymarket scan on momentum events |

---

## Infrastructure

| Component | Detail |
|---|---|
| VPS | Hetzner CX31, 143.110.155.176 |
| Runtime | Docker Compose (agent, db, vpn containers) |
| Wallet | Phantom EOA: `0x544B36fC15842f0C21b9dab06650a8E5bC0B1eD7` |
| Chain | Polygon mainnet (chain ID 137) |
| Collateral | USDC.e (bridged): `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| CTF Contract | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` (CTF Exchange) |
| RPC | `https://polygon-bor-rpc.publicnode.com` |
| Starting Bankroll | $50.00 USDC.e |

---

## Current Performance (Day 1: March 9, 2026)

| Metric | Value |
|---|---|
| Resolved Trades | 39 (excluding 8 scanner-bug trades from initial startup) |
| Wins / Losses | 23W / 16L |
| Win Rate | 59.0% |
| Total P&L | +$14.98 |
| Total Wagered | $65.31 |
| ROI | 22.9% |
| Avg Win | +$1.81 |
| Avg Loss | -$1.67 |
| Avg Bet Size | $1.59 |
| Wallet Balance | ~$43.81 |
| Open Positions | 2 |

### Performance by Window (Today)

| Window | Trades | W/L | Net P&L |
|---|---|---|---|
| 3:55-4:00PM | 4 | 3W/1L | +$4.74 |
| 4:00-4:15PM | 2 | 1W/1L | -$0.08 |
| 4:15-4:20PM | 6 | 2W/4L | -$3.22 |
| 4:55-5:00PM | 3 | 3W/0L | +$5.00 |
| 5:35-5:40PM | 4 | 1W/3L | -$4.26 |
| 5:40-5:45PM | 4 | 4W/0L | +$9.01 |
| 6:15-6:20PM | 4 | 2W/2L | +$1.52 |
| 6:20-6:25PM | 4 | 2W/2L | -$0.09 |
| 6:45-6:50PM | 3 | 1W/2L | -$2.44 |
| 7:00-7:15PM | 3 | 3W/0L | +$4.36 |
| 8:00-8:15PM | 1 | 1W/0L | +$1.17 |
| 8:15-8:30PM | 1 | 0W/1L | -$1.27 |

---

## Key Files

| File | Purpose |
|---|---|
| `predict/order-flow.ts` | WebSocket connection, OFI computation, signal pipeline |
| `predict/execute-polymarket.ts` | CLOB order execution, CTF redemption, bankroll sync |
| `predict/scan-polymarket.ts` | Market discovery via Gamma API slug lookups |
| `predict/risk-gate.ts` | All risk checks, position sizing, daily tracking |
| `predict/price-feed.ts` | Coinbase/Binance WebSocket, momentum signals |
| `predict/intel-signal.ts` | X/Twitter sentiment aggregation with time decay |
| `predict/cron.ts` | Handler functions for all cron jobs |
| `predict/health-monitor.ts` | System health checks (price feed, USDC, gas, crons) |

---

## Known Issues / Notes

1. **3 phantom wins**: Positions 15, 31, 36 were marked as closed_win but had 0 ERC-1155 tokens on-chain after 1+ hour. The CLOB confirmed fills but on-chain settlement may have failed. Combined phantom P&L: ~$5.05.

2. **Polymarket resolution delay**: Their resolution system is batched. After a 5-minute window closes, it can take 5-15 minutes for Polymarket to officially resolve the market. This is their infrastructure, not ours.

3. **WebSocket reconnections**: The CLOB WebSocket disconnects periodically (especially during low-activity periods). Auto-reconnect with exponential backoff handles this. No data loss because OFI only uses the last 60-90 seconds.

4. **All-YES bias early on**: The first several hours only placed YES bets (betting Up). After the signal handler was confirmed working for both directions, NO bets started appearing when OFI was negative (e.g., XRP NO @ 8:00PM).
