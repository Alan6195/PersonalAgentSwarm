/**
 * Unsplash API client for high-quality stock photos.
 *
 * Used as the primary image source for "photo" style posts:
 *   - Colorado landscapes, workspace shots, nature, coffee
 *   - Real, authentic imagery that matches the builder brand
 *
 * Free tier: 50 requests/hour (demo), unlimited images at production.
 * License: irrevocable, worldwide, commercial-OK. Attribution appreciated but not required.
 */

import { createApi } from 'unsplash-js';
import { config } from '../config';

// Unsplash JS client types
type UnsplashApi = ReturnType<typeof createApi>;

let client: UnsplashApi | null = null;

function getClient(): UnsplashApi {
  if (client) return client;

  if (!config.UNSPLASH_ACCESS_KEY) {
    throw new Error('Unsplash API key not configured');
  }

  client = createApi({
    accessKey: config.UNSPLASH_ACCESS_KEY,
    // Node 18+ has native fetch; no polyfill needed
  });

  return client;
}

export function isConfigured(): boolean {
  return !!config.UNSPLASH_ACCESS_KEY;
}

export interface UnsplashPhoto {
  url: string;
  photographer: string;
  photographerUrl: string;
  description: string | null;
  downloadLocation: string;
}

/**
 * Search for a photo by keywords and return a random result from the top matches.
 * Returns the "regular" size URL (1080px wide, perfect for Twitter).
 */
export async function searchPhoto(
  keywords: string,
  orientation: 'landscape' | 'portrait' | 'squarish' = 'landscape'
): Promise<UnsplashPhoto | null> {
  if (!isConfigured()) {
    throw new Error('Unsplash API key not configured');
  }

  const unsplash = getClient();

  console.log(`[Unsplash] Searching for: "${keywords}" (${orientation})`);

  try {
    const result = await unsplash.search.getPhotos({
      query: keywords,
      orientation,
      perPage: 15,
      orderBy: 'relevant',
    });

    if (result.errors) {
      console.error('[Unsplash] API error:', result.errors);
      return null;
    }

    const photos = result.response?.results;
    if (!photos || photos.length === 0) {
      console.log(`[Unsplash] No photos found for "${keywords}"`);
      return null;
    }

    // Pick a random photo from top results for variety
    const idx = Math.floor(Math.random() * Math.min(photos.length, 10));
    const photo = photos[idx];

    console.log(`[Unsplash] Selected photo by ${photo.user.name}: ${photo.urls.regular.substring(0, 80)}...`);

    // Trigger download tracking (required by Unsplash API guidelines)
    // This is a fire-and-forget operation
    triggerDownloadTracking(photo.links.download_location).catch((err) => {
      console.warn('[Unsplash] Download tracking failed:', (err as Error).message);
    });

    return {
      url: photo.urls.regular,
      photographer: photo.user.name,
      photographerUrl: photo.user.links.html,
      description: photo.alt_description || photo.description,
      downloadLocation: photo.links.download_location,
    };
  } catch (err) {
    console.error('[Unsplash] Search failed:', (err as Error).message);
    return null;
  }
}

/**
 * Get a random photo matching keywords.
 * Simpler than search; returns one photo directly.
 */
export async function getRandomPhoto(
  query: string,
  orientation: 'landscape' | 'portrait' | 'squarish' = 'landscape'
): Promise<UnsplashPhoto | null> {
  if (!isConfigured()) {
    throw new Error('Unsplash API key not configured');
  }

  const unsplash = getClient();

  console.log(`[Unsplash] Random photo for: "${query}" (${orientation})`);

  try {
    const result = await unsplash.photos.getRandom({
      query,
      orientation,
      count: 1,
    });

    if (result.errors) {
      console.error('[Unsplash] API error:', result.errors);
      return null;
    }

    const photo = Array.isArray(result.response) ? result.response[0] : result.response;
    if (!photo) {
      console.log(`[Unsplash] No random photo found for "${query}"`);
      return null;
    }

    console.log(`[Unsplash] Random photo by ${photo.user.name}: ${photo.urls.regular.substring(0, 80)}...`);

    // Trigger download tracking
    triggerDownloadTracking(photo.links.download_location).catch((err) => {
      console.warn('[Unsplash] Download tracking failed:', (err as Error).message);
    });

    return {
      url: photo.urls.regular,
      photographer: photo.user.name,
      photographerUrl: photo.user.links.html,
      description: photo.alt_description || photo.description,
      downloadLocation: photo.links.download_location,
    };
  } catch (err) {
    console.error('[Unsplash] Random photo failed:', (err as Error).message);
    return null;
  }
}

/**
 * Trigger Unsplash download tracking (required by API guidelines).
 * Must be called when a photo is actually used/displayed.
 */
async function triggerDownloadTracking(downloadLocation: string): Promise<void> {
  const unsplash = getClient();
  await unsplash.photos.trackDownload({ downloadLocation });
}
