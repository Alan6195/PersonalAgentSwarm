/**
 * Fix: Reset falsely auto-approved items back to "proposed"
 *
 * The update_hotel action had a bug where it defaulted to "approved"
 * when no status was specified. This resets all "approved" items
 * (that were never explicitly approved by the user) back to "proposed".
 *
 * Run: node scripts/fix-approved-items.js
 * Or via Docker: docker compose exec db psql -U mc -d mission_control -c "UPDATE travel_items SET status = 'proposed' WHERE status = 'approved';"
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://localhost:5432/mission_control",
});

async function fix() {
  const client = await pool.connect();
  try {
    // Show current status distribution
    const before = await client.query(`
      SELECT status, COUNT(*) as count
      FROM travel_items
      GROUP BY status
      ORDER BY status
    `);
    console.log("\n[Fix] Current item statuses:");
    for (const row of before.rows) {
      console.log(`  ${row.status}: ${row.count}`);
    }

    // Reset approved -> proposed (none were legitimately user-approved)
    const result = await client.query(`
      UPDATE travel_items
      SET status = 'proposed', updated_at = NOW()
      WHERE status = 'approved'
      RETURNING id, name, region, item_type
    `);

    console.log(`\n[Fix] Reset ${result.rowCount} items from "approved" to "proposed":`);
    for (const row of result.rows) {
      console.log(`  - ${row.name} (${row.item_type} in ${row.region})`);
    }

    // Recalculate budget
    const [trip] = (await client.query(
      `SELECT id FROM travel_trips WHERE trip_id = 'portugal-honeymoon-2026' LIMIT 1`
    )).rows;

    if (trip) {
      const [hotelSum] = (await client.query(
        `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items WHERE trip_db_id = $1 AND item_type = 'hotel' AND status != 'vetoed'`,
        [trip.id]
      )).rows;
      const [actSum] = (await client.query(
        `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items WHERE trip_db_id = $1 AND item_type = 'activity' AND status != 'vetoed'`,
        [trip.id]
      )).rows;
      const [transSum] = (await client.query(
        `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items WHERE trip_db_id = $1 AND item_type = 'transport' AND status != 'vetoed'`,
        [trip.id]
      )).rows;
      const [foodSum] = (await client.query(
        `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items WHERE trip_db_id = $1 AND item_type = 'restaurant' AND status != 'vetoed'`,
        [trip.id]
      )).rows;

      const hotels = Number(hotelSum.total);
      const activities = Number(actSum.total);
      const transport = Number(transSum.total);
      const food = Number(foodSum.total);
      const grand = hotels + activities + transport + food;

      await client.query(
        `UPDATE travel_trips SET budget = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({
          hotels_total_eur: hotels,
          activities_total_eur: activities,
          transport_total_eur: transport,
          food_estimate_eur: food,
          grand_total_eur: grand,
        }), trip.id]
      );
      console.log(`\n[Fix] Budget recalculated: EUR ${grand} total`);
    }

    // Show final state
    const after = await client.query(`
      SELECT status, COUNT(*) as count
      FROM travel_items
      GROUP BY status
      ORDER BY status
    `);
    console.log("\n[Fix] Updated item statuses:");
    for (const row of after.rows) {
      console.log(`  ${row.status}: ${row.count}`);
    }

    console.log("\n[Fix] Done. All items are now 'proposed' and ready for user review.");
  } catch (err) {
    console.error("[Fix] Error:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

fix();
