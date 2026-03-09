'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types matching /api/predict response ──────────────────────────────────
interface PlatformStats {
  bankroll: number;
  bankrollChange: number;
  winRate: number;
  trades: number;
  wins: number;
  losses: number;
  openPositions: number;
  dailyPnl: number;
  totalPnl: number;
}

interface PolymarketStats extends PlatformStats {
  dryRun: boolean;
  openExposure?: number;
}

interface Position {
  id: number;
  platform: string;
  market_question: string;
  direction: string;
  asset: string | null;
  p_market: number;
  p_model: number;
  edge: number;
  bet_size: number;
  fill_price: number;
  shares: number;
  current_price: number | null;
  unrealized_pnl: number | null;
  potential_win: number;
  potential_loss: number;
  time_remaining_min: number | null;
  intel_aligned: boolean;
  status: string;
  pnl: number | null;
  opened_at: string;
}

interface Scan {
  id: number;
  market_question: string;
  platform: string;
  current_prob: number;
  claude_prob: number;
  edge: number;
  kelly_fraction: number;
  reasoning: string;
  created_at: string;
}

interface Hypothesis {
  id: number;
  hypothesis: string;
  category: string;
  status: string;
  confidence: number;
  win_count: number;
  loss_count: number;
  created_at: string;
}

interface RiskState {
  exposure: number;
  dailyLoss: number;
  drawdown: number;
  paused: boolean;
}

interface PhaseGate {
  trades: number;
  tradesTarget: number;
  winRate: number;
  winRateTarget: number;
  sharpe: number;
  sharpeTarget: number;
  phase2Unlocked: boolean;
}

interface EquityPoint {
  timestamp: string;
  balance: number;
}

interface Performance {
  activeDays: number;
  confirmed: number;
  sharpe: number;
  maxDrawdown: number;
  winStreak: number;
}

interface CostByAgent {
  agent: string;
  total: number;
  tokens: number;
  calls: number;
}

interface CostByModel {
  model: string;
  total: number;
  calls: number;
}

interface Costs {
  today: { total: number; byAgent: CostByAgent[] };
  month: { total: number; tokens: number; calls: number };
  byModel: CostByModel[];
}

interface PriceFeedAsset {
  price: number;
  return5m: number;
  momentum: string;
  momentumStrength: number;
  updatedAt: string;
}

interface PriceFeedData {
  connected: boolean;
  assets: Record<string, PriceFeedAsset>;
}

interface IntelSignalData {
  direction: string;
  strength: number;
  ageMinutes: number;
}

interface DashboardData {
  manifold: PlatformStats;
  polymarket: PolymarketStats;
  phaseGate: PhaseGate;
  riskState: RiskState;
  positions: Position[];
  recentScans: Scan[];
  hypotheses: Hypothesis[];
  equityHistory: EquityPoint[];
  costs?: Costs;
  performance: Performance;
  priceFeed?: PriceFeedData;
  intelSignals?: Record<string, IntelSignalData>;
  lastIntelScan?: string;
}

// ── Colour tokens ─────────────────────────────────────────────────────────
const C = {
  bg:        '#000000',
  panel:     '#03080300',
  border:    '#0d2a0d',
  border2:   '#071407',
  green:     '#00ff41',
  greenDim:  '#00b32d',
  greenFaint:'#001a05',
  red:       '#ff2d2d',
  yellow:    '#f5c518',
  cyan:      '#00e5ff',
  white:     '#e8ffe8',
  dim:       '#1a3a1a',
  dimmer:    '#0a150a',
  label:     '#2d5a2d',
  text:      '#7aad7a',
};

// ── Seeded PRNG for stable mock data ─────────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genMockEquityHistory(points = 120): EquityPoint[] {
  const rng = mulberry32(0xdeadbeef);
  let val = 1000;
  return Array.from({ length: points }, (_, i) => {
    val = Math.max(800, val * (1 + (rng() - 0.44) * 0.006));
    return {
      timestamp: new Date(Date.now() - (points - i) * 15 * 60000).toISOString(),
      balance: +val.toFixed(2),
    };
  });
}

const MOCK_HISTORY = genMockEquityHistory(120);

const MOCK_PLATFORM: PlatformStats = {
  bankroll: 1000, bankrollChange: 0, winRate: 0, trades: 0,
  wins: 0, losses: 0, openPositions: 0, dailyPnl: 0, totalPnl: 0,
};

const MOCK_DATA: DashboardData = {
  manifold: { ...MOCK_PLATFORM },
  polymarket: { ...MOCK_PLATFORM, dryRun: true },
  phaseGate: {
    trades: 0, tradesTarget: 15, winRate: 0, winRateTarget: 0.55,
    sharpe: 0, sharpeTarget: 1.2, phase2Unlocked: false,
  },
  riskState: { exposure: 0, dailyLoss: 0, drawdown: 0, paused: false },
  positions: [],
  recentScans: [],
  hypotheses: [],
  equityHistory: MOCK_HISTORY,
  performance: { activeDays: 0, confirmed: 0, sharpe: 0, maxDrawdown: 0, winStreak: 0 },
};

// ── Tiny helpers ──────────────────────────────────────────────────────────
function fmt2(n: number) { return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2); }
function fmtUsd(n: number) { return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtCost(n: number) { return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; }
function shortModel(m: string) { return m.replace(/-\d{8}$/, '').replace('claude-', ''); }
function pct(n: number)  { return `${(n * 100).toFixed(1)}%`; }
function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── SparkLine ─────────────────────────────────────────────────────────────
function SparkLine({ data, color = C.green }: { data: number[]; color?: string }) {
  if (data.length < 2) return null;
  const mn = Math.min(...data), mx = Math.max(...data);
  const range = mx - mn || 1;
  const W = 560, H = 140;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((v - mn) / range) * (H - 8) - 4;
    return `${x},${y}`;
  });
  const line = `M${pts.join(' L')}`;
  const area = `M0,${H} L${pts.join(' L')} L${W},${H} Z`;
  const last = pts[pts.length - 1].split(',');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="sg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sg)" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="3" fill={color} />
    </svg>
  );
}

// ── Blink cursor ──────────────────────────────────────────────────────────
function Cursor() {
  const [on, setOn] = useState(true);
  useEffect(() => { const t = setInterval(() => setOn(v => !v), 530); return () => clearInterval(t); }, []);
  return <span style={{ color: C.green, opacity: on ? 1 : 0 }}>█</span>;
}

// ── Panel ─────────────────────────────────────────────────────────────────
function Panel({ children, title, style = {} }: { children: React.ReactNode; title?: string; style?: React.CSSProperties }) {
  return (
    <div style={{ background: 'rgba(0,8,0,0.6)', border: `1px solid ${C.border}`, borderRadius: 2, ...style }}>
      {title && (
        <div style={{ padding: '3px 8px', borderBottom: `1px solid ${C.border2}`, fontSize: 9, fontFamily: 'monospace', color: C.label, letterSpacing: '0.15em', textTransform: 'uppercase' }}>
          ○ {title}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Formula row ───────────────────────────────────────────────────────────
function FRow({ label, expr, value, vc }: { label?: string; expr?: string; value?: string; vc?: string }) {
  return (
    <div style={{ padding: '4px 8px', borderBottom: `1px solid ${C.border2}` }}>
      {label && <div style={{ fontSize: 8, color: C.label, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 1 }}>{label}</div>}
      {expr  && <div style={{ fontSize: 11, color: C.text, fontFamily: 'monospace' }}>{expr}</div>}
      {value && <div style={{ fontSize: 12, color: vc || C.green, fontFamily: 'monospace', fontWeight: 700, textAlign: 'right', marginTop: 2 }}>{value}</div>}
    </div>
  );
}

// ── Trading stats ─────────────────────────────────────────────────────────
function TradingStatsPanel({ gate, perf }: { gate: PhaseGate; perf: Performance }) {
  return (
    <Panel title="Trading Stats · 24/7 Order Flow">
      <div style={{ padding: '8px 10px' }}>
        <div style={{ display: 'flex', gap: 16 }}>
          {[
            { l: 'TRADES',   v: String(gate.trades), c: C.text },
            { l: 'WIN RATE', v: pct(gate.winRate),   c: gate.winRate >= 0.55 ? C.green : gate.winRate > 0 ? C.yellow : C.text },
            { l: 'SHARPE',   v: gate.sharpe.toFixed(2), c: gate.sharpe >= 1.0 ? C.green : C.yellow },
          ].map(g => (
            <div key={g.l} style={{ fontFamily: 'monospace' }}>
              <div style={{ fontSize: 8, color: C.label }}>{g.l}</div>
              <div style={{ fontSize: 11, color: g.c, fontWeight: 700 }}>{g.v}</div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

// ── Risk state ────────────────────────────────────────────────────────────
function RiskPanel({ risk }: { risk: RiskState }) {
  const ddPct = risk.drawdown * 100;
  const expPct = risk.exposure * 100;
  const dlPct = risk.dailyLoss * 100;
  return (
    <Panel title="Risk State">
      {[
        { l: 'EXPOSURE',   v: `${expPct.toFixed(1)}%`,  bar: expPct / 40,  warn: expPct > 30 },
        { l: 'DRAWDOWN',   v: `${ddPct.toFixed(1)}%`,   bar: ddPct / 15,   warn: ddPct > 10 },
        { l: 'DAILY LOSS', v: `${dlPct.toFixed(1)}%`,   bar: dlPct / 8,    warn: dlPct > 5 },
      ].map(r => (
        <div key={r.l} style={{ padding: '5px 8px', borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 8, color: C.label, fontFamily: 'monospace' }}>{r.l}</span>
            <span style={{ fontSize: 11, color: r.warn ? C.yellow : C.green, fontFamily: 'monospace', fontWeight: 700 }}>{r.v}</span>
          </div>
          <div style={{ height: 2, background: C.dimmer }}>
            <div style={{ height: '100%', width: `${Math.min(r.bar * 100, 100)}%`, background: r.warn ? C.yellow : C.greenDim, transition: 'width 0.5s' }} />
          </div>
        </div>
      ))}
      {risk.paused && (
        <div style={{ padding: '5px 8px', background: 'rgba(255,45,45,0.08)', fontSize: 10, color: C.red, fontFamily: 'monospace' }}>
          ⏸ TRADING PAUSED
        </div>
      )}
    </Panel>
  );
}

// ── Position card ─────────────────────────────────────────────────────────
function PositionRow({ pos }: { pos: Position }) {
  const hasLive = pos.current_price != null && pos.current_price > 0;
  const displayPnl = pos.pnl ?? pos.unrealized_pnl ?? 0;
  const pnlLabel = pos.pnl != null ? '' : (hasLive ? 'UNRL' : 'POT');
  const displayPnlValue = pos.pnl != null ? displayPnl : (hasLive ? displayPnl : pos.potential_win);
  const pnlColor = displayPnlValue >= 0 ? C.green : C.red;

  // Time remaining
  const trMin = pos.time_remaining_min;
  const timeStr = trMin != null
    ? (trMin <= 0 ? 'EXPIRED' : trMin < 1 ? `${Math.round(trMin * 60)}s` : `${Math.round(trMin)}m`)
    : null;
  const timeColor = trMin != null ? (trMin <= 0 ? C.red : trMin < 2 ? C.yellow : C.greenDim) : C.dim;

  return (
    <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border2}`, fontFamily: 'monospace' }}>
      {/* Row 1: Question + P&L */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: C.white, flex: 1, marginRight: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pos.asset && <span style={{ color: C.cyan, marginRight: 6 }}>{pos.asset}</span>}
          {pos.market_question}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: pnlColor, flexShrink: 0 }}>
          {pnlLabel && <span style={{ fontSize: 7, color: C.label, marginRight: 3 }}>{pnlLabel}</span>}
          {fmt2(displayPnlValue)}
        </span>
      </div>

      {/* Row 2: Tags */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 9, padding: '1px 6px', border: `1px solid ${pos.direction === 'YES' ? C.green : C.red}`, color: pos.direction === 'YES' ? C.green : C.red }}>{pos.direction}</span>
        {pos.intel_aligned && <span style={{ fontSize: 9, padding: '1px 6px', border: `1px solid ${C.cyan}`, color: C.cyan }}>⚡ INTEL</span>}
        <span style={{ fontSize: 9, color: '#8b5cf6' }}>edge {(pos.edge * 100).toFixed(0)}¢</span>
        {timeStr && (
          <span style={{ fontSize: 9, padding: '1px 6px', border: `1px solid ${timeColor}`, color: timeColor }}>
            ⏱ {timeStr}
          </span>
        )}
        <span style={{ fontSize: 9, color: C.dim, marginLeft: 'auto' }}>{timeAgo(pos.opened_at)}</span>
      </div>

      {/* Row 3: Trade details grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
        {[
          { l: 'SIZE',    v: `$${pos.bet_size.toFixed(2)}`, c: C.text },
          { l: 'ENTRY',   v: `${(pos.fill_price * 100).toFixed(1)}¢`, c: C.text },
          { l: 'CURRENT', v: hasLive ? `${(pos.current_price! * 100).toFixed(1)}¢` : '--', c: hasLive ? (pos.current_price! > pos.fill_price ? C.green : pos.current_price! < pos.fill_price ? C.red : C.text) : C.dim },
          { l: 'SHARES',  v: pos.shares.toFixed(1), c: C.text },
          { l: 'IF WIN',  v: `+${pos.potential_win.toFixed(2)}`, c: C.greenDim },
        ].map(d => (
          <div key={d.l}>
            <div style={{ fontSize: 7, color: C.label, letterSpacing: '0.08em' }}>{d.l}</div>
            <div style={{ fontSize: 10, color: d.c, fontWeight: 600 }}>{d.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Scan row ──────────────────────────────────────────────────────────────
function ScanRow({ scan }: { scan: Scan }) {
  const edgeColor = scan.edge >= 0.08 ? C.green : scan.edge >= 0.04 ? C.yellow : C.red;
  return (
    <div style={{ padding: '7px 10px', borderBottom: `1px solid ${C.border2}`, fontFamily: 'monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: C.text, flex: 1, marginRight: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {scan.market_question}
        </span>
        <span style={{ fontSize: 11, color: edgeColor, fontWeight: 700, flexShrink: 0 }}>
          {(scan.edge * 100).toFixed(0)}¢
        </span>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <span style={{ fontSize: 9, color: C.label }}>mkt {pct(scan.current_prob)}</span>
        <span style={{ fontSize: 9, color: C.cyan }}>claude {pct(scan.claude_prob)}</span>
        <span style={{ fontSize: 9, color: C.greenDim }}>kelly {(scan.kelly_fraction * 100).toFixed(1)}%</span>
        <span style={{ fontSize: 9, color: C.dim, marginLeft: 'auto' }}>{timeAgo(scan.created_at)}</span>
      </div>
      {scan.reasoning && (
        <div style={{ fontSize: 9, color: C.dim, marginTop: 4, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>
          {scan.reasoning.slice(0, 180)}…
        </div>
      )}
    </div>
  );
}

// ── Hypothesis row ────────────────────────────────────────────────────────
function HypRow({ h }: { h: Hypothesis }) {
  const sc = h.status === 'confirmed' ? C.green : h.status === 'refuted' ? C.red : C.yellow;
  return (
    <div style={{ padding: '6px 10px', borderBottom: `1px solid ${C.border2}`, borderLeft: `2px solid ${sc}`, fontFamily: 'monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 9, color: sc, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h.status}</span>
        <span style={{ fontSize: 9, color: C.dim }}>{(h.confidence * 100).toFixed(0)}% · {h.win_count}W/{h.loss_count}L</span>
      </div>
      <div style={{ fontSize: 10, color: C.text, lineHeight: 1.4 }}>{h.hypothesis}</div>
      <div style={{ height: 2, background: C.dimmer, marginTop: 5 }}>
        <div style={{ height: '100%', width: `${h.confidence * 100}%`, background: sc }} />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function PredictPage() {
  const [data, setData]       = useState<DashboardData>(MOCK_DATA);
  const [isLive, setIsLive]   = useState(false);
  const [activeTab, setTab]   = useState<'positions' | 'scans' | 'hypotheses'>('positions');
  const [tick, setTick]       = useState(0);
  const [lastFetchAt, setLastFetchAt] = useState<number>(Date.now());
  const [secondsAgo, setSecondsAgo]   = useState(0);
  const [dataFlash, setDataFlash]     = useState(false);
  const prevHashRef           = useRef('');
  const rngRef                = useRef(mulberry32(0xabcdef12));

  // Poll /api/predict every 5s
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/predict');
      if (!res.ok) return;
      const json = await res.json();
      // Detect actual data change for flash animation
      const hash = `${json.polymarket?.bankroll}-${json.polymarket?.trades}-${json.positions?.length}-${json.polymarket?.totalPnl}`;
      if (prevHashRef.current && prevHashRef.current !== hash) {
        setDataFlash(true);
        setTimeout(() => setDataFlash(false), 600);
      }
      prevHashRef.current = hash;
      setData(json);
      setIsLive(true);
      setLastFetchAt(Date.now());
    } catch {
      // stay on mock data
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  // Poll every 5 seconds
  useEffect(() => {
    const t = setInterval(() => { fetchData(); setTick(v => v + 1); }, 5_000);
    return () => clearInterval(t);
  }, [fetchData]);
  // Update "seconds ago" counter every second
  useEffect(() => {
    const t = setInterval(() => setSecondsAgo(Math.floor((Date.now() - lastFetchAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [lastFetchAt]);
  // Refetch immediately when tab becomes visible (browsers throttle setInterval in background tabs)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') fetchData(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchData]);

  // Animate equity on mock data
  const [liveHistory, setLiveHistory] = useState(MOCK_HISTORY.map(s => s.balance));
  useEffect(() => {
    if (isLive) return;
    const rng = rngRef.current;
    const t = setInterval(() => {
      setLiveHistory(h => {
        const last = h[h.length - 1];
        return [...h.slice(-119), +(last * (1 + (rng() - 0.44) * 0.004)).toFixed(2)];
      });
    }, 2000);
    return () => clearInterval(t);
  }, [isLive]);

  const equityHistory = isLive
    ? data.equityHistory.map(s => s.balance)
    : liveHistory;

  const p    = data.polymarket;
  const risk = data.riskState;
  const gate = data.phaseGate;
  const perf = data.performance;
  const bal  = p.bankroll;
  const wr   = p.winRate;
  const trades = p.trades;

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'monospace', color: C.text, fontSize: 11, overflow: 'hidden' }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #0d2a0d; border-radius: 1px; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ping { 75%,100% { transform: scale(2); opacity: 0; } }
        @keyframes dataFlash { 0% { background: rgba(0,255,65,0.08); } 100% { background: transparent; } }
        @font-face { font-family: 'JetBrains Mono'; src: local('JetBrains Mono'); }
      `}</style>

      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 14px', background: '#00050000', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
        <span style={{ color: C.green, fontWeight: 700, fontSize: 13, letterSpacing: '0.08em' }}>◈ PREDICT_AGENT</span>
        {[
          { label: p.dryRun ? 'DRY RUN' : '⚡ LIVE USDC', color: p.dryRun ? C.yellow : C.green },
          { label: 'ORDER FLOW', color: C.cyan },
          { label: 'v1.1.0', color: C.greenDim },
        ].map(t => (
          <span key={t.label} style={{ padding: '1px 7px', fontSize: 9, border: `1px solid ${t.color}`, color: t.color, letterSpacing: '0.08em' }}>{t.label}</span>
        ))}
        <div style={{ flex: 1 }} />
        {/* live indicator */}
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ position: 'relative', width: 7, height: 7, display: 'inline-block' }}>
            <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: isLive ? C.green : C.yellow, opacity: 0.4, animation: 'ping 1.5s cubic-bezier(0,0,0.2,1) infinite' }} />
            <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: isLive ? C.green : C.yellow }} />
          </span>
          <span style={{ fontSize: 9, color: isLive ? C.green : C.yellow }}>{isLive ? 'LIVE' : 'MOCK'}</span>
        </span>
        <span style={{ fontSize: 9, color: C.dim }}>POLYMARKET</span>
        <span style={{ fontSize: 9, color: secondsAgo <= 1 ? C.green : C.dim, transition: 'color 0.3s' }}>
          {secondsAgo <= 1 ? '● synced' : `${secondsAgo}s ago`}
        </span>
        <span style={{ fontSize: 9, color: C.dim }}>5s poll</span>
        <Cursor />
      </div>

      {/* ── KPI strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: `1px solid ${C.border}`, animation: dataFlash ? 'dataFlash 0.6s ease-out' : 'none' }}>
        {[
          { label: 'BANKROLL',   value: fmtUsd(bal),                    sub: fmt2(p.bankrollChange),              color: C.green },
          { label: 'WIN RATE',   value: pct(wr),                        sub: `${p.wins}W / ${p.losses}L`,        color: wr >= 0.55 ? C.green : wr > 0 ? C.yellow : C.text },
          { label: 'TOTAL P&L',  value: fmt2(p.totalPnl),               sub: null,                                color: p.totalPnl >= 0 ? C.green : C.red },
          { label: 'TRADES',     value: String(p.trades + p.openPositions), sub: `${p.trades} closed · ${p.openPositions} open`, color: C.text },
          { label: 'DAILY P&L',  value: fmt2(p.dailyPnl),               sub: null,                                color: p.dailyPnl >= 0 ? C.green : C.red },
          { label: 'EXPOSURE',   value: fmtUsd((p as PolymarketStats).openExposure || 0), sub: `${p.openPositions} positions`, color: C.cyan },
          { label: 'DEPLOYED',   value: bal > 0 ? pct(((p as PolymarketStats).openExposure || 0) / bal) : '0.0%', sub: null, color: C.cyan },
        ].map((k, i) => (
          <div key={k.label} style={{ padding: '7px 12px', borderRight: i < 6 ? `1px solid ${C.border}` : 'none' }}>
            <div style={{ fontSize: 8, color: C.label, letterSpacing: '0.12em', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: k.color }}>{k.value}</div>
            {k.sub && <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>{k.sub}</div>}
          </div>
        ))}
      </div>

      {/* ── Main 3-col grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr 230px', height: 'calc(100vh - 88px)', overflow: 'hidden' }}>

        {/* ── LEFT: formulas + risk ── */}
        <div style={{ borderRight: `1px solid ${C.border}`, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
          <Panel title="LMSR Cost Function">
            <FRow expr="C(q) = b · ln( Σ eᵍⁱ/ᵇ )" value="b = 100,000" vc={C.text} />
          </Panel>
          <Panel title="Bayesian Posterior">
            <FRow expr="log P(H|D) = log P(H) + Σ log P(Dᵢ|H)" />
            <FRow label="Prior"     value="—" vc={C.dim} />
            <FRow label="Posterior" value="—" vc={C.cyan} />
          </Panel>
          <Panel title="Hedge Condition π">
            <FRow expr="π = 1.00 − (p_Y + p_N)" value="—" vc={C.dim} />
          </Panel>
          <Panel title="Reward Score S(s)">
            <FRow expr="S(s) = ((v−s)²/v²) · b" />
          </Panel>
          <Panel title="Kelly · EV">
            <FRow expr="f* = (p·b − q) / b" />
            <FRow label="Fractional" expr="f = 0.25 · f*" value="25% Kelly" vc={C.greenDim} />
            <FRow label="Max bet" value="5% bankroll" vc={C.yellow} />
          </Panel>
          <Panel title="Expected Return">
            <FRow expr="E[R] = (Rewards − L_fill) / C_risk" />
          </Panel>
          <Panel title="Risk Limits">
            {[
              ['Max position',  '5% bankroll'],
              ['Max category',  '50% bankroll'],
              ['Max deployed',  '60% bankroll'],
              ['Daily loss',    '25% → pause'],
              ['Drawdown',      '30% → pause'],
              ['Min edge',      '6¢'],
            ].map(([l, v]) => (
              <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 8px', borderBottom: `1px solid ${C.border2}`, fontSize: 10 }}>
                <span style={{ color: C.label }}>{l}</span>
                <span style={{ color: C.text }}>{v}</span>
              </div>
            ))}
          </Panel>
          {/* Live Prices from Coinbase/Binance feed */}
          <Panel title="Live Prices">
            {(() => {
              const pf = data.priceFeed;
              const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
              if (!pf || !pf.assets || Object.keys(pf.assets).length === 0) {
                return <div style={{ padding: '10px 8px', fontSize: 9, color: C.dim }}>Waiting for price feed...</div>;
              }
              const ageStr = () => {
                const any = Object.values(pf.assets)[0];
                if (!any?.updatedAt) return '';
                const s = Math.floor((Date.now() - new Date(any.updatedAt).getTime()) / 1000);
                return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
              };
              return (
                <>
                  {assets.map(a => {
                    const d = pf.assets[a];
                    if (!d || !d.price) return null;
                    const ret = d.return5m * 100;
                    const retColor = Math.abs(ret) < 0.1 ? C.text : ret > 0 ? C.green : C.red;
                    const arrow = ret > 0.1 ? '\u25B2' : ret < -0.1 ? '\u25BC' : '\u2192';
                    const hasSignal = Math.abs(ret) > 0.3;
                    return (
                      <div key={a} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 8px', borderBottom: `1px solid ${C.border2}`, fontSize: 10, fontFamily: 'monospace' }}>
                        <span style={{ color: C.text, width: 30 }}>{a}</span>
                        <span style={{ color: C.white, flex: 1, textAlign: 'right', marginRight: 8 }}>
                          ${d.price < 10 ? d.price.toFixed(4) : d.price < 1000 ? d.price.toFixed(2) : d.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </span>
                        <span style={{ color: retColor, width: 80, textAlign: 'right' }}>
                          {arrow} {ret >= 0 ? '+' : ''}{ret.toFixed(2)}% 5m
                        </span>
                        {hasSignal && <span style={{ color: C.green, marginLeft: 4, fontSize: 7 }}>{'\u25CF'}</span>}
                      </div>
                    );
                  })}
                  <div style={{ padding: '3px 8px', fontSize: 8, color: C.dim }}>
                    FEED: <span style={{ color: pf.connected ? C.green : C.red }}>{'\u25CF'} {pf.connected ? 'LIVE' : 'DISCONNECTED'}</span>
                    {' '}{ageStr()}
                  </div>
                </>
              );
            })()}
          </Panel>

          {/* Intel Signals from X agent */}
          <Panel title="Intel Signals">
            {(() => {
              const intel = data.intelSignals;
              const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
              if (!intel || Object.keys(intel).length === 0) {
                return <div style={{ padding: '10px 8px', fontSize: 9, color: C.dim }}>No intel signals</div>;
              }
              return (
                <>
                  {assets.map(a => {
                    const s = intel[a];
                    if (!s) return (
                      <div key={a} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 8px', borderBottom: `1px solid ${C.border2}`, fontSize: 10, fontFamily: 'monospace' }}>
                        <span style={{ color: C.text, width: 30 }}>{a}</span>
                        <span style={{ color: C.dim }}>{'\u2192'} neutral</span>
                      </div>
                    );
                    const isBull = ['bullish', 'accelerating', 'positive'].includes(s.direction);
                    const isBear = ['bearish', 'decelerating', 'negative'].includes(s.direction);
                    const arrow = isBull ? '\u25B2' : isBear ? '\u25BC' : '\u2192';
                    const color = isBull ? C.green : isBear ? C.red : C.text;
                    return (
                      <div key={a} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 8px', borderBottom: `1px solid ${C.border2}`, fontSize: 10, fontFamily: 'monospace' }}>
                        <span style={{ color: C.text, width: 30 }}>{a}</span>
                        <span style={{ color }}>{arrow} {s.direction}</span>
                        <span style={{ color: C.dim, fontSize: 9, marginLeft: 4 }}>{s.strength.toFixed(2)}</span>
                        <span style={{ color: C.dim, fontSize: 8, marginLeft: 'auto' }}>{s.ageMinutes}m ago</span>
                      </div>
                    );
                  })}
                  {data.lastIntelScan && (
                    <div style={{ padding: '3px 8px', fontSize: 8, color: C.dim }}>
                      Last scan: {timeAgo(data.lastIntelScan)}
                    </div>
                  )}
                </>
              );
            })()}
          </Panel>

          <RiskPanel risk={risk} />
        </div>

        {/* ── CENTER: chart + tabs ── */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Equity chart */}
          <div style={{ padding: '8px 12px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9, color: C.label, letterSpacing: '0.12em', marginBottom: 6 }}>
              <span>○ EQUITY CURVE — LMSR BAYESIAN STRATEGY · POLYMARKET {p.dryRun ? 'DRY RUN' : 'LIVE'}</span>
              <span style={{ padding: '1px 6px', fontSize: 8, border: `1px solid ${isLive ? C.green : C.yellow}`, color: isLive ? C.green : C.yellow }}>
                {isLive ? 'LIVE' : 'MOCK'}
              </span>
            </div>
            <div style={{ position: 'relative' }}>
              <SparkLine data={equityHistory} />
              <div style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,5,0,0.9)', border: `1px solid ${C.border}`, padding: '4px 10px' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.green }}>{fmtUsd(bal)}</div>
                <div style={{ fontSize: 9, color: C.greenDim }}>{fmt2(p.totalPnl)} from start</div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0 6px', fontSize: 8, color: C.dim }}>
              {['30d', '25d', '20d', '15d', '10d', '5d', 'NOW'].map(l => <span key={l}>{l}</span>)}
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
            {(['positions', 'scans', 'hypotheses'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setTab(tab)}
                style={{
                  padding: '6px 16px', background: 'transparent', cursor: 'pointer',
                  border: 'none', borderBottom: activeTab === tab ? `2px solid ${C.green}` : '2px solid transparent',
                  color: activeTab === tab ? C.green : C.label,
                  fontFamily: 'monospace', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em',
                }}
              >
                {tab}
                {tab === 'positions' && data.positions.length > 0 && (
                  <span style={{ marginLeft: 5, background: C.greenFaint, color: C.green, padding: '1px 5px', fontSize: 9 }}>
                    {data.positions.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {activeTab === 'positions' && (
              data.positions.length === 0
                ? <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 11 }}>No open positions · next scan scheduled</div>
                : data.positions.map(p => <PositionRow key={p.id} pos={p} />)
            )}
            {activeTab === 'scans' && (
              data.recentScans.length === 0
                ? <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 11 }}>No scans yet · first scan fires at scheduled time</div>
                : data.recentScans.map(s => <ScanRow key={s.id} scan={s} />)
            )}
            {activeTab === 'hypotheses' && (
              data.hypotheses.length === 0
                ? <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 11 }}>No hypotheses yet · generated after first resolved trade</div>
                : data.hypotheses.map(h => <HypRow key={h.id} h={h} />)
            )}
          </div>
        </div>

        {/* ── RIGHT: phase gate + stats ── */}
        <div style={{ borderLeft: `1px solid ${C.border}`, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
          <TradingStatsPanel gate={gate} perf={perf} />

          {/* Polymarket status */}
          <Panel title="Polymarket">
            <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                padding: '2px 8px', fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
                border: `1px solid ${data.polymarket.dryRun ? C.yellow : C.green}`,
                color: data.polymarket.dryRun ? C.yellow : C.green,
              }}>
                {data.polymarket.dryRun ? 'DRY RUN' : 'LIVE'}
              </span>
              <span style={{ fontSize: 9, color: C.dim }}>
                {data.polymarket.trades + data.polymarket.openPositions} trades · {pct(data.polymarket.winRate)} WR
              </span>
            </div>
          </Panel>

          <Panel title="Performance">
            {[
              { l: 'Active Days',  v: String(perf.activeDays),    c: C.text },
              { l: 'Confirmed',    v: String(perf.confirmed),     c: C.green },
              { l: 'Sharpe',       v: perf.sharpe.toFixed(2),     c: perf.sharpe >= 1.2 ? C.green : C.yellow },
              { l: 'Max Drawdown', v: pct(perf.maxDrawdown),      c: perf.maxDrawdown > 0.10 ? C.red : C.green },
              { l: 'Win Streak',   v: String(perf.winStreak),     c: perf.winStreak > 0 ? C.green : C.text },
            ].map(r => (
              <div key={r.l} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 10px', borderBottom: `1px solid ${C.border2}` }}>
                <span style={{ fontSize: 10, color: C.label }}>{r.l}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: r.c, fontFamily: 'monospace' }}>{r.v}</span>
              </div>
            ))}
          </Panel>

          <Panel title="Telegram Commands">
            {[
              ['/predict status',    'Balance + phase'],
              ['/predict scan',      'Force scan now'],
              ['/predict positions', 'Open positions'],
              ['/predict pause',     'Pause trading'],
              ['/predict gate',      'Phase progress'],
            ].map(([cmd, desc]) => (
              <div key={cmd} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 10px', borderBottom: `1px solid ${C.border2}` }}>
                <code style={{ fontSize: 10, color: C.cyan }}>{cmd}</code>
                <span style={{ fontSize: 9, color: C.dim }}>{desc}</span>
              </div>
            ))}
          </Panel>

          <Panel title="Recent Hypotheses">
            {data.hypotheses.length === 0
              ? <div style={{ padding: '12px 10px', fontSize: 10, color: C.dim }}>Pending first resolved trade</div>
              : data.hypotheses.slice(0, 4).map(h => (
                  <div key={h.id} style={{ padding: '5px 10px', borderBottom: `1px solid ${C.border2}` }}>
                    <div style={{ fontSize: 8, color: h.status === 'confirmed' ? C.green : h.status === 'refuted' ? C.red : C.yellow, marginBottom: 2 }}>
                      {h.status.toUpperCase()} · {(h.confidence * 100).toFixed(0)}%
                    </div>
                    <div style={{ fontSize: 9, color: C.text, lineHeight: 1.4 }}>{h.hypothesis}</div>
                  </div>
                ))
            }
          </Panel>

          <Panel title="Memory Hygiene">
            {[
              { l: 'Active hyp',    v: `${data.hypotheses.filter(h => h.status === 'active').length} / 10`,    warn: data.hypotheses.filter(h => h.status === 'active').length >= 10 },
              { l: 'Confirmed',     v: `${data.hypotheses.filter(h => h.status === 'confirmed').length} / 10`, warn: data.hypotheses.filter(h => h.status === 'confirmed').length >= 10 },
              { l: 'Null reasoning',v: '0',   warn: false },
              { l: 'Null aligned',  v: '0',   warn: false },
            ].map(r => (
              <div key={r.l} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 10px', borderBottom: `1px solid ${C.border2}` }}>
                <span style={{ fontSize: 9, color: C.label }}>{r.l}</span>
                <span style={{ fontSize: 10, color: r.warn ? C.red : C.green, fontFamily: 'monospace' }}>{r.v}</span>
              </div>
            ))}
          </Panel>

          {/* API Cost Tracker */}
          {(() => {
            const c = data.costs;
            const todayColor = !c ? C.dim : c.today.total > 5 ? C.red : c.today.total > 1 ? C.yellow : C.green;
            return (
              <Panel title="API Cost Tracker">
                {[
                  { l: 'TODAY',       v: fmtCost(c?.today.total ?? 0),  c: todayColor },
                  { l: 'THIS MONTH',  v: fmtCost(c?.month.total ?? 0),  c: C.text },
                  { l: 'TOTAL CALLS', v: String(c?.month.calls ?? 0),    c: C.dim },
                ].map(r => (
                  <div key={r.l} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 10px', borderBottom: `1px solid ${C.border2}` }}>
                    <span style={{ fontSize: 9, color: C.label }}>{r.l}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: r.c, fontFamily: 'monospace' }}>{r.v}</span>
                  </div>
                ))}
                {c && c.today.byAgent.length > 0 && (
                  <>
                    <div style={{ padding: '3px 10px', fontSize: 8, color: C.label, letterSpacing: '0.1em', borderBottom: `1px solid ${C.border2}` }}>BY AGENT</div>
                    {c.today.byAgent.map(a => (
                      <div key={a.agent} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 10px', borderBottom: `1px solid ${C.border2}` }}>
                        <span style={{ fontSize: 9, color: C.text }}>{a.agent}</span>
                        <span style={{ fontSize: 10, color: C.greenDim, fontFamily: 'monospace' }}>{fmtCost(a.total)}</span>
                      </div>
                    ))}
                  </>
                )}
                {c && c.byModel.length > 0 && (
                  <>
                    <div style={{ padding: '3px 10px', fontSize: 8, color: C.label, letterSpacing: '0.1em', borderBottom: `1px solid ${C.border2}` }}>BY MODEL</div>
                    {c.byModel.map(m => (
                      <div key={m.model} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 10px', borderBottom: `1px solid ${C.border2}` }}>
                        <span style={{ fontSize: 9, color: C.text }}>{shortModel(m.model)}</span>
                        <span style={{ fontSize: 10, color: C.greenDim, fontFamily: 'monospace' }}>{fmtCost(m.total)}</span>
                      </div>
                    ))}
                  </>
                )}
              </Panel>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
