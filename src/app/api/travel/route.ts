import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

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

    // Build day-by-day view
    const days = buildDayByDay(items);

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
    });
  } catch (error) {
    console.error("Travel API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch travel data" },
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

      days.push({
        date: dateStr,
        dayNumber: dayNum,
        region: region.label,
        hotel: n === 0 ? hotel : null, // Show hotel on check-in day
        activities: dayActivities.length > 0 ? dayActivities : fallbackActivities,
        restaurants: n === 0 ? restaurants : [], // Show restaurants on first day of region
        transport: n === 0 ? transportItems[0] || null : null, // Transport on arrival day
        isCheckIn: n === 0,
        isCheckOut: n === region.nights - 1,
      });

      dayNum++;
    }
  }

  return days;
}
