/**
 * Web Search Service (SerpAPI)
 *
 * Provides web search, hotel pricing, flight pricing, and local/maps
 * results via SerpAPI's Google engines. Single API key covers all.
 *
 * Endpoints used:
 *   - Google Search: general web queries
 *   - Google Hotels: live hotel pricing with dates
 *   - Google Flights: flight pricing with routes
 *   - Google Maps (Local): restaurant/activity discovery with reviews
 */

import { config } from '../config';

// ---------- Types ----------

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export interface HotelResult {
  name: string;
  rating: number | null;
  reviews: number | null;
  pricePerNight: string;
  pricePerNightNum: number | null;
  totalPrice: string;
  totalPriceNum: number | null;
  amenities: string[];
  imageUrl: string;
  hotelClass: number | null;
  checkInTime: string;
  checkOutTime: string;
}

export interface FlightResult {
  airline: string;
  flightNumber: string;
  departureAirport: string;
  departureTime: string;
  arrivalAirport: string;
  arrivalTime: string;
  duration: number; // minutes
  stops: number;
  price: number | null;
  travelClass: string;
  type: string; // "Round trip" etc.
}

export interface LocalResult {
  name: string;
  rating: number | null;
  reviews: number | null;
  type: string;
  address: string;
  priceLevel: string;
  description: string;
  thumbnail: string;
}

// ---------- Config ----------

const SERPAPI_BASE = 'https://serpapi.com/search';

export function isConfigured(): boolean {
  return !!config.SERPAPI_KEY;
}

// ---------- Google Search ----------

export async function searchWeb(searchQuery: string, count: number = 5): Promise<SearchResult[]> {
  if (!isConfigured()) {
    console.warn('[WebSearch] SerpAPI key not configured');
    return [];
  }

  try {
    const params = new URLSearchParams({
      engine: 'google',
      q: searchQuery,
      api_key: config.SERPAPI_KEY,
      num: String(count),
    });

    const response = await fetch(`${SERPAPI_BASE}?${params}`);
    if (!response.ok) {
      console.error(`[WebSearch] SerpAPI returned ${response.status}: ${response.statusText}`);
      return [];
    }

    const data = await response.json() as any;
    const results: SearchResult[] = [];

    if (data.organic_results) {
      for (const r of data.organic_results.slice(0, count)) {
        results.push({
          title: r.title || '',
          url: r.link || '',
          description: r.snippet || '',
        });
      }
    }

    console.log(`[WebSearch] Found ${results.length} results for: ${searchQuery.substring(0, 60)}`);
    return results;
  } catch (err) {
    console.error('[WebSearch] Search failed:', (err as Error).message);
    return [];
  }
}

// ---------- Google Hotels ----------

export async function searchHotels(options: {
  query: string;
  checkIn: string;   // YYYY-MM-DD
  checkOut: string;   // YYYY-MM-DD
  adults?: number;
  currency?: string;
  sortBy?: 'relevance' | 'lowest_price' | 'highest_rating' | 'most_reviewed';
}): Promise<HotelResult[]> {
  if (!isConfigured()) return [];

  const sortMap: Record<string, string> = {
    relevance: '0',
    lowest_price: '3',
    highest_rating: '8',
    most_reviewed: '13',
  };

  try {
    const params = new URLSearchParams({
      engine: 'google_hotels',
      q: options.query,
      check_in_date: options.checkIn,
      check_out_date: options.checkOut,
      adults: String(options.adults || 2),
      currency: options.currency || 'USD',
      api_key: config.SERPAPI_KEY,
    });

    if (options.sortBy) {
      params.set('sort_by', sortMap[options.sortBy] || '0');
    }

    const response = await fetch(`${SERPAPI_BASE}?${params}`);
    if (!response.ok) {
      console.error(`[WebSearch:Hotels] SerpAPI returned ${response.status}`);
      return [];
    }

    const data = await response.json() as any;
    const results: HotelResult[] = [];

    const properties = data.properties || [];
    for (const h of properties.slice(0, 10)) {
      results.push({
        name: h.name || '',
        rating: h.overall_rating || null,
        reviews: h.reviews || null,
        pricePerNight: h.rate_per_night?.lowest || '',
        pricePerNightNum: h.rate_per_night?.extracted_lowest || null,
        totalPrice: h.total_rate?.lowest || '',
        totalPriceNum: h.total_rate?.extracted_lowest || null,
        amenities: h.amenities || [],
        imageUrl: h.images?.[0]?.original_image || h.images?.[0]?.thumbnail || '',
        hotelClass: h.hotel_class || null,
        checkInTime: h.check_in_time || '',
        checkOutTime: h.check_out_time || '',
      });
    }

    console.log(`[WebSearch:Hotels] Found ${results.length} hotels for: ${options.query.substring(0, 40)}`);
    return results;
  } catch (err) {
    console.error('[WebSearch:Hotels] Search failed:', (err as Error).message);
    return [];
  }
}

// ---------- Google Flights ----------

export async function searchFlights(options: {
  departureId: string;   // airport code e.g. "DEN"
  arrivalId: string;     // airport code e.g. "OPO"
  outboundDate: string;  // YYYY-MM-DD
  returnDate?: string;   // YYYY-MM-DD (omit for one-way)
  currency?: string;
}): Promise<FlightResult[]> {
  if (!isConfigured()) return [];

  try {
    const params = new URLSearchParams({
      engine: 'google_flights',
      departure_id: options.departureId,
      arrival_id: options.arrivalId,
      outbound_date: options.outboundDate,
      currency: options.currency || 'USD',
      api_key: config.SERPAPI_KEY,
      type: options.returnDate ? '1' : '2', // 1=round trip, 2=one way
    });

    if (options.returnDate) {
      params.set('return_date', options.returnDate);
    }

    const response = await fetch(`${SERPAPI_BASE}?${params}`);
    if (!response.ok) {
      console.error(`[WebSearch:Flights] SerpAPI returned ${response.status}`);
      return [];
    }

    const data = await response.json() as any;
    const results: FlightResult[] = [];

    const bestFlights = data.best_flights || [];
    const otherFlights = data.other_flights || [];
    const allOptions = [...bestFlights, ...otherFlights].slice(0, 8);

    for (const option of allOptions) {
      const legs = option.flights || [];
      if (legs.length === 0) continue;

      const first = legs[0];
      const last = legs[legs.length - 1];

      results.push({
        airline: first.airline || '',
        flightNumber: first.flight_number || '',
        departureAirport: first.departure_airport?.id || '',
        departureTime: first.departure_airport?.time || '',
        arrivalAirport: last.arrival_airport?.id || '',
        arrivalTime: last.arrival_airport?.time || '',
        duration: option.total_duration || 0,
        stops: legs.length - 1,
        price: option.price || null,
        travelClass: first.travel_class || 'Economy',
        type: option.type || 'Round trip',
      });
    }

    console.log(`[WebSearch:Flights] Found ${results.length} flights ${options.departureId}->${options.arrivalId}`);
    return results;
  } catch (err) {
    console.error('[WebSearch:Flights] Search failed:', (err as Error).message);
    return [];
  }
}

// ---------- Google Maps / Local ----------

export async function searchLocal(options: {
  query: string;
  location?: string; // e.g. "Porto, Portugal"
}): Promise<LocalResult[]> {
  if (!isConfigured()) return [];

  try {
    const params = new URLSearchParams({
      engine: 'google_maps',
      q: options.query,
      api_key: config.SERPAPI_KEY,
    });

    if (options.location) {
      params.set('ll', ''); // let SerpAPI geocode from query
    }

    const response = await fetch(`${SERPAPI_BASE}?${params}`);
    if (!response.ok) {
      console.error(`[WebSearch:Local] SerpAPI returned ${response.status}`);
      return [];
    }

    const data = await response.json() as any;
    const results: LocalResult[] = [];

    const places = data.local_results || [];
    for (const p of places.slice(0, 10)) {
      results.push({
        name: p.title || '',
        rating: p.rating || null,
        reviews: p.reviews || null,
        type: p.type || '',
        address: p.address || '',
        priceLevel: p.price || '',
        description: p.description || p.snippet || '',
        thumbnail: p.thumbnail || '',
      });
    }

    console.log(`[WebSearch:Local] Found ${results.length} places for: ${options.query.substring(0, 40)}`);
    return results;
  } catch (err) {
    console.error('[WebSearch:Local] Search failed:', (err as Error).message);
    return [];
  }
}

// ---------- Formatters ----------

export function formatResultsForAgent(results: SearchResult[]): string {
  if (results.length === 0) return 'No web search results found.';

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`);
  }
  return lines.join('\n\n');
}

export function formatHotelsForAgent(hotels: HotelResult[]): string {
  if (hotels.length === 0) return 'No hotel results found.';

  const lines: string[] = [];
  for (const h of hotels) {
    const stars = h.hotelClass ? `${'*'.repeat(h.hotelClass)}` : '';
    const rating = h.rating ? `${h.rating}/5 (${h.reviews || 0} reviews)` : 'No rating';
    const amenitiesStr = h.amenities.slice(0, 5).join(', ');
    lines.push(
      `**${h.name}** ${stars}\n` +
      `  Rate: ${h.pricePerNight}/night | Total: ${h.totalPrice}\n` +
      `  Rating: ${rating}\n` +
      `  Amenities: ${amenitiesStr}\n` +
      `  Check-in: ${h.checkInTime} | Check-out: ${h.checkOutTime}` +
      (h.imageUrl ? `\n  Image: ${h.imageUrl}` : '')
    );
  }
  return lines.join('\n\n');
}

export function formatFlightsForAgent(flights: FlightResult[]): string {
  if (flights.length === 0) return 'No flight results found.';

  const lines: string[] = [];
  for (const f of flights) {
    const hrs = Math.floor(f.duration / 60);
    const mins = f.duration % 60;
    const stopsStr = f.stops === 0 ? 'Nonstop' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`;
    const priceStr = f.price ? `$${f.price}` : 'Price N/A';
    lines.push(
      `**${f.airline} ${f.flightNumber}** | ${priceStr} (${f.type})\n` +
      `  ${f.departureAirport} ${f.departureTime} -> ${f.arrivalAirport} ${f.arrivalTime}\n` +
      `  Duration: ${hrs}h ${mins}m | ${stopsStr} | ${f.travelClass}`
    );
  }
  return lines.join('\n\n');
}

export function formatLocalForAgent(places: LocalResult[]): string {
  if (places.length === 0) return 'No local results found.';

  const lines: string[] = [];
  for (const p of places) {
    const rating = p.rating ? `${p.rating}/5 (${p.reviews || 0} reviews)` : 'No rating';
    lines.push(
      `**${p.name}** ${p.priceLevel}\n` +
      `  ${p.type} | ${rating}\n` +
      `  ${p.address}` +
      (p.description ? `\n  ${p.description}` : '')
    );
  }
  return lines.join('\n\n');
}
