import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import ExcelJS from "exceljs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await query<any>(
      `SELECT b.*, v.name as vendor_name
       FROM wedding_budget b
       LEFT JOIN wedding_vendors v ON b.vendor_id = v.id
       ORDER BY b.category, b.item`
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Wedding Budget");

    sheet.columns = [
      { header: "Category", key: "category", width: 20 },
      { header: "Item", key: "item", width: 35 },
      { header: "Amount", key: "amount", width: 15 },
      { header: "Actual", key: "actual", width: 15 },
      { header: "Status", key: "status", width: 12 },
      { header: "Vendor", key: "vendor", width: 25 },
      { header: "Due Date", key: "due_date", width: 15 },
      { header: "Notes", key: "notes", width: 40 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE8E8E8" },
    };

    for (const row of rows) {
      sheet.addRow({
        category: row.category,
        item: row.item,
        amount: row.estimated_cents / 100,
        actual: row.actual_cents / 100,
        status: (row.status || (row.paid ? "paid" : "budget")).charAt(0).toUpperCase() +
                (row.status || (row.paid ? "paid" : "budget")).slice(1),
        vendor: row.vendor_name || "",
        due_date: row.due_date || "",
        notes: row.notes || "",
      });
    }

    // Currency formatting
    sheet.getColumn("amount").numFmt = "$#,##0.00";
    sheet.getColumn("actual").numFmt = "$#,##0.00";

    // Total row
    const lastDataRow = rows.length + 1;
    const totalRow = sheet.addRow({
      category: "",
      item: "TOTAL",
      amount: { formula: `SUM(C2:C${lastDataRow})` },
      actual: { formula: `SUM(D2:D${lastDataRow})` },
      status: "",
      vendor: "",
      due_date: "",
      notes: "",
    });
    totalRow.font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    const uint8 = new Uint8Array(buffer as ArrayBuffer);

    return new NextResponse(uint8, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="wedding-budget.xlsx"',
      },
    });
  } catch (error) {
    console.error("Budget export error:", error);
    return NextResponse.json(
      { error: "Failed to export budget" },
      { status: 500 }
    );
  }
}
