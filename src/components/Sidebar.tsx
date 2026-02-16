"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  ListTodo,
  Clock,
  DollarSign,
  BarChart3,
  Bot,
  Radio,
  Zap,
  Heart,
} from "lucide-react";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tasks", label: "Task Board", icon: ListTodo },
  { href: "/crons", label: "Cron Monitor", icon: Clock },
  { href: "/costs", label: "Cost Tracker", icon: DollarSign },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/wedding", label: "Wedding", icon: Heart },
];

const agents = [
  { id: "alan-os", name: "Alan OS", color: "#6b8f71", model: "opus" },
  { id: "ascend-builder", name: "Ascend Builder", color: "#3d9970", model: "opus" },
  { id: "legal-advisor", name: "Legal Advisor", color: "#d9534f", model: "opus" },
  { id: "social-media", name: "Social Media", color: "#4a8fe7", model: "sonnet" },
  { id: "wedding-planner", name: "Wedding Planner", color: "#d946a8", model: "sonnet" },
  { id: "life-admin", name: "Life Admin", color: "#d4940a", model: "sonnet" },
  { id: "research-analyst", name: "Research Analyst", color: "#8b5cf6", model: "opus" },
  { id: "comms-drafter", name: "Comms Drafter", color: "#d4940a", model: "sonnet" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col h-screen shrink-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sage-400/15 border border-sage-400/30 flex items-center justify-center">
            <Zap className="w-4 h-4 text-sage-300" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white tracking-tight">
              Mission Control
            </h1>
            <p className="text-[10px] font-mono text-cream-500 uppercase tracking-widest">
              Alan OS v1.0
            </p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-auto px-3 py-4 space-y-1">
        <p className="px-4 pb-2 text-[10px] font-mono uppercase tracking-widest text-cream-600">
          Views
        </p>
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn("sidebar-link", isActive && "active")}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}

        <div className="pt-6 pb-2">
          <p className="px-4 pb-2 text-[10px] font-mono uppercase tracking-widest text-cream-600">
            Agents
          </p>
        </div>
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center gap-3 px-4 py-2 rounded-lg text-sm text-cream-400 hover:text-cream-200 transition-colors"
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: agent.color }}
            />
            <span className="truncate flex-1">{agent.name}</span>
            <span className="text-[10px] font-mono text-cream-600 uppercase">
              {agent.model}
            </span>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-sidebar-border">
        <div className="flex items-center gap-2">
          <Radio className="w-3 h-3 text-sage-300 animate-pulse-slow" />
          <span className="text-[11px] font-mono text-cream-500">
            System Online
          </span>
        </div>
      </div>
    </aside>
  );
}
