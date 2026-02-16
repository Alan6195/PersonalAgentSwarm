import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import ExcelJS from "exceljs";

export const dynamic = "force-dynamic";

const STATUS_MAP: Record<string, string> = {
  paid: "paid",
  partial: "partial",
  budget: "budget",
  pending: "pending",
  estimate: "budget",
};

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer as ExcelJS.Buffer);

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      return NextResponse.json(
        { error: "No worksheet found" },
        { status: 400 }
      );
    }

    // Detect header row by looking for "category" or "item" in first 5 rows
    let headerRow = 1;
    let colMap: Record<string, number> = {};

    for (let r = 1; r <= Math.min(5, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cells[colNumber] = String(cell.value || "").toLowerCase().trim();
      });

      // Look for recognizable header patterns
      const hasCategory = cells.some((c) => c === "category");
      const hasItem = cells.some((c) => c === "item");
      const hasAmount =
        cells.some((c) => c === "amount") ||
        cells.some((c) => c === "estimated");

      if (hasCategory || (hasItem && hasAmount)) {
        headerRow = r;
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const val = String(cell.value || "").toLowerCase().trim();
          if (val) colMap[val] = colNumber;
        });
        break;
      }
    }

    // If no header found, try first row as header anyway
    if (Object.keys(colMap).length === 0) {
      const row = sheet.getRow(1);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const val = String(cell.value || "").toLowerCase().trim();
        if (val) colMap[val] = colNumber;
      });
    }

    // Map flexible column names
    const catCol = colMap["category"];
    const itemCol = colMap["item"] || colMap["description"] || colMap["name"];
    const amountCol =
      colMap["amount"] || colMap["estimated"] || colMap["cost"] || colMap["price"];
    const actualCol = colMap["actual"] || colMap["actual cost"];
    const statusCol = colMap["status"];
    const notesCol = colMap["notes"] || colMap["note"] || colMap["comments"];

    if (!itemCol && !amountCol) {
      return NextResponse.json(
        {
          error:
            "Could not detect columns. Expected headers like: Category, Item, Amount, Status, Notes",
        },
        { status: 400 }
      );
    }

    // Get existing items for deduplication
    const existing = await query<any>("SELECT item FROM wedding_budget");
    const existingNames = new Set(
      existing.map((r: any) => r.item.toLowerCase().trim())
    );

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      try {
        const cellVal = (col: number | undefined) => {
          if (!col) return null;
          const cell = row.getCell(col);
          if (!cell || cell.value === null || cell.value === undefined)
            return null;
          return String(cell.value).trim();
        };

        const numVal = (col: number | undefined): number => {
          if (!col) return 0;
          const cell = row.getCell(col);
          if (!cell || cell.value === null || cell.value === undefined) return 0;
          const v = typeof cell.value === "number" ? cell.value : parseFloat(String(cell.value).replace(/[$,]/g, ""));
          return isNaN(v) ? 0 : v;
        };

        const itemName = cellVal(itemCol);
        if (!itemName || itemName.toLowerCase() === "total") continue;

        // Skip if already exists
        if (existingNames.has(itemName.toLowerCase())) {
          skipped++;
          continue;
        }

        const category = cellVal(catCol) || "other";
        const amount = numVal(amountCol);
        const actual = numVal(actualCol);
        const rawStatus = (cellVal(statusCol) || "budget").toLowerCase();
        const status = STATUS_MAP[rawStatus] || "budget";
        const notes = cellVal(notesCol) || null;

        await query(
          `INSERT INTO wedding_budget (category, item, estimated_cents, actual_cents, paid, status, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            category,
            itemName,
            Math.round(amount * 100),
            Math.round(actual * 100),
            status === "paid",
            status,
            notes,
          ]
        );

        existingNames.add(itemName.toLowerCase());
        imported++;
      } catch (err) {
        errors.push(`Row ${r}: ${(err as Error).message}`);
      }
    }

    return NextResponse.json({ imported, skipped, errors });
  } catch (error) {
    console.error("Budget import error:", error);
    return NextResponse.json(
      { error: "Failed to import budget" },
      { status: 500 }
    );
  }
}
