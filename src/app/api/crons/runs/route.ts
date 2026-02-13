import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("job_id");
    const limit = parseInt(searchParams.get("limit") || "50");

    let where = "";
    const params: any[] = [];

    if (jobId) {
      where = "WHERE cr.cron_job_id = $1";
      params.push(parseInt(jobId));
    }

    const runs = await query(
      `SELECT cr.*, cj.name as job_name
       FROM cron_runs cr
       LEFT JOIN cron_jobs cj ON cr.cron_job_id = cj.id
       ${where}
       ORDER BY cr.started_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    return NextResponse.json(runs);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch cron runs" },
      { status: 500 }
    );
  }
}
