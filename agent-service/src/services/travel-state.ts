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
  gf_df_rating: string | null;        // green, yellow, orange, red
  price_per_person: number | null;
  created_at: string;
}

export interface TravelFlight {
  id: number;
  trip_db_id: number;
  direction: string;       // outbound, return
  route: string | null;
  departure_airport: string;
  arrival_airport: string;
  departure_date: string | null;
  airline: string | null;
  cabin_class: string;
  price_usd: number | null;
  points_cost: number | null;
  points_program: string | null;
  cpp_value: number | null;
  status: string;          // tracking, price_alert, booked, cancelled
  booked_via: string | null;
  confirmation_number: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TravelFlightPriceHistory {
  id: number;
  flight_id: number;
  price_usd: number | null;
  points_cost: number | null;
  source: string | null;
  checked_at: string;
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
  flights_total_usd: number;
  flights_total_points: number;
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
          flights_total_usd: 0,
          flights_total_points: 0,
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
      gf_df_rating: data.gf_df_rating,
      price_per_person: data.price_per_person,
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
    `INSERT INTO travel_items (trip_db_id, region, item_type, name, status, cost_eur, nightly_rate_eur, nights, cost_per_person_eur, booking_url, confirmation_number, day, time, notes, metadata, gf_df_rating, price_per_person)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
      data.gf_df_rating ?? null,
      data.price_per_person ?? null,
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

// ----- Flights -----

export async function setFlight(
  tripDbId: number,
  direction: string,
  data: Partial<TravelFlight>
): Promise<TravelFlight> {
  // Upsert by trip + direction
  const existing = await queryOne<TravelFlight>(
    `SELECT * FROM travel_flights WHERE trip_db_id = $1 AND direction = $2`,
    [tripDbId, direction]
  );

  if (existing) {
    const [updated] = await query<TravelFlight>(
      `UPDATE travel_flights SET
        route = COALESCE($1, route),
        departure_airport = COALESCE($2, departure_airport),
        arrival_airport = COALESCE($3, arrival_airport),
        departure_date = COALESCE($4, departure_date),
        airline = COALESCE($5, airline),
        cabin_class = COALESCE($6, cabin_class),
        price_usd = COALESCE($7, price_usd),
        points_cost = COALESCE($8, points_cost),
        points_program = COALESCE($9, points_program),
        cpp_value = COALESCE($10, cpp_value),
        status = COALESCE($11, status),
        booked_via = COALESCE($12, booked_via),
        notes = COALESCE($13, notes),
        metadata = COALESCE($14, metadata),
        updated_at = NOW()
       WHERE id = $15
       RETURNING *`,
      [
        data.route ?? null,
        data.departure_airport ?? null,
        data.arrival_airport ?? null,
        data.departure_date ?? null,
        data.airline ?? null,
        data.cabin_class ?? null,
        data.price_usd ?? null,
        data.points_cost ?? null,
        data.points_program ?? null,
        data.cpp_value ?? null,
        data.status ?? null,
        data.booked_via ?? null,
        data.notes ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        existing.id,
      ]
    );
    console.log(`[TravelState] Updated flight: ${direction}`);
    return updated;
  }

  const [flight] = await query<TravelFlight>(
    `INSERT INTO travel_flights (trip_db_id, direction, route, departure_airport, arrival_airport, departure_date, airline, cabin_class, price_usd, points_cost, points_program, cpp_value, status, booked_via, notes, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      tripDbId,
      direction,
      data.route ?? null,
      data.departure_airport || 'PDX',
      data.arrival_airport || (direction === 'outbound' ? 'OPO' : 'PDX'),
      data.departure_date ?? null,
      data.airline ?? null,
      data.cabin_class || 'economy',
      data.price_usd ?? null,
      data.points_cost ?? null,
      data.points_program ?? null,
      data.cpp_value ?? null,
      data.status || 'tracking',
      data.booked_via ?? null,
      data.notes ?? null,
      data.metadata ? JSON.stringify(data.metadata) : '{}',
    ]
  );
  console.log(`[TravelState] Added flight: ${direction} ${data.departure_airport || 'PDX'} -> ${data.arrival_airport}`);
  return flight;
}

export async function getFlights(tripDbId: number): Promise<TravelFlight[]> {
  return query<TravelFlight>(
    `SELECT * FROM travel_flights WHERE trip_db_id = $1 ORDER BY direction`,
    [tripDbId]
  );
}

export async function addFlightPriceCheck(
  flightId: number,
  priceUsd: number | null,
  pointsCost: number | null,
  source: string
): Promise<void> {
  await query(
    `INSERT INTO travel_flight_price_history (flight_id, price_usd, points_cost, source)
     VALUES ($1, $2, $3, $4)`,
    [flightId, priceUsd, pointsCost, source]
  );
  console.log(`[TravelState] Logged price check for flight #${flightId}: $${priceUsd} / ${pointsCost} pts`);
}

export async function getFlightPriceHistory(
  flightId: number,
  limit: number = 10
): Promise<TravelFlightPriceHistory[]> {
  return query<TravelFlightPriceHistory>(
    `SELECT * FROM travel_flight_price_history WHERE flight_id = $1 ORDER BY checked_at DESC LIMIT $2`,
    [flightId, limit]
  );
}

export async function updateFlightStatus(
  flightId: number,
  status: string,
  extra?: { confirmation_number?: string; booked_via?: string; booking_url?: string }
): Promise<void> {
  const setClauses = ['status = $1', 'updated_at = NOW()'];
  const values: unknown[] = [status];
  let idx = 2;

  if (extra?.confirmation_number) {
    setClauses.push(`confirmation_number = $${idx++}`);
    values.push(extra.confirmation_number);
  }
  if (extra?.booked_via) {
    setClauses.push(`booked_via = $${idx++}`);
    values.push(extra.booked_via);
  }
  if (extra?.booking_url) {
    setClauses.push(`booking_url = $${idx++}`);
    values.push(extra.booking_url);
  }

  values.push(flightId);
  await query(
    `UPDATE travel_flights SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    values
  );
  console.log(`[TravelState] Flight #${flightId} status -> ${status}`);
}

// ----- Budget Auto-Recalculation -----

export async function recalculateBudget(tripDbId: number): Promise<TravelBudget> {
  // Sum costs from all non-vetoed items by category
  const hotelResult = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items
     WHERE trip_db_id = $1 AND item_type = 'hotel' AND status != 'vetoed'`,
    [tripDbId]
  );
  const activityResult = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(COALESCE(cost_eur, cost_per_person_eur * 2)), 0) as total FROM travel_items
     WHERE trip_db_id = $1 AND item_type = 'activity' AND status != 'vetoed'`,
    [tripDbId]
  );
  const transportResult = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(cost_eur), 0) as total FROM travel_items
     WHERE trip_db_id = $1 AND item_type = 'transport' AND status != 'vetoed'`,
    [tripDbId]
  );
  const foodResult = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(COALESCE(cost_eur, price_per_person * 2)), 0) as total FROM travel_items
     WHERE trip_db_id = $1 AND item_type = 'restaurant' AND status != 'vetoed'`,
    [tripDbId]
  );

  // Flight costs (USD + points)
  const flightCashResult = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(price_usd * 2), 0) as total FROM travel_flights
     WHERE trip_db_id = $1 AND status != 'cancelled'`,
    [tripDbId]
  );
  const flightPointsResult = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(points_cost), 0) as total FROM travel_flights
     WHERE trip_db_id = $1 AND status != 'cancelled'`,
    [tripDbId]
  );

  const hotels = parseFloat(hotelResult?.total || '0');
  const activities = parseFloat(activityResult?.total || '0');
  const transport = parseFloat(transportResult?.total || '0');
  const food = parseFloat(foodResult?.total || '0');
  const flightsUsd = parseFloat(flightCashResult?.total || '0');
  const flightsPoints = parseInt(flightPointsResult?.total || '0', 10);

  const budget: TravelBudget = {
    hotels_total_eur: Math.round(hotels * 100) / 100,
    activities_total_eur: Math.round(activities * 100) / 100,
    transport_total_eur: Math.round(transport * 100) / 100,
    food_estimate_eur: Math.round(food * 100) / 100,
    flights_total_usd: Math.round(flightsUsd * 100) / 100,
    flights_total_points: flightsPoints,
    grand_total_eur: Math.round((hotels + activities + transport + food) * 100) / 100,
  };

  // Get trip_id for update
  const trip = await queryOne<{ trip_id: string }>(
    `SELECT trip_id FROM travel_trips WHERE id = $1`,
    [tripDbId]
  );
  if (trip) {
    await updateTripBudget(trip.trip_id, budget);
  }

  console.log(`[TravelState] Budget recalculated: EUR ${budget.grand_total_eur} + $${budget.flights_total_usd} (${budget.flights_total_points} pts)`);
  return budget;
}

// ----- Context Builder for Agent Injection -----

const GF_DF_LABELS: Record<string, string> = {
  green: 'SAFE',
  yellow: 'GOOD',
  orange: 'CAUTION',
  red: 'AVOID',
};

export async function buildTravelContext(tripId: string = DEFAULT_TRIP_ID): Promise<string> {
  const trip = await getOrCreateTrip(tripId);
  const items = await getItems(trip.id);
  const vetoes = await getVetoes(trip.id);
  const flights = await getFlights(trip.id);

  const sections: string[] = [];
  sections.push('=== HONEYMOON PLANNING STATE ===\n');
  sections.push(`Trip: ${trip.trip_id} | Status: ${trip.status}`);

  // ----- Hotels -----
  const hotels = items.filter(i => i.item_type === 'hotel' && i.status !== 'vetoed');
  const regionOrder = ['porto', 'douro', 'lisbon', 'comporta', 'alentejo', 'algarve'];
  const confirmedRegions = new Set(hotels.map(h => h.region.toLowerCase()));
  const hotelCount = confirmedRegions.size;

  sections.push(`\n## Hotels (${hotelCount}/4 regions)`);
  for (const region of regionOrder) {
    const regionHotels = hotels.filter(h => h.region.toLowerCase() === region);
    if (regionHotels.length > 0) {
      for (const h of regionHotels) {
        const rate = h.nightly_rate_eur ? `EUR ${h.nightly_rate_eur}/night` : '';
        const total = h.cost_eur ? ` = EUR ${h.cost_eur} total` : '';
        const nights = h.nights ? ` x ${h.nights}n` : '';
        const gfdf = h.gf_df_rating ? ` | GF/DF: ${GF_DF_LABELS[h.gf_df_rating] || h.gf_df_rating}` : '';
        const confirm = h.confirmation_number ? ` | Conf: ${h.confirmation_number}` : '';
        sections.push(`- ${region}: ${h.name} [${h.status}] ${rate}${nights}${total}${gfdf}${confirm}`);
      }
    } else if (['porto', 'lisbon', 'algarve'].includes(region) || (region === 'comporta' || region === 'alentejo')) {
      sections.push(`- ${region}: NOT SELECTED`);
    }
  }

  // ----- Restaurants -----
  const restaurants = items.filter(i => i.item_type === 'restaurant' && i.status !== 'vetoed');
  sections.push(`\n## Restaurants (${restaurants.length} planned)`);
  if (restaurants.length > 0) {
    for (const r of restaurants) {
      const gfdf = r.gf_df_rating ? ` [GF/DF: ${GF_DF_LABELS[r.gf_df_rating] || r.gf_df_rating}]` : '';
      const price = r.price_per_person ? ` EUR ${r.price_per_person}/pp` : '';
      const day = r.day ? ` | Day: ${r.day}` : '';
      const meal = r.time ? ` (${r.time})` : '';
      sections.push(`- ${r.region}: ${r.name}${gfdf}${price}${meal}${day}${r.notes ? ` | ${r.notes}` : ''}`);
    }
  } else {
    sections.push('(No restaurants planned yet)');
  }

  // ----- Activities -----
  const activities = items.filter(i => i.item_type === 'activity' && i.status !== 'vetoed');
  sections.push(`\n## Activities (${activities.length} planned)`);
  if (activities.length > 0) {
    for (const a of activities) {
      const cost = a.cost_eur ? ` EUR ${a.cost_eur}` : (a.cost_per_person_eur ? ` EUR ${a.cost_per_person_eur}/pp` : '');
      const day = a.day ? ` | Day: ${a.day}` : '';
      const time = a.time ? ` (${a.time})` : '';
      sections.push(`- ${a.region}: ${a.name}${cost}${time}${day} [${a.status}]`);
    }
  } else {
    sections.push('(No activities planned yet)');
  }

  // ----- Transport -----
  const transports = items.filter(i => i.item_type === 'transport' && i.status !== 'vetoed');
  sections.push(`\n## Transport`);
  if (transports.length > 0) {
    for (const t of transports) {
      const cost = t.cost_eur ? ` EUR ${t.cost_eur}` : '';
      const meta = t.metadata as Record<string, unknown>;
      const method = meta?.method || '';
      sections.push(`- ${t.region}: ${t.name}${method ? ` (${method})` : ''}${cost}${t.notes ? ` | ${t.notes}` : ''}`);
    }
  } else {
    sections.push('(No transport planned yet)');
  }

  // ----- Flights -----
  sections.push('\n## Flights');
  sections.push('Points Budget: 100,000 Chase UR');
  if (flights.length > 0) {
    let totalPointsUsed = 0;
    for (const f of flights) {
      const price = f.price_usd ? `$${f.price_usd}/pp cash` : '';
      const points = f.points_cost ? `${f.points_cost.toLocaleString()} pts` : '';
      const cpp = f.cpp_value ? ` (${f.cpp_value} cpp)` : '';
      const program = f.points_program ? ` via ${f.points_program}` : '';
      const conf = f.confirmation_number ? ` | Conf: ${f.confirmation_number}` : '';
      sections.push(`\n### ${f.direction.charAt(0).toUpperCase() + f.direction.slice(1)} (${f.status})`);
      sections.push(`Route: ${f.route || `${f.departure_airport} -> ${f.arrival_airport}`}`);
      if (f.airline) sections.push(`Airline: ${f.airline}`);
      if (f.departure_date) sections.push(`Date: ${f.departure_date}`);
      if (price || points) sections.push(`Price: ${[price, points].filter(Boolean).join(' | ')}${cpp}${program}`);
      if (f.confirmation_number) sections.push(`Confirmation: ${f.confirmation_number}`);
      if (f.notes) sections.push(`Notes: ${f.notes}`);
      if (f.points_cost) totalPointsUsed += f.points_cost;
    }
    sections.push(`\nPoints Used: ${totalPointsUsed.toLocaleString()} / 100,000 (${(100000 - totalPointsUsed).toLocaleString()} remaining)`);
  } else {
    sections.push('Outbound (PDX -> OPO, Jul 17): Not tracked');
    sections.push('Return (FAO -> PDX, Jul 26): Not tracked');
  }

  // ----- Budget -----
  const budget = trip.budget;
  sections.push('\n## Budget Summary');
  sections.push(`Hotels: EUR ${budget.hotels_total_eur}`);
  sections.push(`Activities: EUR ${budget.activities_total_eur}`);
  sections.push(`Transport: EUR ${budget.transport_total_eur}`);
  sections.push(`Food: EUR ${budget.food_estimate_eur}`);
  sections.push(`Flights: $${budget.flights_total_usd || 0} + ${(budget.flights_total_points || 0).toLocaleString()} pts`);
  sections.push(`**Grand Total (excl. flights): EUR ${budget.grand_total_eur} (~$${Math.round(budget.grand_total_eur * 1.1)})**`);
  sections.push(`Target: EUR 4,000-6,500`);

  // ----- Notes -----
  if (trip.notes && trip.notes.length > 0) {
    sections.push('\n## Notes');
    for (const note of trip.notes) {
      sections.push(`- ${note}`);
    }
  }

  // ----- Vetoes -----
  if (vetoes.length > 0) {
    sections.push('\n## VETOED ITEMS (DO NOT SUGGEST THESE)');
    for (const v of vetoes) {
      sections.push(`- ${v.item_type} in ${v.region}: ${v.name} (reason: ${v.reason})`);
    }
  }

  sections.push('\n=== END PLANNING STATE ===');

  return sections.join('\n');
}
