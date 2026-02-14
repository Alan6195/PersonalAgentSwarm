/**
 * Atlas Cloud API client for image and video generation.
 *
 * Uses the unified Atlas Cloud API for:
 *   - Text-to-image (Flux, Seedream)
 *   - Text-to-video (Seedance)
 *
 * Endpoints:
 *   POST /api/v1/model/generateImage   (returns prediction ID)
 *   POST /api/v1/model/generateVideo   (returns prediction ID)
 *   GET  /api/v1/model/prediction/:id  (poll for async results)
 *
 * All responses are wrapped: { code, message, data: { id, status, outputs, ... } }
 */

import { config } from '../config';

const BASE_URL = 'https://api.atlascloud.ai';

// Default models
const DEFAULT_IMAGE_MODEL = 'black-forest-labs/flux-1.1-pro';
const DEFAULT_VIDEO_MODEL = 'bytedance/seedance-v1.5-pro/text-to-video';

/** Inner data payload from Atlas Cloud responses */
interface AtlasData {
  id: string;
  status: string;
  model: string;
  outputs: string[] | null;
  urls: Record<string, string>;
  created_at: string;
  has_nsfw_contents: boolean[] | null;
  error?: string;
  executionTime?: number;
}

/** Top-level Atlas Cloud API response envelope */
interface AtlasApiResponse {
  code: number;
  message: string;
  data: AtlasData;
}

interface ImageOptions {
  model?: string;
  size?: string;
  maxImages?: number;
}

interface VideoOptions {
  model?: string;
  aspectRatio?: string;
  duration?: number;
}

export function isConfigured(): boolean {
  return !!config.ATLAS_CLOUD_API_KEY;
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.ATLAS_CLOUD_API_KEY}`,
  };
}

/**
 * Parse an Atlas Cloud JSON response, unwrapping the { code, message, data } envelope.
 */
function unwrap(json: unknown): AtlasData {
  const envelope = json as AtlasApiResponse;
  if (envelope.data) return envelope.data;
  // Fallback: maybe the response IS the data (no envelope)
  return json as AtlasData;
}

function hasOutputs(data: AtlasData): boolean {
  return !!(data.outputs && data.outputs.length > 0 && data.outputs[0]);
}

function isTerminal(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'completed' || s === 'succeeded' || s === 'failed' || s === 'error' || s === 'canceled';
}

function isSuccess(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'completed' || s === 'succeeded';
}

/**
 * Poll for a generation result until completed or failed.
 */
async function pollForResult(
  predictionId: string,
  maxWaitMs: number = 120_000
): Promise<AtlasData> {
  const pollUrl = `${BASE_URL}/api/v1/model/prediction/${predictionId}`;
  const startTime = Date.now();
  const pollIntervalMs = 3000;
  let attempts = 0;

  console.log(`[AtlasCloud] Polling prediction ${predictionId}...`);

  while (Date.now() - startTime < maxWaitMs) {
    attempts++;
    const res = await fetch(pollUrl, { method: 'GET', headers: authHeaders() });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[AtlasCloud] Poll HTTP ${res.status}: ${body.substring(0, 200)}`);
      if (res.status >= 500) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        continue;
      }
      throw new Error(`Atlas Cloud poll failed (${res.status}): ${body.substring(0, 200)}`);
    }

    const data = unwrap(await res.json());
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`[AtlasCloud] Poll #${attempts} (${elapsed}s): status=${data.status}, outputs=${data.outputs?.length ?? 0}`);

    if (hasOutputs(data)) {
      console.log(`[AtlasCloud] Generation complete: ${data.outputs![0].substring(0, 100)}`);
      return data;
    }

    if (isTerminal(data.status) && !hasOutputs(data)) {
      if (isSuccess(data.status)) {
        console.error(`[AtlasCloud] Status=${data.status} but no outputs: ${JSON.stringify(data)}`);
        throw new Error(`Atlas Cloud returned status "${data.status}" but no outputs`);
      }
      throw new Error(`Atlas Cloud generation failed (status: ${data.status}): ${data.error || JSON.stringify(data)}`);
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Atlas Cloud generation timed out after ${maxWaitMs / 1000}s (${attempts} polls)`);
}

/**
 * Generate an image from a text prompt.
 * Returns the URL of the generated image.
 */
export async function generateImage(
  prompt: string,
  options: ImageOptions = {}
): Promise<string> {
  if (!isConfigured()) {
    throw new Error('Atlas Cloud API key not configured');
  }

  const model = options.model || DEFAULT_IMAGE_MODEL;
  const body: Record<string, unknown> = {
    model,
    prompt,
  };

  if (options.size) body.size = options.size;
  if (options.maxImages) body.max_images = options.maxImages;

  console.log(`[AtlasCloud] Generating image with ${model}: "${prompt.substring(0, 80)}..."`);

  const res = await fetch(`${BASE_URL}/api/v1/model/generateImage`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[AtlasCloud] generateImage HTTP ${res.status}: ${errorBody.substring(0, 300)}`);
    throw new Error(`Atlas Cloud image generation failed (${res.status}): ${errorBody.substring(0, 200)}`);
  }

  const data = unwrap(await res.json());
  console.log(`[AtlasCloud] Initial response: id=${data.id}, status=${data.status}, outputs=${data.outputs?.length ?? 0}`);

  // If outputs already present, return immediately
  if (hasOutputs(data)) {
    const imageUrl = data.outputs![0];
    console.log(`[AtlasCloud] Image ready immediately: ${imageUrl.substring(0, 100)}`);
    return imageUrl;
  }

  // Otherwise poll for result
  const result = await pollForResult(data.id, 120_000);

  if (!hasOutputs(result)) {
    throw new Error('Atlas Cloud returned no image outputs after polling');
  }

  const imageUrl = result.outputs![0];
  console.log(`[AtlasCloud] Image generated: ${imageUrl.substring(0, 100)}`);
  return imageUrl;
}

/**
 * Generate a video from a text prompt.
 * Returns the URL of the generated video.
 * Note: video generation is always async and can take 1-5 minutes.
 */
export async function generateVideo(
  prompt: string,
  options: VideoOptions = {}
): Promise<string> {
  if (!isConfigured()) {
    throw new Error('Atlas Cloud API key not configured');
  }

  const model = options.model || DEFAULT_VIDEO_MODEL;
  const body: Record<string, unknown> = {
    model,
    prompt,
    aspect_ratio: options.aspectRatio || '16:9',
    duration: options.duration || 8,
    generate_audio: false,
  };

  console.log(`[AtlasCloud] Generating video with ${model}: "${prompt.substring(0, 80)}..."`);

  const res = await fetch(`${BASE_URL}/api/v1/model/generateVideo`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[AtlasCloud] generateVideo HTTP ${res.status}: ${errorBody.substring(0, 300)}`);
    throw new Error(`Atlas Cloud video generation failed (${res.status}): ${errorBody.substring(0, 200)}`);
  }

  const data = unwrap(await res.json());
  console.log(`[AtlasCloud] Initial response: id=${data.id}, status=${data.status}`);

  // Video is always async; poll for result (up to 5 minutes)
  const result = await pollForResult(data.id, 300_000);

  if (!hasOutputs(result)) {
    throw new Error('Atlas Cloud returned no video outputs after polling');
  }

  const videoUrl = result.outputs![0];
  console.log(`[AtlasCloud] Video generated: ${videoUrl.substring(0, 100)}`);
  return videoUrl;
}
