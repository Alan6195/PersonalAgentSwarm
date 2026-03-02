import * as twitter from './twitter';
import * as runway from './runway';
import * as imageStrategy from './image-strategy';
import type { ImageStyle } from './image-strategy';
import * as xIntelligence from './x-intelligence';
import { recordPost } from './analytics-ingestion';

export interface TwitterActionResult {
  actionTaken: boolean;
  actionType: string;
  result: string;
  originalResponse: string;
}

/**
 * Parse and execute any [ACTION:...] blocks in agent response.
 * Returns the modified response (action blocks replaced with results).
 */
export async function processTwitterActions(
  agentResponse: string,
  taskId?: number,
  cronJobName?: string
): Promise<TwitterActionResult> {
  // Check if X is configured
  if (!twitter.isConfigured()) {
    // Strip action blocks and append a note
    const cleaned = agentResponse
      .replace(/\[ACTION:(TWEET_WITH_VIDEO|TWEET_WITH_IMAGE|TWEET|THREAD|REPLY|MENTIONS|TIMELINE|PROFILE|SEARCH)[^\]]*\]/g, '')
      .trim();
    return {
      actionTaken: false,
      actionType: 'none',
      result: cleaned + '\n\n(X/Twitter integration not configured yet; no action taken)',
      originalResponse: agentResponse,
    };
  }

  // ------------------------------------------------------------------
  // [ACTION:TWEET_WITH_IMAGE]
  // IMAGE_STYLE: photo | illustration | abstract (optional)
  // IMAGE_PROMPT: description of the image to generate/search
  // TWEET: the tweet text
  // ------------------------------------------------------------------
  const imageMatch = agentResponse.match(
    /\[ACTION:TWEET_WITH_IMAGE\]\s*(?:IMAGE_STYLE:\s*(\S+)\s*\n)?IMAGE_PROMPT:\s*(.+?)\s*\nTWEET:\s*(.+?)(?:\n\n|\[ACTION:|$)/s
  );
  if (imageMatch) {
    const rawStyle = imageMatch[1]?.trim()?.toLowerCase();
    const imageStyle: ImageStyle | undefined =
      rawStyle === 'photo' || rawStyle === 'illustration' || rawStyle === 'abstract'
        ? rawStyle
        : undefined;
    const imagePrompt = imageMatch[2].trim();
    const tweetText = imageMatch[3].trim();

    // Regex to strip the full action block from response
    const stripRegex = /\[ACTION:TWEET_WITH_IMAGE\]\s*(?:IMAGE_STYLE:\s*\S+\s*\n)?IMAGE_PROMPT:\s*.+?\s*\nTWEET:\s*.+?(?:\n\n|\[ACTION:|$)/s;

    try {
      // Generate image via multi-provider strategy
      const imageResult = await imageStrategy.generateImage(imageStyle, imagePrompt);

      let mediaId: string;
      if (imageResult.provider === 'none') {
        throw new Error('All image providers failed');
      } else if (imageResult.buffer) {
        // GPT Image 1 returns a buffer
        mediaId = await twitter.uploadMediaFromBuffer(imageResult.buffer, 'image/png', 'image');
      } else if (imageResult.url) {
        // Unsplash returns a URL
        mediaId = await twitter.uploadMediaFromUrl(imageResult.url, 'image');
      } else {
        throw new Error('Image result has neither buffer nor URL');
      }

      // Post tweet with media
      const posted = await twitter.postTweetWithMedia(tweetText, mediaId, taskId);
      // Record for analytics (fire-and-forget)
      recordPost({ tweetId: posted.id, content: tweetText, contentType: 'tweet_with_image', hasMedia: true, mediaType: 'image', taskId, cronJobName }).catch(e => console.warn('[Analytics] recordPost failed:', e.message));
      const cleanResponse = agentResponse.replace(stripRegex, '').trim();
      const providerNote = imageResult.photographer
        ? ` (photo by ${imageResult.photographer})`
        : ` (via ${imageResult.provider})`;
      return {
        actionTaken: true,
        actionType: 'tweet_with_image',
        result: `${cleanResponse}\n\nPosted to X with image${providerNote}: "${posted.text}"\nhttps://x.com/i/status/${posted.id}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      // Fallback: try posting without image
      console.error(`[TwitterActions] Image generation/upload failed, posting text-only: ${(err as Error).message}`);
      try {
        const posted = await twitter.postTweet(tweetText, taskId);
        recordPost({ tweetId: posted.id, content: tweetText, contentType: 'tweet', taskId, cronJobName }).catch(e => console.warn('[Analytics] recordPost failed:', e.message));
        const cleanResponse = agentResponse.replace(stripRegex, '').trim();
        return {
          actionTaken: true,
          actionType: 'tweet_image_fallback',
          result: `${cleanResponse}\n\nPosted to X (image failed, text only): "${posted.text}"\nhttps://x.com/i/status/${posted.id}\n(Image error: ${(err as Error).message})`.trim(),
          originalResponse: agentResponse,
        };
      } catch (tweetErr) {
        return {
          actionTaken: false,
          actionType: 'tweet_with_image_failed',
          result: `${agentResponse}\n\nFailed to post: ${(tweetErr as Error).message}`,
          originalResponse: agentResponse,
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:TWEET_WITH_VIDEO]
  // VIDEO_PROMPT: description of the video to generate
  // TWEET: the tweet text
  // ------------------------------------------------------------------
  const videoMatch = agentResponse.match(
    /\[ACTION:TWEET_WITH_VIDEO\]\s*VIDEO_PROMPT:\s*(.+?)\s*\nTWEET:\s*(.+?)(?:\n\n|\[ACTION:|$)/s
  );
  if (videoMatch) {
    const videoPrompt = videoMatch[1].trim();
    const tweetText = videoMatch[2].trim();
    try {
      // Generate video via Runway
      const videoUrl = await runway.generateVideo(videoPrompt);
      // Upload to Twitter
      const mediaId = await twitter.uploadMediaFromUrl(videoUrl, 'video');
      // Post tweet with media
      const posted = await twitter.postTweetWithMedia(tweetText, mediaId, taskId);
      recordPost({ tweetId: posted.id, content: tweetText, contentType: 'tweet_with_video', hasMedia: true, mediaType: 'video', taskId, cronJobName }).catch(e => console.warn('[Analytics] recordPost failed:', e.message));
      const cleanResponse = agentResponse.replace(
        /\[ACTION:TWEET_WITH_VIDEO\]\s*VIDEO_PROMPT:\s*.+?\s*\nTWEET:\s*.+?(?:\n\n|\[ACTION:|$)/s,
        ''
      ).trim();
      return {
        actionTaken: true,
        actionType: 'tweet_with_video',
        result: `${cleanResponse}\n\nPosted to X with video: "${posted.text}"\nhttps://x.com/i/status/${posted.id}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      // Fallback: try posting without video
      console.error(`[TwitterActions] Video generation/upload failed, posting text-only: ${(err as Error).message}`);
      try {
        const posted = await twitter.postTweet(tweetText, taskId);
        recordPost({ tweetId: posted.id, content: tweetText, contentType: 'tweet', taskId, cronJobName }).catch(e => console.warn('[Analytics] recordPost failed:', e.message));
        const cleanResponse = agentResponse.replace(
          /\[ACTION:TWEET_WITH_VIDEO\]\s*VIDEO_PROMPT:\s*.+?\s*\nTWEET:\s*.+?(?:\n\n|\[ACTION:|$)/s,
          ''
        ).trim();
        return {
          actionTaken: true,
          actionType: 'tweet_video_fallback',
          result: `${cleanResponse}\n\nPosted to X (video failed, text only): "${posted.text}"\nhttps://x.com/i/status/${posted.id}\n(Video error: ${(err as Error).message})`.trim(),
          originalResponse: agentResponse,
        };
      } catch (tweetErr) {
        return {
          actionTaken: false,
          actionType: 'tweet_with_video_failed',
          result: `${agentResponse}\n\nFailed to post: ${(tweetErr as Error).message}`,
          originalResponse: agentResponse,
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:TWEET] text
  // ------------------------------------------------------------------
  const tweetMatch = agentResponse.match(/\[ACTION:TWEET\]\s*(.+?)(?:\n\n|\[ACTION:|$)/s);
  if (tweetMatch) {
    const tweetText = tweetMatch[1].trim();
    try {
      const posted = await twitter.postTweet(tweetText, taskId);
      recordPost({ tweetId: posted.id, content: tweetText, contentType: 'tweet', taskId, cronJobName }).catch(e => console.warn('[Analytics] recordPost failed:', e.message));
      const cleanResponse = agentResponse.replace(
        /\[ACTION:TWEET\]\s*.+?(?:\n\n|\[ACTION:|$)/s,
        ''
      ).trim();
      return {
        actionTaken: true,
        actionType: 'tweet',
        result: `${cleanResponse}\n\nPosted to X: "${posted.text}"\nhttps://x.com/i/status/${posted.id}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      return {
        actionTaken: false,
        actionType: 'tweet_failed',
        result: `${agentResponse}\n\nFailed to post: ${(err as Error).message}`,
        originalResponse: agentResponse,
      };
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:THREAD]
  // 1. first tweet
  // 2. second tweet
  // ------------------------------------------------------------------
  const threadMatch = agentResponse.match(/\[ACTION:THREAD\]\s*([\s\S]+?)(?:\n\n(?!\d+\.)|\[ACTION:|$)/);
  if (threadMatch) {
    const lines = threadMatch[1].trim().split('\n');
    const tweets: string[] = [];
    for (const line of lines) {
      const cleaned = line.replace(/^\d+\.\s*/, '').trim();
      if (cleaned) tweets.push(cleaned);
    }

    if (tweets.length > 0) {
      try {
        const posted = await twitter.postThread(tweets, taskId);
        // Record each tweet in the thread for analytics
        const threadId = posted.ids[0];
        for (let i = 0; i < posted.ids.length; i++) {
          recordPost({
            tweetId: posted.ids[i],
            threadId,
            content: posted.texts[i] || tweets[i],
            contentType: i === 0 ? 'thread' : 'reply',
            taskId,
            cronJobName,
          }).catch(e => console.warn('[Analytics] recordPost failed:', e.message));
        }
        const cleanResponse = agentResponse.replace(
          /\[ACTION:THREAD\]\s*[\s\S]+?(?:\n\n(?!\d+\.)|\[ACTION:|$)/,
          ''
        ).trim();
        return {
          actionTaken: true,
          actionType: 'thread',
          result: `${cleanResponse}\n\nPosted thread (${posted.ids.length} tweets) to X:\nhttps://x.com/i/status/${posted.ids[0]}`.trim(),
          originalResponse: agentResponse,
        };
      } catch (err) {
        return {
          actionTaken: false,
          actionType: 'thread_failed',
          result: `${agentResponse}\n\nFailed to post thread: ${(err as Error).message}`,
          originalResponse: agentResponse,
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:REPLY:tweet_id] text
  // ------------------------------------------------------------------
  const replyMatch = agentResponse.match(/\[ACTION:REPLY:(\d+)\]\s*(.+?)(?:\n\n|\[ACTION:|$)/s);
  if (replyMatch) {
    const tweetId = replyMatch[1];
    const replyText = replyMatch[2].trim();
    try {
      const posted = await twitter.replyToTweet(tweetId, replyText, taskId);
      recordPost({ tweetId: posted.id, content: replyText, contentType: 'reply', taskId, cronJobName }).catch(e => console.warn('[Analytics] recordPost failed:', e.message));
      const cleanResponse = agentResponse.replace(
        /\[ACTION:REPLY:\d+\]\s*.+?(?:\n\n|\[ACTION:|$)/s,
        ''
      ).trim();
      return {
        actionTaken: true,
        actionType: 'reply',
        result: `${cleanResponse}\n\nReplied to tweet:\nhttps://x.com/i/status/${posted.id}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      return {
        actionTaken: false,
        actionType: 'reply_failed',
        result: `${agentResponse}\n\nFailed to reply: ${(err as Error).message}`,
        originalResponse: agentResponse,
      };
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:INTEL_SCAN] - Full intelligence scan (new, preferred)
  // [ACTION:INTEL_SCAN:topic1,topic2]
  // ------------------------------------------------------------------
  const intelMatch = agentResponse.match(/\[ACTION:INTEL_SCAN(?::([^\]]+))?\]/);
  if (intelMatch) {
    const topics = intelMatch[1]
      ? intelMatch[1].split(',').map(t => t.trim())
      : ['ai_agents', 'ai_adoption', 'agent_frameworks'];
    try {
      const report = await xIntelligence.runIntelligenceScan(topics);
      const formatted = xIntelligence.formatForSocialMedia(report);

      // Store trend snapshot for historical tracking
      await xIntelligence.storeTrendSnapshot(report);

      const cleanResponse = agentResponse.replace(/\[ACTION:INTEL_SCAN[^\]]*\]/, '').trim();
      return {
        actionTaken: true,
        actionType: 'intel_scan',
        result: `${cleanResponse}\n\n${formatted}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      return {
        actionTaken: false,
        actionType: 'intel_scan_failed',
        result: `${agentResponse}\n\nIntelligence scan failed: ${(err as Error).message}`,
        originalResponse: agentResponse,
      };
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:SEARCH:query] - with improved classification
  // ------------------------------------------------------------------
  const searchMatch = agentResponse.match(/\[ACTION:SEARCH:(.+?)\]/);
  if (searchMatch) {
    const searchQuery = searchMatch[1].trim();
    try {
      const tweets = await twitter.searchTweets(searchQuery, 20);
      const formatted = xIntelligence.formatSearchResults(tweets, searchQuery);

      const cleanResponse = agentResponse.replace(/\[ACTION:SEARCH:.+?\]/, '').trim();
      return {
        actionTaken: true,
        actionType: 'search',
        result: `${cleanResponse}\n\n${formatted}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      return {
        actionTaken: false,
        actionType: 'search_failed',
        result: `${agentResponse}\n\nFailed to search: ${(err as Error).message}`,
        originalResponse: agentResponse,
      };
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:MENTIONS]
  // ------------------------------------------------------------------
  if (agentResponse.includes('[ACTION:MENTIONS]')) {
    try {
      const mentions = await twitter.getRecentMentions(10);
      const formatted = mentions.length > 0
        ? mentions.map((m, i) => `${i + 1}. @${m.author_id}: "${m.text?.substring(0, 120)}" (${m.created_at ?? 'unknown'})`).join('\n')
        : 'No recent mentions found.';

      const cleanResponse = agentResponse.replace('[ACTION:MENTIONS]', '').trim();
      return {
        actionTaken: true,
        actionType: 'mentions',
        result: `${cleanResponse}\n\nRecent Mentions:\n${formatted}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      return {
        actionTaken: false,
        actionType: 'mentions_failed',
        result: `${agentResponse}\n\nFailed to fetch mentions: ${(err as Error).message}`,
        originalResponse: agentResponse,
      };
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:TIMELINE]
  // ------------------------------------------------------------------
  if (agentResponse.includes('[ACTION:TIMELINE]')) {
    try {
      const tweets = await twitter.getMyRecentTweets(10);
      const formatted = tweets.length > 0
        ? tweets.map((t, i) => {
            const metrics = t.public_metrics;
            const stats = metrics
              ? `${metrics.like_count} likes, ${metrics.retweet_count} RTs, ${metrics.reply_count} replies`
              : 'no metrics';
            return `${i + 1}. "${t.text?.substring(0, 100)}" (${stats})`;
          }).join('\n')
        : 'No recent tweets found.';

      const cleanResponse = agentResponse.replace('[ACTION:TIMELINE]', '').trim();
      return {
        actionTaken: true,
        actionType: 'timeline',
        result: `${cleanResponse}\n\nRecent Tweets:\n${formatted}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      return {
        actionTaken: false,
        actionType: 'timeline_failed',
        result: `${agentResponse}\n\nFailed to fetch timeline: ${(err as Error).message}`,
        originalResponse: agentResponse,
      };
    }
  }

  // ------------------------------------------------------------------
  // [ACTION:PROFILE]
  // ------------------------------------------------------------------
  if (agentResponse.includes('[ACTION:PROFILE]')) {
    try {
      const profile = await twitter.getProfile();
      const formatted = [
        `@${profile.username} (${profile.name})`,
        `Followers: ${profile.followers.toLocaleString()}`,
        `Following: ${profile.following.toLocaleString()}`,
        `Total Tweets: ${profile.tweetCount.toLocaleString()}`,
      ].join('\n');

      const cleanResponse = agentResponse.replace('[ACTION:PROFILE]', '').trim();
      return {
        actionTaken: true,
        actionType: 'profile',
        result: `${cleanResponse}\n\nX Profile:\n${formatted}`.trim(),
        originalResponse: agentResponse,
      };
    } catch (err) {
      return {
        actionTaken: false,
        actionType: 'profile_failed',
        result: `${agentResponse}\n\nFailed to fetch profile: ${(err as Error).message}`,
        originalResponse: agentResponse,
      };
    }
  }

  // No action blocks found; return response as-is
  return {
    actionTaken: false,
    actionType: 'none',
    result: agentResponse,
    originalResponse: agentResponse,
  };
}
