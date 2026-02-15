import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      name, category, contact_name, email, phone,
      status, cost_estimate, cost_actual, notes,
      next_action, next_action_date,
    } = body;

    if (!name || !category) {
      return NextResponse.json(
        { error: "name and category are required" },
        { status: 400 }
      );
    }

    const [vendor] = await query(
      `INSERT INTO wedding_vendors
        (name, category, contact_name, email, phone, status, cost_estimate, cost_actual, notes, next_action, next_action_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        name, category, contact_name || null, email || null, phone || null,
        status || "researching", cost_estimate || null, cost_actual || null,
        notes || null, next_action || null, next_action_date || null,
      ]
    );

    return NextResponse.json(vendor, { status: 201 });
  } catch (error) {
    console.error("Create vendor error:", error);
    return NextResponse.json(
      { error: "Failed to create vendor" },
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
      "name", "category", "contact_name", "email", "phone",
      "status", "cost_estimate", "cost_actual", "notes",
      "next_action", "next_action_date",
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

    setClauses.push(`updated_at = NOW()`);
    values.push(id);

    const [vendor] = await query(
      `UPDATE wedding_vendors SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    return NextResponse.json(vendor);
  } catch (error) {
    console.error("Update vendor error:", error);
    return NextResponse.json(
      { error: "Failed to update vendor" },
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

    await query("DELETE FROM wedding_vendors WHERE id = $1", [id]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete vendor error:", error);
    return NextResponse.json(
      { error: "Failed to delete vendor" },
      { status: 500 }
    );
  }
}
