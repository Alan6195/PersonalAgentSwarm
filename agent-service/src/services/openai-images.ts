/**
 * OpenAI GPT Image 1 client for AI-generated images.
 *
 * Used for "illustration" and "abstract" style posts:
 *   - Data visualizations, architecture diagrams
 *   - Abstract conceptual art, generative patterns
 *   - Stylized illustrations that look intentionally artistic
 *
 * Model: gpt-image-1 (medium quality)
 * Cost: ~$0.04 per image at medium quality / 1024x1024
 * Returns: base64 encoded image data (decoded to Buffer)
 *
 * Uses the existing OpenAI SDK (already installed for embeddings).
 */

import OpenAI from 'openai';
import { config } from '../config';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;

  if (!config.OPENAI_API_KEY) {
    throw new Error('OpenAI API key not configured');
  }

  client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    timeout: 120_000, // 2 minutes
    maxRetries: 2,
  });

  return client;
}

export function isConfigured(): boolean {
  return !!config.OPENAI_API_KEY;
}

export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536';
export type ImageQuality = 'low' | 'medium' | 'high';

interface ImageOptions {
  size?: ImageSize;
  quality?: ImageQuality;
}

/**
 * Generate an image from a text prompt using GPT Image 1.
 * Returns the image as a Buffer (decoded from base64).
 */
export async function generateImage(
  prompt: string,
  options: ImageOptions = {}
): Promise<Buffer> {
  if (!isConfigured()) {
    throw new Error('OpenAI API key not configured');
  }

  const openai = getClient();
  const size = options.size || '1024x1024';
  const quality = options.quality || 'medium';

  console.log(`[OpenAI Images] Generating (gpt-image-1, ${quality}, ${size}): "${prompt.substring(0, 80)}..."`);

  try {
    const response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size,
      quality,
    });

    if (!response.data || response.data.length === 0) {
      throw new Error('OpenAI returned no image data');
    }

    const imageData = response.data[0];
    if (!imageData?.b64_json) {
      throw new Error('OpenAI returned image data without b64_json');
    }

    const buffer = Buffer.from(imageData.b64_json, 'base64');

    console.log(`[OpenAI Images] Image generated (${(buffer.length / 1024).toFixed(0)}KB)`);
    return buffer;
  } catch (err: any) {
    if (err?.status === 400) {
      throw new Error(`OpenAI image generation rejected: ${err.message}`);
    }
    if (err?.status === 429) {
      throw new Error('OpenAI rate limit exceeded for image generation');
    }
    throw new Error(`OpenAI image generation failed: ${(err as Error).message}`);
  }
}
