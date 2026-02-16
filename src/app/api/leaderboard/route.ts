import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const agents = await query(
      `SELECT
        id, name, description, model, color, status,
        COALESCE(xp, 0) as xp,
        COALESCE(level, 1) as level,
        COALESCE(level_title, 'Intern') as level_title,
        COALESCE(streak, 0) as streak,
        COALESCE(best_streak, 0) as best_streak,
        total_tasks,
        total_cost_cents,
        last_active_at
       FROM agents
       ORDER BY COALESCE(xp, 0) DESC`
    );

    return NextResponse.json(agents);
  } catch (error) {
    console.error("[API] Leaderboard error:", error);
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
  }
}
