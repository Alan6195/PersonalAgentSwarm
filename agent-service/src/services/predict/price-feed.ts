/**
 * Real-Time Price Feed Service
 *
 * Connects to Coinbase Advanced Trade WebSocket for BTC/ETH/SOL/XRP prices.
 * Maintains rolling 20-minute history of 10-second snapshots in memory.
 * Computes momentum signals for the Polymarket scanner's Bayesian prior update.
 *
 * Flushes signals to price_signals table every 30 seconds for the dashboard API.
 *
 * If Coinbase fails, falls back to Binance WebSocket.
 */

import WebSocket from 'ws';
import { query } from '../../db';

export interface PriceSnapshot {
  price: number;
  timestamp: number; // unix ms
}

export interface AssetSignal {
  asset: string;
  currentPrice: number;
  return1m: number;    // % return over last 1 minute
  return5m: number;    // % return over last 5 minutes
  return15m: number;   // % return over last 15 minutes
  volatility5m: number; // rolling stddev of returns over 5 min
  momentum: 'strong_up' | 'up' | 'neutral' | 'down' | 'strong_down';
  momentumStrength: number; // 0.0 - 1.0
  lastUpdated: number; // unix ms
}

const COINBASE_ASSETS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
const BINANCE_STREAMS = ['btcusdt@ticker', 'ethusdt@ticker', 'solusdt@ticker', 'xrpusdt@ticker'];

const ASSET_MAP_COINBASE: Record<string, string> = {
  'BTC-USD': 'BTC', 'ETH-USD': 'ETH', 'SOL-USD': 'SOL', 'XRP-USD': 'XRP',
};
const ASSET_MAP_BINANCE: Record<string, string> = {
  'BTCUSDT': 'BTC', 'ETHUSDT': 'ETH', 'SOLUSDT': 'SOL', 'XRPUSDT': 'XRP',
};

// Keep 20 minutes of 10-second snapshots = 120 snapshots per asset
const MAX_HISTORY = 120;

class PriceFeedService {
  private history: Map<string, PriceSnapshot[]> = new Map();
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private dbFlushInterval: NodeJS.Timeout | null = null;
  private isConnected = false;
  private source: 'coinbase' | 'binance' = 'coinbase';
  private coinbaseFailed = false;

  constructor() {
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      this.history.set(asset, []);
    }
  }

  start(): void {
    console.log('[PriceFeed] Starting price feed service');
    this.connect();

    // Flush to DB every 30 seconds for dashboard API
    this.dbFlushInterval = setInterval(() => this.flushToDb(), 30_000);
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.dbFlushInterval) clearInterval(this.dbFlushInterval);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
    this.isConnected = false;
    console.log('[PriceFeed] Stopped');
  }

  private connect(): void {
    if (this.coinbaseFailed) {
      this.connectBinance();
    } else {
      this.connectCoinbase();
    }
  }

  private connectCoinbase(): void {
    try {
      this.source = 'coinbase';
      this.ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');

      this.ws.on('open', () => {
        this.isConnected = true;
        console.log('[PriceFeed] Connected to Coinbase WebSocket');

        this.ws!.send(JSON.stringify({
          type: 'subscribe',
          channels: [{ name: 'ticker', product_ids: COINBASE_ASSETS }],
        }));
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleCoinbaseMessage(msg);
        } catch { /* ignore parse errors */ }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        console.log('[PriceFeed] Coinbase disconnected, reconnecting in 5s');
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      });

      this.ws.on('error', (err: Error) => {
        console.error('[PriceFeed] Coinbase WebSocket error:', err.message);
        if (!this.coinbaseFailed) {
          this.coinbaseFailed = true;
          console.log('[PriceFeed] Switching to Binance fallback');
        }
      });
    } catch (err: any) {
      console.error('[PriceFeed] Failed to connect to Coinbase:', err);
      this.coinbaseFailed = true;
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    }
  }

  private connectBinance(): void {
    try {
      this.source = 'binance';
      const streams = BINANCE_STREAMS.join('/');
      this.ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

      this.ws.on('open', () => {
        this.isConnected = true;
        console.log('[PriceFeed] Connected to Binance WebSocket');
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleBinanceMessage(msg);
        } catch { /* ignore parse errors */ }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        console.log('[PriceFeed] Binance disconnected, reconnecting in 5s');
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      });

      this.ws.on('error', (err: Error) => {
        console.error('[PriceFeed] Binance WebSocket error:', err.message);
      });
    } catch (err: any) {
      console.error('[PriceFeed] Failed to connect to Binance:', err);
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    }
  }

  private handleCoinbaseMessage(msg: Record<string, unknown>): void {
    if (msg.type !== 'ticker') return;

    const productId = msg.product_id as string;
    const price = parseFloat(msg.price as string);
    if (!productId || isNaN(price)) return;

    const asset = ASSET_MAP_COINBASE[productId];
    if (!asset) return;

    this.addSnapshot(asset, price);
  }

  private handleBinanceMessage(msg: Record<string, unknown>): void {
    // Binance combined stream format: { stream: "btcusdt@ticker", data: { ... } }
    const streamData = msg.data as Record<string, unknown>;
    if (!streamData) return;

    const symbol = (streamData.s as string || '').toUpperCase();
    const price = parseFloat(streamData.c as string); // 'c' = close/last price
    if (!symbol || isNaN(price)) return;

    const asset = ASSET_MAP_BINANCE[symbol];
    if (!asset) return;

    this.addSnapshot(asset, price);
  }

  private addSnapshot(asset: string, price: number): void {
    const history = this.history.get(asset);
    if (!history) return;

    const now = Date.now();
    const last = history[history.length - 1];

    if (!last || now - last.timestamp >= 10_000) {
      history.push({ price, timestamp: now });
      if (history.length > MAX_HISTORY) history.shift();
    } else {
      // Update the most recent snapshot price
      history[history.length - 1].price = price;
    }
  }

  getSignal(asset: string): AssetSignal | null {
    const history = this.history.get(asset);
    if (!history || history.length < 2) return null;

    const now = Date.now();
    const currentPrice = history[history.length - 1].price;

    const priceMinutesAgo = (minutes: number): number | null => {
      const targetTime = now - minutes * 60 * 1000;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].timestamp <= targetTime) return history[i].price;
      }
      return null;
    };

    const price1mAgo  = priceMinutesAgo(1);
    const price5mAgo  = priceMinutesAgo(5);
    const price15mAgo = priceMinutesAgo(15);

    const return1m  = price1mAgo  ? (currentPrice - price1mAgo)  / price1mAgo  : 0;
    const return5m  = price5mAgo  ? (currentPrice - price5mAgo)  / price5mAgo  : 0;
    const return15m = price15mAgo ? (currentPrice - price15mAgo) / price15mAgo : 0;

    // Rolling volatility: stddev of returns over last 5 minutes
    const recentHistory = history.filter(s => now - s.timestamp <= 5 * 60 * 1000);
    let volatility5m = 0;
    if (recentHistory.length >= 3) {
      const returns: number[] = [];
      for (let i = 1; i < recentHistory.length; i++) {
        returns.push((recentHistory[i].price - recentHistory[i-1].price) / recentHistory[i-1].price);
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      volatility5m = Math.sqrt(variance);
    }

    const momentum = classifyMomentum(return5m, return1m, volatility5m);

    return {
      asset,
      currentPrice,
      return1m,
      return5m,
      return15m,
      volatility5m,
      momentum: momentum.label,
      momentumStrength: momentum.strength,
      lastUpdated: history[history.length - 1].timestamp,
    };
  }

  getStatus(): { connected: boolean; source: string; assets: Record<string, number> } {
    const assets: Record<string, number> = {};
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      const history = this.history.get(asset);
      assets[asset] = history?.[history.length - 1]?.price ?? 0;
    }
    return { connected: this.isConnected, source: this.source, assets };
  }

  private async flushToDb(): Promise<void> {
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      const signal = this.getSignal(asset);
      if (!signal) continue;
      try {
        await query(`
          INSERT INTO price_signals
            (asset, current_price, return_1m, return_5m, return_15m,
             volatility_5m, momentum, momentum_strength, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
          ON CONFLICT (asset) DO UPDATE SET
            current_price = EXCLUDED.current_price,
            return_1m = EXCLUDED.return_1m,
            return_5m = EXCLUDED.return_5m,
            return_15m = EXCLUDED.return_15m,
            volatility_5m = EXCLUDED.volatility_5m,
            momentum = EXCLUDED.momentum,
            momentum_strength = EXCLUDED.momentum_strength,
            updated_at = NOW()
        `, [asset, signal.currentPrice, signal.return1m, signal.return5m,
            signal.return15m, signal.volatility5m, signal.momentum, signal.momentumStrength]);
      } catch { /* non-critical: dashboard just shows stale data */ }
    }
  }
}

function classifyMomentum(
  return5m: number,
  return1m: number,
  volatility: number
): { label: AssetSignal['momentum']; strength: number } {
  // Normalize by volatility: a 0.3% move means more in low-vol than high-vol
  const volAdjusted5m = volatility > 0 ? return5m / (volatility * 10) : return5m * 100;

  if (volAdjusted5m > 1.5 && return1m > 0)
    return { label: 'strong_up',   strength: Math.min(1.0, volAdjusted5m / 3) };
  if (volAdjusted5m > 0.5)
    return { label: 'up',          strength: Math.min(0.7, volAdjusted5m / 3) };
  if (volAdjusted5m < -1.5 && return1m < 0)
    return { label: 'strong_down', strength: Math.min(1.0, Math.abs(volAdjusted5m) / 3) };
  if (volAdjusted5m < -0.5)
    return { label: 'down',        strength: Math.min(0.7, Math.abs(volAdjusted5m) / 3) };

  return { label: 'neutral', strength: 0 };
}

// Singleton export
export const priceFeed = new PriceFeedService();
