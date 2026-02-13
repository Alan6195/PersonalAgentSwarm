import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "30");

    const daily = await query(
      `SELECT * FROM cost_daily
       WHERE date >= CURRENT_DATE - $1 * INTERVAL '1 day'
       ORDER BY date ASC`,
      [days]
    );

    const byAgent = await query(`
      SELECT
        a.id, a.name, a.color,
        COALESCE(SUM(ce.cost_cents), 0) as total_cost,
        COALESCE(SUM(ce.total_tokens), 0) as total_tokens,
        COUNT(ce.id) as event_count
      FROM agents a
      LEFT JOIN cost_events ce ON a.id = ce.agent_id
        AND ce.created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
      GROUP BY a.id, a.name, a.color
      ORDER BY total_cost DESC
    `, [days]);

    const byModel = await query(`
      SELECT
        model,
        COALESCE(SUM(cost_cents), 0) as total_cost,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COUNT(*) as event_count
      FROM cost_events
      WHERE created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
      GROUP BY model
      ORDER BY total_cost DESC
    `, [days]);

    return NextResponse.json({ daily, byAgent, byModel });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch cost data" },
      { status: 500 }
    );
  }
}
