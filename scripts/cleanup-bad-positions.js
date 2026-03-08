/**
 * One-time cleanup: sell/flag the 5 bad positions from the first buggy scan.
 * Run inside agent container: node scripts/cleanup-bad-positions.js
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://mc:mc@db:5432/mission_control',
});

async function cleanup() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, market_id, direction, question FROM market_positions WHERE status = 'open'`
    );
    console.log(`Found ${rows.length} open positions to close`);

    let closed = 0;
    let flagged = 0;

    for (const pos of rows) {
      try {
        const url = `https://api.manifold.markets/v0/market/${pos.market_id}/sell`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Key ${process.env.MANIFOLD_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ outcome: pos.direction }),
        });

        if (res.ok) {
          await client.query(
            `UPDATE market_positions
             SET status = 'cancelled', outcome = 'push', pnl = 0,
                 notes = 'scanner bug: wrong category/negative edge, sold early',
                 closed_at = NOW()
             WHERE id = $1`,
            [pos.id]
          );
          closed++;
          console.log(`Sold position #${pos.id}: ${pos.question.substring(0, 60)}`);
        } else {
          const errText = await res.text();
          console.log(`Sell failed for #${pos.id} (${res.status}): ${errText.substring(0, 100)}`);
          await client.query(
            `UPDATE market_positions
             SET notes = 'scanner bug: wrong category/negative edge, holding to resolution'
             WHERE id = $1`,
            [pos.id]
          );
          flagged++;
        }
      } catch (err) {
        console.log(`Error for #${pos.id}: ${err.message}`);
        await client.query(
          `UPDATE market_positions
           SET notes = 'scanner bug: wrong category/negative edge, holding to resolution'
           WHERE id = $1`,
          [pos.id]
        );
        flagged++;
      }
    }

    console.log(`\nDone. Closed: ${closed}, Flagged (holding to resolution): ${flagged}`);
  } finally {
    client.release();
    await pool.end();
  }
}

cleanup().catch(e => {
  console.error(e);
  process.exit(1);
});
