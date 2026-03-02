import { TwitterApi, TweetV2, ApiResponseError } from 'twitter-api-v2';
import { config } from '../config';
import * as activityLogger from './activity-logger';

let client: TwitterApi | null = null;

function getClient(): TwitterApi {
  if (client) return client;

  if (!config.X_API_KEY || !config.X_API_SECRET || !config.X_ACCESS_TOKEN || !config.X_ACCESS_SECRET) {
    throw new Error('X/Twitter API credentials not configured');
  }

  client = new TwitterApi({
    appKey: config.X_API_KEY,
    appSecret: config.X_API_SECRET,
    accessToken: config.X_ACCESS_TOKEN,
    accessSecret: config.X_ACCESS_SECRET,
  });

  return client;
}

export function isConfigured(): boolean {
  return !!(config.X_API_KEY && config.X_API_SECRET && config.X_ACCESS_TOKEN && config.X_ACCESS_SECRET);
}

// ------------------------------------------------------------------
// Post a single tweet
// ------------------------------------------------------------------
export async function postTweet(text: string, taskId?: number): Promise<{ id: string; text: string }> {
  const twitter = getClient();

  try {
    const result = await twitter.v2.tweet(text);
    const tweetId = result.data.id;
    const tweetText = result.data.text;

    console.log(`[Twitter] Posted tweet ${tweetId}: "${tweetText.substring(0, 60)}..."`);

    await activityLogger.log({
      event_type: 'tweet_posted',
      agent_id: 'social-media',
      task_id: taskId,
      channel: 'twitter',
      summary: `Posted tweet: "${tweetText.substring(0, 100)}"`,
      metadata: { tweet_id: tweetId },
    });

    return { id: tweetId, text: tweetText };
  } catch (err) {
    const msg = err instanceof ApiResponseError
      ? `Twitter API ${err.code}: ${err.data?.detail ?? err.message}`
      : (err as Error).message;

    console.error('[Twitter] Post failed:', msg);

    await activityLogger.log({
      event_type: 'agent_error',
      agent_id: 'social-media',
      task_id: taskId,
      channel: 'twitter',
      summary: `Tweet failed: ${msg.substring(0, 200)}`,
    });

    throw new Error(`Failed to post tweet: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Post a thread (array of tweet texts)
// ------------------------------------------------------------------
export async function postThread(
  tweets: string[],
  taskId?: number
): Promise<{ ids: string[]; texts: string[] }> {
  const twitter = getClient();
  const ids: string[] = [];
  const texts: string[] = [];

  try {
    let lastTweetId: string | undefined;

    for (const tweetText of tweets) {
      const options: { text: string; reply?: { in_reply_to_tweet_id: string } } = {
        text: tweetText,
      };
      if (lastTweetId) {
        options.reply = { in_reply_to_tweet_id: lastTweetId };
      }

      const result = await twitter.v2.tweet(options);
      lastTweetId = result.data.id;
      ids.push(result.data.id);
      texts.push(result.data.text);
    }

    console.log(`[Twitter] Posted thread of ${ids.length} tweets, first: ${ids[0]}`);

    await activityLogger.log({
      event_type: 'thread_posted',
      agent_id: 'social-media',
      task_id: taskId,
      channel: 'twitter',
      summary: `Posted thread (${ids.length} tweets): "${texts[0].substring(0, 80)}"`,
      metadata: { tweet_ids: ids },
    });

    return { ids, texts };
  } catch (err) {
    const msg = err instanceof ApiResponseError
      ? `Twitter API ${err.code}: ${err.data?.detail ?? err.message}`
      : (err as Error).message;

    console.error('[Twitter] Thread post failed:', msg);

    await activityLogger.log({
      event_type: 'agent_error',
      agent_id: 'social-media',
      task_id: taskId,
      channel: 'twitter',
      summary: `Thread failed at tweet ${ids.length + 1}: ${msg.substring(0, 200)}`,
      metadata: { posted_ids: ids },
    });

    throw new Error(`Failed to post thread at tweet ${ids.length + 1}: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Upload media from a URL and return the media_id
// ------------------------------------------------------------------
export async function uploadMediaFromUrl(
  mediaUrl: string,
  type: 'image' | 'video' = 'image'
): Promise<string> {
  const twitter = getClient();

  try {
    // Download the media file into a Buffer
    console.log(`[Twitter] Downloading ${type} from URL: ${mediaUrl.substring(0, 100)}...`);
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      throw new Error(`Failed to download media: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log(`[Twitter] Uploading ${type} (${(buffer.length / 1024).toFixed(0)}KB)...`);

    // Use v1 media upload (v2 media upload is still buggy)
    const mimeType = type === 'video' ? 'video/mp4' : 'image/png';
    const mediaId = await twitter.v1.uploadMedia(buffer, {
      mimeType,
      ...(type === 'video' ? { type: 'longmp4' } : {}),
    });

    console.log(`[Twitter] Media uploaded, media_id: ${mediaId}`);
    return mediaId;
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[Twitter] Media upload failed: ${msg}`);
    throw new Error(`Failed to upload media: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Post a tweet with attached media (image or video)
// ------------------------------------------------------------------
export async function postTweetWithMedia(
  text: string,
  mediaId: string,
  taskId?: number
): Promise<{ id: string; text: string }> {
  const twitter = getClient();

  try {
    const result = await twitter.v2.tweet({
      text,
      media: { media_ids: [mediaId] },
    });
    const tweetId = result.data.id;
    const tweetText = result.data.text;

    console.log(`[Twitter] Posted tweet with media ${tweetId}: "${tweetText.substring(0, 60)}..."`);

    await activityLogger.log({
      event_type: 'tweet_posted_with_media',
      agent_id: 'social-media',
      task_id: taskId,
      channel: 'twitter',
      summary: `Posted tweet with media: "${tweetText.substring(0, 100)}"`,
      metadata: { tweet_id: tweetId, media_id: mediaId },
    });

    return { id: tweetId, text: tweetText };
  } catch (err) {
    const msg = err instanceof ApiResponseError
      ? `Twitter API ${err.code}: ${err.data?.detail ?? err.message}`
      : (err as Error).message;

    console.error('[Twitter] Post with media failed:', msg);

    await activityLogger.log({
      event_type: 'agent_error',
      agent_id: 'social-media',
      task_id: taskId,
      channel: 'twitter',
      summary: `Tweet with media failed: ${msg.substring(0, 200)}`,
    });

    throw new Error(`Failed to post tweet with media: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Delete a tweet
// ------------------------------------------------------------------
export async function deleteTweet(tweetId: string, taskId?: number): Promise<void> {
  const twitter = getClient();

  try {
    await twitter.v2.deleteTweet(tweetId);

    console.log(`[Twitter] Deleted tweet ${tweetId}`);
    await activityLogger.log({
      event_type: 'tweet_deleted',
      agent_id: 'social-media',
      task_id: taskId,
      channel: 'twitter',
      summary: `Deleted tweet ${tweetId}`,
    });
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(`Failed to delete tweet: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Get recent mentions (timeline of @mentions)
// ------------------------------------------------------------------
export async function getRecentMentions(
  count: number = 10
): Promise<TweetV2[]> {
  const twitter = getClient();

  try {
    const me = await twitter.v2.me();
    const userId = me.data.id;

    const mentions = await twitter.v2.userMentionTimeline(userId, {
      max_results: Math.min(count, 100),
      'tweet.fields': ['created_at', 'author_id', 'public_metrics', 'text'],
    });

    return mentions.data?.data ?? [];
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[Twitter] Fetch mentions failed:', msg);
    throw new Error(`Failed to fetch mentions: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Get own recent tweets
// ------------------------------------------------------------------
export async function getMyRecentTweets(
  count: number = 10
): Promise<TweetV2[]> {
  const twitter = getClient();

  try {
    const me = await twitter.v2.me();
    const userId = me.data.id;

    const timeline = await twitter.v2.userTimeline(userId, {
      max_results: Math.min(count, 100),
      'tweet.fields': ['created_at', 'public_metrics', 'text'],
      exclude: ['retweets', 'replies'],
    });

    return timeline.data?.data ?? [];
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[Twitter] Fetch timeline failed:', msg);
    throw new Error(`Failed to fetch timeline: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Get profile info
// ------------------------------------------------------------------
export async function getProfile(): Promise<{
  id: string;
  name: string;
  username: string;
  followers: number;
  following: number;
  tweetCount: number;
}> {
  const twitter = getClient();

  const me = await twitter.v2.me({
    'user.fields': ['public_metrics', 'description'],
  });

  const metrics = me.data.public_metrics;

  return {
    id: me.data.id,
    name: me.data.name,
    username: me.data.username,
    followers: metrics?.followers_count ?? 0,
    following: metrics?.following_count ?? 0,
    tweetCount: metrics?.tweet_count ?? 0,
  };
}

// ------------------------------------------------------------------
// Reply to a specific tweet
// ------------------------------------------------------------------
export async function replyToTweet(
  tweetId: string,
  text: string,
  taskId?: number
): Promise<{ id: string; text: string }> {
  const twitter = getClient();

  try {
    const result = await twitter.v2.reply(text, tweetId);
    const replyId = result.data.id;

    console.log(`[Twitter] Replied to ${tweetId} with ${replyId}`);

    await activityLogger.log({
      event_type: 'tweet_reply',
      agent_id: 'social-media',
      task_id: taskId,
      channel: 'twitter',
      summary: `Replied to tweet ${tweetId}: "${text.substring(0, 80)}"`,
      metadata: { reply_id: replyId, in_reply_to: tweetId },
    });

    return { id: replyId, text: result.data.text };
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(`Failed to reply: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Search recent tweets
// ------------------------------------------------------------------
export async function searchTweets(
  searchQuery: string,
  count: number = 20
): Promise<TweetV2[]> {
  const twitter = getClient();

  try {
    const results = await twitter.v2.search(searchQuery, {
      max_results: Math.min(Math.max(count, 10), 100),
      'tweet.fields': ['created_at', 'author_id', 'public_metrics', 'text'],
      'user.fields': ['username', 'name'],
      expansions: ['author_id'],
    });

    const users = results.includes?.users ?? [];
    const tweets = results.data?.data ?? [];

    // Attach username to tweets via author_id lookup
    for (const tweet of tweets) {
      const user = users.find((u: any) => u.id === tweet.author_id);
      if (user) {
        (tweet as any).author_username = user.username;
        (tweet as any).author_name = user.name;
      }
    }

    console.log(`[Twitter] Search "${searchQuery}": ${tweets.length} results`);
    return tweets;
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[Twitter] Search failed:', msg);
    throw new Error(`Failed to search tweets: ${msg}`);
  }
}

// ------------------------------------------------------------------
// Batch fetch tweet metrics (for analytics snapshots)
// ------------------------------------------------------------------
export interface TweetMetrics {
  id: string;
  likes: number;
  retweets: number;
  replies: number;
  impressions: number;
  bookmarks: number;
  quote_tweets: number;
}

export async function getTweetMetrics(tweetIds: string[]): Promise<TweetMetrics[]> {
  if (tweetIds.length === 0) return [];

  const twitter = getClient();
  const results: TweetMetrics[] = [];

  // X API allows up to 100 IDs per request
  const chunks: string[][] = [];
  for (let i = 0; i < tweetIds.length; i += 100) {
    chunks.push(tweetIds.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const response = await twitter.v2.tweets(chunk, {
        'tweet.fields': ['public_metrics'],
      });

      if (response.data) {
        for (const tweet of response.data) {
          const m = tweet.public_metrics;
          results.push({
            id: tweet.id,
            likes: m?.like_count ?? 0,
            retweets: m?.retweet_count ?? 0,
            replies: m?.reply_count ?? 0,
            impressions: m?.impression_count ?? 0,
            bookmarks: m?.bookmark_count ?? 0,
            quote_tweets: m?.quote_count ?? 0,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof ApiResponseError
        ? `Twitter API ${err.code}: ${err.data?.detail ?? err.message}`
        : (err as Error).message;
      console.error(`[Twitter] getTweetMetrics failed for chunk: ${msg}`);
      // Continue with other chunks rather than failing entirely
    }
  }

  return results;
}

// ------------------------------------------------------------------
// Like a tweet
// ------------------------------------------------------------------
export async function likeTweet(tweetId: string): Promise<void> {
  const twitter = getClient();
  const me = await twitter.v2.me();
  await twitter.v2.like(me.data.id, tweetId);
  console.log(`[Twitter] Liked tweet ${tweetId}`);
}

// ------------------------------------------------------------------
// Retweet
// ------------------------------------------------------------------
export async function retweet(tweetId: string): Promise<void> {
  const twitter = getClient();
  const me = await twitter.v2.me();
  await twitter.v2.retweet(me.data.id, tweetId);
  console.log(`[Twitter] Retweeted ${tweetId}`);
}
