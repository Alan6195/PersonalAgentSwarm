'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types matching /api/predict response ──────────────────────────────────
interface EquitySnapshot {
  bankroll: number;
  unrealized_pnl: number;
  total_equity: number;
  win_rate: number;
  total_trades: number;
  snapshot_at: string;
}

interface Position {
  id: number;
  platform: string;
  market_question: string;
  direction: string;
  p_market: number;
  p_model: number;
  edge: number;
  bet_size: number;
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
}

interface RiskState {
  current_bankroll: number;
  peak_bankroll: number;
  daily_pnl: number;
  daily_loss: number;
  current_exposure: number;
  trading_paused: boolean;
  pause_reason: string | null;
  current_drawdown: number;
}

interface PhaseGate {
  phase: string;
  trades: number;
  trades_target: number;
  win_rate: number;
  win_rate_target: number;
  sharpe: number;
  sharpe_target: number;
  ready: boolean;
}

interface DashboardData {
  equity: EquitySnapshot | null;
  equity_history: EquitySnapshot[];
  positions: Position[];
  recent_scans: Scan[];
  risk_state: RiskState | null;
  phase_gate: PhaseGate;
  hypotheses: Hypothesis[];
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

function genMockEquityHistory(points = 120): EquitySnapshot[] {
  const rng = mulberry32(0xdeadbeef);
  let val = 1000;
  return Array.from({ length: points }, (_, i) => {
    val = Math.max(800, val * (1 + (rng() - 0.44) * 0.006));
    return {
      bankroll: +val.toFixed(2),
      unrealized_pnl: 0,
      total_equity: +val.toFixed(2),
      win_rate: 0,
      total_trades: 0,
      snapshot_at: new Date(Date.now() - (points - i) * 15 * 60000).toISOString(),
    };
  });
}

const MOCK_HISTORY = genMockEquityHistory(120);

const MOCK_DATA: DashboardData = {
  equity: {
    bankroll: 1000,
    unrealized_pnl: 0,
    total_equity: 1000,
    win_rate: 0,
    total_trades: 0,
    snapshot_at: new Date().toISOString(),
  },
  equity_history: MOCK_HISTORY,
  positions: [],
  recent_scans: [],
  risk_state: {
    current_bankroll: 1000,
    peak_bankroll: 1000,
    daily_pnl: 0,
    daily_loss: 0,
    current_exposure: 0,
    trading_paused: false,
    pause_reason: null,
    current_drawdown: 0,
  },
  phase_gate: {
    phase: 'manifold',
    trades: 0,
    trades_target: 30,
    win_rate: 0,
    win_rate_target: 0.60,
    sharpe: 0,
    sharpe_target: 1.5,
    ready: false,
  },
  hypotheses: [],
};

// ── Tiny helpers ──────────────────────────────────────────────────────────
function fmt2(n: number) { return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2); }
function fmtM(n: number) { return `M$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }
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

// ── Phase gate ────────────────────────────────────────────────────────────
function PhaseGate({ gate }: { gate: PhaseGate }) {
  const progress = Math.min(gate.trades / gate.trades_target, 1);
  const wrOk = gate.win_rate >= gate.win_rate_target;
  const shOk = gate.sharpe >= gate.sharpe_target;
  const trOk = gate.trades >= gate.trades_target;
  return (
    <Panel title="Phase Gate · Manifold → Polymarket">
      <div style={{ padding: '8px 10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: gate.ready ? C.green : C.yellow, fontFamily: 'monospace' }}>
            {gate.ready ? '✓ READY FOR LIVE' : '⚠ CONTINUE PAPER TRADING'}
          </span>
          <span style={{ fontSize: 9, color: C.label, fontFamily: 'monospace' }}>{gate.trades}/{gate.trades_target} trades</span>
        </div>
        <div style={{ height: 3, background: C.dimmer, marginBottom: 8 }}>
          <div style={{ height: '100%', width: `${progress * 100}%`, background: gate.ready ? C.green : C.greenDim, transition: 'width 1s' }} />
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          {[
            { l: 'TRADES',  v: `${gate.trades}/${gate.trades_target}`, ok: trOk },
            { l: 'WIN RATE', v: pct(gate.win_rate),                    ok: wrOk, tgt: `≥${pct(gate.win_rate_target)}` },
            { l: 'SHARPE',  v: gate.sharpe.toFixed(2),                 ok: shOk, tgt: `≥${gate.sharpe_target}` },
          ].map(g => (
            <div key={g.l} style={{ fontFamily: 'monospace' }}>
              <div style={{ fontSize: 8, color: C.label }}>{g.l}</div>
              <div style={{ fontSize: 11, color: g.ok ? C.green : C.yellow }}>
                {g.ok ? '✓ ' : '○ '}{g.v}
                {g.tgt && <span style={{ color: C.dim, fontSize: 9 }}> / {g.tgt}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

// ── Risk state ────────────────────────────────────────────────────────────
function RiskPanel({ risk }: { risk: RiskState }) {
  const ddPct = risk.current_drawdown * 100;
  const expPct = risk.current_exposure / Math.max(risk.current_bankroll, 1) * 100;
  return (
    <Panel title="Risk State">
      {[
        { l: 'DRAWDOWN',  v: `${ddPct.toFixed(1)}%`,    bar: ddPct / 15,  warn: ddPct > 10 },
        { l: 'EXPOSURE',  v: `${expPct.toFixed(1)}%`,   bar: expPct / 40, warn: expPct > 30 },
        { l: 'DAILY LOSS', v: fmt2(-risk.daily_loss),   bar: risk.daily_loss / (risk.current_bankroll * 0.08), warn: risk.daily_loss > risk.current_bankroll * 0.05 },
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
      {risk.trading_paused && (
        <div style={{ padding: '5px 8px', background: 'rgba(255,45,45,0.08)', fontSize: 10, color: C.red, fontFamily: 'monospace' }}>
          ⏸ PAUSED: {risk.pause_reason || 'manual'}
        </div>
      )}
    </Panel>
  );
}

// ── Position card ─────────────────────────────────────────────────────────
function PositionRow({ pos }: { pos: Position }) {
  const pnl = pos.pnl ?? 0;
  return (
    <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border2}`, fontFamily: 'monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: C.white, flex: 1, marginRight: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pos.market_question}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: pnl >= 0 ? C.green : C.red, flexShrink: 0 }}>
          {fmt2(pnl)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <span style={{ fontSize: 9, padding: '1px 6px', border: `1px solid ${pos.direction === 'YES' ? C.green : C.red}`, color: pos.direction === 'YES' ? C.green : C.red }}>{pos.direction}</span>
        {pos.intel_aligned && <span style={{ fontSize: 9, padding: '1px 6px', border: `1px solid ${C.cyan}`, color: C.cyan }}>⚡ INTEL</span>}
        <span style={{ fontSize: 9, color: C.label }}>mkt {pct(pos.p_market)}</span>
        <span style={{ fontSize: 9, color: C.text }}>model {pct(pos.p_model)}</span>
        <span style={{ fontSize: 9, color: '#8b5cf6' }}>edge {(pos.edge * 100).toFixed(0)}¢</span>
        <span style={{ fontSize: 9, color: C.dim, marginLeft: 'auto' }}>{timeAgo(pos.opened_at)}</span>
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
  const rngRef                = useRef(mulberry32(0xabcdef12));

  // Poll /api/predict every 10s
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/predict');
      if (!res.ok) return;
      const json = await res.json();
      setData(json);
      setIsLive(true);
    } catch {
      // stay on mock data
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    const t = setInterval(() => { fetchData(); setTick(v => v + 1); }, 10_000);
    return () => clearInterval(t);
  }, [fetchData]);

  // Animate equity on mock data
  const [liveHistory, setLiveHistory] = useState(MOCK_HISTORY.map(s => s.bankroll));
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
    ? data.equity_history.map(s => s.total_equity)
    : liveHistory;

  const eq   = data.equity;
  const risk = data.risk_state;
  const gate = data.phase_gate;
  const bal  = eq?.bankroll ?? 1000;
  const wr   = eq?.win_rate ?? 0;
  const trades = eq?.total_trades ?? 0;
  const dailyPnl = risk?.daily_pnl ?? 0;

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'monospace', color: C.text, fontSize: 11, overflow: 'hidden' }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #0d2a0d; border-radius: 1px; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ping { 75%,100% { transform: scale(2); opacity: 0; } }
        @font-face { font-family: 'JetBrains Mono'; src: local('JetBrains Mono'); }
      `}</style>

      {/* ── Top bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 14px', background: '#00050000', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
        <span style={{ color: C.green, fontWeight: 700, fontSize: 13, letterSpacing: '0.08em' }}>◈ PREDICT_AGENT</span>
        {[
          { label: gate.phase === 'manifold' ? 'PAPER' : '⚡ LIVE', color: gate.phase === 'manifold' ? C.yellow : C.green },
          { label: 'LMSR + KELLY', color: C.cyan },
          { label: 'v1.0.0', color: C.greenDim },
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
        <span style={{ fontSize: 9, color: C.dim }}>MANIFOLD</span>
        <span style={{ fontSize: 9, color: C.dim }}>10s poll</span>
        <Cursor />
      </div>

      {/* ── KPI strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', borderBottom: `1px solid ${C.border}` }}>
        {[
          { label: 'BANKROLL',   value: fmtM(bal),                     color: C.green },
          { label: 'WIN RATE',   value: pct(wr),                        color: wr >= 0.6 ? C.green : wr > 0 ? C.yellow : C.text },
          { label: 'TOTAL P&L',  value: fmt2(bal - 1000),               color: bal >= 1000 ? C.green : C.red },
          { label: 'TRADES',     value: `${trades}W / ${data.positions.filter(p => p.status === 'open').length}L`, color: C.text },
          { label: 'DAILY P&L',  value: fmt2(dailyPnl),                 color: dailyPnl >= 0 ? C.green : C.red },
          { label: 'DEPLOYED',   value: fmtM(risk?.current_exposure ?? 0), color: C.cyan },
        ].map((k, i) => (
          <div key={k.label} style={{ padding: '7px 12px', borderRight: i < 5 ? `1px solid ${C.border}` : 'none' }}>
            <div style={{ fontSize: 8, color: C.label, letterSpacing: '0.12em', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: k.color }}>{k.value}</div>
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
            <FRow label="Prior"     value="0.2198" />
            <FRow label="Posterior" value="—" vc={C.cyan} />
          </Panel>
          <Panel title="Hedge Condition π">
            <FRow expr="π = 1.00 − (p_Y + p_N)" value={risk ? (1 - (0.48 + 0.49)).toFixed(4) : '—'} vc={C.yellow} />
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
              ['Max category',  '20% bankroll'],
              ['Max deployed',  '40% bankroll'],
              ['Daily loss',    '8% → pause'],
              ['Drawdown',      '15% → pause'],
              ['Min edge',      '4¢'],
            ].map(([l, v]) => (
              <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 8px', borderBottom: `1px solid ${C.border2}`, fontSize: 10 }}>
                <span style={{ color: C.label }}>{l}</span>
                <span style={{ color: C.text }}>{v}</span>
              </div>
            ))}
          </Panel>
          {risk && <div style={{ marginTop: 0 }}><RiskPanel risk={risk} /></div>}
        </div>

        {/* ── CENTER: chart + tabs ── */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Equity chart */}
          <div style={{ padding: '8px 12px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, color: C.label, letterSpacing: '0.12em', marginBottom: 6 }}>
              ○ EQUITY CURVE — LMSR BAYESIAN STRATEGY · MANIFOLD PAPER
            </div>
            <div style={{ position: 'relative' }}>
              <SparkLine data={equityHistory} />
              <div style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,5,0,0.9)', border: `1px solid ${C.border}`, padding: '4px 10px' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.green }}>{fmtM(bal)}</div>
                <div style={{ fontSize: 9, color: C.greenDim }}>{fmt2(bal - 1000)} from start</div>
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
              data.recent_scans.length === 0
                ? <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: 11 }}>No scans yet · first scan fires at scheduled time</div>
                : data.recent_scans.map(s => <ScanRow key={s.id} scan={s} />)
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
          <PhaseGate gate={gate} />

          <Panel title="Performance">
            {[
              { l: 'Win Rate',    v: pct(wr),             c: wr >= 0.6 ? C.green : C.yellow },
              { l: 'Total P&L',   v: fmt2(bal - 1000),    c: bal >= 1000 ? C.green : C.red },
              { l: 'Daily P&L',   v: fmt2(dailyPnl),      c: dailyPnl >= 0 ? C.green : C.red },
              { l: 'Trades',      v: String(trades),       c: C.text },
              { l: 'Open',        v: String(data.positions.filter(p => p.status === 'open').length), c: C.cyan },
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
        </div>
      </div>
    </div>
  );
}
