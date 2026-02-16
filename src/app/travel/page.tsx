"use client";

import { useFetch } from "@/lib/hooks";
import { cn } from "@/lib/utils";
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
    };
    notes: string[];
  } | null;
  items: TravelItem[];
  vetoes: any[];
  days: DayEntry[];
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

const AMBER = "#f59e0b";
const AMBER_DIM = "#f59e0b20";

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
};

const TRIP_STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  itinerary_approved: "Itinerary Approved",
  booking: "Booking in Progress",
  booked: "Fully Booked",
  in_progress: "Trip in Progress",
  completed: "Completed",
};

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
// Hotel Card
// ────────────────────────────────────────────

function HotelCard({ item }: { item: TravelItem }) {
  const style = STATUS_STYLES[item.status] || STATUS_STYLES.proposed;
  return (
    <div className="bg-carbon-800/40 rounded-lg p-3 border border-carbon-700/50">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Hotel className="w-4 h-4 text-amber-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-white">{item.name}</p>
            {item.nightly_rate_eur && (
              <p className="text-xs font-mono text-carbon-400 mt-0.5">
                EUR {item.nightly_rate_eur}/night
                {item.nights ? ` x ${item.nights} nights` : ""}
                {item.cost_eur ? ` = EUR ${item.cost_eur}` : ""}
              </p>
            )}
          </div>
        </div>
        <span className={cn("badge text-[10px] shrink-0", style.bg, style.text)}>
          {style.label}
        </span>
      </div>
      {item.notes && (
        <p className="text-xs text-carbon-500 mt-2 leading-relaxed">{item.notes}</p>
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
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Activity Card
// ────────────────────────────────────────────

function ActivityCard({ item }: { item: TravelItem }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Wine className="w-3.5 h-3.5 text-purple-400 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-carbon-200">{item.name}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {item.time && (
            <span className="text-[10px] font-mono text-carbon-500">
              <Clock className="w-2.5 h-2.5 inline mr-0.5" />
              {item.time}
            </span>
          )}
          {item.cost_per_person_eur && (
            <span className="text-[10px] font-mono text-carbon-500">
              EUR {item.cost_per_person_eur}/pp
            </span>
          )}
          {item.cost_eur && (
            <span className="text-[10px] font-mono text-amber-400/70">
              EUR {item.cost_eur} total
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Restaurant Card
// ────────────────────────────────────────────

function RestaurantCard({ item }: { item: TravelItem }) {
  const meta = item.metadata || {};
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Utensils className="w-3.5 h-3.5 text-orange-400 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-carbon-200">
          {item.name}
          {meta.gf_df_friendly && (
            <span className="ml-1.5 text-[9px] font-mono text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded">
              GF/DF
            </span>
          )}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          {meta.price_range_eur && (
            <span className="text-[10px] font-mono text-carbon-500">
              {meta.price_range_eur}
            </span>
          )}
          {meta.reservation_needed && (
            <span className="text-[10px] font-mono text-amber-400/60">
              Reservation req.
            </span>
          )}
        </div>
        {item.notes && (
          <p className="text-[10px] text-carbon-600 mt-0.5">{item.notes}</p>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Day Card
// ────────────────────────────────────────────

function DayCard({ day }: { day: DayEntry }) {
  const regionColor = REGION_COLORS[day.region] || "#94a3b8";
  const emoji = REGION_ICONS[day.region] || "\uD83D\uDCCD";
  const dateObj = new Date(day.date + "T12:00:00");
  const weekday = dateObj.toLocaleDateString("en-US", { weekday: "short" });
  const monthDay = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const hasContent = day.hotel || day.activities.length > 0 || day.restaurants.length > 0 || day.transport;

  return (
    <div className="card overflow-hidden animate-slide-up">
      {/* Day header */}
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ borderLeft: `3px solid ${regionColor}` }}
      >
        <div className="flex items-center gap-3">
          <div className="text-center">
            <p className="text-lg font-bold text-white leading-none">{dayNumber(day.dayNumber)}</p>
            <p className="text-[10px] font-mono text-carbon-500 uppercase mt-0.5">Day</p>
          </div>
          <div className="h-8 w-px bg-carbon-700/50" />
          <div>
            <p className="text-sm text-white font-medium">
              {emoji} {day.region}
              {day.isCheckIn && (
                <span className="ml-2 text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                  Check-in
                </span>
              )}
              {day.isCheckOut && (
                <span className="ml-2 text-[10px] font-mono text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                  Check-out
                </span>
              )}
            </p>
            <p className="text-xs font-mono text-carbon-500">{weekday}, {monthDay}</p>
          </div>
        </div>
      </div>

      {/* Day content */}
      {hasContent ? (
        <div className="px-4 pb-4 pt-2 space-y-3">
          {/* Transport arrival */}
          {day.transport && (
            <div className="flex items-center gap-2 text-xs text-carbon-400 bg-carbon-800/30 rounded-lg px-3 py-2">
              <Train className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span>
                Arrive via: {day.transport.name}
                {day.transport.cost_eur ? ` (EUR ${day.transport.cost_eur})` : ""}
                {day.transport.metadata?.duration ? ` | ${day.transport.metadata.duration}` : ""}
              </span>
            </div>
          )}

          {/* Hotel */}
          {day.hotel && <HotelCard item={day.hotel} />}

          {/* Activities */}
          {day.activities.length > 0 && (
            <div>
              <p className="text-[10px] font-mono text-carbon-600 uppercase tracking-wider mb-1">
                Activities
              </p>
              {day.activities.map((a) => (
                <ActivityCard key={a.id} item={a} />
              ))}
            </div>
          )}

          {/* Restaurants */}
          {day.restaurants.length > 0 && (
            <div>
              <p className="text-[10px] font-mono text-carbon-600 uppercase tracking-wider mb-1">
                Dining
              </p>
              {day.restaurants.map((r) => (
                <RestaurantCard key={r.id} item={r} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="px-4 pb-4 pt-2">
          <p className="text-xs text-carbon-600 italic">
            Free day to explore {day.region}. Ask the travel agent for suggestions.
          </p>
        </div>
      )}
    </div>
  );
}

function dayNumber(n: number): string {
  return n.toString().padStart(2, "0");
}

// ────────────────────────────────────────────
// Budget Bar
// ────────────────────────────────────────────

function BudgetBar({
  label,
  amount,
  total,
  color,
}: {
  label: string;
  amount: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.min(100, (amount / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-carbon-400">{label}</span>
        <span className="font-mono text-carbon-300">EUR {amount.toLocaleString()}</span>
      </div>
      <div className="h-1.5 bg-carbon-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────

export default function TravelPage() {
  const { data, loading } = useFetch<TravelData>("/api/travel", 30000);

  const trip = data?.trip;
  const items = data?.items || [];
  const vetoes = data?.vetoes || [];
  const days = data?.days || [];
  const budget = trip?.budget;

  // Count items by status
  const booked = items.filter((i) => i.status === "booked").length;
  const approved = items.filter((i) => i.status === "approved").length;
  const proposed = items.filter((i) => i.status === "proposed").length;

  // Countdown
  const tripStart = new Date("2026-07-16");
  const now = new Date();
  const daysToTrip = Math.ceil(
    (tripStart.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Hotels by region
  const hotels = items.filter((i) => i.item_type === "hotel" && i.status !== "vetoed");

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center gap-3">
            <Plane className="w-6 h-6 text-amber-400" />
            Portugal Honeymoon
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            July 16-26, 2026{" "}
            <span className="text-carbon-600">|</span> Porto to Algarve{" "}
            <span className="text-carbon-600">|</span>{" "}
            <span className={cn(
              "capitalize",
              trip?.status === "booked" ? "text-emerald-400" : "text-amber-400"
            )}>
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Days to Departure"
          value={daysToTrip}
          sub="Jul 16, 2026"
          icon={Plane}
          accent="#f59e0b"
          delay={0}
        />
        <StatCard
          label="Trip Budget"
          value={budget ? `\u20AC${budget.grand_total_eur.toLocaleString()}` : "\u20AC0"}
          sub={budget ? `~$${Math.round(budget.grand_total_eur * 1.1).toLocaleString()}` : ""}
          icon={DollarSign}
          accent="#22c55e"
          delay={50}
        />
        <StatCard
          label="Items Booked"
          value={`${booked} / ${booked + approved + proposed}`}
          sub={`${approved} approved`}
          icon={Check}
          accent="#06b6d4"
          delay={100}
        />
        <StatCard
          label="Hotels Selected"
          value={hotels.length}
          sub={`${hotels.filter((h) => h.status === "booked").length} booked`}
          icon={Hotel}
          accent="#a855f7"
          delay={150}
        />
      </div>

      {/* Budget breakdown + Hotels sidebar */}
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
                <div className="border-t border-carbon-800 pt-3 flex items-center justify-between">
                  <span className="text-xs text-carbon-400">Grand Total</span>
                  <div className="text-right">
                    <p className="text-sm font-mono text-white font-semibold">
                      EUR {budget.grand_total_eur.toLocaleString()}
                    </p>
                    <p className="text-[10px] font-mono text-carbon-500">
                      ~${Math.round(budget.grand_total_eur * 1.1).toLocaleString()} USD
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-carbon-600 text-center py-4">
                Budget will populate as the travel agent builds the itinerary.
              </p>
            )}
          </div>

          {/* Vetoed Items */}
          {vetoes.length > 0 && (
            <>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Ban className="w-3.5 h-3.5 text-red-400" />
                Vetoed ({vetoes.length})
              </h2>
              <div className="card p-3">
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {vetoes.map((v: any) => (
                    <div key={v.id} className="text-xs">
                      <p className="text-red-400/80 line-through">{v.name}</p>
                      <p className="text-[10px] text-carbon-600">
                        {v.region} {v.item_type}: {v.reason}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
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
            <span className="text-xs font-mono text-carbon-500">
              {days.length} days, 10 nights
            </span>
          </div>

          {days.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {days.map((day) => (
                <DayCard key={day.date} day={day} />
              ))}
            </div>
          ) : (
            <div className="card p-12 text-center">
              <Plane className="w-10 h-10 text-amber-400/30 mx-auto mb-4" />
              <p className="text-carbon-400 text-sm">
                No itinerary yet. Ask the travel agent on Telegram to start planning.
              </p>
              <p className="text-carbon-600 text-xs mt-2 font-mono">
                Try: "Let's start planning the honeymoon" or "Show me hotel options for Porto"
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
