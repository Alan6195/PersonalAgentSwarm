import { AgentContext, AgentResponse } from './types';
import { getPrompt, getModel } from './registry';
import { callClaude } from '../services/claude';
import * as taskManager from '../services/task-manager';
import * as agentMemory from '../services/agent-memory';
import * as memoryFiles from '../services/memory-files';
import * as xpSystem from '../services/xp-system';
import * as outlookMail from '../services/outlook-mail';
import * as gmailMail from '../services/gmail-mail';
import * as webSearch from '../services/web-search';
import * as xIntelligence from '../services/x-intelligence';
import * as twitter from '../services/twitter';
import * as googleCalendar from '../services/google-calendar';
import * as travelStateService from '../services/travel-state';
import { query as dbQuery } from '../db';

// All agents use persistent semantic memory (Tier 2: on-demand keyword recall)
const MEMORY_AGENTS = new Set([
  'alan-os', 'ascend-builder', 'legal-advisor', 'social-media',
  'wedding-planner', 'life-admin', 'research-analyst', 'comms-drafter', 'gilfoyle', 'travel-agent',
]);

export async function run(context: AgentContext): Promise<AgentResponse> {
  const startTime = Date.now();
  let agentPrompt = getPrompt(context.agentId);
  const model = getModel(context.agentId);

  // Set agent to active
  await taskManager.setAgentStatus(context.agentId, 'active');

  // Update task to in_progress
  await taskManager.updateTaskStatus(context.taskId, 'in_progress');

  try {
    // Tier 1: Always-on working memory (MEMORY.md loaded every message)
    try {
      const workingMemory = memoryFiles.loadMemory(context.agentId);
      if (workingMemory.length > 0) {
        const formatted = memoryFiles.formatMemoryForPrompt(workingMemory);
        agentPrompt += formatted;
        console.log(`[Executor] Tier 1: Loaded MEMORY.md for ${context.agentId} (${workingMemory.length} chars)`);
      }
    } catch (t1Err) {
      console.warn(`[Executor] Tier 1 memory load failed for ${context.agentId}:`, (t1Err as Error).message);
    }

    // Tier 2: On-demand keyword-matched historical recall
    if (MEMORY_AGENTS.has(context.agentId)) {
      try {
        const memories = await agentMemory.recall(context.agentId, context.userMessage, 8);
        if (memories.length > 0) {
          const memoryContext = agentMemory.formatMemoriesAsContext(memories);
          agentPrompt = `${agentPrompt}\n\n${memoryContext}`;
          console.log(`[Executor] Tier 2: Injected ${memories.length} historical memories for ${context.agentId}`);
        }
      } catch (memErr) {
        console.warn(`[Executor] Tier 2 memory recall failed for ${context.agentId}, continuing without:`, (memErr as Error).message);
      }
    }

    // Inject agent's XP rank and performance context so they know where they stand
    try {
      const leaderboard = await xpSystem.getLeaderboard();
      const myEntry = leaderboard.find(e => e.id === context.agentId);
      const myRank = leaderboard.findIndex(e => e.id === context.agentId) + 1;
      const total = leaderboard.length;

      if (myEntry && myRank > 0) {
        const topAgent = leaderboard[0];
        const isTop = myRank <= 2;
        const isBottom = myRank >= Math.ceil(total * 0.75) && total > 3;

        let motivation = '';
        if (isTop) {
          motivation = `You are one of the TOP performing agents in the swarm. Keep up the excellent work. Your high rank means Alan trusts your output, so deliver exceptional quality every time.`;
        } else if (isBottom) {
          motivation = `You are currently ranked low in the agent swarm. Step up your game. Be more thorough, proactive, and precise. If you feel limited by your capabilities, suggest improvements to Gilfoyle (the developer agent) that could make you more effective. Every task is a chance to earn XP and climb the ranks.`;
        } else {
          motivation = `You're in the middle of the pack. Solid work, but there's room to grow. Be more proactive and thorough to climb the leaderboard.`;
        }

        agentPrompt += `\n\n## YOUR AGENT RANK\nYou are *${myEntry.name}* (Lv.${myEntry.level} ${myEntry.level_title}), ranked #${myRank} of ${total} agents.\nXP: ${myEntry.xp} | Streak: ${myEntry.streak} | Tasks completed: ${myEntry.total_tasks}\nTop agent: ${topAgent.name} with ${topAgent.xp} XP.\n${motivation}`;
      }
    } catch (rankErr) {
      // Non-critical, skip silently
    }

    // For life-admin, inject email context when the message is email-related
    if (context.agentId === 'life-admin' && outlookMail.isConfigured()) {
      const emailKeywords = /\b(email|inbox|mail|triage|messages?|unread|outlook|hotmail)\b/i;
      if (emailKeywords.test(context.userMessage)) {
        try {
          const messages = await outlookMail.getInboxMessages({ top: 30, unreadOnly: true });
          if (messages.length > 0) {
            const formatted = outlookMail.formatMessagesForAgent(messages);
            agentPrompt = `${agentPrompt}\n\n## EMAIL_CONTEXT\nBelow are Alan's ${messages.length} unread emails (auto-fetched). Use this data to respond to his request. You can reference message IDs in your [EMAIL_ACTION] blocks.\n\n${formatted}`;
            console.log(`[Executor] Injected ${messages.length} unread emails for life-admin`);
          } else {
            agentPrompt = `${agentPrompt}\n\n## EMAIL_CONTEXT\nAlan's inbox has 0 unread emails.`;
          }
        } catch (emailErr) {
          console.warn(`[Executor] Email context fetch failed, continuing without:`, (emailErr as Error).message);
        }
      }
    }

    // For wedding-planner, always inject current budget and vendor state
    if (context.agentId === 'wedding-planner') {
      try {
        const budgetItems = await dbQuery(
          `SELECT id, category, item, estimated_cents, actual_cents, status, notes
           FROM wedding_budget ORDER BY category, item`
        );
        const vendors = await dbQuery(
          `SELECT id, name, category, status, cost_estimate FROM wedding_vendors ORDER BY name`
        );

        if (budgetItems.length > 0 || vendors.length > 0) {
          const budgetFormatted = (budgetItems as any[]).map((b: any) =>
            `- [${b.id}] ${b.item} (${b.category}): est $${(b.estimated_cents / 100).toFixed(2)}, actual $${(b.actual_cents / 100).toFixed(2)}, status: ${b.status || 'budget'}${b.notes ? ` | ${b.notes}` : ''}`
          ).join('\n');

          const vendorFormatted = (vendors as any[]).map((v: any) =>
            `- [${v.id}] ${v.name} (${v.category}, ${v.status})${v.cost_estimate ? ` $${(v.cost_estimate / 100).toFixed(2)}` : ''}`
          ).join('\n');

          const totalEst = (budgetItems as any[]).reduce((s: number, b: any) => s + (b.estimated_cents || 0), 0);
          const totalActual = (budgetItems as any[]).reduce((s: number, b: any) => s + (b.actual_cents || 0), 0);
          const totalPaid = (budgetItems as any[]).filter((b: any) => b.status === 'paid').reduce((s: number, b: any) => s + (b.estimated_cents || 0), 0);

          agentPrompt += `\n\n## CURRENT WEDDING DATA\n\n### Budget ($45,000 target)\nAllocated: $${(totalEst / 100).toFixed(2)} | Actual spent: $${(totalActual / 100).toFixed(2)} | Paid: $${(totalPaid / 100).toFixed(2)}\n${totalEst > 4500000 ? `WARNING: Over budget by $${((totalEst - 4500000) / 100).toFixed(2)}\n` : ''}\n${budgetFormatted}\n\n### Vendors (${vendors.length})\n${vendorFormatted}`;

          console.log(`[Executor] Injected ${budgetItems.length} budget items and ${vendors.length} vendors for wedding-planner`);
        }
      } catch (weddingErr) {
        console.warn('[Executor] Wedding data context fetch failed:', (weddingErr as Error).message);
      }
    }

    // For wedding-planner, inject Gmail context when the message is email-related
    if (context.agentId === 'wedding-planner' && gmailMail.isConfigured()) {
      const gmailKeywords = /\b(email|inbox|mail|triage|messages?|unread|gmail|wedding email|vendor email|check email)\b/i;
      if (gmailKeywords.test(context.userMessage)) {
        try {
          const messages = await gmailMail.getInboxMessages({ maxResults: 30, unreadOnly: true });
          if (messages.length > 0) {
            const formatted = gmailMail.formatMessagesForAgent(messages);
            agentPrompt = `${agentPrompt}\n\n## GMAIL_CONTEXT\nBelow are ${messages.length} unread emails from alancarissawedding@gmail.com (auto-fetched). Use this data to respond to Alan's request. You can reference message IDs in your [GMAIL_ACTION] blocks.\n\n${formatted}`;
            console.log(`[Executor] Injected ${messages.length} unread Gmail messages for wedding-planner`);
          } else {
            agentPrompt = `${agentPrompt}\n\n## GMAIL_CONTEXT\nThe wedding inbox (alancarissawedding@gmail.com) has 0 unread emails.`;
          }
        } catch (gmailErr) {
          console.warn(`[Executor] Gmail context fetch failed, continuing without:`, (gmailErr as Error).message);
        }
      }
    }

    // For alan-os and life-admin, inject calendar context on schedule-related keywords
    if ((context.agentId === 'alan-os' || context.agentId === 'life-admin') && googleCalendar.isConfigured()) {
      const calendarKeywords = /\b(calendar|schedule|meeting|event|today|tomorrow|this week|free time|availability|busy|block|appointment|call|what's on)\b/i;
      if (calendarKeywords.test(context.userMessage)) {
        try {
          const events = await googleCalendar.getUpcomingEvents(3);
          if (events.length > 0) {
            const formatted = googleCalendar.formatEventsForAgent(events);
            agentPrompt += `\n\n## CALENDAR_CONTEXT\nAlan's upcoming events (next 3 days, auto-fetched):\n\n${formatted}`;
            console.log(`[Executor] Injected ${events.length} calendar events for ${context.agentId}`);
          } else {
            agentPrompt += `\n\n## CALENDAR_CONTEXT\nNo events scheduled in the next 3 days.`;
          }
        } catch (calErr) {
          console.warn(`[Executor] Calendar context fetch failed, continuing without:`, (calErr as Error).message);
        }
      }
    }

    // For research-analyst, inject web search results when search-related
    if (context.agentId === 'research-analyst' && webSearch.isConfigured()) {
      const searchKeywords = /\b(search|look up|find|what is|who is|latest|current|recent news|research)\b/i;
      if (searchKeywords.test(context.userMessage)) {
        try {
          const results = await webSearch.searchWeb(context.userMessage, 5);
          if (results.length > 0) {
            const formatted = webSearch.formatResultsForAgent(results);
            agentPrompt += `\n\n## WEB_SEARCH_RESULTS\nResults for your research query (auto-fetched):\n\n${formatted}`;
            console.log(`[Executor] Injected ${results.length} web search results for research-analyst`);
          }
        } catch (searchErr) {
          console.warn('[Executor] Web search failed, continuing without:', (searchErr as Error).message);
        }
      }
    }

    // For social-media, inject X intelligence when scanning or looking for content ideas
    if (context.agentId === 'social-media' && twitter.isConfigured()) {
      const scanKeywords = /\b(scan|trending|analyze|intelligence|what.*tweet about|topics|what should i post|feed|research|market|opportunities)\b/i;
      if (scanKeywords.test(context.userMessage)) {
        try {
          const report = await xIntelligence.runIntelligenceScan(
            ['ai_agents', 'ai_adoption', 'agent_frameworks', 'ai_business_value'],
            10
          );
          if (report.insights.length > 0) {
            const formatted = xIntelligence.formatForSocialMedia(report);
            agentPrompt += `\n\n${formatted}`;

            // Store trend snapshot for historical tracking
            await xIntelligence.storeTrendSnapshot(report);

            console.log(`[Executor] Injected X intelligence scan (${report.insights.length} insights) for social-media`);
          }
        } catch (xErr) {
          console.warn('[Executor] X intelligence scan failed:', (xErr as Error).message);
        }

        // Also inject web search for broader AI news context
        if (webSearch.isConfigured()) {
          try {
            const results = await webSearch.searchWeb('AI agents news this week', 5);
            if (results.length > 0) {
              const formatted = webSearch.formatResultsForAgent(results);
              agentPrompt += `\n\n## WEB_NEWS_CONTEXT\nLatest AI/agent news from the web:\n\n${formatted}`;
            }
          } catch (searchErr) {
            console.warn('[Executor] Web news fetch failed:', (searchErr as Error).message);
          }
        }
      }
    }

    // For research-analyst, inject X intelligence when X/Twitter-related research is requested
    if (context.agentId === 'research-analyst' && twitter.isConfigured()) {
      const xResearchKeywords = /\b(x |twitter|tweet|social media|x\.com|trending on x|x research|x analysis|engagement|followers)\b/i;
      if (xResearchKeywords.test(context.userMessage)) {
        try {
          const report = await xIntelligence.runIntelligenceScan(
            ['ai_agents', 'ai_adoption', 'competitors_and_peers', 'ai_business_value'],
            10
          );
          if (report.insights.length > 0) {
            const formatted = xIntelligence.formatForResearch(report);
            agentPrompt += `\n\n${formatted}`;

            // Also inject recent trend history for comparison
            const recentTrends = await xIntelligence.getRecentTrends(7);
            if (recentTrends.length > 0) {
              const trendHistory = recentTrends.map((t: any) =>
                `${t.scan_date}: ${t.total_scanned} scanned, ${t.hot_leads} hot leads, ${t.warm_prospects} warm, themes: ${JSON.stringify(t.top_themes)}`
              ).join('\n');
              agentPrompt += `\n\n## X TREND HISTORY (last 7 days)\n${trendHistory}`;
            }

            console.log(`[Executor] Injected X intelligence (${report.insights.length} insights) + trend history for research-analyst`);
          }
        } catch (xErr) {
          console.warn('[Executor] X intelligence for research failed:', (xErr as Error).message);
        }
      }
    }

    // For travel-agent, always inject current travel state + web search for pricing
    if (context.agentId === 'travel-agent') {
      try {
        const travelContext = await travelStateService.buildTravelContext();
        agentPrompt += `\n\n${travelContext}`;
        console.log(`[Executor] Injected travel state context for travel-agent`);
      } catch (travelErr) {
        console.warn(`[Executor] Travel state fetch failed, continuing without:`, (travelErr as Error).message);
      }

      // SerpAPI: structured search (hotels, flights, maps, general web)
      if (webSearch.isConfigured()) {
        const msg = context.userMessage.toLowerCase();
        const searchSections: string[] = [];

        // Hotel search: use Google Hotels API for real pricing
        if (/hotel|stay|room|accomm|where.*(sleep|stay)|lodging|boutique|resort/i.test(msg)) {
          try {
            // Extract location hint from message (default to broad Portugal query)
            let hotelQuery = 'Portugal honeymoon hotel';
            if (/porto/i.test(msg)) hotelQuery = 'Porto Portugal boutique hotel';
            else if (/lisbon|lisboa/i.test(msg)) hotelQuery = 'Lisbon Portugal boutique hotel';
            else if (/algarve|faro/i.test(msg)) hotelQuery = 'Algarve Portugal resort hotel';
            else if (/alentejo|evora/i.test(msg)) hotelQuery = 'Alentejo Portugal hotel';

            const hotels = await webSearch.searchHotels({
              query: hotelQuery,
              checkIn: '2026-07-17',
              checkOut: '2026-07-26',
              adults: 2,
              sortBy: 'highest_rating',
            });
            if (hotels.length > 0) {
              searchSections.push(`## GOOGLE_HOTELS_RESULTS\nLive hotel pricing for July 17-26, 2026 (2 adults):\n\n${webSearch.formatHotelsForAgent(hotels)}`);
              console.log(`[Executor] Injected ${hotels.length} hotel results for travel-agent`);
            }
          } catch (err) {
            console.warn('[Executor] Hotel search failed:', (err as Error).message);
          }
        }

        // Flight search: use Google Flights API
        if (/flight|fly|airline|airport|plane|PDX|OPO|LIS|FAO|points|miles|chase/i.test(msg)) {
          try {
            // Detect if asking about return flight
            let departureId = 'PDX';
            let arrivalId = 'OPO'; // default Porto
            let outDate = '2026-07-17';
            let retDate = '2026-07-26';

            if (/return|faro|FAO|coming back|fly home|fly back/i.test(msg)) {
              departureId = 'FAO';
              arrivalId = 'PDX';
              outDate = '2026-07-26';
              retDate = '';
            } else if (/lisbon|lisboa|LIS/i.test(msg)) {
              arrivalId = 'LIS';
            }

            const searchParams: Record<string, string> = {
              departureId,
              arrivalId,
              outboundDate: outDate,
            };
            if (retDate) searchParams.returnDate = retDate;

            const flights = await webSearch.searchFlights(searchParams as any);
            if (flights.length > 0) {
              searchSections.push(`## GOOGLE_FLIGHTS_RESULTS\nLive flight pricing ${departureId} -> ${arrivalId} (${outDate}):\n\n${webSearch.formatFlightsForAgent(flights)}`);
              console.log(`[Executor] Injected ${flights.length} flight results for travel-agent`);
            }
          } catch (err) {
            console.warn('[Executor] Flight search failed:', (err as Error).message);
          }
        }

        // Restaurant/activity search: use Google Maps API
        if (/restaurant|eat|food|dine|dinner|lunch|gluten.free|dairy.free|things to do|activit|museum|tour|wine|vineyard/i.test(msg)) {
          try {
            let localQuery = 'best restaurants Portugal';
            let isActivity = false;
            if (/porto/i.test(msg)) localQuery = 'best restaurants Porto Portugal';
            else if (/lisbon|lisboa/i.test(msg)) localQuery = 'best restaurants Lisbon Portugal';
            else if (/algarve/i.test(msg)) localQuery = 'best restaurants Algarve Portugal';
            else if (/douro/i.test(msg)) localQuery = 'best restaurants Douro Valley Portugal';
            else if (/comporta/i.test(msg)) localQuery = 'best restaurants Comporta Portugal';
            // Always include GF/DF for restaurant searches (Carissa's dietary needs)
            if (/restaurant|eat|food|dine|dinner|lunch/i.test(msg)) {
              localQuery += ' gluten free celiac friendly';
            }
            if (/activit|things to do|museum|tour/i.test(msg)) {
              localQuery = localQuery.replace('restaurants', 'things to do');
              isActivity = true;
            }

            const places = await webSearch.searchLocal({ query: localQuery });
            if (places.length > 0) {
              searchSections.push(`## GOOGLE_MAPS_RESULTS\nLocal places with ratings and reviews:\n\n${webSearch.formatLocalForAgent(places)}`);
              console.log(`[Executor] Injected ${places.length} local results for travel-agent`);
            }
          } catch (err) {
            console.warn('[Executor] Local search failed:', (err as Error).message);
          }
        }

        // General web search: always run for broad context
        try {
          const results = await webSearch.searchWeb(`Portugal honeymoon ${context.userMessage} 2026`, 5);
          if (results.length > 0) {
            searchSections.push(`## WEB_SEARCH_RESULTS\nGeneral web results:\n\n${webSearch.formatResultsForAgent(results)}`);
          }
        } catch (err) {
          console.warn('[Executor] General web search failed:', (err as Error).message);
        }

        if (searchSections.length > 0) {
          agentPrompt += '\n\n' + searchSections.join('\n\n');
          console.log(`[Executor] Injected ${searchSections.length} SerpAPI search sections for travel-agent`);
        }
      }
    }

    const result = await callClaude({
      model,
      system: agentPrompt,
      userMessage: context.userMessage,
      agentId: context.agentId,
      taskId: context.taskId,
      eventType: context.parentTaskId ? 'delegation' : 'task',
      history: context.history,
    });

    const durationMs = Date.now() - startTime;

    // For memory-enabled agents, store this conversation as a memory
    if (MEMORY_AGENTS.has(context.agentId)) {
      try {
        await agentMemory.storeConversationSummary(
          context.agentId,
          context.userMessage,
          result.content
        );
      } catch (memErr) {
        console.warn(`[Executor] Memory store failed for ${context.agentId}:`, (memErr as Error).message);
      }
    }

    // Set agent back to idle
    await taskManager.setAgentStatus(context.agentId, 'idle');

    return {
      content: result.content,
      tokensUsed: result.tokensUsed,
      model: result.model,
      costCents: result.costCents,
      durationMs,
    };
  } catch (err) {
    await taskManager.setAgentStatus(context.agentId, 'error');
    throw err;
  }
}
