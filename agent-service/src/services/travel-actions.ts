/**
 * Travel Actions Processor
 *
 * Parses [TRAVEL_DATA]...[/TRAVEL_DATA] blocks from travel-agent responses
 * and executes them against the travel state persistence layer.
 */

import * as travelState from './travel-state';

export interface TravelActionResult {
  actionsTaken: boolean;
  actions: string[];
  result: string;
  originalResponse: string;
}

export async function processTravelActions(
  agentResponse: string,
  taskId?: number
): Promise<TravelActionResult> {
  const blockRegex = /\[TRAVEL_DATA\]([\s\S]*?)\[\/TRAVEL_DATA\]/g;
  const blocks: { full: string; body: string }[] = [];
  let match;

  while ((match = blockRegex.exec(agentResponse)) !== null) {
    blocks.push({ full: match[0], body: match[1] });
  }

  if (blocks.length === 0) {
    return {
      actionsTaken: false,
      actions: [],
      result: agentResponse,
      originalResponse: agentResponse,
    };
  }

  const trip = await travelState.getOrCreateTrip();
  let modifiedResponse = agentResponse;
  const actions: string[] = [];

  for (const block of blocks) {
    const fields = parseFields(block.body);
    const action = fields.action || '';
    let replacement = '';

    try {
      switch (action) {
        case 'update_status': {
          const status = fields.status;
          if (!status) {
            replacement = '\n\n(Error: update_status requires status)';
            break;
          }
          await travelState.updateTripStatus(trip.trip_id, status);
          replacement = `\n\nTrip status updated to: ${status}`;
          actions.push(`update_status: ${status}`);
          break;
        }

        case 'set_hotel': {
          const region = fields.region;
          const hotelName = fields.hotel_name || fields.name;
          if (!region || !hotelName) {
            replacement = '\n\n(Error: set_hotel requires region and hotel_name)';
            break;
          }
          const metadata: Record<string, unknown> = {};
          if (fields.image_url) metadata.image_url = fields.image_url;
          if (fields.bed_type) metadata.bed_type = fields.bed_type;
          if (fields.description) metadata.description = fields.description;
          if (fields.honeymoon_package) metadata.honeymoon_package = fields.honeymoon_package;
          if (fields.stars) metadata.stars = fields.stars;

          const item = await travelState.setItem(trip.id, region, 'hotel', hotelName, {
            status: fields.status || 'proposed',
            nightly_rate_eur: fields.nightly_rate_eur ? parseFloat(fields.nightly_rate_eur) : (fields.price_per_night ? parseFloat(fields.price_per_night) : undefined),
            nights: fields.nights ? parseInt(fields.nights) : undefined,
            cost_eur: fields.total_eur ? parseFloat(fields.total_eur) : (fields.total ? parseFloat(fields.total) : undefined),
            booking_url: fields.booking_url || undefined,
            notes: fields.notes || undefined,
            gf_df_rating: fields.gf_df_rating || undefined,
            metadata,
          });
          replacement = `\n\nHotel set for ${region}: ${hotelName} [${item.status}]${item.cost_eur ? ` EUR ${item.cost_eur}` : ''}`;
          actions.push(`set_hotel: ${region} / ${hotelName}`);
          break;
        }

        case 'update_hotel': {
          const region = fields.region;
          if (!region) {
            replacement = '\n\n(Error: update_hotel requires region)';
            break;
          }
          // Only update status if explicitly provided; never auto-approve
          const newStatus = fields.status;
          if (newStatus) {
            await travelState.updateItemStatus(
              trip.id,
              region,
              'hotel',
              newStatus,
              { confirmation_number: fields.confirmation_number }
            );
            replacement = `\n\nHotel in ${region} updated to: ${newStatus}${fields.confirmation_number ? ` (conf: ${fields.confirmation_number})` : ''}`;
            actions.push(`update_hotel: ${region} -> ${newStatus}`);
          } else if (fields.confirmation_number) {
            // Just update confirmation number without changing status
            await travelState.updateItemStatus(
              trip.id,
              region,
              'hotel',
              'booked',
              { confirmation_number: fields.confirmation_number }
            );
            replacement = `\n\nHotel in ${region} booked (conf: ${fields.confirmation_number})`;
            actions.push(`update_hotel: ${region} -> booked`);
          } else {
            replacement = '\n\n(Error: update_hotel requires status or confirmation_number)';
          }
          break;
        }

        case 'add_activity': {
          const region = fields.region;
          const name = fields.name;
          if (!region || !name) {
            replacement = '\n\n(Error: add_activity requires region and name)';
            break;
          }
          const totalEur = fields.total_eur ? parseFloat(fields.total_eur) : undefined;
          const costPp = fields.cost_per_person_eur ? parseFloat(fields.cost_per_person_eur) : undefined;
          const actMeta: Record<string, unknown> = {};
          if (fields.image_url) actMeta.image_url = fields.image_url;
          if (fields.description) actMeta.description = fields.description;
          if (fields.duration) actMeta.duration = fields.duration;

          const item = await travelState.setItem(trip.id, region, 'activity', name, {
            status: fields.status || 'proposed',
            cost_eur: totalEur,
            cost_per_person_eur: costPp,
            price_per_person: fields.price_estimate_pp ? parseFloat(fields.price_estimate_pp) : costPp,
            booking_url: fields.booking_url || undefined,
            day: normalizeDay(fields.day),
            time: fields.time || undefined,
            notes: fields.notes || undefined,
            metadata: Object.keys(actMeta).length > 0 ? actMeta : undefined,
          });
          replacement = `\n\nActivity added for ${region}: ${name} [${item.status}]`;
          actions.push(`add_activity: ${region} / ${name}`);
          break;
        }

        case 'add_restaurant': {
          const region = fields.region;
          const name = fields.name;
          if (!region || !name) {
            replacement = '\n\n(Error: add_restaurant requires region and name)';
            break;
          }
          const restMeta: Record<string, unknown> = {};
          if (fields.price_range_eur) restMeta.price_range_eur = fields.price_range_eur;
          if (fields.gf_df_friendly) restMeta.gf_df_friendly = fields.gf_df_friendly === 'true';
          if (fields.reservation_needed) restMeta.reservation_needed = fields.reservation_needed === 'true' || fields.reservation_needed === 'yes';
          if (fields.reservation_advance) restMeta.reservation_advance = fields.reservation_advance;
          if (fields.address) restMeta.address = fields.address;

          const pricePp = fields.price_estimate_pp ? parseFloat(fields.price_estimate_pp) : undefined;

          const item = await travelState.setItem(trip.id, region, 'restaurant', name, {
            status: 'proposed',
            day: normalizeDay(fields.day),
            time: fields.meal || fields.time || undefined,
            notes: fields.notes || undefined,
            booking_url: fields.booking_url || undefined,
            gf_df_rating: fields.gf_df_rating || undefined,
            price_per_person: pricePp,
            metadata: restMeta,
          });
          const gfLabel = item.gf_df_rating ? ` [GF/DF: ${item.gf_df_rating}]` : '';
          replacement = `\n\nRestaurant added for ${region}: ${name}${gfLabel}`;
          actions.push(`add_restaurant: ${region} / ${name}`);
          break;
        }

        case 'set_transport': {
          const fromRegion = fields.from_region;
          const toRegion = fields.to_region;
          if (!fromRegion || !toRegion) {
            replacement = '\n\n(Error: set_transport requires from_region and to_region)';
            break;
          }
          const transportName = fields.method || `${fromRegion} to ${toRegion}`;
          const metadata: Record<string, unknown> = {};
          if (fields.duration) metadata.duration = fields.duration;
          if (fields.from_region) metadata.from_region = fromRegion;
          if (fields.to_region) metadata.to_region = toRegion;

          const item = await travelState.setItem(trip.id, `${fromRegion}_to_${toRegion}`, 'transport', transportName, {
            status: 'proposed',
            cost_eur: fields.cost_eur ? parseFloat(fields.cost_eur) : undefined,
            booking_url: fields.booking_url || undefined,
            notes: fields.notes || undefined,
            metadata,
          });
          replacement = `\n\nTransport: ${fromRegion} -> ${toRegion} via ${transportName}${item.cost_eur ? ` EUR ${item.cost_eur}` : ''}`;
          actions.push(`set_transport: ${fromRegion} -> ${toRegion}`);
          break;
        }

        case 'veto': {
          const type = fields.type;
          const region = fields.region;
          const name = fields.name;
          const reason = fields.reason || 'No reason given';
          if (!type || !region || !name) {
            replacement = '\n\n(Error: veto requires type, region, and name)';
            break;
          }
          await travelState.addVeto(trip.id, type, region, name, reason);
          replacement = `\n\nVetoed ${type} in ${region}: ${name} (${reason})`;
          actions.push(`veto: ${type} / ${name}`);
          break;
        }

        case 'add_note': {
          const note = fields.note;
          if (!note) {
            replacement = '\n\n(Error: add_note requires note)';
            break;
          }
          await travelState.addTripNote(trip.trip_id, note);
          replacement = `\n\nNote added: ${note}`;
          actions.push(`add_note: ${note.substring(0, 60)}`);
          break;
        }

        case 'update_budget': {
          const budget: travelState.TravelBudget = {
            hotels_total_eur: fields.hotels_total_eur ? parseFloat(fields.hotels_total_eur) : trip.budget.hotels_total_eur,
            activities_total_eur: fields.activities_total_eur ? parseFloat(fields.activities_total_eur) : trip.budget.activities_total_eur,
            transport_total_eur: fields.transport_total_eur ? parseFloat(fields.transport_total_eur) : trip.budget.transport_total_eur,
            food_estimate_eur: fields.food_estimate_eur ? parseFloat(fields.food_estimate_eur) : trip.budget.food_estimate_eur,
            flights_total_usd: fields.flights_total_usd ? parseFloat(fields.flights_total_usd) : (trip.budget.flights_total_usd || 0),
            flights_total_points: fields.flights_total_points ? parseInt(fields.flights_total_points) : (trip.budget.flights_total_points || 0),
            grand_total_eur: fields.grand_total_eur ? parseFloat(fields.grand_total_eur) : 0,
          };
          // Auto-calculate grand total if not provided
          if (!fields.grand_total_eur) {
            budget.grand_total_eur = budget.hotels_total_eur + budget.activities_total_eur + budget.transport_total_eur + budget.food_estimate_eur;
          }
          await travelState.updateTripBudget(trip.trip_id, budget);
          replacement = `\n\nBudget updated: EUR ${budget.grand_total_eur} (~$${Math.round(budget.grand_total_eur * 1.1)})`;
          actions.push(`update_budget: EUR ${budget.grand_total_eur}`);
          break;
        }

        case 'track_flight': {
          const direction = fields.direction;
          if (!direction) {
            replacement = '\n\n(Error: track_flight requires direction)';
            break;
          }
          const flight = await travelState.setFlight(trip.id, direction, {
            route: fields.route || undefined,
            departure_airport: fields.departure_airport || (direction === 'outbound' ? 'PDX' : 'FAO'),
            arrival_airport: fields.arrival_airport || (direction === 'outbound' ? 'OPO' : 'PDX'),
            departure_date: fields.date || fields.departure_date || undefined,
            airline: fields.airline || undefined,
            cabin_class: fields.cabin_class || 'economy',
            price_usd: fields.cash_price_pp ? parseFloat(fields.cash_price_pp) : (fields.price_usd ? parseFloat(fields.price_usd) : undefined),
            points_cost: fields.points_needed ? parseInt(fields.points_needed) : (fields.points_cost ? parseInt(fields.points_cost) : undefined),
            points_program: fields.points_option || fields.points_program || undefined,
            cpp_value: fields.cpp_value ? parseFloat(fields.cpp_value) : undefined,
            notes: fields.notes || undefined,
          });
          // Log price check
          if (flight.id && (fields.cash_price_pp || fields.price_usd || fields.points_needed || fields.points_cost)) {
            await travelState.addFlightPriceCheck(
              flight.id,
              fields.cash_price_pp ? parseFloat(fields.cash_price_pp) : (fields.price_usd ? parseFloat(fields.price_usd) : null),
              fields.points_needed ? parseInt(fields.points_needed) : (fields.points_cost ? parseInt(fields.points_cost) : null),
              'agent_search'
            );
          }
          const depAirport = fields.departure_airport || (direction === 'outbound' ? 'PDX' : 'FAO');
          const arrAirport = fields.arrival_airport || (direction === 'outbound' ? 'OPO' : 'PDX');
          replacement = `\n\nFlight tracked: ${direction} ${depAirport} -> ${arrAirport}${fields.airline ? ` (${fields.airline})` : ''}${fields.cash_price_pp ? ` $${fields.cash_price_pp}/pp` : ''}`;
          actions.push(`track_flight: ${direction}`);
          break;
        }

        case 'book_flight': {
          const direction = fields.direction;
          if (!direction) {
            replacement = '\n\n(Error: book_flight requires direction)';
            break;
          }
          const flights = await travelState.getFlights(trip.id);
          const target = flights.find(f => f.direction === direction);
          if (!target) {
            replacement = `\n\n(Error: no tracked flight found for direction: ${direction}. Use track_flight first.)`;
            break;
          }
          await travelState.updateFlightStatus(target.id, 'booked', {
            confirmation_number: fields.confirmation_number || undefined,
            booked_via: fields.strategy || fields.booked_via || undefined,
            booking_url: fields.booking_url || undefined,
          });
          replacement = `\n\nFlight booked: ${direction} (conf: ${fields.confirmation_number || 'pending'})`;
          actions.push(`book_flight: ${direction}`);
          break;
        }

        case 'get_state': {
          const context = await travelState.buildTravelContext(trip.trip_id);
          replacement = `\n\n${context}`;
          actions.push('get_state');
          break;
        }

        default:
          replacement = `\n\n(Unknown travel action: ${action})`;
      }
      // Auto-recalculate budget after cost-impacting actions
      const costActions = ['set_hotel', 'add_activity', 'add_restaurant', 'set_transport', 'track_flight', 'book_flight'];
      if (costActions.includes(action)) {
        try {
          await travelState.recalculateBudget(trip.id);
        } catch (budgetErr) {
          console.error(`[TravelActions] Budget recalculation failed:`, (budgetErr as Error).message);
        }
      }
    } catch (err) {
      replacement = `\n\n(Travel action "${action}" failed: ${(err as Error).message})`;
      console.error(`[TravelActions] Action "${action}" failed:`, (err as Error).message);
    }

    modifiedResponse = modifiedResponse.replace(block.full, replacement);
  }

  return {
    actionsTaken: actions.length > 0,
    actions,
    result: modifiedResponse.trim(),
    originalResponse: agentResponse,
  };
}

/**
 * Normalize a day value to a full ISO date (YYYY-MM-DD).
 * The agent sometimes outputs just a day number (e.g., "17") or
 * a partial date (e.g., "July 17") instead of "2026-07-17".
 * This normalizes all variations to the trip's date range.
 */
function normalizeDay(dayValue: string | undefined): string | undefined {
  if (!dayValue) return undefined;

  // Already a full ISO date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dayValue)) return dayValue;

  // Just a number (e.g., "17", "18", "25")
  const dayNum = parseInt(dayValue, 10);
  if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
    // Trip is July 17-26, 2026. If day <= 26, it's July; otherwise something's off.
    const month = dayNum >= 17 && dayNum <= 31 ? '07' : '07'; // Always July for this trip
    return `2026-${month}-${String(dayNum).padStart(2, '0')}`;
  }

  // Handle "Jul 17" or "July 17" or "Jul 17, 2026" patterns
  const monthMatch = dayValue.match(/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/i);
  if (monthMatch) {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const monthStr = dayValue.substring(0, 3).toLowerCase();
    const monthNum = months[monthStr] || '07';
    const day = String(parseInt(monthMatch[1], 10)).padStart(2, '0');
    return `2026-${monthNum}-${day}`;
  }

  // Fallback: return as-is and let PostgreSQL handle it (may fail)
  return dayValue;
}

// Parse key: value fields from a block body
function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = body.trim().split('\n');

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();
    if (key) fields[key] = value;
  }

  return fields;
}
