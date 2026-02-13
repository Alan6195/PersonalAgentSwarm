import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const agent = searchParams.get("agent");
    const priority = searchParams.get("priority");
    const limit = parseInt(searchParams.get("limit") || "50");

    let where = "WHERE 1=1";
    const params: any[] = [];
    let paramIdx = 1;

    if (status) {
      where += ` AND t.status = $${paramIdx++}`;
      params.push(status);
    }
    if (agent) {
      where += ` AND t.assigned_agent = $${paramIdx++}`;
      params.push(agent);
    }
    if (priority) {
      where += ` AND t.priority = $${paramIdx++}`;
      params.push(priority);
    }

    const tasks = await query(
      `SELECT t.*, a.name as agent_name, a.color as agent_color
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent = a.id
       ${where}
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         t.created_at DESC
       LIMIT $${paramIdx}`,
      [...params, limit]
    );

    return NextResponse.json(tasks);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch tasks" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, description, priority, domain, assigned_agent } = body;

    const [task] = await query(
      `INSERT INTO tasks (title, description, priority, domain, assigned_agent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title, description, priority || "normal", domain, assigned_agent]
    );

    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to create task" },
      { status: 500 }
    );
  }
}
