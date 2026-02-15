import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, date, category, completed, vendor_id, notes } = body;

    if (!title || !date) {
      return NextResponse.json(
        { error: "title and date are required" },
        { status: 400 }
      );
    }

    const [row] = await query(
      `INSERT INTO wedding_timeline (title, date, category, completed, vendor_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, date, category || "milestone", completed || false, vendor_id || null, notes || null]
    );

    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    console.error("Create timeline item error:", error);
    return NextResponse.json(
      { error: "Failed to create timeline item" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { id, ...fields } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const setClauses: string[] = [];
    const values: any[] = [];
    let idx = 1;

    const allowedFields = ["title", "date", "category", "completed", "vendor_id", "notes"];

    for (const key of allowedFields) {
      if (key in fields) {
        setClauses.push(`${key} = $${idx++}`);
        values.push(fields[key]);
      }
    }

    if (setClauses.length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    values.push(id);

    const [row] = await query(
      `UPDATE wedding_timeline SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    return NextResponse.json(row);
  } catch (error) {
    console.error("Update timeline item error:", error);
    return NextResponse.json(
      { error: "Failed to update timeline item" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    await query("DELETE FROM wedding_timeline WHERE id = $1", [id]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete timeline item error:", error);
    return NextResponse.json(
      { error: "Failed to delete timeline item" },
      { status: 500 }
    );
  }
}
