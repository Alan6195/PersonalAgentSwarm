import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "7");

    const activity = await query(
      `SELECT al.*, a.name as agent_name, a.color as agent_color
       FROM activity_log al
       LEFT JOIN agents a ON al.agent_id = a.id
       WHERE al.created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
       ORDER BY al.created_at DESC
       LIMIT 100`,
      [days]
    );

    const tasksByDay = await query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM tasks
      WHERE created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [days]);

    const tasksByAgent = await query(`
      SELECT
        a.id, a.name, a.color,
        COUNT(t.id) as total,
        COUNT(t.id) FILTER (WHERE t.status = 'completed') as completed,
        AVG(t.duration_ms) as avg_duration_ms,
        AVG(t.tokens_used) as avg_tokens
      FROM agents a
      LEFT JOIN tasks t ON a.id = t.assigned_agent
        AND t.created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
      GROUP BY a.id, a.name, a.color
      ORDER BY total DESC
    `, [days]);

    const delegations = await query(`
      SELECT
        delegated_by as from_agent,
        assigned_agent as to_agent,
        COUNT(*) as count
      FROM tasks
      WHERE delegated_by IS NOT NULL
        AND created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
      GROUP BY delegated_by, assigned_agent
      ORDER BY count DESC
    `, [days]);

    const channelBreakdown = await query(`
      SELECT
        channel,
        COUNT(*) as count
      FROM activity_log
      WHERE channel IS NOT NULL
        AND created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
      GROUP BY channel
      ORDER BY count DESC
    `, [days]);

    return NextResponse.json({
      activity,
      tasksByDay,
      tasksByAgent,
      delegations,
      channelBreakdown,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch analytics" },
      { status: 500 }
    );
  }
}
