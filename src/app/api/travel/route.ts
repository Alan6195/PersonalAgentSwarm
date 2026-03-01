import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://agent:3001";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Helper: recalculate budget after status changes
async function recalculateBudget(tripDbId: number): Promise<void> {
  // Sum hotels
  const [hotelSum] = await query<any>(
    `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items
     WHERE trip_db_id = $1 AND item_type = 'hotel' AND status != 'vetoed'`,
    [tripDbId]
  );
  // Sum activities
  const [actSum] = await query<any>(
    `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items
     WHERE trip_db_id = $1 AND item_type = 'activity' AND status != 'vetoed'`,
    [tripDbId]
  );
  // Sum transport
  const [transSum] = await query<any>(
    `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items
     WHERE trip_db_id = $1 AND item_type = 'transport' AND status != 'vetoed'`,
    [tripDbId]
  );
  // Sum food (restaurants)
  const [foodSum] = await query<any>(
    `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items
     WHERE trip_db_id = $1 AND item_type = 'restaurant' AND status != 'vetoed'`,
    [tripDbId]
  );
  // Sum flights
  let flightsUsd = 0;
  let flightsPoints = 0;
  try {
    const [flightSum] = await query<any>(
      `SELECT COALESCE(SUM(price_usd), 0) as total_usd,
              COALESCE(SUM(points_cost), 0) as total_points
       FROM travel_flights
       WHERE trip_db_id = $1 AND status != 'cancelled'`,
      [tripDbId]
    );
    flightsUsd = Number(flightSum.total_usd);
    flightsPoints = Number(flightSum.total_points);
  } catch {
    // flights table may not exist
  }

  const hotels = Number(hotelSum.total);
  const activities = Number(actSum.total);
  const transport = Number(transSum.total);
  const food = Number(foodSum.total);
  const grand = hotels + activities + transport + food;

  await query(
    `UPDATE travel_trips SET budget = $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [
      JSON.stringify({
        hotels_total_eur: hotels,
        activities_total_eur: activities,
        transport_total_eur: transport,
        food_estimate_eur: food,
        grand_total_eur: grand,
        flights_total_usd: flightsUsd,
        flights_total_points: flightsPoints,
      }),
      tripDbId,
    ]
  );
}

// Helper: fire-and-forget notification to agent-service (echoes to Telegram)
function notifyAgent(message: string): void {
  if (!WEBHOOK_SECRET) return;
  const body = JSON.stringify({ message, notification: true });
  fetch(`${AGENT_SERVICE_URL}/api/webhooks/dashboard`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": WEBHOOK_SECRET,
    },
    body,
  }).catch((err) => {
    console.error("Agent notification error:", err);
  });
}

export async function GET() {
  try {
    // Get the trip
    const [trip] = await query<any>(
      `SELECT * FROM travel_trips WHERE trip_id = 'portugal-honeymoon-2026' LIMIT 1`
    );

    if (!trip) {
      return NextResponse.json({
        trip: null,
        items: [],
        vetoes: [],
        days: [],
        flights: [],
        messages: [],
      });
    }

    // Get all items (excluding vetoed)
    const items = await query<any>(
      `SELECT * FROM travel_items
       WHERE trip_db_id = $1 AND status != 'vetoed'
       ORDER BY region, item_type, created_at`,
      [trip.id]
    );

    // Get vetoes
    const vetoes = await query<any>(
      `SELECT * FROM travel_vetoes WHERE trip_db_id = $1 ORDER BY created_at`,
      [trip.id]
    );

    // Get flights with price history
    let flights: any[] = [];
    try {
      flights = await query<any>(
        `SELECT f.*,
          (SELECT json_agg(json_build_object(
            'price_usd', ph.price_usd,
            'points_cost', ph.points_cost,
            'source', ph.source,
            'checked_at', ph.checked_at
          ) ORDER BY ph.checked_at DESC)
          FROM travel_flight_price_history ph
          WHERE ph.flight_id = f.id) as price_history
        FROM travel_flights f
        WHERE f.trip_db_id = $1
        ORDER BY f.direction`,
        [trip.id]
      );
    } catch {
      // Table might not exist yet if migration hasn't run
      flights = [];
    }

    // Build day-by-day view
    const days = buildDayByDay(items);

    // Get recent dashboard messages
    let messages: any[] = [];
    try {
      messages = await query<any>(
        `SELECT * FROM dashboard_messages
         WHERE trip_db_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [trip.id]
      );
      // Reverse so oldest first (for chat display)
      messages.reverse();
    } catch {
      // Table might not exist yet
      messages = [];
    }

    // Parse JSONB fields
    const preferences =
      typeof trip.preferences === "string"
        ? JSON.parse(trip.preferences)
        : trip.preferences;
    const budget =
      typeof trip.budget === "string" ? JSON.parse(trip.budget) : trip.budget;
    const notes =
      typeof trip.notes === "string" ? JSON.parse(trip.notes) : trip.notes;

    return NextResponse.json({
      trip: {
        ...trip,
        preferences,
        budget,
        notes,
      },
      items,
      vetoes,
      days,
      flights,
      messages,
    });
  } catch (error) {
    console.error("Travel API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch travel data" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { id, action, reason } = body;

    if (!id || !action) {
      return NextResponse.json(
        { error: "id and action are required" },
        { status: 400 }
      );
    }

    if (!["approve", "veto"].includes(action)) {
      return NextResponse.json(
        { error: "action must be 'approve' or 'veto'" },
        { status: 400 }
      );
    }

    // Get the item first (need region, name, item_type for veto record)
    const [item] = await query<any>(
      `SELECT * FROM travel_items WHERE id = $1`,
      [id]
    );

    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    if (action === "approve") {
      // Update status to approved
      const [updated] = await query<any>(
        `UPDATE travel_items SET status = 'approved', updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id]
      );

      // Recalculate budget
      await recalculateBudget(item.trip_db_id);

      // Notify Telegram
      notifyAgent(
        `\u2705 *Dashboard:* Approved "${item.name}" (${item.item_type}) in ${item.region}`
      );

      return NextResponse.json(updated);
    }

    if (action === "veto") {
      // Update status to vetoed
      const [updated] = await query<any>(
        `UPDATE travel_items SET status = 'vetoed', updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id]
      );

      // Create veto record
      await query(
        `INSERT INTO travel_vetoes (trip_db_id, item_type, region, name, reason)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (trip_db_id, item_type, region, name) DO NOTHING`,
        [
          item.trip_db_id,
          item.item_type,
          item.region,
          item.name,
          reason || "Vetoed from dashboard",
        ]
      );

      // Recalculate budget
      await recalculateBudget(item.trip_db_id);

      // Notify Telegram
      notifyAgent(
        `\u274C *Dashboard:* Vetoed "${item.name}" (${item.item_type}) in ${item.region}${reason ? `: ${reason}` : ""}`
      );

      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Travel PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to update item" },
      { status: 500 }
    );
  }
}

interface DayEntry {
  date: string;
  dayNumber: number;
  region: string;
  hotel: any | null;
  activities: any[];
  restaurants: any[];
  transport: any | null;
  isCheckIn: boolean;
  isCheckOut: boolean;
}

function buildDayByDay(items: any[]): DayEntry[] {
  // Define the trip structure
  const regions = [
    { name: "porto", label: "Porto", start: "2026-07-17", end: "2026-07-20", nights: 3 },
    { name: "lisbon", label: "Lisbon", start: "2026-07-20", end: "2026-07-22", nights: 2 },
    { name: "alentejo", label: "Alentejo", start: "2026-07-22", end: "2026-07-23", nights: 1 },
    { name: "algarve", label: "Algarve", start: "2026-07-23", end: "2026-07-26", nights: 3 },
  ];

  // Build item lookup by region
  const itemsByRegion = new Map<string, any[]>();
  for (const item of items) {
    const region = item.region.toLowerCase();
    if (!itemsByRegion.has(region)) itemsByRegion.set(region, []);
    itemsByRegion.get(region)!.push(item);
  }

  const days: DayEntry[] = [];
  let dayNum = 1;

  for (const region of regions) {
    const regionItems = itemsByRegion.get(region.name) || [];
    const hotel = regionItems.find((i: any) => i.item_type === "hotel") || null;
    const activities = regionItems.filter((i: any) => i.item_type === "activity");
    const restaurants = regionItems.filter((i: any) => i.item_type === "restaurant");

    // Find transport TO this region (stored as "prev_to_current" region key)
    const transportItems = items.filter(
      (i: any) => i.item_type === "transport" && i.region.includes(`_to_${region.name}`)
    );

    const startDate = new Date(region.start);

    for (let n = 0; n < region.nights; n++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + n);
      const dateStr = date.toISOString().split("T")[0];

      // Activities for this specific day (if day field matches)
      const dayActivities = activities.filter((a: any) => {
        if (a.day) {
          const actDay = new Date(a.day).toISOString().split("T")[0];
          return actDay === dateStr;
        }
        return false;
      });

      // If no day-specific activities, spread them across days
      const fallbackActivities =
        dayActivities.length === 0 && n === 1
          ? activities.filter((a: any) => !a.day)
          : [];

      // Distribute restaurants: day-specific first, then spread evenly across region nights
      const dayRestaurants = restaurants.filter((r: any) => {
        if (r.day) {
          const rDay = new Date(r.day).toISOString().split("T")[0];
          return rDay === dateStr;
        }
        // If restaurant has a meal time (lunch/dinner) but no day, distribute by meal
        if (r.time && !r.day) {
          // Spread unassigned restaurants across days in the region
          const unassignedIdx = restaurants.filter((x: any) => !x.day).indexOf(r);
          return unassignedIdx % region.nights === n;
        }
        return false;
      });
      // Fallback: if no day-specific restaurants and it's the first day, show any unassigned ones
      const fallbackRestaurants =
        dayRestaurants.length === 0 && n === 0
          ? restaurants.filter((r: any) => !r.day && !r.time)
          : [];

      days.push({
        date: dateStr,
        dayNumber: dayNum,
        region: region.label,
        hotel: n === 0 ? hotel : null, // Show hotel on check-in day
        activities: dayActivities.length > 0 ? dayActivities : fallbackActivities,
        restaurants: dayRestaurants.length > 0 ? dayRestaurants : fallbackRestaurants,
        transport: n === 0 ? transportItems[0] || null : null, // Transport on arrival day
        isCheckIn: n === 0,
        isCheckOut: n === region.nights - 1,
      });

      dayNum++;
    }
  }

  return days;
}
