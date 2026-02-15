export interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  color: string;
  status: "idle" | "active" | "error" | "disabled";
  last_active_at: string | null;
  total_tasks: number;
  total_tokens_used: number;
  total_cost_cents: number;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: "pending" | "in_progress" | "delegated" | "completed" | "failed" | "cancelled";
  priority: "urgent" | "high" | "normal" | "low";
  domain: string | null;
  assigned_agent: string | null;
  delegated_by: string | null;
  parent_task_id: number | null;
  input_summary: string | null;
  output_summary: string | null;
  tokens_used: number;
  cost_cents: number;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  agent_name?: string;
  agent_color?: string;
}

export interface CronJob {
  id: number;
  name: string;
  description: string | null;
  schedule: string;
  agent_id: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: "pending" | "running" | "success" | "failed";
  last_duration_ms: number | null;
  last_error: string | null;
  run_count: number;
  fail_count: number;
  avg_tokens: number;
  avg_cost_cents: number;
  agent_name?: string;
  agent_color?: string;
}

export interface CronRun {
  id: number;
  cron_job_id: number;
  status: "running" | "success" | "failed";
  tokens_used: number;
  cost_cents: number;
  duration_ms: number | null;
  output_summary: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface CostDaily {
  date: string;
  total_tokens: number;
  total_cost_cents: number;
  opus_cost_cents: number;
  sonnet_cost_cents: number;
  haiku_cost_cents: number;
  task_count: number;
  cron_count: number;
}

export interface ActivityEvent {
  id: number;
  event_type: string;
  agent_id: string | null;
  task_id: number | null;
  channel: string | null;
  summary: string;
  created_at: string;
  agent_name?: string;
  agent_color?: string;
}

export interface DashboardStats {
  agents_active: number;
  tasks_today: number;
  tasks_pending: number;
  cost_today_cents: number;
  cost_this_week_cents: number;
  tokens_today: number;
  crons_today: number;
  crons_failed: number;
  wedding_days_left: number;
}

// Wedding Planner

export interface WeddingVendor {
  id: number;
  name: string;
  category: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  status: "researching" | "contacted" | "quoted" | "booked" | "paid" | "cancelled";
  cost_estimate: number | null;
  cost_actual: number | null;
  notes: string | null;
  next_action: string | null;
  next_action_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface WeddingBudgetItem {
  id: number;
  category: string;
  item: string;
  estimated_cents: number;
  actual_cents: number;
  paid: boolean;
  vendor_id: number | null;
  due_date: string | null;
  notes: string | null;
  created_at: string;
}

export interface WeddingTimelineItem {
  id: number;
  title: string;
  date: string;
  category: "milestone" | "deadline" | "appointment" | "payment";
  completed: boolean;
  vendor_id: number | null;
  notes: string | null;
  created_at: string;
}

export interface WeddingDashboardData {
  vendors: WeddingVendor[];
  budget: WeddingBudgetItem[];
  timeline: WeddingTimelineItem[];
  stats: {
    days_left: number;
    total_estimated_cents: number;
    total_actual_cents: number;
    total_paid_cents: number;
    vendors_booked: number;
    vendors_total: number;
    upcoming_deadlines: number;
  };
  recent_activity: ActivityEvent[];
}
