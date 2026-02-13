import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const jobs = await query(`
      SELECT c.*, a.name as agent_name, a.color as agent_color
      FROM cron_jobs c
      LEFT JOIN agents a ON c.agent_id = a.id
      ORDER BY c.enabled DESC, c.name
    `);

    return NextResponse.json(jobs);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch cron jobs" },
      { status: 500 }
    );
  }
}
