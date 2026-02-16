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
            nightly_rate_eur: fields.nightly_rate_eur ? parseFloat(fields.nightly_rate_eur) : undefined,
            nights: fields.nights ? parseInt(fields.nights) : undefined,
            cost_eur: fields.total_eur ? parseFloat(fields.total_eur) : undefined,
            booking_url: fields.booking_url || undefined,
            notes: fields.notes || undefined,
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
          await travelState.updateItemStatus(
            trip.id,
            region,
            'hotel',
            fields.status || 'approved',
            { confirmation_number: fields.confirmation_number }
          );
          replacement = `\n\nHotel in ${region} updated to: ${fields.status}${fields.confirmation_number ? ` (conf: ${fields.confirmation_number})` : ''}`;
          actions.push(`update_hotel: ${region} -> ${fields.status}`);
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
            booking_url: fields.booking_url || undefined,
            day: fields.day || undefined,
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
          const metadata: Record<string, unknown> = {};
          if (fields.price_range_eur) metadata.price_range_eur = fields.price_range_eur;
          if (fields.gf_df_friendly) metadata.gf_df_friendly = fields.gf_df_friendly === 'true';
          if (fields.reservation_needed) metadata.reservation_needed = fields.reservation_needed === 'true';
          if (fields.reservation_advance) metadata.reservation_advance = fields.reservation_advance;

          const item = await travelState.setItem(trip.id, region, 'restaurant', name, {
            status: 'proposed',
            notes: fields.notes || undefined,
            metadata,
          });
          replacement = `\n\nRestaurant added for ${region}: ${name}`;
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

        case 'get_state': {
          const context = await travelState.buildTravelContext(trip.trip_id);
          replacement = `\n\n${context}`;
          actions.push('get_state');
          break;
        }

        default:
          replacement = `\n\n(Unknown travel action: ${action})`;
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
