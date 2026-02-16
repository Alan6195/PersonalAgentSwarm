import { config } from '../config';
import { RoutingDecision } from './types';
import { callClaude } from '../services/claude';
import * as executor from './executor';
import * as taskManager from '../services/task-manager';
import * as activityLogger from '../services/activity-logger';
import { processTwitterActions } from '../services/twitter-actions';
import { processEmailActions } from '../services/email-actions';
import { processGmailActions } from '../services/gmail-actions';
import { processWeddingDataActions } from '../services/wedding-data-actions';
import { processTravelActions } from '../services/travel-actions';
import { executeDeveloperTask } from '../services/developer-executor';
import { getPrompt } from './registry';
import * as memory from '../services/conversation-memory';

// Ship mode detection pattern
const SHIP_MODE_PATTERN = /\/ship|build.*overnight|gilfoyle.*work.*overnight|night\s*shift|autonomous.*build|full\s*build|ship\s*mode/i;

// Progress notifier (wired from index.ts)
let progressNotifier: ((text: string) => Promise<void>) | null = null;

export function setProgressNotifier(notifier: (text: string) => Promise<void>): void {
  progressNotifier = notifier;
}

const ROUTING_PROMPT = `You are Alan OS, a routing AI. Your job is to classify an incoming message and decide how to handle it.

Option 1: Respond directly (general chat, quick questions, greetings, status checks)
Option 2: Delegate to a single specialist agent
Option 3: Multi-delegate to 2-3 agents in parallel (for complex requests that span multiple domains, then alan-os will synthesize their results)

Available specialist agents:
- ascend-builder: Ascend Intuition, Ship Protocol, app development, technical architecture
- legal-advisor: Custody, co-parenting, Carrie, Theo, Lyla, parenting plan, child support, drafting responses to the ex, legal matters, contracts. ALWAYS delegate when Alan mentions Carrie, the kids' mom, custody, co-parenting, parenting time, child support, or asks to draft/respond to a text or email from his ex
- social-media: X/Twitter posting, content creation, feed scanning, engagement. ALWAYS delegate when Alan says "tweet", "post to X", "thread about", "scan the feed", "what should I tweet", "check my mentions", or anything about X/Twitter content
- wedding-planner: July 12 2026 wedding coordination with Jade, wedding email management, vendor emails. ALWAYS delegate when Alan says "wedding email", "check wedding inbox", "wedding vendor", "email the florist/DJ/photographer/caterer/venue"
- life-admin: Finances, custody schedule, household, personal logistics, email management, inbox triage, email cleanup. ALWAYS delegate when Alan says "check my email", "clean my inbox", "email triage", or anything about managing email
- research-analyst: Deep research, competitive intel, market analysis, web search, X/Twitter trend analysis. ALWAYS delegate when Alan says "analyze X", "X trends", "Twitter analysis", "research the X feed", "what's trending on X", or requests analysis of social media data/trends
- comms-drafter: Email drafting, Slack messages, proposals, written communications
- gilfoyle: Code changes, bug fixes, new features, file reading/editing, shell commands, codebase operations, git, npm, docker
- travel-agent: Portugal honeymoon trip planning (July 16-26, 2026). Hotels, activities, restaurants, transport, booking. ALWAYS delegate when Alan mentions "honeymoon", "Portugal trip", "travel", "hotels in Portugal", "Porto", "Lisbon", "Algarve", "Faro", or anything about the honeymoon itinerary

Respond with ONLY valid JSON (no markdown, no backticks):
{
  "action": "respond_directly" or "delegate" or "multi_delegate",
  "target_agent_id": "<agent-id if single delegate, omit otherwise>",
  "target_agent_ids": ["<agent-id-1>", "<agent-id-2>"] (only for multi_delegate),
  "reasoning": "<brief one-sentence reasoning>",
  "priority": "urgent" or "high" or "normal" or "low",
  "domain": "<optional domain tag>",
  "task_title": "<short 5-8 word task title>"
}`;

async function routeMessage(userMessage: string, taskId: number): Promise<RoutingDecision> {
  const result = await callClaude({
    model: config.ROUTER_MODEL,
    system: ROUTING_PROMPT,
    userMessage,
    agentId: 'alan-os',
    taskId,
    eventType: 'task',
    maxTokens: 256,
  });

  try {
    return JSON.parse(result.content) as RoutingDecision;
  } catch {
    // If routing fails to parse, default to responding directly
    console.warn('[Router] Failed to parse routing decision, defaulting to direct response');
    return {
      action: 'respond_directly',
      reasoning: 'Routing parse failed, handling directly',
      priority: 'normal',
      task_title: 'Direct response',
    };
  }
}

export async function handleUserMessage(
  userMessage: string,
  telegramMessageId: number,
  chatId?: number
): Promise<string> {
  const effectiveChatId = chatId ?? telegramMessageId;

  // 0. Record user message in conversation memory
  memory.addUserMessage(effectiveChatId, userMessage);

  // 1. Create parent task
  const task = await taskManager.createTask({
    title: `Telegram: ${userMessage.substring(0, 80)}`,
    description: userMessage,
    status: 'in_progress',
    priority: 'normal',
    assigned_agent: 'alan-os',
    input_summary: userMessage,
    metadata: { telegram_message_id: telegramMessageId, channel: 'telegram' },
  });

  // 2. Log message received
  await activityLogger.log({
    event_type: 'message_received',
    agent_id: 'alan-os',
    task_id: task.id,
    channel: 'telegram',
    summary: `Received: "${userMessage.substring(0, 100)}"`,
  });

  // 3. Set alan-os active
  await taskManager.setAgentStatus('alan-os', 'active');

  try {
    // 4. Check if this is a follow-up to the last agent conversation
    const isFollowUpMsg = memory.isFollowUp(userMessage, effectiveChatId);
    const lastAgent = memory.getLastAgentId(effectiveChatId);
    const history = memory.getHistory(effectiveChatId);
    // Remove the current message from history (it was just added; we pass it separately)
    const priorHistory = history.slice(0, -1);

    let routing: RoutingDecision;

    if (isFollowUpMsg && lastAgent) {
      // Skip the router: send directly to the agent that handled the last message
      console.log(`[Router] Follow-up detected, routing directly to ${lastAgent}: "${userMessage.substring(0, 60)}"`);
      routing = {
        action: lastAgent === 'alan-os' ? 'respond_directly' : 'delegate',
        target_agent_id: lastAgent === 'alan-os' ? undefined : lastAgent,
        reasoning: `Follow-up to previous ${lastAgent} conversation`,
        priority: 'normal',
        task_title: 'Follow-up response',
      };

      await activityLogger.log({
        event_type: 'follow_up_detected',
        agent_id: 'alan-os',
        task_id: task.id,
        channel: 'telegram',
        summary: `Follow-up routed to ${lastAgent}: "${userMessage.substring(0, 80)}"`,
      });
    } else {
      // Normal routing through the LLM router
      routing = await routeMessage(userMessage, task.id);
    }

    // Update parent task with routing info
    await taskManager.updateTaskStatus(task.id, 'in_progress');

    let finalResponse: string;
    let totalTokens = 0;
    let totalCost = 0;
    let respondingAgent: string;
    const startTime = Date.now();

    if (routing.action === 'delegate' && routing.target_agent_id) {
      respondingAgent = routing.target_agent_id;

      // 5a. Delegate to specialist
      const subTask = await taskManager.createTask({
        title: routing.task_title,
        description: userMessage,
        status: 'pending',
        priority: routing.priority,
        domain: routing.domain,
        assigned_agent: routing.target_agent_id,
        delegated_by: 'alan-os',
        parent_task_id: task.id,
        input_summary: userMessage,
      });

      await activityLogger.log({
        event_type: 'task_delegated',
        agent_id: 'alan-os',
        task_id: subTask.id,
        channel: 'telegram',
        summary: `Delegated to ${routing.target_agent_id}: ${routing.task_title}`,
        metadata: { reasoning: routing.reasoning },
      });

      if (routing.target_agent_id === 'gilfoyle') {
        // Gilfoyle agent: uses Agent SDK agentic loop with tool use
        await taskManager.setAgentStatus('gilfoyle', 'active');
        await taskManager.updateTaskStatus(subTask.id, 'in_progress');

        // Detect ship mode from message keywords
        const isShipMode = SHIP_MODE_PATTERN.test(userMessage);
        if (isShipMode) {
          console.log(`[Router] Ship mode activated for Gilfoyle`);
          await activityLogger.log({
            event_type: 'ship_mode_activated',
            agent_id: 'gilfoyle',
            task_id: subTask.id,
            channel: 'telegram',
            summary: `Ship mode: ${userMessage.substring(0, 100)}`,
          });
        }

        const devResult = await executeDeveloperTask(
          userMessage,
          getPrompt('gilfoyle'),
          config.DEV_AGENT_CWD,
          {
            shipMode: isShipMode,
            onProgress: progressNotifier ?? undefined,
          }
        );

        finalResponse = devResult.content;
        totalTokens = devResult.totalTokens;
        totalCost = Math.ceil(devResult.totalCostUsd * 100);

        // Append file modification summary
        if (devResult.filesModified.length > 0) {
          finalResponse += `\n\nFiles modified:\n${devResult.filesModified.map(f => '- ' + f).join('\n')}`;
        }

        // Ship mode: append cost/turns summary
        if (isShipMode) {
          finalResponse += `\n\nShip mode summary: ${devResult.numTurns} turns, $${devResult.totalCostUsd.toFixed(2)}, ${devResult.filesModified.length} files`;
        }

        await activityLogger.log({
          event_type: 'developer_action',
          agent_id: 'gilfoyle',
          task_id: subTask.id,
          channel: 'telegram',
          summary: `Dev task${isShipMode ? ' [SHIP]' : ''} (${devResult.numTurns} turns, ${devResult.durationMs}ms): ${userMessage.substring(0, 100)}`,
          metadata: {
            files_modified: devResult.filesModified,
            num_turns: devResult.numTurns,
            cost_usd: devResult.totalCostUsd,
            ship_mode: isShipMode,
          },
        });

        await taskManager.setAgentStatus('gilfoyle', 'idle');

        // Complete sub-task
        await taskManager.completeTask(subTask.id, {
          content: devResult.content,
          tokensUsed: devResult.totalTokens,
          costCents: Math.ceil(devResult.totalCostUsd * 100),
          durationMs: devResult.durationMs,
        });
      } else {
        // All other agents: single-shot executor (with history)
        const agentResponse = await executor.run({
          agentId: routing.target_agent_id,
          taskId: subTask.id,
          parentTaskId: task.id,
          userMessage,
          history: priorHistory,
        });

        finalResponse = agentResponse.content;
        totalTokens = agentResponse.tokensUsed.total;
        totalCost = agentResponse.costCents;

        // If social-media agent, process any X/Twitter action blocks
        if (routing.target_agent_id === 'social-media') {
          const twitterResult = await processTwitterActions(finalResponse, subTask.id);
          finalResponse = twitterResult.result;
          if (twitterResult.actionTaken) {
            await activityLogger.log({
              event_type: 'twitter_action',
              agent_id: 'social-media',
              task_id: subTask.id,
              channel: 'twitter',
              summary: `X action: ${twitterResult.actionType}`,
              metadata: { action_type: twitterResult.actionType },
            });
          }
        }

        // If life-admin agent, process any email action blocks
        if (routing.target_agent_id === 'life-admin') {
          const emailResult = await processEmailActions(finalResponse, subTask.id);
          finalResponse = emailResult.result;
          if (emailResult.actionsTaken) {
            await activityLogger.log({
              event_type: 'email_action',
              agent_id: 'life-admin',
              task_id: subTask.id,
              channel: 'email',
              summary: `Email actions: ${emailResult.actions.join(', ')}`,
              metadata: { actions: emailResult.actions },
            });
          }
        }

        // If wedding-planner agent, process any Gmail action blocks
        if (routing.target_agent_id === 'wedding-planner') {
          const gmailResult = await processGmailActions(finalResponse, subTask.id);
          finalResponse = gmailResult.result;
          if (gmailResult.actionsTaken) {
            await activityLogger.log({
              event_type: 'gmail_action',
              agent_id: 'wedding-planner',
              task_id: subTask.id,
              channel: 'gmail',
              summary: `Gmail actions: ${gmailResult.actions.join(', ')}`,
              metadata: { actions: gmailResult.actions },
            });
          }

          // Also process any wedding dashboard data blocks
          const weddingDataResult = await processWeddingDataActions(finalResponse, subTask.id);
          finalResponse = weddingDataResult.result;
          if (weddingDataResult.actionsTaken) {
            await activityLogger.log({
              event_type: 'wedding_data_update',
              agent_id: 'wedding-planner',
              task_id: subTask.id,
              channel: 'wedding',
              summary: `Wedding data: ${weddingDataResult.actions.join(', ')}`,
              metadata: { actions: weddingDataResult.actions },
            });
          }
        }

        // If travel-agent, process any travel data action blocks
        if (routing.target_agent_id === 'travel-agent') {
          const travelResult = await processTravelActions(finalResponse, subTask.id);
          finalResponse = travelResult.result;
          if (travelResult.actionsTaken) {
            await activityLogger.log({
              event_type: 'travel_data_update',
              agent_id: 'travel-agent',
              task_id: subTask.id,
              channel: 'travel',
              summary: `Travel data: ${travelResult.actions.join(', ')}`,
              metadata: { actions: travelResult.actions },
            });
          }
        }

        // Complete sub-task
        await taskManager.completeTask(subTask.id, {
          content: agentResponse.content,
          tokensUsed: agentResponse.tokensUsed.total,
          costCents: agentResponse.costCents,
          durationMs: agentResponse.durationMs,
        });
      }
    } else if (routing.action === 'multi_delegate' && routing.target_agent_ids && routing.target_agent_ids.length > 0) {
      respondingAgent = 'alan-os';

      // 5b. Multi-delegate: run multiple agents in parallel, then synthesize
      await activityLogger.log({
        event_type: 'multi_delegate',
        agent_id: 'alan-os',
        task_id: task.id,
        channel: 'telegram',
        summary: `Multi-delegate to: ${routing.target_agent_ids.join(', ')}`,
        metadata: { agents: routing.target_agent_ids, reasoning: routing.reasoning },
      });

      // Run all agents in parallel
      const agentResults = await Promise.all(
        routing.target_agent_ids.map(async (agentId) => {
          const subTask = await taskManager.createTask({
            title: `${routing.task_title} (${agentId})`,
            description: userMessage,
            status: 'pending',
            priority: routing.priority,
            domain: routing.domain,
            assigned_agent: agentId,
            delegated_by: 'alan-os',
            parent_task_id: task.id,
            input_summary: userMessage,
          });

          try {
            const response = await executor.run({
              agentId,
              taskId: subTask.id,
              parentTaskId: task.id,
              userMessage,
              history: priorHistory,
            });

            await taskManager.completeTask(subTask.id, {
              content: response.content,
              tokensUsed: response.tokensUsed.total,
              costCents: response.costCents,
              durationMs: response.durationMs,
            });

            return { agentId, content: response.content, costCents: response.costCents, tokens: response.tokensUsed.total };
          } catch (err) {
            await taskManager.failTask(subTask.id, (err as Error).message);
            return { agentId, content: `Error: ${(err as Error).message}`, costCents: 0, tokens: 0 };
          }
        })
      );

      // Accumulate costs
      for (const r of agentResults) {
        totalTokens += r.tokens;
        totalCost += r.costCents;
      }

      // Synthesize results with alan-os
      const synthesisPrompt = agentResults
        .map(r => `## ${r.agentId} response:\n${r.content}`)
        .join('\n\n');

      const synthesisResponse = await executor.run({
        agentId: 'alan-os',
        taskId: task.id,
        userMessage: `Synthesize these agent responses into a unified answer for the user.\n\nOriginal request: ${userMessage}\n\n${synthesisPrompt}`,
        history: priorHistory,
      });

      finalResponse = synthesisResponse.content;
      totalTokens += synthesisResponse.tokensUsed.total;
      totalCost += synthesisResponse.costCents;

    } else {
      respondingAgent = 'alan-os';

      // 5c. Alan OS handles directly (with history)
      const agentResponse = await executor.run({
        agentId: 'alan-os',
        taskId: task.id,
        userMessage,
        history: priorHistory,
      });

      finalResponse = agentResponse.content;
      totalTokens = agentResponse.tokensUsed.total;
      totalCost = agentResponse.costCents;
    }

    // 6. Record assistant response in conversation memory
    memory.addAssistantMessage(effectiveChatId, finalResponse, respondingAgent);

    // 7. Complete parent task
    const durationMs = Date.now() - startTime;
    await taskManager.completeTask(task.id, {
      content: finalResponse,
      tokensUsed: totalTokens,
      costCents: totalCost,
      durationMs,
    });

    // 8. Log response sent
    await activityLogger.log({
      event_type: 'message_sent',
      agent_id: 'alan-os',
      task_id: task.id,
      channel: 'telegram',
      summary: `Responded: "${finalResponse.substring(0, 100)}"`,
    });

    // 9. Set alan-os idle
    await taskManager.setAgentStatus('alan-os', 'idle');

    return finalResponse;
  } catch (err) {
    // Handle errors gracefully
    const errorMsg = (err as Error).message;

    await taskManager.failTask(task.id, errorMsg);
    await activityLogger.log({
      event_type: 'agent_error',
      agent_id: 'alan-os',
      task_id: task.id,
      channel: 'telegram',
      summary: `Error: ${errorMsg.substring(0, 200)}`,
    });
    await taskManager.setAgentStatus('alan-os', 'error');

    throw err;
  }
}
