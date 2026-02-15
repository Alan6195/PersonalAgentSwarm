"use client";

import { useState } from "react";
import { useFetch } from "@/lib/hooks";
import { formatCost, timeAgo, cn } from "@/lib/utils";
import type {
  WeddingDashboardData,
  WeddingVendor,
  WeddingBudgetItem,
  WeddingTimelineItem,
  ActivityEvent,
} from "@/types";
import {
  Heart,
  DollarSign,
  Users,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Check,
  Mail,
  Clock,
  MapPin,
  Phone,
  ExternalLink,
} from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

const PINK = "#ec4899";
const PINK_DIM = "#ec489930";

const VENDOR_CATEGORIES = [
  "venue", "catering", "photography", "videography", "florist",
  "dj", "officiant", "cake", "dress", "hair_makeup", "rentals", "decor", "other",
];

const VENDOR_STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  researching: { bg: "bg-carbon-700/40", text: "text-carbon-400", label: "Researching" },
  contacted: { bg: "bg-blue-500/15", text: "text-blue-400", label: "Contacted" },
  quoted: { bg: "bg-amber-500/15", text: "text-amber-400", label: "Quoted" },
  booked: { bg: "bg-emerald-500/15", text: "text-emerald-400", label: "Booked" },
  paid: { bg: "bg-neon-green/10", text: "text-neon-green", label: "Paid" },
  cancelled: { bg: "bg-red-500/15", text: "text-red-400", label: "Cancelled" },
};

const CATEGORY_COLORS: Record<string, string> = {
  venue: "#ec4899",
  catering: "#f97316",
  photography: "#a855f7",
  videography: "#8b5cf6",
  florist: "#22c55e",
  dj: "#06b6d4",
  officiant: "#eab308",
  cake: "#f472b6",
  dress: "#e879f9",
  hair_makeup: "#fb923c",
  rentals: "#38bdf8",
  decor: "#34d399",
  other: "#94a3b8",
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
          style={{ backgroundColor: `${accent || PINK}15` }}
        >
          <Icon className="w-4 h-4" style={{ color: accent || PINK }} />
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
// Vendor Row
// ────────────────────────────────────────────

function VendorRow({
  vendor,
  onUpdate,
}: {
  vendor: WeddingVendor;
  onUpdate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const style = VENDOR_STATUS_STYLES[vendor.status] || VENDOR_STATUS_STYLES.researching;
  const catColor = CATEGORY_COLORS[vendor.category] || "#94a3b8";

  return (
    <div className="border-b border-carbon-800/50 last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-carbon-800/30 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-carbon-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-carbon-500 shrink-0" />
        )}
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: catColor }}
        />
        <span className="text-sm text-white flex-1 truncate">{vendor.name}</span>
        <span className="text-xs font-mono text-carbon-500 capitalize hidden sm:inline">
          {vendor.category.replace("_", " ")}
        </span>
        {vendor.cost_estimate && (
          <span className="text-xs font-mono text-carbon-400 hidden md:inline">
            {formatCost(vendor.cost_estimate)}
          </span>
        )}
        <span
          className={cn(
            "badge text-[10px]",
            style.bg,
            style.text,
            `border-current/30`
          )}
        >
          {style.label}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pl-10 space-y-2 animate-fade-in">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {vendor.contact_name && (
              <div className="flex items-center gap-2 text-carbon-400">
                <Users className="w-3 h-3" />
                <span>{vendor.contact_name}</span>
              </div>
            )}
            {vendor.email && (
              <div className="flex items-center gap-2 text-carbon-400">
                <Mail className="w-3 h-3" />
                <span>{vendor.email}</span>
              </div>
            )}
            {vendor.phone && (
              <div className="flex items-center gap-2 text-carbon-400">
                <Phone className="w-3 h-3" />
                <span>{vendor.phone}</span>
              </div>
            )}
            {vendor.cost_estimate && (
              <div className="flex items-center gap-2 text-carbon-400">
                <DollarSign className="w-3 h-3" />
                <span>
                  Est: {formatCost(vendor.cost_estimate)}
                  {vendor.cost_actual ? ` / Actual: ${formatCost(vendor.cost_actual)}` : ""}
                </span>
              </div>
            )}
          </div>
          {vendor.next_action && (
            <div className="text-xs text-amber-400/80 bg-amber-500/10 rounded-lg px-3 py-2 border border-amber-500/20">
              Next: {vendor.next_action}
              {vendor.next_action_date && (
                <span className="text-carbon-500 ml-1">
                  (by {new Date(vendor.next_action_date).toLocaleDateString()})
                </span>
              )}
            </div>
          )}
          {vendor.notes && (
            <p className="text-xs text-carbon-500 leading-relaxed">{vendor.notes}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────
// Add Vendor Modal
// ────────────────────────────────────────────

function AddVendorForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({
    name: "", category: "venue", contact_name: "", email: "", phone: "",
    status: "researching", cost_estimate: "", notes: "", next_action: "",
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch("/api/wedding/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          cost_estimate: form.cost_estimate ? Math.round(parseFloat(form.cost_estimate) * 100) : null,
        }),
      });
      onAdded();
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="card p-6 w-full max-w-lg space-y-4 animate-slide-up"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Add Vendor</h3>
          <button type="button" onClick={onClose} className="text-carbon-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <input
            placeholder="Vendor name *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            className="col-span-2 bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-pink-500/50"
          >
            {VENDOR_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace("_", " ").replace(/^\w/, (l) => l.toUpperCase())}
              </option>
            ))}
          </select>
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-pink-500/50"
          >
            {Object.entries(VENDOR_STATUS_STYLES).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <input
            placeholder="Contact name"
            value={form.contact_name}
            onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
          <input
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
          <input
            placeholder="Phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
          <input
            placeholder="Estimated cost ($)"
            value={form.cost_estimate}
            onChange={(e) => setForm({ ...form, cost_estimate: e.target.value })}
            type="number"
            step="0.01"
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
        </div>
        <input
          placeholder="Next action needed"
          value={form.next_action}
          onChange={(e) => setForm({ ...form, next_action: e.target.value })}
          className="w-full bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
        />
        <textarea
          placeholder="Notes"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={2}
          className="w-full bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50 resize-none"
        />
        <button
          type="submit"
          disabled={saving || !form.name}
          className="w-full py-2.5 rounded-lg bg-pink-500/20 border border-pink-500/40 text-pink-300 text-sm font-medium hover:bg-pink-500/30 transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Add Vendor"}
        </button>
      </form>
    </div>
  );
}

// ────────────────────────────────────────────
// Add Budget Item Modal
// ────────────────────────────────────────────

function AddBudgetForm({
  vendors,
  onClose,
  onAdded,
}: {
  vendors: WeddingVendor[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [form, setForm] = useState({
    category: "venue", item: "", estimated: "", actual: "",
    paid: false, vendor_id: "", due_date: "", notes: "",
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch("/api/wedding/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: form.category,
          item: form.item,
          estimated_cents: form.estimated ? Math.round(parseFloat(form.estimated) * 100) : 0,
          actual_cents: form.actual ? Math.round(parseFloat(form.actual) * 100) : 0,
          paid: form.paid,
          vendor_id: form.vendor_id ? parseInt(form.vendor_id) : null,
          due_date: form.due_date || null,
          notes: form.notes || null,
        }),
      });
      onAdded();
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="card p-6 w-full max-w-lg space-y-4 animate-slide-up"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Add Budget Item</h3>
          <button type="button" onClick={onClose} className="text-carbon-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <input
            placeholder="Item name *"
            value={form.item}
            onChange={(e) => setForm({ ...form, item: e.target.value })}
            required
            className="col-span-2 bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-pink-500/50"
          >
            {VENDOR_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace("_", " ").replace(/^\w/, (l) => l.toUpperCase())}
              </option>
            ))}
          </select>
          <select
            value={form.vendor_id}
            onChange={(e) => setForm({ ...form, vendor_id: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-pink-500/50"
          >
            <option value="">No linked vendor</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          <input
            placeholder="Estimated ($)"
            value={form.estimated}
            onChange={(e) => setForm({ ...form, estimated: e.target.value })}
            type="number"
            step="0.01"
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
          <input
            placeholder="Actual ($)"
            value={form.actual}
            onChange={(e) => setForm({ ...form, actual: e.target.value })}
            type="number"
            step="0.01"
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
          <input
            type="date"
            value={form.due_date}
            onChange={(e) => setForm({ ...form, due_date: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-pink-500/50"
          />
          <label className="flex items-center gap-2 text-sm text-carbon-400 cursor-pointer">
            <input
              type="checkbox"
              checked={form.paid}
              onChange={(e) => setForm({ ...form, paid: e.target.checked })}
              className="rounded border-carbon-600 bg-carbon-800"
            />
            Paid
          </label>
        </div>
        <button
          type="submit"
          disabled={saving || !form.item}
          className="w-full py-2.5 rounded-lg bg-pink-500/20 border border-pink-500/40 text-pink-300 text-sm font-medium hover:bg-pink-500/30 transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Add Budget Item"}
        </button>
      </form>
    </div>
  );
}

// ────────────────────────────────────────────
// Add Timeline Modal
// ────────────────────────────────────────────

function AddTimelineForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({
    title: "", date: "", category: "milestone", notes: "",
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch("/api/wedding/timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      onAdded();
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="card p-6 w-full max-w-lg space-y-4 animate-slide-up"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Add Timeline Event</h3>
          <button type="button" onClick={onClose} className="text-carbon-500 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <input
            placeholder="Event title *"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
            className="col-span-2 bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50"
          />
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            required
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-pink-500/50"
          />
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-pink-500/50"
          >
            <option value="milestone">Milestone</option>
            <option value="deadline">Deadline</option>
            <option value="appointment">Appointment</option>
            <option value="payment">Payment</option>
          </select>
        </div>
        <textarea
          placeholder="Notes"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={2}
          className="w-full bg-carbon-800/60 border border-carbon-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-carbon-600 focus:outline-none focus:border-pink-500/50 resize-none"
        />
        <button
          type="submit"
          disabled={saving || !form.title || !form.date}
          className="w-full py-2.5 rounded-lg bg-pink-500/20 border border-pink-500/40 text-pink-300 text-sm font-medium hover:bg-pink-500/30 transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Add Event"}
        </button>
      </form>
    </div>
  );
}

// ────────────────────────────────────────────
// Timeline Item
// ────────────────────────────────────────────

function TimelineRow({
  item,
  onToggle,
}: {
  item: WeddingTimelineItem;
  onToggle: () => void;
}) {
  const isPast = new Date(item.date) < new Date();
  const categoryIcon: Record<string, string> = {
    milestone: "\u2606",
    deadline: "\u26a0",
    appointment: "\u2315",
    payment: "$",
  };

  return (
    <div className={cn(
      "flex items-start gap-3 py-2.5",
      item.completed && "opacity-50",
    )}>
      <button
        onClick={onToggle}
        className={cn(
          "w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-colors",
          item.completed
            ? "border-pink-500 bg-pink-500/20"
            : isPast
            ? "border-red-400/50 hover:border-red-400"
            : "border-carbon-600 hover:border-pink-400"
        )}
      >
        {item.completed && <Check className="w-3 h-3 text-pink-400" />}
      </button>
      <div className="flex-1 min-w-0">
        <p className={cn(
          "text-sm",
          item.completed ? "text-carbon-500 line-through" : "text-white"
        )}>
          {item.title}
        </p>
        <p className="text-[11px] font-mono text-carbon-500 mt-0.5">
          <span className="mr-1">{categoryIcon[item.category] || "\u2606"}</span>
          {new Date(item.date).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
          {item.notes && <span className="ml-2 text-carbon-600">: {item.notes}</span>}
        </p>
      </div>
      {!item.completed && isPast && (
        <span className="badge bg-red-500/15 text-red-400 border-red-500/30 text-[10px] shrink-0">
          Overdue
        </span>
      )}
    </div>
  );
}

// ────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────

export default function WeddingPage() {
  const { data, refetch } = useFetch<WeddingDashboardData>("/api/wedding", 30000);
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showAddBudget, setShowAddBudget] = useState(false);
  const [showAddTimeline, setShowAddTimeline] = useState(false);
  const [vendorFilter, setVendorFilter] = useState<string>("all");

  const stats = data?.stats;
  const vendors = data?.vendors || [];
  const budget = data?.budget || [];
  const timeline = data?.timeline || [];
  const activity = data?.recent_activity || [];

  const filteredVendors =
    vendorFilter === "all"
      ? vendors
      : vendors.filter((v) => v.category === vendorFilter);

  // Budget chart data
  const budgetByCategory = budget.reduce<Record<string, { estimated: number; actual: number }>>(
    (acc, item) => {
      if (!acc[item.category]) acc[item.category] = { estimated: 0, actual: 0 };
      acc[item.category].estimated += item.estimated_cents;
      acc[item.category].actual += item.actual_cents;
      return acc;
    },
    {}
  );

  const chartData = Object.entries(budgetByCategory).map(([cat, vals]) => ({
    name: cat.replace("_", " ").replace(/^\w/, (l) => l.toUpperCase()),
    value: vals.estimated,
    color: CATEGORY_COLORS[cat] || "#94a3b8",
  }));

  const toggleTimeline = async (item: WeddingTimelineItem) => {
    await fetch("/api/wedding/timeline", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, completed: !item.completed }),
    });
    refetch();
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center gap-3">
            <Heart className="w-6 h-6 text-pink-400" />
            Wedding Planner
          </h1>
          <p className="text-sm text-carbon-500 font-mono mt-1">
            July 12, 2026 <span className="text-carbon-600">|</span> Peyton, Colorado
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-carbon-500">
          <MapPin className="w-3 h-3 text-pink-400" />
          Alan & Jade
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Days to Go"
          value={stats?.days_left ?? "..."}
          sub="July 12, 2026"
          icon={Heart}
          accent={PINK}
          delay={0}
        />
        <StatCard
          label="Total Budget"
          value={formatCost(stats?.total_estimated_cents ?? 0)}
          sub={`${formatCost(stats?.total_paid_cents ?? 0)} paid`}
          icon={DollarSign}
          accent="#ffb800"
          delay={50}
        />
        <StatCard
          label="Vendors"
          value={`${stats?.vendors_booked ?? 0} / ${stats?.vendors_total ?? 0}`}
          sub="booked"
          icon={Users}
          accent="#a855f7"
          delay={100}
        />
        <StatCard
          label="Upcoming"
          value={stats?.upcoming_deadlines ?? 0}
          sub="next 30 days"
          icon={CalendarClock}
          accent="#06b6d4"
          delay={150}
        />
      </div>

      {/* Vendors + Timeline */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Vendor Tracker */}
        <div className="xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Vendor Tracker</h2>
            <div className="flex items-center gap-2">
              <select
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
                className="bg-carbon-800/60 border border-carbon-700 rounded-lg px-2 py-1 text-xs font-mono text-carbon-400 focus:outline-none"
              >
                <option value="all">All categories</option>
                {VENDOR_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.replace("_", " ").replace(/^\w/, (l) => l.toUpperCase())}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowAddVendor(true)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-pink-500/10 border border-pink-500/30 text-pink-300 text-xs font-mono hover:bg-pink-500/20 transition-colors"
              >
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
          </div>
          <div className="card">
            {filteredVendors.length > 0 ? (
              filteredVendors.map((v) => (
                <VendorRow key={v.id} vendor={v} onUpdate={refetch} />
              ))
            ) : (
              <div className="text-center py-10 text-carbon-500 text-sm">
                {vendors.length === 0
                  ? "No vendors yet. Add your first vendor to get started."
                  : "No vendors in this category."}
              </div>
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Timeline</h2>
            <button
              onClick={() => setShowAddTimeline(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-pink-500/10 border border-pink-500/30 text-pink-300 text-xs font-mono hover:bg-pink-500/20 transition-colors"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          <div className="card p-4">
            {timeline.length > 0 ? (
              <div className="divide-y divide-carbon-800/30">
                {timeline.map((item) => (
                  <TimelineRow
                    key={item.id}
                    item={item}
                    onToggle={() => toggleTimeline(item)}
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-carbon-500 text-sm">
                No timeline events yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Budget + Activity */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Budget */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Budget</h2>
            <button
              onClick={() => setShowAddBudget(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-pink-500/10 border border-pink-500/30 text-pink-300 text-xs font-mono hover:bg-pink-500/20 transition-colors"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>

          {chartData.length > 0 && (
            <div className="card p-4">
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {chartData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} fillOpacity={0.7} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number) => formatCost(value)}
                      contentStyle={{
                        backgroundColor: "#1c1c1e",
                        border: "1px solid #333",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-3 justify-center mt-2">
                {chartData.map((entry) => (
                  <div key={entry.name} className="flex items-center gap-1.5 text-[11px] text-carbon-400">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: entry.color }}
                    />
                    {entry.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            {budget.length > 0 ? (
              <div className="divide-y divide-carbon-800/50">
                {budget.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: CATEGORY_COLORS[item.category] || "#94a3b8" }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{item.item}</p>
                      <p className="text-xs font-mono text-carbon-500">
                        {item.category.replace("_", " ")}
                        {item.due_date && (
                          <span className="ml-2">
                            due {new Date(item.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-mono text-white">
                        {formatCost(item.actual_cents || item.estimated_cents)}
                      </p>
                      {item.paid && (
                        <span className="text-[10px] font-mono text-neon-green">PAID</span>
                      )}
                    </div>
                  </div>
                ))}
                {/* Total row */}
                <div className="flex items-center justify-between px-4 py-3 bg-carbon-800/30">
                  <span className="text-xs font-mono text-carbon-400 uppercase tracking-wider">
                    Total
                  </span>
                  <div className="text-right">
                    <p className="text-sm font-mono text-white font-semibold">
                      {formatCost(stats?.total_estimated_cents ?? 0)}
                    </p>
                    <p className="text-[10px] font-mono text-carbon-500">
                      {formatCost(stats?.total_actual_cents ?? 0)} actual
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-carbon-500 text-sm">
                No budget items yet.
              </div>
            )}
          </div>
        </div>

        {/* Recent Email Activity */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Agent Activity</h2>
            <span className="text-xs font-mono text-carbon-500">
              {activity.length} recent events
            </span>
          </div>
          <div className="card p-4">
            {activity.length > 0 ? (
              <div className="divide-y divide-carbon-800/30 max-h-[500px] overflow-y-auto">
                {activity.map((evt) => (
                  <div key={evt.id} className="flex items-start gap-3 py-3">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-pink-500/10 mt-0.5">
                      {evt.event_type === "gmail_action" ? (
                        <Mail className="w-3.5 h-3.5 text-pink-400" />
                      ) : (
                        <Clock className="w-3.5 h-3.5 text-pink-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-carbon-300 leading-relaxed line-clamp-2">
                        {evt.summary}
                      </p>
                      <p className="text-[10px] font-mono text-carbon-600 mt-1">
                        {evt.event_type.replace("_", " ")} : {timeAgo(evt.created_at)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-carbon-500 text-sm">
                No agent activity yet. The wedding planner will show email triage summaries here.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showAddVendor && (
        <AddVendorForm onClose={() => setShowAddVendor(false)} onAdded={refetch} />
      )}
      {showAddBudget && (
        <AddBudgetForm
          vendors={vendors}
          onClose={() => setShowAddBudget(false)}
          onAdded={refetch}
        />
      )}
      {showAddTimeline && (
        <AddTimelineForm onClose={() => setShowAddTimeline(false)} onAdded={refetch} />
      )}
    </div>
  );
}
