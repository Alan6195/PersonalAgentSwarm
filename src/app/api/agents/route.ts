import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const agents = await query(`
      SELECT a.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.assigned_agent = a.id AND t.status IN ('pending', 'in_progress')) as active_tasks
      FROM agents a
      ORDER BY
        CASE WHEN a.id = 'alan-os' THEN 0 ELSE 1 END,
        a.name
    `);
    return NextResponse.json(agents);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch agents" },
      { status: 500 }
    );
  }
}
