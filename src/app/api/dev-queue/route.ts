import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const limit = parseInt(searchParams.get("limit") || "50", 10);

    let sql = `SELECT * FROM dev_queue`;
    const params: any[] = [];

    if (status) {
      sql += ` WHERE status = $1`;
      params.push(status);
    }

    sql += ` ORDER BY
      CASE status
        WHEN 'in_progress' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'completed' THEN 2
        WHEN 'failed' THEN 3
        WHEN 'cancelled' THEN 4
      END,
      priority DESC, created_at DESC
      LIMIT $${params.length + 1}`;
    params.push(limit);

    const items = await query(sql, params);

    return NextResponse.json(items);
  } catch (error) {
    console.error("[API] Dev queue error:", error);
    return NextResponse.json({ error: "Failed to fetch dev queue" }, { status: 500 });
  }
}
