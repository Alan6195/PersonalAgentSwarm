/**
 * Travel State Persistence Service
 *
 * Manages the persistent state for the travel-agent. Stores itinerary,
 * hotel picks, activities, restaurants, transport, vetoes, and budget
 * in the travel_trips / travel_items / travel_vetoes tables.
 */

import { query, queryOne } from '../db';

// ----- Interfaces -----

export interface TravelTrip {
  id: number;
  trip_id: string;
  status: string;
  preferences: Record<string, unknown>;
  budget: TravelBudget;
  notes: string[];
  created_at: string;
  updated_at: string;
}

export interface TravelItem {
  id: number;
  trip_db_id: number;
  region: string;
  item_type: string;       // hotel, activity, restaurant, transport
  name: string;
  status: string;          // proposed, approved, booked, vetoed
  cost_eur: number | null;
  nightly_rate_eur: number | null;
  nights: number | null;
  cost_per_person_eur: number | null;
  booking_url: string | null;
  confirmation_number: string | null;
  day: string | null;
  time: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface TravelVeto {
  id: number;
  trip_db_id: number;
  item_type: string;
  region: string;
  name: string;
  reason: string;
  created_at: string;
}

export interface TravelBudget {
  hotels_total_eur: number;
  activities_total_eur: number;
  transport_total_eur: number;
  food_estimate_eur: number;
  grand_total_eur: number;
}

// ----- Trip CRUD -----

const DEFAULT_TRIP_ID = 'portugal-honeymoon-2026';

export async function getOrCreateTrip(tripId: string = DEFAULT_TRIP_ID): Promise<TravelTrip> {
  let trip = await queryOne<TravelTrip>(
    `SELECT * FROM travel_trips WHERE trip_id = $1`,
    [tripId]
  );

  if (!trip) {
    [trip] = await query<TravelTrip>(
      `INSERT INTO travel_trips (trip_id, status, preferences, budget, notes)
       VALUES ($1, 'planning', $2, $3, '[]')
       RETURNING *`,
      [
        tripId,
        JSON.stringify({
          hotel_style: 'boutique luxury',
          dietary: ['dairy-free', 'gluten-free'],
          budget_per_night_eur: [150, 400],
        }),
        JSON.stringify({
          hotels_total_eur: 0,
          activities_total_eur: 0,
          transport_total_eur: 0,
          food_estimate_eur: 0,
          grand_total_eur: 0,
        }),
      ]
    );
    console.log(`[TravelState] Created new trip: ${tripId}`);
  }

  // Parse JSONB fields if they come back as strings
  if (typeof trip.preferences === 'string') trip.preferences = JSON.parse(trip.preferences);
  if (typeof trip.budget === 'string') trip.budget = JSON.parse(trip.budget);
  if (typeof trip.notes === 'string') trip.notes = JSON.parse(trip.notes);

  return trip;
}

export async function updateTripStatus(tripId: string, status: string): Promise<void> {
  await query(
    `UPDATE travel_trips SET status = $1, updated_at = NOW() WHERE trip_id = $2`,
    [status, tripId]
  );
  console.log(`[TravelState] Trip ${tripId} status -> ${status}`);
}

export async function updateTripBudget(tripId: string, budget: TravelBudget): Promise<void> {
  await query(
    `UPDATE travel_trips SET budget = $1, updated_at = NOW() WHERE trip_id = $2`,
    [JSON.stringify(budget), tripId]
  );
}

export async function addTripNote(tripId: string, note: string): Promise<void> {
  await query(
    `UPDATE travel_trips SET notes = notes || $1::jsonb, updated_at = NOW() WHERE trip_id = $2`,
    [JSON.stringify([note]), tripId]
  );
}

// ----- Items (Hotels, Activities, Restaurants, Transport) -----

export async function setItem(
  tripDbId: number,
  region: string,
  itemType: string,
  name: string,
  data: Partial<TravelItem>
): Promise<TravelItem> {
  // Upsert: if same region + item_type + name exists, update it
  const existing = await queryOne<TravelItem>(
    `SELECT * FROM travel_items WHERE trip_db_id = $1 AND region = $2 AND item_type = $3 AND name = $4`,
    [tripDbId, region, itemType, name]
  );

  if (existing) {
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    const fields: Record<string, unknown> = {
      status: data.status,
      cost_eur: data.cost_eur,
      nightly_rate_eur: data.nightly_rate_eur,
      nights: data.nights,
      cost_per_person_eur: data.cost_per_person_eur,
      booking_url: data.booking_url,
      confirmation_number: data.confirmation_number,
      day: data.day,
      time: data.time,
      notes: data.notes,
      metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
    };

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        values.push(val);
      }
    }

    values.push(existing.id);
    const [updated] = await query<TravelItem>(
      `UPDATE travel_items SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    console.log(`[TravelState] Updated ${itemType} in ${region}: ${name}`);
    return updated;
  }

  // Insert new
  const [item] = await query<TravelItem>(
    `INSERT INTO travel_items (trip_db_id, region, item_type, name, status, cost_eur, nightly_rate_eur, nights, cost_per_person_eur, booking_url, confirmation_number, day, time, notes, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      tripDbId,
      region,
      itemType,
      name,
      data.status || 'proposed',
      data.cost_eur ?? null,
      data.nightly_rate_eur ?? null,
      data.nights ?? null,
      data.cost_per_person_eur ?? null,
      data.booking_url ?? null,
      data.confirmation_number ?? null,
      data.day ?? null,
      data.time ?? null,
      data.notes ?? null,
      data.metadata ? JSON.stringify(data.metadata) : '{}',
    ]
  );
  console.log(`[TravelState] Added ${itemType} in ${region}: ${name}`);
  return item;
}

export async function updateItemStatus(
  tripDbId: number,
  region: string,
  itemType: string,
  status: string,
  extra?: { confirmation_number?: string }
): Promise<void> {
  const setClauses = ['status = $1', 'updated_at = NOW()'];
  const values: unknown[] = [status];
  let idx = 2;

  if (extra?.confirmation_number) {
    setClauses.push(`confirmation_number = $${idx++}`);
    values.push(extra.confirmation_number);
  }

  values.push(tripDbId, region, itemType);
  await query(
    `UPDATE travel_items SET ${setClauses.join(', ')} WHERE trip_db_id = $${idx} AND region = $${idx + 1} AND item_type = $${idx + 2}`,
    values
  );
}

export async function getItems(tripDbId: number, region?: string, itemType?: string): Promise<TravelItem[]> {
  let sql = 'SELECT * FROM travel_items WHERE trip_db_id = $1';
  const params: unknown[] = [tripDbId];
  let idx = 2;

  if (region) {
    sql += ` AND region = $${idx++}`;
    params.push(region);
  }
  if (itemType) {
    sql += ` AND item_type = $${idx++}`;
    params.push(itemType);
  }

  sql += ' ORDER BY region, item_type, created_at';
  return query<TravelItem>(sql, params);
}

// ----- Vetoes -----

export async function addVeto(
  tripDbId: number,
  itemType: string,
  region: string,
  name: string,
  reason: string
): Promise<void> {
  await query(
    `INSERT INTO travel_vetoes (trip_db_id, item_type, region, name, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [tripDbId, itemType, region, name, reason]
  );

  // Also mark the item as vetoed if it exists
  await query(
    `UPDATE travel_items SET status = 'vetoed', updated_at = NOW()
     WHERE trip_db_id = $1 AND region = $2 AND item_type = $3 AND name = $4`,
    [tripDbId, region, itemType, name]
  );

  console.log(`[TravelState] Vetoed ${itemType} in ${region}: ${name} (${reason})`);
}

export async function getVetoes(tripDbId: number): Promise<TravelVeto[]> {
  return query<TravelVeto>(
    `SELECT * FROM travel_vetoes WHERE trip_db_id = $1 ORDER BY created_at`,
    [tripDbId]
  );
}

// ----- Context Builder for Agent Injection -----

export async function buildTravelContext(tripId: string = DEFAULT_TRIP_ID): Promise<string> {
  const trip = await getOrCreateTrip(tripId);
  const items = await getItems(trip.id);
  const vetoes = await getVetoes(trip.id);

  const sections: string[] = ['## TRAVEL_STATE_CONTEXT\n'];
  sections.push(`Trip: ${trip.trip_id} | Status: ${trip.status}`);

  // Preferences
  const prefs = trip.preferences as Record<string, unknown>;
  if (prefs) {
    sections.push(`\nPreferences: ${JSON.stringify(prefs)}`);
  }

  // Notes
  if (trip.notes && trip.notes.length > 0) {
    sections.push('\nNotes:');
    for (const note of trip.notes) {
      sections.push(`- ${note}`);
    }
  }

  // Budget
  const budget = trip.budget;
  sections.push('\n### Budget Summary');
  sections.push(`Hotels: EUR ${budget.hotels_total_eur}`);
  sections.push(`Activities: EUR ${budget.activities_total_eur}`);
  sections.push(`Transport: EUR ${budget.transport_total_eur}`);
  sections.push(`Food: EUR ${budget.food_estimate_eur}`);
  sections.push(`*Grand Total: EUR ${budget.grand_total_eur} (~$${Math.round(budget.grand_total_eur * 1.1)})*`);

  // Items by region
  const regionMap = new Map<string, TravelItem[]>();
  for (const item of items) {
    if (item.status === 'vetoed') continue;
    if (!regionMap.has(item.region)) regionMap.set(item.region, []);
    regionMap.get(item.region)!.push(item);
  }

  if (regionMap.size > 0) {
    sections.push('\n### Itinerary by Region');
    for (const [region, regionItems] of regionMap) {
      sections.push(`\n*${region.toUpperCase()}*`);
      for (const item of regionItems) {
        const costStr = item.cost_eur ? ` EUR ${item.cost_eur}` : '';
        const statusStr = item.status ? ` [${item.status}]` : '';
        const confirmStr = item.confirmation_number ? ` #${item.confirmation_number}` : '';
        sections.push(`- ${item.item_type}: ${item.name}${costStr}${statusStr}${confirmStr}${item.notes ? ` | ${item.notes}` : ''}`);
      }
    }
  } else {
    sections.push('\n(No itinerary items yet. Present your initial recommendation.)');
  }

  // Vetoes (CRITICAL: agent must never suggest these again)
  if (vetoes.length > 0) {
    sections.push('\n### VETOED ITEMS (DO NOT SUGGEST THESE)');
    for (const v of vetoes) {
      sections.push(`- ${v.item_type} in ${v.region}: ${v.name} (reason: ${v.reason})`);
    }
  }

  return sections.join('\n');
}
