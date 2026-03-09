/**
 * Real-Time Order Flow Scanner for Polymarket 5/15-min Crypto Markets
 *
 * Connects to Polymarket CLOB WebSocket for live trade data.
 * Computes Order Flow Imbalance (OFI) from aggressive buy/sell volume.
 * Fires signals when OFI crosses thresholds near window boundaries.
 *
 * Architecture:
 *   WebSocket -> last_trade_price events -> rolling trade history
 *   -> OFI computation every 10s -> PRE_WINDOW / NEW_WINDOW signals
 *   -> signal handler -> risk gate -> execution
 *
 * The edge: large traders position 30-60s before a window opens.
 * We detect that order flow imbalance and enter in the first 60s of the
 * new window before the market fully prices it in.
 */

import WebSocket from 'ws';
import { query } from '../../db';

// ── Polymarket CLOB WebSocket ───────────────────────────────────────────

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Interfaces ──────────────────────────────────────────────────────────

export interface ActiveMarket {
  conditionId: string;
  asset: string;             // BTC, ETH, SOL, XRP
  windowMinutes: number;     // 5 or 15
  question: string;
  midPrice: number;
  endTime: number;           // unix ms when this window closes
  yesTokenId: string;
  noTokenId: string;
  eventSlug: string;
}

/** Raw trade from Polymarket WebSocket last_trade_price event */
interface RawTrade {
  assetId: string;
  side: 'BUY' | 'SELL';     // BUY = aggressive buyer (bullish), SELL = aggressive seller (bearish)
  size: number;              // shares
  price: number;             // 0-1
  timestamp: number;         // unix ms
}

/** Computed OFI signal for a single market */
export interface OrderFlowSignal {
  conditionId: string;
  asset: string;
  question: string;
  windowMinutes: number;
  windowEnd: number;              // unix ms
  minutesUntilWindowEnd: number;
  ofi30s: number;                 // order flow imbalance last 30s (-1 to +1)
  ofi60s: number;                 // last 60s
  ofi90s: number;                 // last 90s
  aggressiveBuyVolume: number;    // taker buy shares last 60s
  aggressiveSellVolume: number;   // taker sell shares last 60s
  totalVolume60s: number;         // total volume last 60s
  largeTradeDetected: boolean;    // any single trade > threshold in last 30s
  largeTradeDirection: 'YES' | 'NO' | null;
  signal: 'strong_yes' | 'yes' | 'neutral' | 'no' | 'strong_no';
  signalStrength: number;         // 0.0-1.0
  entryDirection: 'YES' | 'NO' | null;
  midPrice: number;
  yesTokenId: string;
  noTokenId: string;
}

// ── Config ──────────────────────────────────────────────────────────────

const TRADE_WINDOW_MS = 120 * 1000;      // keep 120s of trade history
const LARGE_TRADE_THRESHOLD = 500;        // shares (single trade)
const SIGNAL_CHECK_INTERVAL_MS = 10_000;  // check every 10s
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

// OFI thresholds for signal classification
const OFI_STRONG_THRESHOLD = 0.30;       // |OFI| > 0.3 = strong signal
const OFI_SIGNAL_THRESHOLD = 0.10;       // |OFI| > 0.1 = weak signal
const ENTRY_MIN_STRENGTH = 0.40;         // min strength to generate entry signal

// ── OrderFlowService ────────────────────────────────────────────────────

class OrderFlowService {
  private ws: WebSocket | null = null;
  private tradeHistory: Map<string, RawTrade[]> = new Map(); // key: assetId (YES token)
  private markets: Map<string, ActiveMarket> = new Map();    // key: conditionId
  private tokenToMarket: Map<string, string> = new Map();    // assetId -> conditionId
  private pendingEntries: Map<string, OrderFlowSignal> = new Map(); // conditionId -> signal
  private recentlySignaled: Set<string> = new Set(); // next-market conditionIds already signaled (dedup)
  private reconnectTimer: NodeJS.Timeout | null = null;
  private signalCheckTimer: NodeJS.Timeout | null = null;
  private onSignal: ((signal: OrderFlowSignal) => void) | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private subscribedTokens: string[] = [];
  private msgCount = 0;
  private tradeCount = 0;
  private lastStatusLog = 0;

  /** Register handler for when a tradeable signal fires */
  setSignalHandler(handler: (signal: OrderFlowSignal) => void): void {
    this.onSignal = handler;
  }

  /** Start watching a set of active markets */
  async start(activeMarkets: ActiveMarket[]): Promise<void> {
    // Build mappings
    for (const m of activeMarkets) {
      this.markets.set(m.conditionId, m);
      this.tokenToMarket.set(m.yesTokenId, m.conditionId);
      if (!this.tradeHistory.has(m.yesTokenId)) {
        this.tradeHistory.set(m.yesTokenId, []);
      }
    }

    const tokenIds = activeMarkets.map(m => m.yesTokenId);
    this.connect(tokenIds);

    // Periodic signal check
    if (!this.signalCheckTimer) {
      this.signalCheckTimer = setInterval(() => this.checkAllSignals(), SIGNAL_CHECK_INTERVAL_MS);
    }

    console.log(`[OrderFlow] Started watching ${activeMarkets.length} markets (${tokenIds.length} tokens)`);
  }

  /** Update the markets being watched (called by discovery cron) */
  async updateMarkets(newMarkets: ActiveMarket[]): Promise<void> {
    const oldTokens = new Set(this.subscribedTokens);
    const newTokenIds: string[] = [];

    for (const m of newMarkets) {
      this.markets.set(m.conditionId, m);
      this.tokenToMarket.set(m.yesTokenId, m.conditionId);
      if (!this.tradeHistory.has(m.yesTokenId)) {
        this.tradeHistory.set(m.yesTokenId, []);
      }
      newTokenIds.push(m.yesTokenId);
    }

    // Remove expired markets
    const newConditionIds = new Set(newMarkets.map(m => m.conditionId));
    for (const [cid, _] of this.markets) {
      if (!newConditionIds.has(cid)) {
        const market = this.markets.get(cid);
        if (market) {
          this.tradeHistory.delete(market.yesTokenId);
          this.tokenToMarket.delete(market.yesTokenId);
        }
        this.markets.delete(cid);
        this.pendingEntries.delete(cid);
      }
    }

    // Reconnect if token set changed
    const tokensChanged = newTokenIds.length !== oldTokens.size ||
      newTokenIds.some(t => !oldTokens.has(t));

    if (tokensChanged && this.ws) {
      console.log(`[OrderFlow] Market set changed, reconnecting (${newTokenIds.length} tokens)`);
      this.ws.close();
      // Reconnect handler will fire and use new token list
    }
  }

  /** Graceful shutdown */
  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.signalCheckTimer) clearInterval(this.signalCheckTimer);
    this.signalCheckTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
    this.isConnected = false;
    console.log('[OrderFlow] Stopped');
  }

  /** Get current status */
  getStatus(): { connected: boolean; marketsWatched: number; tradesTracked: number } {
    let tradesTracked = 0;
    for (const [, trades] of this.tradeHistory) tradesTracked += trades.length;
    return {
      connected: this.isConnected,
      marketsWatched: this.markets.size,
      tradesTracked,
    };
  }

  /** Get the current signal for a specific market (for dashboard/API) */
  getSignalForMarket(conditionId: string): OrderFlowSignal | null {
    const market = this.markets.get(conditionId);
    if (!market) return null;
    return this.computeSignal(market);
  }

  /** Get signals for all watched markets (for dashboard) */
  getAllSignals(): OrderFlowSignal[] {
    const signals: OrderFlowSignal[] = [];
    for (const [, market] of this.markets) {
      signals.push(this.computeSignal(market));
    }
    return signals;
  }

  // ── WebSocket connection ────────────────────────────────────────────

  private connect(tokenIds: string[]): void {
    this.subscribedTokens = tokenIds;

    try {
      this.ws = new WebSocket(POLY_WS_URL);

      this.ws.on('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log('[OrderFlow] Connected to Polymarket WebSocket');

        // Subscribe to market channel with all token IDs
        const subMsg = JSON.stringify({
          assets_ids: tokenIds,
          type: 'market',
          custom_feature_enabled: true,
        });
        this.ws!.send(subMsg);
        console.log(`[OrderFlow] Subscribed to ${tokenIds.length} tokens`);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch { /* ignore parse errors */ }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        const delay = Math.min(
          RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
          MAX_RECONNECT_DELAY_MS
        );
        this.reconnectAttempts++;
        console.log(`[OrderFlow] Disconnected, reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => this.connect(this.subscribedTokens), delay);
      });

      this.ws.on('error', (err) => {
        console.error('[OrderFlow] WebSocket error:', err.message);
      });

    } catch (err: any) {
      console.error('[OrderFlow] Failed to connect:', err.message);
      this.reconnectTimer = setTimeout(() => this.connect(tokenIds), RECONNECT_DELAY_MS);
    }
  }

  // ── Message handling ────────────────────────────────────────────────

  private handleMessage(msg: Record<string, unknown>): void {
    this.msgCount++;
    const eventType = msg.event_type as string;

    // Log first few messages for debugging subscription format
    if (this.msgCount <= 5) {
      console.log(`[OrderFlow] WS msg #${this.msgCount}: event_type=${eventType}, keys=${Object.keys(msg).join(',')}`);
    }

    if (eventType === 'last_trade_price') {
      this.tradeCount++;
      this.handleTrade(msg);
    }

    // Periodic status log every 60s
    const now = Date.now();
    if (now - this.lastStatusLog > 60_000) {
      this.lastStatusLog = now;
      let totalTrades = 0;
      for (const [, trades] of this.tradeHistory) totalTrades += trades.length;
      console.log(
        `[OrderFlow] Status: ${this.msgCount} msgs, ${this.tradeCount} trades received, ` +
        `${totalTrades} in window, ${this.markets.size} markets, ` +
        `${this.pendingEntries.size} pending signals`
      );
    }
  }

  private handleTrade(msg: Record<string, unknown>): void {
    const assetId = msg.asset_id as string;
    const side = msg.side as string;
    const size = parseFloat(msg.size as string);
    const price = parseFloat(msg.price as string);
    const timestamp = parseInt(msg.timestamp as string, 10);

    if (!assetId || !side || isNaN(size) || isNaN(price)) return;

    const history = this.tradeHistory.get(assetId);
    if (!history) return; // not a market we're tracking

    const trade: RawTrade = {
      assetId,
      side: side === 'BUY' ? 'BUY' : 'SELL',
      size,
      price,
      timestamp: timestamp || Date.now(),
    };

    history.push(trade);

    // Prune old trades beyond our tracking window
    const cutoff = Date.now() - TRADE_WINDOW_MS;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }
  }

  // ── Signal computation ──────────────────────────────────────────────

  private checkAllSignals(): void {
    const now = Date.now();

    for (const [conditionId, market] of this.markets) {
      const msUntilEnd = market.endTime - now;
      const minutesUntilEnd = msUntilEnd / 60_000;

      // Skip if window already ended (stale market)
      if (msUntilEnd < -60_000) continue;

      // PRE_WINDOW: 60-90 seconds before window ends
      // This is when we capture the order flow from early positioners
      if (msUntilEnd <= 90_000 && msUntilEnd > 60_000) {
        const signal = this.computeSignal(market);
        if (signal.entryDirection) {
          console.log(
            `[OrderFlow] PRE_WINDOW: ${market.asset} ${signal.entryDirection} ` +
            `OFI60=${signal.ofi60s.toFixed(3)} str=${signal.signalStrength.toFixed(2)} ` +
            `vol=${signal.totalVolume60s.toFixed(0)} large=${signal.largeTradeDetected}`
          );
          this.pendingEntries.set(conditionId, signal);
        }
      }

      // NEW_WINDOW check: if we have a pending entry and current window just ended
      // (i.e., we're past the end time and within the first 60s after expiry).
      // The signal was detected on THIS market (closing), but we trade the NEXT
      // window for the same asset. Find it by looking for the same asset with
      // endTime > now (the window that just opened).
      if (msUntilEnd < 0 && msUntilEnd > -60_000 && this.pendingEntries.has(conditionId)) {
        const pendingSignal = this.pendingEntries.get(conditionId)!;
        const freshSignal = this.computeSignal(market);

        // Confirm signal: strength still above threshold and direction hasn't flipped
        if (freshSignal.signalStrength >= ENTRY_MIN_STRENGTH &&
            freshSignal.entryDirection === pendingSignal.entryDirection) {

          // Find the NEXT window for this asset (same asset, endTime > now, closest)
          const nextMarket = this.findNextWindow(market.asset, now);
          if (nextMarket) {
            // Dedup: if multiple expiring windows (e.g., 5m + 15m ending at same time)
            // both find the same next market, only signal once.
            if (this.recentlySignaled.has(nextMarket.conditionId)) {
              console.log(
                `[OrderFlow] NEW_WINDOW DEDUP: ${market.asset} ${freshSignal.entryDirection} ` +
                `-> "${nextMarket.question.substring(0, 50)}" already signaled`
              );
            } else {
              this.recentlySignaled.add(nextMarket.conditionId);
              // Auto-clear after 2 minutes (well past the 60s NEW_WINDOW check)
              setTimeout(() => this.recentlySignaled.delete(nextMarket.conditionId), 120_000);

              // Build signal with the NEXT market's identifiers but current OFI data
              const tradeSignal: OrderFlowSignal = {
                ...freshSignal,
                conditionId: nextMarket.conditionId,
                question: nextMarket.question,
                windowMinutes: nextMarket.windowMinutes,
                windowEnd: nextMarket.endTime,
                minutesUntilWindowEnd: (nextMarket.endTime - now) / 60_000,
                midPrice: nextMarket.midPrice,
                yesTokenId: nextMarket.yesTokenId,
                noTokenId: nextMarket.noTokenId,
              };
              console.log(
                `[OrderFlow] NEW_WINDOW CONFIRMED: ${market.asset} ${freshSignal.entryDirection} ` +
                `OFI60=${freshSignal.ofi60s.toFixed(3)} str=${freshSignal.signalStrength.toFixed(2)} ` +
                `-> trading next window: "${nextMarket.question.substring(0, 50)}"`
              );
              this.onSignal?.(tradeSignal);
            }
          } else {
            console.log(
              `[OrderFlow] NEW_WINDOW CONFIRMED but no next window found for ${market.asset}`
            );
          }
        } else {
          console.log(
            `[OrderFlow] NEW_WINDOW CANCELLED: ${market.asset} ` +
            `(str=${freshSignal.signalStrength.toFixed(2)}, dir=${freshSignal.entryDirection})`
          );
        }

        this.pendingEntries.delete(conditionId);
      }

      // Persist OFI to DB for dashboard (throttled to every 30s)
      if (now % 30_000 < SIGNAL_CHECK_INTERVAL_MS) {
        this.persistSignal(market).catch(() => {});
      }
    }
  }

  /**
   * Find the next active window for a given asset (same asset, endTime > now).
   * Returns the closest upcoming window, or null if none found.
   */
  private findNextWindow(asset: string, now: number): ActiveMarket | null {
    let best: ActiveMarket | null = null;
    let bestEnd = Infinity;

    for (const [, m] of this.markets) {
      if (m.asset === asset && m.endTime > now && m.endTime < bestEnd) {
        best = m;
        bestEnd = m.endTime;
      }
    }
    return best;
  }

  computeSignal(market: ActiveMarket): OrderFlowSignal {
    const history = this.tradeHistory.get(market.yesTokenId) ?? [];
    const now = Date.now();

    // Compute OFI for different time windows
    const computeOFI = (windowMs: number): { ofi: number; buyVol: number; sellVol: number } => {
      const cutoff = now - windowMs;
      const recent = history.filter(t => t.timestamp >= cutoff);
      if (recent.length === 0) return { ofi: 0, buyVol: 0, sellVol: 0 };

      // BUY side = buying YES = bullish. SELL side = selling YES = bearish.
      const buyVol = recent.filter(t => t.side === 'BUY').reduce((s, t) => s + t.size, 0);
      const sellVol = recent.filter(t => t.side === 'SELL').reduce((s, t) => s + t.size, 0);
      const total = buyVol + sellVol;
      return {
        ofi: total === 0 ? 0 : (buyVol - sellVol) / total,
        buyVol,
        sellVol,
      };
    };

    const r30 = computeOFI(30_000);
    const r60 = computeOFI(60_000);
    const r90 = computeOFI(90_000);

    // Large trade detection (any single trade > threshold in last 30s)
    const recent30s = history.filter(t => t.timestamp >= now - 30_000);
    const largeTrade = recent30s.find(t => t.size >= LARGE_TRADE_THRESHOLD);

    // Signal classification based on OFI60s (most reliable window)
    // Confirmation: OFI30s should agree with OFI60s direction
    const ofiAligned = (r60.ofi > 0 && r30.ofi > 0) || (r60.ofi < 0 && r30.ofi < 0);
    const baseStrength = ofiAligned
      ? Math.min(1.0, Math.abs(r60.ofi) * 2)  // amplify when 30s confirms 60s
      : Math.min(0.5, Math.abs(r60.ofi));      // cap at 0.5 when divergent

    // Boost for large trades (institutional flow detected)
    const signalStrength = largeTrade
      ? Math.min(1.0, baseStrength + 0.2)
      : baseStrength;

    // Signal classification
    let signal: OrderFlowSignal['signal'];
    if (r60.ofi > OFI_STRONG_THRESHOLD && ofiAligned) signal = 'strong_yes';
    else if (r60.ofi > OFI_SIGNAL_THRESHOLD) signal = 'yes';
    else if (r60.ofi < -OFI_STRONG_THRESHOLD && ofiAligned) signal = 'strong_no';
    else if (r60.ofi < -OFI_SIGNAL_THRESHOLD) signal = 'no';
    else signal = 'neutral';

    // Entry decision: require minimum strength and non-neutral signal
    let entryDirection: 'YES' | 'NO' | null = null;
    if (signalStrength >= ENTRY_MIN_STRENGTH && signal !== 'neutral') {
      entryDirection = r60.ofi > 0 ? 'YES' : 'NO';
    }

    return {
      conditionId: market.conditionId,
      asset: market.asset,
      question: market.question,
      windowMinutes: market.windowMinutes,
      windowEnd: market.endTime,
      minutesUntilWindowEnd: (market.endTime - now) / 60_000,
      ofi30s: r30.ofi,
      ofi60s: r60.ofi,
      ofi90s: r90.ofi,
      aggressiveBuyVolume: r60.buyVol,
      aggressiveSellVolume: r60.sellVol,
      totalVolume60s: r60.buyVol + r60.sellVol,
      largeTradeDetected: !!largeTrade,
      largeTradeDirection: largeTrade ? (largeTrade.side === 'BUY' ? 'YES' : 'NO') : null,
      signal,
      signalStrength,
      entryDirection,
      midPrice: market.midPrice,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
    };
  }

  // ── DB persistence (for dashboard) ──────────────────────────────────

  private async persistSignal(market: ActiveMarket): Promise<void> {
    const signal = this.computeSignal(market);
    await query(
      `INSERT INTO order_flow_signals (asset, market_id, ofi_30s, ofi_60s, ofi_90s, signal, signal_strength, large_trade, large_trade_dir, trades_per_min, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (asset) DO UPDATE SET
         market_id = EXCLUDED.market_id,
         ofi_30s = EXCLUDED.ofi_30s,
         ofi_60s = EXCLUDED.ofi_60s,
         ofi_90s = EXCLUDED.ofi_90s,
         signal = EXCLUDED.signal,
         signal_strength = EXCLUDED.signal_strength,
         large_trade = EXCLUDED.large_trade,
         large_trade_dir = EXCLUDED.large_trade_dir,
         trades_per_min = EXCLUDED.trades_per_min,
         updated_at = NOW()`,
      [
        market.asset,
        market.conditionId,
        signal.ofi30s,
        signal.ofi60s,
        signal.ofi90s,
        signal.signal,
        signal.signalStrength,
        signal.largeTradeDetected,
        signal.largeTradeDirection,
        signal.totalVolume60s, // approximate trades/min
      ]
    ).catch(() => {}); // non-critical; table may not exist yet
  }
}

// ── Singleton export ──────────────────────────────────────────────────

export const orderFlowService = new OrderFlowService();
