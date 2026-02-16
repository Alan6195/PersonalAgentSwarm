/**
 * Web Search Service
 *
 * Provides web search capabilities via Brave Search API or Serper.dev.
 * Results are injected into agent context for grounded responses.
 */

import { config } from '../config';

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export function isConfigured(): boolean {
  return !!(config as any).SEARCH_API_KEY;
}

export async function searchWeb(searchQuery: string, count: number = 5): Promise<SearchResult[]> {
  if (!isConfigured()) {
    console.warn('[WebSearch] Search API not configured');
    return [];
  }

  const apiKey = (config as any).SEARCH_API_KEY;
  const apiUrl = (config as any).SEARCH_API_URL || 'https://api.search.brave.com/res/v1/web/search';

  try {
    const url = new URL(apiUrl);
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('count', String(count));

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      console.error(`[WebSearch] API returned ${response.status}: ${response.statusText}`);
      return [];
    }

    const data = await response.json() as any;
    const results: SearchResult[] = [];

    // Brave Search API format
    if (data.web?.results) {
      for (const r of data.web.results.slice(0, count)) {
        results.push({
          title: r.title || '',
          url: r.url || '',
          description: r.description || '',
        });
      }
    }
    // Serper.dev format
    else if (data.organic) {
      for (const r of data.organic.slice(0, count)) {
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

export function formatResultsForAgent(results: SearchResult[]): string {
  if (results.length === 0) return 'No web search results found.';

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`);
  }
  return lines.join('\n\n');
}
