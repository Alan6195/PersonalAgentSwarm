"use client";

import { useFetch } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Plane,
  Hotel,
  Utensils,
  MapPin,
  Train,
  Sun,
  Wine,
  Calendar,
  ExternalLink,
  Check,
  Clock,
  Ban,
  DollarSign,
  Star,
  Bed,
  Car,
  Heart,
  TrendingDown,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Coins,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  MessageCircle,
  Send,
  X,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  Loader2,
  Search,
} from "lucide-react";

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

interface TravelItem {
  id: number;
  region: string;
  item_type: string;
  name: string;
  status: string;
  cost_eur: number | null;
  nightly_rate_eur: number | null;
  nights: number | null;
  cost_per_person_eur: number | null;
  booking_url: string | null;
  confirmation_number: string | null;
  day: string | null;
  time: string | null;
  notes: string | null;
  metadata: any;
  gf_df_rating: string | null;
  price_per_person: number | null;
}

interface TravelFlightPriceEntry {
  price_usd: number | null;
  points_cost: number | null;
  source: string | null;
  checked_at: string;
}

interface TravelFlight {
  id: number;
  trip_db_id: number;
  direction: string;
  route: string | null;
  departure_airport: string;
  arrival_airport: string;
  departure_date: string | null;
  airline: string | null;
  cabin_class: string;
  price_usd: number | null;
  points_cost: number | null;
  points_program: string | null;
  cpp_value: number | null;
  status: string;
  booked_via: string | null;
  confirmation_number: string | null;
  notes: string | null;
  metadata: any;
  price_history: TravelFlightPriceEntry[] | null;
}

interface DashboardMessage {
  id: number;
  direction: string;
  content: string;
  action_type: string | null;
  created_at: string;
}

interface DayEntry {
  date: string;
  dayNumber: number;
  region: string;
  hotel: TravelItem | null;
  activities: TravelItem[];
  restaurants: TravelItem[];
  transport: TravelItem | null;
  isCheckIn: boolean;
  isCheckOut: boolean;
}

interface TravelData {
  trip: {
    trip_id: string;
    status: string;
    preferences: any;
    budget: {
      hotels_total_eur: number;
      activities_total_eur: number;
      transport_total_eur: number;
      food_estimate_eur: number;
      grand_total_eur: number;
      flights_total_usd: number;
      flights_total_points: number;
    };
    notes: string[];
  } | null;
  items: TravelItem[];
  vetoes: any[];
  days: DayEntry[];
  flights: TravelFlight[];
  messages: DashboardMessage[];
}

interface ToastMessage {
  id: number;
  text: string;
  type: "success" | "error" | "info";
}

type ItemActionHandler = (
  item: TravelItem,
  action: "approve" | "veto" | "alternative",
  reason?: string
) => void;

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

const AMBER = "#f59e0b";

const REGION_COLORS: Record<string, string> = {
  Porto: "#06b6d4",
  Lisbon: "#a855f7",
  Alentejo: "#22c55e",
  Algarve: "#f59e0b",
};

const REGION_ICONS: Record<string, string> = {
  Porto: "\uD83C\uDDF5\uD83C\uDDF9",
  Lisbon: "\uD83C\uDFDB\uFE0F",
  Alentejo: "\uD83C\uDF3E",
  Algarve: "\u2600\uFE0F",
};

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  proposed: { bg: "bg-blue-500/15", text: "text-blue-400", label: "Proposed" },
  approved: { bg: "bg-amber-500/15", text: "text-amber-400", label: "Approved" },
  booked: { bg: "bg-emerald-500/15", text: "text-emerald-400", label: "Booked" },
  vetoed: { bg: "bg-red-500/15", text: "text-red-400", label: "Vetoed" },
  tracking: { bg: "bg-blue-500/15", text: "text-blue-400", label: "Tracking" },
};

const TRIP_STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  itinerary_approved: "Itinerary Approved",
  booking: "Booking in Progress",
  booked: "Fully Booked",
  in_progress: "Trip in Progress",
  completed: "Completed",
};

const CHASE_UR_TOTAL = 100000;

const GF_DF_TIERS: Record<string, { label: string; color: string; bg: string; icon: any; description: string }> = {
  green: {
    label: "SAFE",
    color: "text-emerald-400",
    bg: "bg-emerald-500/15",
    icon: ShieldCheck,
    description: "Dedicated GF menu, staff trained on celiac",
  },
  yellow: {
    label: "GOOD",
    color: "text-yellow-400",
    bg: "bg-yellow-500/15",
    icon: ShieldCheck,
    description: "Accommodates well, some naturally GF options",
  },
  orange: {
    label: "CAUTION",
    color: "text-orange-400",
    bg: "bg-orange-500/15",
    icon: ShieldQuestion,
    description: "Can accommodate with advance notice",
  },
  red: {
    label: "AVOID",
    color: "text-red-400",
    bg: "bg-red-500/15",
    icon: ShieldX,
    description: "High cross-contamination risk",
  },
};

const QUICK_ACTIONS = [
  "Find hotels in Porto",
  "Search GF restaurants",
  "Budget summary",
];

const FLIGHT_QUICK_ACTIONS = [
  "Search flights PDX to OPO July 17",
  "Search return flights FAO to PDX July 26",
  "Best Chase UR transfer options for Portugal",
  "Compare United vs portal for PDX-OPO",
];

const CHASE_TRANSFER_PARTNERS = [
  { name: "United MileagePlus", ratio: "1:1", best: true, note: "30-60K economy, dynamic pricing" },
  { name: "Air Canada Aeroplan", ratio: "1:1", best: false, note: "40-60K economy, distance-based" },
  { name: "British Airways Avios", ratio: "1:1", best: false, note: "Off-peak deals, short-haul better" },
  { name: "Chase Travel Portal", ratio: "1.25-1.75x", best: false, note: "Any flight, no blackouts, Points Boost" },
];

// ────────────────────────────────────────────
// Toast Component
// ────────────────────────────────────────────

function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 3500);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const colors = {
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    error: "border-red-500/30 bg-red-500/10 text-red-400",
    info: "border-blue-500/30 bg-blue-500/10 text-blue-400",
  };

  return (
    <div
      className={cn(
        "px-4 py-2.5 rounded-lg border text-xs font-mono animate-slide-up shadow-lg",
        colors[toast.type]
      )}
    >
      {toast.text}
    </div>
  );
}

// ────────────────────────────────────────────
// Item Action Buttons
// ────────────────────────────────────────────

function ItemActions({
  item,
  onAction,
  loading,
}: {
  item: TravelItem;
  onAction: ItemActionHandler;
  loading: number | null;
}) {
  const [showVetoInput, setShowVetoInput] = useState(false);
  const [vetoReason, setVetoReason] = useState("");
  const isLoading = loading === item.id;

  if (item.status === "booked") return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 mt-2">
        <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />
        <span className="text-[10px] font-mono text-carbon-500">Updating...</span>
      </div>
    );
  }

  if (showVetoInput) {
    return (
      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="text"
          placeholder="Reason (optional)"
          value={vetoReason}
          onChange={(e) => setVetoReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onAction(item, "veto", vetoReason);
              setShowVetoInput(false);
              setVetoReason("");
            }
          }}
          className="flex-1 text-[10px] font-mono bg-carbon-800 border border-carbon-700 rounded px-2 py-1 text-white placeholder-carbon-600 focus:outline-none focus:border-red-500/50"
          autoFocus
        />
        <button
          onClick={() => {
            onAction(item, "veto", vetoReason);
            setShowVetoInput(false);
            setVetoReason("");
          }}
          className="text-[10px] font-mono text-red-400 bg-red-500/10 px-2 py-1 rounded hover:bg-red-500/20 transition-colors"
        >
          Veto
        </button>
        <button
          onClick={() => { setShowVetoInput(false); setVetoReason(""); }}
          className="text-[10px] font-mono text-carbon-500 hover:text-carbon-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-2">
      {item.status === "proposed" && (
        <button
          onClick={() => onAction(item, "approve")}
          className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded hover:bg-emerald-500/20 transition-colors flex items-center gap-1"
        >
          <ThumbsUp className="w-2.5 h-2.5" /> Approve
        </button>
      )}
      {(item.status === "proposed" || item.status === "approved") && (
        <button
          onClick={() => setShowVetoInput(true)}
          className="text-[10px] font-mono text-red-400 bg-red-500/10 px-2 py-1 rounded hover:bg-red-500/20 transition-colors flex items-center gap-1"
        >
          <ThumbsDown className="w-2.5 h-2.5" /> Veto
        </button>
      )}
      {(item.status === "proposed" || item.status === "approved") && (
        <button
          onClick={() => onAction(item, "alternative")}
          className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-2 py-1 rounded hover:bg-cyan-500/20 transition-colors flex items-center gap-1"
        >
          <RefreshCw className="w-2.5 h-2.5" /> Alternative
        </button>
      )}
    </div>
  );
}

// ────────────────────────────────────────────
// Chat Panel
// ────────────────────────────────────────────

function ChatPanel({
  messages,
  onSend,
  sending,
  open,
  onToggle,
}: {
  messages: DashboardMessage[];
  onSend: (message: string) => void;
  sending: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, open]);

  const handleSend = () => {
    const msg = input.trim();
    if (!msg || sending) return;
    setInput("");
    onSend(msg);
  };

  if (!open) {
    return (
      <button
        onClick={onToggle}
        className="fixed bottom-6 right-6 w-12 h-12 rounded-full bg-amber-500 hover:bg-amber-400 text-carbon-900 shadow-lg flex items-center justify-center transition-all z-50 hover:scale-105"
        title="Chat with travel agent"
      >
        <MessageCircle className="w-5 h-5" />
        {messages.length > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-400 text-[9px] font-bold text-carbon-900 flex items-center justify-center">
            {messages.filter((m) => m.direction === "agent").length}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 w-96 max-h-[500px] bg-carbon-900 border border-carbon-700 rounded-xl shadow-2xl flex flex-col z-50 animate-slide-up">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-carbon-800">
        <div className="flex items-center gap-2">
          <Plane className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-medium text-white">Travel Agent</span>
        </div>
        <button
          onClick={onToggle}
          className="text-carbon-500 hover:text-white transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[200px] max-h-[340px]">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <MessageCircle className="w-8 h-8 text-carbon-700 mx-auto mb-2" />
            <p className="text-xs text-carbon-500">
              Ask the travel agent anything about your honeymoon.
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "max-w-[85%] rounded-lg px-3 py-2",
              msg.direction === "user"
                ? "ml-auto bg-blue-500/15 text-blue-200"
                : "mr-auto bg-carbon-800 text-carbon-200"
            )}
          >
            <p className="text-xs whitespace-pre-wrap leading-relaxed">{msg.content}</p>
            <p className="text-[9px] font-mono text-carbon-600 mt-1">
              {new Date(msg.created_at).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          </div>
        ))}
        {sending && (
          <div className="mr-auto bg-carbon-800 text-carbon-400 rounded-lg px-3 py-2 flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span className="text-xs">Travel agent is thinking...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick actions */}
      <div className="px-4 py-2 border-t border-carbon-800 flex items-center gap-1.5 overflow-x-auto">
        {QUICK_ACTIONS.map((qa) => (
          <button
            key={qa}
            onClick={() => onSend(qa)}
            disabled={sending}
            className="text-[9px] font-mono text-carbon-400 bg-carbon-800 px-2 py-1 rounded hover:bg-carbon-700 hover:text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {qa}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="px-3 py-3 border-t border-carbon-800 flex items-center gap-2">
        <input
          type="text"
          placeholder="Ask the travel agent anything..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={sending}
          className="flex-1 text-xs bg-carbon-800 border border-carbon-700 rounded-lg px-3 py-2 text-white placeholder-carbon-600 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="w-8 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 text-carbon-900 flex items-center justify-center transition-colors disabled:opacity-30 disabled:hover:bg-amber-500"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Stat Card
// ────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
  delay,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: any;
  accent?: string;
  delay?: number;
}) {
  return (
    <div
      className="card-glow p-5 animate-slide-up"
      style={{ animationDelay: `${delay || 0}ms` }}
    >
      <div className="flex items-start justify-between mb-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${accent || AMBER}15` }}
        >
          <Icon className="w-4 h-4" style={{ color: accent || AMBER }} />
        </div>
        {sub && (
          <span className="text-[11px] font-mono text-carbon-500">{sub}</span>
        )}
      </div>
      <p className="stat-value" style={{ color: accent || "#fff" }}>
        {value}
      </p>
      <p className="stat-label mt-1">{label}</p>
    </div>
  );
}

// ────────────────────────────────────────────
// GF/DF Badge
// ────────────────────────────────────────────

function GfDfBadge({ rating, compact }: { rating: string | null; compact?: boolean }) {
  if (!rating) return null;

  const tier = GF_DF_TIERS[rating.toLowerCase()];
  if (!tier) return null;

  const TierIcon = tier.icon;

  if (compact) {
    return (
      <span
        className={cn("inline-flex items-center gap-0.5 text-[9px] font-mono px-1 py-0.5 rounded", tier.bg, tier.color)}
        title={`GF/DF: ${tier.label} - ${tier.description}`}
      >
        <TierIcon className="w-2.5 h-2.5" />
        {tier.label}
      </span>
    );
  }

  return (
    <div
      className={cn("inline-flex items-center gap-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded", tier.bg, tier.color)}
      title={tier.description}
    >
      <TierIcon className="w-3 h-3" />
      <span>GF/DF: {tier.label}</span>
    </div>
  );
}

// ────────────────────────────────────────────
// Hotel Card
// ────────────────────────────────────────────

function HotelCard({ item, onAction, loadingId }: { item: TravelItem; onAction: ItemActionHandler; loadingId: number | null }) {
  const style = STATUS_STYLES[item.status] || STATUS_STYLES.proposed;
  const meta = item.metadata || {};
  const imageUrl = meta.image_url;
  const bedType = meta.bed_type;
  const description = meta.description;
  const stars = meta.stars;
  const honeymoonPkg = meta.honeymoon_package;

  return (
    <div className="bg-carbon-800/40 rounded-lg border border-carbon-700/50 overflow-hidden">
      {imageUrl && (
        <div className="relative h-36 w-full bg-carbon-900">
          <img
            src={imageUrl}
            alt={item.name}
            className="w-full h-full object-cover opacity-90"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-carbon-900/80 via-transparent to-transparent" />
          <div className="absolute bottom-2 left-3 flex items-center gap-2">
            <span className={cn("badge text-[10px]", style.bg, style.text)}>
              {style.label}
            </span>
            {bedType && (
              <span className="badge text-[10px] bg-purple-500/15 text-purple-400 flex items-center gap-0.5">
                <Bed className="w-2.5 h-2.5" /> {bedType}
              </span>
            )}
            {honeymoonPkg && (
              <span className="badge text-[10px] bg-pink-500/15 text-pink-400 flex items-center gap-0.5">
                <Heart className="w-2.5 h-2.5" /> Honeymoon
              </span>
            )}
          </div>
        </div>
      )}

      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Hotel className="w-4 h-4 text-amber-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-white">
                {item.name}
                {stars && (
                  <span className="ml-1.5 text-amber-400/80 text-xs">
                    {"★".repeat(Number(stars))}
                  </span>
                )}
              </p>
              {item.nightly_rate_eur && (
                <p className="text-xs font-mono text-carbon-400 mt-0.5">
                  EUR {item.nightly_rate_eur}/night
                  {item.nights ? ` x ${item.nights} nights` : ""}
                  {item.cost_eur ? ` = EUR ${item.cost_eur}` : ""}
                </p>
              )}
            </div>
          </div>
          {!imageUrl && (
            <div className="flex items-center gap-1.5 shrink-0">
              {bedType && (
                <span className="badge text-[10px] bg-purple-500/15 text-purple-400 flex items-center gap-0.5">
                  <Bed className="w-2.5 h-2.5" /> {bedType}
                </span>
              )}
              <span className={cn("badge text-[10px]", style.bg, style.text)}>
                {style.label}
              </span>
            </div>
          )}
        </div>

        {item.gf_df_rating && (
          <div className="mt-2">
            <GfDfBadge rating={item.gf_df_rating} />
          </div>
        )}

        {description && (
          <p className="text-xs text-carbon-400 mt-2 leading-relaxed">{description}</p>
        )}

        {item.notes && (
          <p className="text-xs text-carbon-500 mt-1.5 leading-relaxed">{item.notes}</p>
        )}

        <div className="flex items-center gap-3 mt-2">
          {item.booking_url && (
            <a
              href={item.booking_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono text-amber-400/70 hover:text-amber-400 flex items-center gap-1 transition-colors"
            >
              <ExternalLink className="w-3 h-3" /> Book
            </a>
          )}
          {item.confirmation_number && (
            <span className="text-[10px] font-mono text-emerald-400">
              Conf: {item.confirmation_number}
            </span>
          )}
          {honeymoonPkg && !imageUrl && (
            <span className="text-[10px] font-mono text-pink-400/70 flex items-center gap-0.5">
              <Heart className="w-2.5 h-2.5" /> Honeymoon pkg
            </span>
          )}
        </div>

        <ItemActions item={item} onAction={onAction} loading={loadingId} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Activity Card
// ────────────────────────────────────────────

function ActivityCard({ item, onAction, loadingId }: { item: TravelItem; onAction: ItemActionHandler; loadingId: number | null }) {
  const meta = item.metadata || {};
  return (
    <div className="py-1.5">
      <div className="flex items-start gap-2">
        <Wine className="w-3.5 h-3.5 text-purple-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-carbon-200">{item.name}</p>
          {meta.description && (
            <p className="text-[10px] text-carbon-500 mt-0.5">{meta.description}</p>
          )}
          <div className="flex items-center gap-2 mt-0.5">
            {item.time && (
              <span className="text-[10px] font-mono text-carbon-500">
                <Clock className="w-2.5 h-2.5 inline mr-0.5" />
                {item.time}
              </span>
            )}
            {meta.duration && (
              <span className="text-[10px] font-mono text-carbon-500">
                {meta.duration}
              </span>
            )}
            {(item.price_per_person || item.cost_per_person_eur) && (
              <span className="text-[10px] font-mono text-carbon-500">
                EUR {item.price_per_person || item.cost_per_person_eur}/pp
              </span>
            )}
            {item.cost_eur && (
              <span className="text-[10px] font-mono text-amber-400/70">
                EUR {item.cost_eur} total
              </span>
            )}
          </div>
          {item.booking_url && (
            <a
              href={item.booking_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono text-purple-400/70 hover:text-purple-400 flex items-center gap-1 mt-0.5 transition-colors"
            >
              <ExternalLink className="w-2.5 h-2.5" /> Book
            </a>
          )}
          <ItemActions item={item} onAction={onAction} loading={loadingId} />
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Restaurant Card
// ────────────────────────────────────────────

function RestaurantCard({ item, onAction, loadingId }: { item: TravelItem; onAction: ItemActionHandler; loadingId: number | null }) {
  const meta = item.metadata || {};
  return (
    <div className="py-1.5">
      <div className="flex items-start gap-2">
        <Utensils className="w-3.5 h-3.5 text-orange-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-xs text-carbon-200">{item.name}</p>
            <GfDfBadge rating={item.gf_df_rating} compact />
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {meta.meal && (
              <span className="text-[10px] font-mono text-carbon-500 capitalize">
                {meta.meal}
              </span>
            )}
            {(item.price_per_person || meta.price_range_eur) && (
              <span className="text-[10px] font-mono text-carbon-500">
                {item.price_per_person
                  ? `EUR ${item.price_per_person}/pp`
                  : meta.price_range_eur}
              </span>
            )}
            {meta.reservation_needed && (
              <span className="text-[10px] font-mono text-amber-400/60">
                Reservation req.
              </span>
            )}
            {meta.address && (
              <span className="text-[10px] font-mono text-carbon-600">
                <MapPin className="w-2.5 h-2.5 inline mr-0.5" />
                {meta.address}
              </span>
            )}
          </div>
          {item.notes && (
            <p className="text-[10px] text-carbon-600 mt-0.5">{item.notes}</p>
          )}
          {item.booking_url && (
            <a
              href={item.booking_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono text-orange-400/70 hover:text-orange-400 flex items-center gap-0.5 mt-0.5 transition-colors"
            >
              <ExternalLink className="w-2.5 h-2.5" /> Reserve
            </a>
          )}
          <ItemActions item={item} onAction={onAction} loading={loadingId} />
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Flight Card
// ────────────────────────────────────────────

function FlightCard({ flight }: { flight: TravelFlight }) {
  const statusStyle = STATUS_STYLES[flight.status] || STATUS_STYLES.tracking;
  const isOutbound = flight.direction === "outbound";
  const priceHistory = flight.price_history || [];

  let priceTrend: "up" | "down" | "stable" | null = null;
  if (priceHistory.length >= 2) {
    const latest = priceHistory[0]?.price_usd ?? 0;
    const prev = priceHistory[1]?.price_usd ?? 0;
    if (latest < prev) priceTrend = "down";
    else if (latest > prev) priceTrend = "up";
    else priceTrend = "stable";
  }

  return (
    <div className="card p-4 animate-slide-up">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-9 h-9 rounded-lg flex items-center justify-center",
              isOutbound ? "bg-cyan-500/15" : "bg-amber-500/15"
            )}
          >
            <Plane
              className={cn("w-4 h-4", isOutbound ? "text-cyan-400" : "text-amber-400")}
              style={isOutbound ? {} : { transform: "scaleX(-1)" }}
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-white">
                {flight.departure_airport}
                <ArrowRight className="w-3 h-3 inline mx-1.5 text-carbon-500" />
                {flight.arrival_airport}
              </p>
              <span className={cn("badge text-[9px]", statusStyle.bg, statusStyle.text)}>
                {statusStyle.label}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {flight.airline && (
                <span className="text-[10px] font-mono text-carbon-400">{flight.airline}</span>
              )}
              {flight.cabin_class && flight.cabin_class !== "economy" && (
                <span className="text-[10px] font-mono text-purple-400/70 capitalize">{flight.cabin_class}</span>
              )}
              {flight.departure_date && (
                <span className="text-[10px] font-mono text-carbon-500">
                  {new Date(flight.departure_date + "T12:00:00").toLocaleDateString("en-US", {
                    month: "short", day: "numeric", year: "numeric",
                  })}
                </span>
              )}
              {flight.route && (
                <span className="text-[10px] font-mono text-carbon-600">{flight.route}</span>
              )}
            </div>
          </div>
        </div>

        <div className="text-right shrink-0">
          {flight.price_usd != null && (
            <div className="flex items-center gap-1 justify-end">
              <p className="text-sm font-mono text-white font-semibold">
                ${flight.price_usd.toLocaleString()}
              </p>
              {priceTrend === "down" && <TrendingDown className="w-3.5 h-3.5 text-emerald-400" />}
              {priceTrend === "up" && <TrendingUp className="w-3.5 h-3.5 text-red-400" />}
            </div>
          )}
          {flight.points_cost != null && (
            <p className="text-[10px] font-mono text-amber-400/80">
              {flight.points_cost.toLocaleString()} pts
              {flight.cpp_value && <span className="text-carbon-500 ml-1">({flight.cpp_value}cpp)</span>}
            </p>
          )}
          {flight.points_program && (
            <p className="text-[10px] font-mono text-carbon-500">{flight.points_program}</p>
          )}
        </div>
      </div>

      {priceHistory.length > 1 && (
        <div className="mt-3 pt-2 border-t border-carbon-800">
          <p className="text-[10px] font-mono text-carbon-600 mb-1.5">Price History</p>
          <div className="flex items-end gap-1 h-6">
            {priceHistory.slice(0, 10).reverse().map((ph, i) => {
              const prices = priceHistory.slice(0, 10).map((p) => p.price_usd || 0);
              const maxP = Math.max(...prices);
              const minP = Math.min(...prices.filter((p) => p > 0));
              const range = maxP - minP || 1;
              const height = ((((ph.price_usd || 0) - minP) / range) * 16) + 4;
              const isLatest = i === priceHistory.slice(0, 10).length - 1;
              return (
                <div
                  key={i}
                  className={cn("w-2 rounded-sm transition-all", isLatest ? "bg-amber-400" : "bg-carbon-600")}
                  style={{ height: `${height}px` }}
                  title={`$${ph.price_usd} - ${new Date(ph.checked_at).toLocaleDateString()}`}
                />
              );
            })}
          </div>
        </div>
      )}

      {flight.confirmation_number && (
        <div className="mt-2 pt-2 border-t border-carbon-800">
          <span className="text-[10px] font-mono text-emerald-400">Conf: {flight.confirmation_number}</span>
          {flight.booked_via && <span className="text-[10px] font-mono text-carbon-500 ml-2">via {flight.booked_via}</span>}
        </div>
      )}

      {flight.notes && <p className="text-[10px] text-carbon-600 mt-1.5">{flight.notes}</p>}
    </div>
  );
}

// ────────────────────────────────────────────
// Points Gauge
// ────────────────────────────────────────────

function PointsGauge({ allocated, total, flights }: { allocated: number; total: number; flights: TravelFlight[] }) {
  const remaining = Math.max(0, total - allocated);
  const outboundPts = flights.filter((f) => f.direction === "outbound" && f.points_cost).reduce((s, f) => s + (f.points_cost || 0), 0);
  const returnPts = flights.filter((f) => f.direction === "return" && f.points_cost).reduce((s, f) => s + (f.points_cost || 0), 0);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center">
            <Coins className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div>
            <p className="text-xs font-medium text-white">Chase UR Points</p>
            <p className="text-[10px] font-mono text-carbon-500">{remaining.toLocaleString()} remaining</p>
          </div>
        </div>
        <p className="text-sm font-mono text-amber-400 font-semibold">
          {allocated.toLocaleString()} / {total.toLocaleString()}
        </p>
      </div>
      <div className="h-2.5 bg-carbon-800 rounded-full overflow-hidden">
        {outboundPts > 0 && (
          <div className="h-full bg-cyan-400 float-left" style={{ width: `${(outboundPts / total) * 100}%` }} title={`Outbound: ${outboundPts.toLocaleString()} pts`} />
        )}
        {returnPts > 0 && (
          <div className="h-full bg-amber-400 float-left" style={{ width: `${(returnPts / total) * 100}%` }} title={`Return: ${returnPts.toLocaleString()} pts`} />
        )}
      </div>
      {(outboundPts > 0 || returnPts > 0) && (
        <div className="flex items-center gap-4 mt-2">
          {outboundPts > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-cyan-400" />
              <span className="text-[10px] font-mono text-carbon-400">Outbound: {outboundPts.toLocaleString()}</span>
            </div>
          )}
          {returnPts > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-[10px] font-mono text-carbon-400">Return: {returnPts.toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────
// Flights Section (always visible)
// ────────────────────────────────────────────

function FlightsSection({
  flights,
  totalPointsAllocated,
  onChatSend,
  onOpenChat,
}: {
  flights: TravelFlight[];
  totalPointsAllocated: number;
  onChatSend: (msg: string) => void;
  onOpenChat: () => void;
}) {
  const [showPartners, setShowPartners] = useState(false);
  const remaining = CHASE_UR_TOTAL - totalPointsAllocated;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-white flex items-center gap-2">
        <Plane className="w-4 h-4 text-amber-400" />
        Flights & Points
      </h2>

      {/* Chase Sapphire Card Overview */}
      <div className="card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-8 rounded bg-gradient-to-br from-blue-700 to-blue-900 flex items-center justify-center shadow-md border border-blue-600/30">
              <span className="text-[8px] font-bold text-white tracking-wider">SAPPHIRE</span>
            </div>
            <div>
              <p className="text-sm font-medium text-white">Chase Sapphire Preferred</p>
              <p className="text-[10px] font-mono text-carbon-400">
                {remaining.toLocaleString()} of {CHASE_UR_TOTAL.toLocaleString()} UR points available
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-lg font-mono text-amber-400 font-bold">
              {(remaining / 1000).toFixed(0)}K
            </p>
            <p className="text-[10px] font-mono text-carbon-500">pts available</p>
          </div>
        </div>

        {/* Points gauge bar */}
        <div className="mt-3 h-2.5 bg-carbon-800 rounded-full overflow-hidden">
          {flights.filter(f => f.direction === "outbound" && f.points_cost).map((f, i) => (
            <div
              key={`out-${i}`}
              className="h-full bg-cyan-400 float-left"
              style={{ width: `${((f.points_cost || 0) / CHASE_UR_TOTAL) * 100}%` }}
              title={`Outbound: ${(f.points_cost || 0).toLocaleString()} pts`}
            />
          ))}
          {flights.filter(f => f.direction === "return" && f.points_cost).map((f, i) => (
            <div
              key={`ret-${i}`}
              className="h-full bg-amber-400 float-left"
              style={{ width: `${((f.points_cost || 0) / CHASE_UR_TOTAL) * 100}%` }}
              title={`Return: ${(f.points_cost || 0).toLocaleString()} pts`}
            />
          ))}
        </div>
        {totalPointsAllocated > 0 && (
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-cyan-400" />
              <span className="text-[10px] font-mono text-carbon-400">
                Outbound: {flights.filter(f => f.direction === "outbound").reduce((s, f) => s + (f.points_cost || 0), 0).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-[10px] font-mono text-carbon-400">
                Return: {flights.filter(f => f.direction === "return").reduce((s, f) => s + (f.points_cost || 0), 0).toLocaleString()}
              </span>
            </div>
          </div>
        )}

        {/* Transfer Partners */}
        <button
          onClick={() => setShowPartners(!showPartners)}
          className="mt-3 text-[10px] font-mono text-carbon-500 hover:text-amber-400 transition-colors flex items-center gap-1"
        >
          {showPartners ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Transfer Partners ({CHASE_TRANSFER_PARTNERS.length})
        </button>
        {showPartners && (
          <div className="mt-2 space-y-1.5">
            {CHASE_TRANSFER_PARTNERS.map((p) => (
              <div
                key={p.name}
                className={cn(
                  "flex items-center justify-between px-2.5 py-1.5 rounded text-[10px] font-mono",
                  p.best ? "bg-cyan-500/10 border border-cyan-500/20" : "bg-carbon-800/50"
                )}
              >
                <div className="flex items-center gap-2">
                  {p.best && <Star className="w-2.5 h-2.5 text-cyan-400" />}
                  <span className={p.best ? "text-cyan-400" : "text-carbon-300"}>{p.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-carbon-500">{p.note}</span>
                  <span className={cn("font-bold", p.best ? "text-cyan-400" : "text-amber-400/70")}>{p.ratio}</span>
                </div>
              </div>
            ))}
            <p className="text-[9px] text-carbon-600 mt-1 px-1">
              Portal value: 1.25x base, up to 1.75x with Points Boost. Transfer ratio is 1:1 to airline partners.
            </p>
          </div>
        )}
      </div>

      {/* Flight Cards or Empty State */}
      {flights.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {flights.map((f) => <FlightCard key={f.id} flight={f} />)}
        </div>
      ) : (
        <div className="card p-6 text-center">
          <Plane className="w-8 h-8 text-amber-400/20 mx-auto mb-3" />
          <p className="text-sm text-carbon-400 mb-1">No flights tracked yet</p>
          <p className="text-xs text-carbon-600 mb-4">
            Ask the agent to search for flights. When you find one you like, tell it to track it.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {FLIGHT_QUICK_ACTIONS.map((qa) => (
              <button
                key={qa}
                onClick={() => { onChatSend(qa); onOpenChat(); }}
                className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-3 py-1.5 rounded-lg hover:bg-cyan-500/20 transition-colors flex items-center gap-1.5"
              >
                <Search className="w-2.5 h-2.5" />
                {qa}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────
// Day Card
// ────────────────────────────────────────────

function DayCard({ day, onAction, loadingId }: { day: DayEntry; onAction: ItemActionHandler; loadingId: number | null }) {
  const regionColor = REGION_COLORS[day.region] || "#94a3b8";
  const emoji = REGION_ICONS[day.region] || "\uD83D\uDCCD";
  const dateObj = new Date(day.date + "T12:00:00");
  const weekday = dateObj.toLocaleDateString("en-US", { weekday: "short" });
  const monthDay = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const hasContent = day.hotel || day.activities.length > 0 || day.restaurants.length > 0 || day.transport;

  return (
    <div className="card overflow-hidden animate-slide-up">
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ borderLeft: `3px solid ${regionColor}` }}
      >
        <div className="flex items-center gap-3">
          <div className="text-center">
            <p className="text-lg font-bold text-white leading-none">{day.dayNumber.toString().padStart(2, "0")}</p>
            <p className="text-[10px] font-mono text-carbon-500 uppercase mt-0.5">Day</p>
          </div>
          <div className="h-8 w-px bg-carbon-700/50" />
          <div>
            <p className="text-sm text-white font-medium">
              {emoji} {day.region}
              {day.isCheckIn && <span className="ml-2 text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded">Check-in</span>}
              {day.isCheckOut && <span className="ml-2 text-[10px] font-mono text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">Check-out</span>}
            </p>
            <p className="text-xs font-mono text-carbon-500">{weekday}, {monthDay}</p>
          </div>
        </div>
      </div>

      {hasContent ? (
        <div className="px-4 pb-4 pt-2 space-y-3">
          {day.transport && (
            <div className="bg-carbon-800/30 rounded-lg px-3 py-2.5 border border-carbon-700/30">
              <div className="flex items-center gap-2 text-xs text-carbon-300">
                {day.transport.name.toLowerCase().includes("train") ? (
                  <Train className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                ) : day.transport.name.toLowerCase().includes("car") || day.transport.name.toLowerCase().includes("drive") ? (
                  <Car className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                ) : (
                  <MapPin className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                )}
                <span className="font-medium">{day.transport.name}</span>
              </div>
              <div className="flex items-center gap-3 mt-1 ml-5.5">
                {day.transport.metadata?.duration && (
                  <span className="text-[10px] font-mono text-carbon-500 flex items-center gap-0.5">
                    <Clock className="w-2.5 h-2.5" /> {day.transport.metadata.duration}
                  </span>
                )}
                {day.transport.cost_eur && (
                  <span className="text-[10px] font-mono text-amber-400/70">EUR {day.transport.cost_eur}</span>
                )}
                {day.transport.booking_url && (
                  <a href={day.transport.booking_url} target="_blank" rel="noopener noreferrer" className="text-[10px] font-mono text-cyan-400/70 hover:text-cyan-400 flex items-center gap-0.5 transition-colors">
                    <ExternalLink className="w-2.5 h-2.5" /> Book
                  </a>
                )}
              </div>
              {day.transport.notes && <p className="text-[10px] text-carbon-600 mt-1 ml-5.5">{day.transport.notes}</p>}
            </div>
          )}

          {day.hotel && <HotelCard item={day.hotel} onAction={onAction} loadingId={loadingId} />}

          {day.activities.length > 0 && (
            <div>
              <p className="text-[10px] font-mono text-carbon-600 uppercase tracking-wider mb-1">Activities</p>
              {day.activities.map((a) => <ActivityCard key={a.id} item={a} onAction={onAction} loadingId={loadingId} />)}
            </div>
          )}

          {day.restaurants.length > 0 && (
            <div>
              <p className="text-[10px] font-mono text-carbon-600 uppercase tracking-wider mb-1">Dining</p>
              {day.restaurants.map((r) => <RestaurantCard key={r.id} item={r} onAction={onAction} loadingId={loadingId} />)}
            </div>
          )}
        </div>
      ) : (
        <div className="px-4 pb-4 pt-2">
          <p className="text-xs text-carbon-600 italic">Free day to explore {day.region}. Ask the travel agent for suggestions.</p>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────
// Budget Bar
// ────────────────────────────────────────────

function BudgetBar({ label, amount, total, color, suffix }: { label: string; amount: number; total: number; color: string; suffix?: string }) {
  const pct = total > 0 ? Math.min(100, (amount / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-carbon-400">{label}</span>
        <span className="font-mono text-carbon-300">{suffix || "EUR"} {amount.toLocaleString()}</span>
      </div>
      <div className="h-1.5 bg-carbon-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────

export default function TravelPage() {
  const { data, loading, refetch } = useFetch<TravelData>("/api/travel", 30000);
  const [vetoesExpanded, setVetoesExpanded] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<DashboardMessage[]>([]);
  const [chatSending, setChatSending] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastIdRef = useRef(0);

  // Sync server messages into local chat state
  useEffect(() => {
    if (data?.messages && data.messages.length > 0) {
      setChatMessages(data.messages);
    }
  }, [data?.messages]);

  const addToast = useCallback((text: string, type: ToastMessage["type"]) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text, type }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Handle approve/veto/alternative actions on items
  const handleItemAction: ItemActionHandler = useCallback(
    async (item, action, reason) => {
      if (action === "alternative") {
        // Route through agent chat
        const msg = `Find me alternative ${item.item_type}s in ${item.region} instead of "${item.name}". I want different options.`;
        handleChatSend(msg, { id: item.id, name: item.name, region: item.region, item_type: item.item_type });
        setChatOpen(true);
        return;
      }

      setActionLoading(item.id);
      try {
        const res = await fetch("/api/travel", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, action, reason }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Failed to update");
        }

        addToast(
          action === "approve"
            ? `"${item.name}" approved`
            : `"${item.name}" vetoed`,
          action === "approve" ? "success" : "error"
        );

        // Refetch data to get updated state
        if (refetch) refetch();
      } catch (err) {
        addToast(`Failed to ${action} "${item.name}"`, "error");
      } finally {
        setActionLoading(null);
      }
    },
    [addToast, refetch]
  );

  // Handle sending chat messages
  const handleChatSend = useCallback(
    async (message: string, itemContext?: { id: number; name: string; region: string; item_type: string }) => {
      // Optimistically add user message
      const tempId = Date.now();
      const userMsg: DashboardMessage = {
        id: tempId,
        direction: "user",
        content: message,
        action_type: "chat",
        created_at: new Date().toISOString(),
      };
      setChatMessages((prev) => [...prev, userMsg]);
      setChatSending(true);

      try {
        const res = await fetch("/api/travel/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, item_context: itemContext }),
        });

        if (!res.ok) {
          throw new Error("Agent request failed");
        }

        const result = await res.json();

        // Add agent response
        const agentMsg: DashboardMessage = {
          id: result.message_id || Date.now() + 1,
          direction: "agent",
          content: result.response || "No response from agent.",
          action_type: "chat",
          created_at: new Date().toISOString(),
        };
        setChatMessages((prev) => [...prev, agentMsg]);

        // Refetch data since agent may have created new items
        if (refetch) refetch();
      } catch (err) {
        const errorMsg: DashboardMessage = {
          id: Date.now() + 1,
          direction: "agent",
          content: "Sorry, I couldn't reach the travel agent. Try again or use Telegram.",
          action_type: "error",
          created_at: new Date().toISOString(),
        };
        setChatMessages((prev) => [...prev, errorMsg]);
      } finally {
        setChatSending(false);
      }
    },
    [refetch]
  );

  const trip = data?.trip;
  const items = data?.items || [];
  const vetoes = data?.vetoes || [];
  const days = data?.days || [];
  const flights = data?.flights || [];
  const budget = trip?.budget;

  const booked = items.filter((i) => i.status === "booked").length;
  const approved = items.filter((i) => i.status === "approved").length;
  const proposed = items.filter((i) => i.status === "proposed").length;

  const tripStart = new Date("2026-07-17");
  const now = new Date();
  const daysToTrip = Math.ceil((tripStart.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const hotels = items.filter((i) => i.item_type === "hotel" && i.status !== "vetoed");
  const totalPointsAllocated = flights.reduce((sum, f) => sum + (f.points_cost || 0), 0);
  const shouldCollapseVetoes = vetoes.length > 3;

  return (
    <div className="space-y-8">
      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={dismissToast} />
        ))}
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center gap-3">
            <Plane className="w-6 h-6 text-amber-400" />
            Portugal Honeymoon
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            July 17-26, 2026{" "}
            <span className="text-carbon-600">|</span> Porto to Algarve{" "}
            <span className="text-carbon-600">|</span>{" "}
            <span className={cn("capitalize", trip?.status === "booked" ? "text-emerald-400" : "text-amber-400")}>
              {TRIP_STATUS_LABELS[trip?.status || "planning"] || trip?.status || "Planning"}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-carbon-500">
          <Sun className="w-3 h-3 text-amber-400" />
          Alan & Carissa
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Days to Departure" value={daysToTrip} sub="Jul 17, 2026" icon={Plane} accent="#f59e0b" delay={0} />
        <StatCard label="Trip Budget" value={budget ? `\u20AC${budget.grand_total_eur.toLocaleString()}` : "\u20AC0"} sub={budget ? `~$${Math.round(budget.grand_total_eur * 1.1).toLocaleString()}` : ""} icon={DollarSign} accent="#22c55e" delay={50} />
        <StatCard label="Items Booked" value={`${booked} / ${booked + approved + proposed}`} sub={`${approved} approved`} icon={Check} accent="#06b6d4" delay={100} />
        <StatCard label="Hotels Selected" value={hotels.length} sub={`${hotels.filter((h) => h.status === "booked").length} booked`} icon={Hotel} accent="#a855f7" delay={150} />
        <StatCard label="Chase UR Points" value={totalPointsAllocated > 0 ? `${(totalPointsAllocated / 1000).toFixed(0)}K` : "100K"} sub={totalPointsAllocated > 0 ? `${((CHASE_UR_TOTAL - totalPointsAllocated) / 1000).toFixed(0)}K left` : "available"} icon={Coins} accent="#f59e0b" delay={200} />
      </div>

      {/* Flights & Points Section */}
      <FlightsSection
        flights={flights}
        totalPointsAllocated={totalPointsAllocated}
        onChatSend={(msg) => handleChatSend(msg)}
        onOpenChat={() => setChatOpen(true)}
      />

      {/* Budget breakdown + Itinerary */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
        {/* Budget Breakdown */}
        <div className="xl:col-span-1 space-y-4">
          <h2 className="text-sm font-semibold text-white">Budget Breakdown</h2>
          <div className="card p-4 space-y-4">
            {budget && budget.grand_total_eur > 0 ? (
              <>
                <BudgetBar label="Hotels" amount={budget.hotels_total_eur} total={budget.grand_total_eur} color="#a855f7" />
                <BudgetBar label="Activities" amount={budget.activities_total_eur} total={budget.grand_total_eur} color="#06b6d4" />
                <BudgetBar label="Transport" amount={budget.transport_total_eur} total={budget.grand_total_eur} color="#22c55e" />
                <BudgetBar label="Food" amount={budget.food_estimate_eur} total={budget.grand_total_eur} color="#f59e0b" />

                {(budget.flights_total_usd > 0 || budget.flights_total_points > 0) && (
                  <div className="border-t border-carbon-800 pt-3 space-y-2">
                    <p className="text-[10px] font-mono text-carbon-600 uppercase tracking-wider">Flights (USD / Points)</p>
                    {budget.flights_total_usd > 0 && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-carbon-400">Cash</span>
                        <span className="font-mono text-carbon-300">${budget.flights_total_usd.toLocaleString()}</span>
                      </div>
                    )}
                    {budget.flights_total_points > 0 && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-carbon-400">Points</span>
                        <span className="font-mono text-amber-400/80">{budget.flights_total_points.toLocaleString()} UR</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="border-t border-carbon-800 pt-3 flex items-center justify-between">
                  <span className="text-xs text-carbon-400">Grand Total</span>
                  <div className="text-right">
                    <p className="text-sm font-mono text-white font-semibold">EUR {budget.grand_total_eur.toLocaleString()}</p>
                    <p className="text-[10px] font-mono text-carbon-500">
                      ~${Math.round(budget.grand_total_eur * 1.1).toLocaleString()} USD
                      {budget.flights_total_usd > 0 && <span> + ${budget.flights_total_usd.toLocaleString()} flights</span>}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-carbon-600 text-center py-4">Budget will populate as the travel agent builds the itinerary.</p>
            )}
          </div>

          {/* Vetoed Items */}
          {vetoes.length > 0 && (
            <>
              <button
                className="text-sm font-semibold text-white flex items-center gap-2 w-full text-left hover:text-amber-400 transition-colors"
                onClick={() => setVetoesExpanded(!vetoesExpanded)}
              >
                <Ban className="w-3.5 h-3.5 text-red-400" />
                Vetoed ({vetoes.length})
                {shouldCollapseVetoes && (
                  vetoesExpanded
                    ? <ChevronDown className="w-3 h-3 text-carbon-500 ml-auto" />
                    : <ChevronRight className="w-3 h-3 text-carbon-500 ml-auto" />
                )}
              </button>
              {(!shouldCollapseVetoes || vetoesExpanded) && (
                <div className="card p-3">
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {vetoes.map((v: any) => (
                      <div key={v.id} className="text-xs">
                        <p className="text-red-400/80 line-through">{v.name}</p>
                        <p className="text-[10px] text-carbon-600">{v.region} {v.item_type}: {v.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Notes */}
          {trip?.notes && trip.notes.length > 0 && (
            <>
              <h2 className="text-sm font-semibold text-white">Trip Notes</h2>
              <div className="card p-3">
                <div className="space-y-1.5">
                  {trip.notes.map((note: string, i: number) => (
                    <p key={i} className="text-xs text-carbon-400 flex items-start gap-1.5">
                      <Star className="w-3 h-3 text-amber-400/50 shrink-0 mt-0.5" />
                      {note}
                    </p>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Day-by-Day Itinerary */}
        <div className="xl:col-span-3 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Calendar className="w-4 h-4 text-amber-400" />
              Day-by-Day Itinerary
            </h2>
            <span className="text-xs font-mono text-carbon-500">{days.length} days, 9 nights</span>
          </div>

          {days.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {days.map((day) => <DayCard key={day.date} day={day} onAction={handleItemAction} loadingId={actionLoading} />)}
            </div>
          ) : (
            <div className="card p-12 text-center">
              <Plane className="w-10 h-10 text-amber-400/30 mx-auto mb-4" />
              <p className="text-carbon-400 text-sm">No itinerary yet. Ask the travel agent to start planning.</p>
              <p className="text-carbon-600 text-xs mt-2 font-mono">
                Click the chat button below, or message on Telegram.
              </p>
              <button
                onClick={() => setChatOpen(true)}
                className="mt-4 text-xs font-mono text-amber-400 bg-amber-500/10 px-4 py-2 rounded-lg hover:bg-amber-500/20 transition-colors inline-flex items-center gap-2"
              >
                <MessageCircle className="w-3.5 h-3.5" />
                Open Chat
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Chat Panel */}
      <ChatPanel
        messages={chatMessages}
        onSend={(msg) => handleChatSend(msg)}
        sending={chatSending}
        open={chatOpen}
        onToggle={() => setChatOpen(!chatOpen)}
      />
    </div>
  );
}
