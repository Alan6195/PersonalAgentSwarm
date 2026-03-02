/**
 * Runway API client for image and video generation.
 *
 * Uses Runway for:
 *   - Text-to-image (gen4_image)
 *   - Text-to-video (gen4.5)
 *
 * Replaces the previous Atlas Cloud integration.
 */

import RunwayML from '@runwayml/sdk';
import { config } from '../config';

let client: RunwayML | null = null;

function getClient(): RunwayML {
  if (client) return client;

  if (!config.RUNWAY_API_KEY) {
    throw new Error('Runway API key not configured');
  }

  client = new RunwayML({
    apiKey: config.RUNWAY_API_KEY,
    timeout: 120_000, // 2 minutes for initial request
    maxRetries: 2,
  });

  return client;
}

export function isConfigured(): boolean {
  return !!config.RUNWAY_API_KEY;
}

interface ImageOptions {
  ratio?: '1024:1024' | '1080:1080' | '1168:880' | '1360:768' | '1440:1080' | '1080:1440' | '1808:768' | '1920:1080' | '1080:1920' | '2112:912' | '1280:720' | '720:1280' | '720:720' | '960:720' | '720:960' | '1680:720';
  seed?: number;
}

interface VideoOptions {
  ratio?: '1280:720' | '720:1280';
  duration?: number;
  seed?: number;
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
    throw new Error('Runway API key not configured');
  }

  const runway = getClient();
  const ratio = options.ratio || '1024:1024';

  console.log(`[Runway] Generating image (gen4_image): "${prompt.substring(0, 80)}..."`);

  try {
    // Use gen4_image (referenceImages optional) instead of gen4_image_turbo (requires referenceImages)
    const taskPromise = runway.textToImage.create({
      model: 'gen4_image',
      promptText: prompt,
      ratio,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    });

    // waitForTaskOutput is on the APIPromiseWithAwaitableTask, not the resolved value
    const result = await taskPromise.waitForTaskOutput({
      timeout: 120_000, // 2 minutes for images
    });

    if (!result.output || result.output.length === 0) {
      throw new Error('Runway returned no image outputs');
    }

    const imageUrl = result.output[0];
    console.log(`[Runway] Image generated: ${imageUrl.substring(0, 100)}`);
    return imageUrl;
  } catch (err: any) {
    if (err?.constructor?.name === 'TaskFailedError') {
      throw new Error(`Runway image generation failed: ${err.taskDetails?.failure || err.message}`);
    }
    if (err?.constructor?.name === 'TaskTimedOutError') {
      throw new Error('Runway image generation timed out after 2 minutes');
    }
    throw new Error(`Runway image generation failed: ${(err as Error).message}`);
  }
}

/**
 * Generate a video from a text prompt.
 * Returns the URL of the generated video.
 * Note: video generation can take 1-5 minutes.
 */
export async function generateVideo(
  prompt: string,
  options: VideoOptions = {}
): Promise<string> {
  if (!isConfigured()) {
    throw new Error('Runway API key not configured');
  }

  const runway = getClient();
  const ratio = options.ratio || '1280:720';
  const duration = options.duration || 5;

  console.log(`[Runway] Generating video (gen4.5): "${prompt.substring(0, 80)}..."`);

  try {
    const taskPromise = runway.textToVideo.create({
      model: 'gen4.5',
      promptText: prompt,
      ratio,
      duration,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    });

    // waitForTaskOutput is on the APIPromiseWithAwaitableTask, not the resolved value
    const result = await taskPromise.waitForTaskOutput({
      timeout: 600_000, // 10 minutes for videos
    });

    if (!result.output || result.output.length === 0) {
      throw new Error('Runway returned no video outputs');
    }

    const videoUrl = result.output[0];
    console.log(`[Runway] Video generated: ${videoUrl.substring(0, 100)}`);
    return videoUrl;
  } catch (err: any) {
    if (err?.constructor?.name === 'TaskFailedError') {
      throw new Error(`Runway video generation failed: ${err.taskDetails?.failure || err.message}`);
    }
    if (err?.constructor?.name === 'TaskTimedOutError') {
      throw new Error('Runway video generation timed out after 10 minutes');
    }
    throw new Error(`Runway video generation failed: ${(err as Error).message}`);
  }
}
