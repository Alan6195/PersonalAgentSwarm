/**
 * Multi-provider image strategy orchestrator.
 *
 * Routes image generation to the best provider based on content style:
 *   - "photo"        -> Unsplash (real stock photos, free, authentic)
 *   - "illustration" -> GPT Image 1 (styled AI art, great prompt adherence)
 *   - "abstract"     -> GPT Image 1 (generative art, conceptual visuals)
 *   - auto-detect    -> Analyze prompt keywords to pick provider
 *
 * Each provider has a fallback chain so image generation rarely fails entirely.
 * If all providers fail, the tweet posts text-only (handled by twitter-actions.ts).
 */

import * as unsplash from './unsplash';
import * as openaiImages from './openai-images';

export type ImageStyle = 'photo' | 'illustration' | 'abstract';

export interface ImageResult {
  /** Image URL (for Unsplash results) */
  url?: string;
  /** Image buffer (for GPT Image 1 results) */
  buffer?: Buffer;
  /** Which provider produced this image */
  provider: 'unsplash' | 'openai' | 'none';
  /** Photographer credit (Unsplash only) */
  photographer?: string;
}

/**
 * Keywords that suggest a real photo would be best.
 */
const PHOTO_KEYWORDS = [
  'colorado', 'mountain', 'landscape', 'sunrise', 'sunset', 'nature',
  'workspace', 'desk', 'office', 'coffee', 'laptop', 'morning',
  'trail', 'hiking', 'outdoor', 'sky', 'cloud', 'forest', 'pine',
  'prairie', 'ranch', 'snow', 'winter', 'autumn', 'spring',
  'building', 'city', 'town', 'road', 'small business',
];

/**
 * Auto-detect the best image style from the prompt text.
 */
function detectStyle(prompt: string): ImageStyle {
  const lower = prompt.toLowerCase();

  // Check for photo-oriented keywords
  const photoScore = PHOTO_KEYWORDS.filter(kw => lower.includes(kw)).length;

  // Check for AI-generation-oriented keywords
  const aiKeywords = [
    'abstract', 'visualization', 'diagram', 'geometric', 'particle',
    'vector', 'node', 'network', 'generative', 'flowing', 'gradient',
    'isometric', 'render', '3d', 'illustration', 'minimal', 'conceptual',
    'data', 'chart', 'graph', 'hub', 'spoke', 'pastel', 'flat design',
    'glowing', 'neon', 'pattern', 'fractal',
  ];
  const aiScore = aiKeywords.filter(kw => lower.includes(kw)).length;

  if (photoScore > aiScore && photoScore > 0) {
    return 'photo';
  }
  if (aiScore > 0) {
    return lower.includes('abstract') || lower.includes('particle') || lower.includes('generative')
      ? 'abstract'
      : 'illustration';
  }

  // Default to illustration (GPT Image 1 handles ambiguous prompts better)
  return 'illustration';
}

/**
 * Extract 2-3 concise search keywords from a photo prompt for Unsplash.
 * Strips descriptive adjectives and focuses on nouns.
 */
function extractSearchKeywords(prompt: string): string {
  const lower = prompt.toLowerCase();

  // Remove common descriptive words that don't help search
  const stopWords = [
    'a', 'an', 'the', 'of', 'in', 'on', 'at', 'with', 'and', 'or',
    'beautiful', 'stunning', 'dramatic', 'sweeping', 'epic', 'warm',
    'cool', 'soft', 'crisp', 'sharp', 'golden', 'deep', 'bright',
    'dark', 'light', 'wide', 'close', 'angle', 'shot', 'style',
    'aesthetic', 'vibes', 'mood', 'feeling', 'sense', 'cinematic',
    'photorealistic', 'photograph', 'photo', 'image', 'picture',
  ];

  const words = lower
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));

  // Take the first 3-4 meaningful words as search terms
  return words.slice(0, 4).join(' ');
}

/**
 * Generate an image using the best provider for the given style and prompt.
 *
 * @param style - The image style (photo, illustration, abstract), or undefined for auto-detect
 * @param prompt - The image prompt/description
 * @returns ImageResult with either a URL or Buffer, plus provider metadata
 */
export async function generateImage(
  style: ImageStyle | undefined,
  prompt: string
): Promise<ImageResult> {
  const resolvedStyle = style || detectStyle(prompt);

  console.log(`[ImageStrategy] Style: ${resolvedStyle} (${style ? 'explicit' : 'auto-detected'})`);

  switch (resolvedStyle) {
    case 'photo':
      return generatePhotoImage(prompt);
    case 'illustration':
    case 'abstract':
      return generateAIImage(prompt);
    default:
      return generateAIImage(prompt);
  }
}

/**
 * Photo strategy: Unsplash first, GPT Image 1 fallback.
 */
async function generatePhotoImage(prompt: string): Promise<ImageResult> {
  // Try Unsplash first
  if (unsplash.isConfigured()) {
    try {
      const keywords = extractSearchKeywords(prompt);
      console.log(`[ImageStrategy] Unsplash search: "${keywords}"`);

      const photo = await unsplash.searchPhoto(keywords, 'landscape');
      if (photo) {
        console.log(`[ImageStrategy] Using Unsplash photo by ${photo.photographer}`);
        return {
          url: photo.url,
          provider: 'unsplash',
          photographer: photo.photographer,
        };
      }
      console.log('[ImageStrategy] Unsplash returned no results, falling back to GPT Image 1');
    } catch (err) {
      console.warn('[ImageStrategy] Unsplash failed, falling back:', (err as Error).message);
    }
  } else {
    console.log('[ImageStrategy] Unsplash not configured, using GPT Image 1');
  }

  // Fallback to GPT Image 1
  return generateAIImage(prompt);
}

/**
 * AI image strategy: GPT Image 1 first, Unsplash fallback.
 */
async function generateAIImage(prompt: string): Promise<ImageResult> {
  // Try GPT Image 1 first
  if (openaiImages.isConfigured()) {
    try {
      // Use landscape for Twitter card optimization
      const buffer = await openaiImages.generateImage(prompt, {
        size: '1536x1024',
        quality: 'medium',
      });
      console.log('[ImageStrategy] Using GPT Image 1 generated image');
      return {
        buffer,
        provider: 'openai',
      };
    } catch (err) {
      console.warn('[ImageStrategy] GPT Image 1 failed, falling back:', (err as Error).message);
    }
  } else {
    console.log('[ImageStrategy] OpenAI not configured for images');
  }

  // Fallback to Unsplash with extracted keywords
  if (unsplash.isConfigured()) {
    try {
      const keywords = extractSearchKeywords(prompt);
      const photo = await unsplash.searchPhoto(keywords, 'landscape');
      if (photo) {
        console.log(`[ImageStrategy] Fallback: Unsplash photo by ${photo.photographer}`);
        return {
          url: photo.url,
          provider: 'unsplash',
          photographer: photo.photographer,
        };
      }
    } catch (err) {
      console.warn('[ImageStrategy] Unsplash fallback also failed:', (err as Error).message);
    }
  }

  // All providers failed
  console.error('[ImageStrategy] All image providers failed');
  return { provider: 'none' };
}
