import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const vendors = await query(
      `SELECT * FROM wedding_vendors ORDER BY
        CASE status
          WHEN 'booked' THEN 0
          WHEN 'paid' THEN 1
          WHEN 'quoted' THEN 2
          WHEN 'contacted' THEN 3
          WHEN 'researching' THEN 4
          WHEN 'cancelled' THEN 5
        END,
        name ASC`
    );

    const budget = await query(
      `SELECT b.*, v.name as vendor_name
       FROM wedding_budget b
       LEFT JOIN wedding_vendors v ON b.vendor_id = v.id
       ORDER BY b.category, b.item`
    );

    const timeline = await query(
      `SELECT t.*, v.name as vendor_name
       FROM wedding_timeline t
       LEFT JOIN wedding_vendors v ON t.vendor_id = v.id
       ORDER BY t.date ASC`
    );

    const recentActivity = await query(
      `SELECT al.*, a.name as agent_name, a.color as agent_color
       FROM activity_log al
       LEFT JOIN agents a ON al.agent_id = a.id
       WHERE al.agent_id = 'wedding-planner'
       ORDER BY al.created_at DESC
       LIMIT 15`
    );

    // Compute stats
    const weddingDate = new Date("2026-07-12");
    const now = new Date();
    const daysLeft = Math.ceil(
      (weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    const [budgetStats] = await query<any>(
      `SELECT
        COALESCE(SUM(estimated_cents), 0) as total_estimated,
        COALESCE(SUM(actual_cents), 0) as total_actual,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN estimated_cents WHEN status = 'partial' THEN actual_cents ELSE 0 END), 0) as total_paid
       FROM wedding_budget`
    );

    const [vendorStats] = await query<any>(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status IN ('booked', 'paid')) as booked
       FROM wedding_vendors`
    );

    const [deadlineStats] = await query<any>(
      `SELECT COUNT(*) as upcoming
       FROM wedding_timeline
       WHERE NOT completed
         AND date <= NOW() + INTERVAL '30 days'
         AND date >= NOW()`
    );

    return NextResponse.json({
      vendors,
      budget,
      timeline,
      recent_activity: recentActivity,
      stats: {
        days_left: daysLeft,
        total_estimated_cents: parseInt(budgetStats?.total_estimated || "0"),
        total_actual_cents: parseInt(budgetStats?.total_actual || "0"),
        total_paid_cents: parseInt(budgetStats?.total_paid || "0"),
        budget_target_cents: 4500000,
        vendors_booked: parseInt(vendorStats?.booked || "0"),
        vendors_total: parseInt(vendorStats?.total || "0"),
        upcoming_deadlines: parseInt(deadlineStats?.upcoming || "0"),
      },
    });
  } catch (error) {
    console.error("Wedding API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch wedding data" },
      { status: 500 }
    );
  }
}
