import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [stats] = await query<any>(`
      SELECT
        (SELECT COUNT(*) FROM agents WHERE status = 'active') as agents_active,
        (SELECT COUNT(*) FROM tasks WHERE created_at >= CURRENT_DATE) as tasks_today,
        (SELECT COUNT(*) FROM tasks WHERE status IN ('pending', 'in_progress', 'delegated')) as tasks_pending,
        (SELECT COALESCE(SUM(cost_cents), 0) FROM cost_events WHERE created_at >= CURRENT_DATE) as cost_today_cents,
        (SELECT COALESCE(SUM(cost_cents), 0) FROM cost_events WHERE created_at >= date_trunc('week', CURRENT_DATE)) as cost_this_week_cents,
        (SELECT COALESCE(SUM(total_tokens), 0) FROM cost_events WHERE created_at >= CURRENT_DATE) as tokens_today,
        (SELECT COUNT(*) FROM cron_runs WHERE started_at >= CURRENT_DATE) as crons_today,
        (SELECT COUNT(*) FROM cron_runs WHERE started_at >= CURRENT_DATE AND status = 'failed') as crons_failed
    `);

    const weddingDate = new Date("2026-07-12");
    const now = new Date();
    const weddingDaysLeft = Math.ceil(
      (weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    return NextResponse.json({
      ...stats,
      wedding_days_left: weddingDaysLeft,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch stats" },
      { status: 500 }
    );
  }
}
