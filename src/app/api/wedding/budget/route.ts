import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { category, item, estimated_cents, actual_cents, paid, status, vendor_id, due_date, notes } = body;

    if (!category || !item) {
      return NextResponse.json(
        { error: "category and item are required" },
        { status: 400 }
      );
    }

    const effectiveStatus = status || (paid ? "paid" : "budget");
    const effectivePaid = effectiveStatus === "paid" || paid || false;

    const [row] = await query(
      `INSERT INTO wedding_budget (category, item, estimated_cents, actual_cents, paid, status, vendor_id, due_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        category, item,
        estimated_cents || 0, actual_cents || 0, effectivePaid, effectiveStatus,
        vendor_id || null, due_date || null, notes || null,
      ]
    );

    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    console.error("Create budget item error:", error);
    return NextResponse.json(
      { error: "Failed to create budget item" },
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

    const allowedFields = [
      "category", "item", "estimated_cents", "actual_cents",
      "paid", "status", "vendor_id", "due_date", "notes",
    ];

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
      `UPDATE wedding_budget SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    return NextResponse.json(row);
  } catch (error) {
    console.error("Update budget item error:", error);
    return NextResponse.json(
      { error: "Failed to update budget item" },
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

    await query("DELETE FROM wedding_budget WHERE id = $1", [id]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete budget item error:", error);
    return NextResponse.json(
      { error: "Failed to delete budget item" },
      { status: 500 }
    );
  }
}
