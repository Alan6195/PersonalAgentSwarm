/**
 * In-memory conversation history store.
 *
 * Tracks recent message pairs (user + assistant) per chat, plus which agent
 * handled the last message. Designed for easy migration to DB-backed storage later.
 *
 * TTL: conversations expire after 30 minutes of inactivity.
 * Max history: 10 message pairs (20 messages) per chat.
 */

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationState {
  messages: ConversationMessage[];
  lastAgentId: string | null;
  lastActivity: number; // epoch ms
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PAIRS = 10; // keep last 10 exchanges (20 messages)

const conversations = new Map<number, ConversationState>();

/**
 * Cleanup expired conversations. Called on every access.
 */
function cleanup(): void {
  const now = Date.now();
  for (const [chatId, state] of conversations) {
    if (now - state.lastActivity > TTL_MS) {
      conversations.delete(chatId);
    }
  }
}

/**
 * Get or create conversation state for a chat.
 */
function getState(chatId: number): ConversationState {
  cleanup();
  let state = conversations.get(chatId);
  if (!state) {
    state = { messages: [], lastAgentId: null, lastActivity: Date.now() };
    conversations.set(chatId, state);
  }
  state.lastActivity = Date.now();
  return state;
}

/**
 * Add a user message to the conversation history.
 */
export function addUserMessage(chatId: number, content: string): void {
  const state = getState(chatId);
  state.messages.push({ role: 'user', content });
  trimHistory(state);
}

/**
 * Add an assistant response to the conversation history,
 * and record which agent produced it.
 */
export function addAssistantMessage(chatId: number, content: string, agentId: string): void {
  const state = getState(chatId);
  state.messages.push({ role: 'assistant', content });
  state.lastAgentId = agentId;
  trimHistory(state);
}

/**
 * Get the agent that handled the last message in this chat.
 */
export function getLastAgentId(chatId: number): string | null {
  const state = conversations.get(chatId);
  if (!state) return null;
  if (Date.now() - state.lastActivity > TTL_MS) {
    conversations.delete(chatId);
    return null;
  }
  return state.lastAgentId;
}

/**
 * Get conversation history for passing to Claude.
 * Returns messages in chronological order (oldest first).
 */
export function getHistory(chatId: number): ConversationMessage[] {
  const state = conversations.get(chatId);
  if (!state) return [];
  if (Date.now() - state.lastActivity > TTL_MS) {
    conversations.delete(chatId);
    return [];
  }
  return [...state.messages];
}

/**
 * Clear conversation history for a chat (e.g., on /clear command).
 */
export function clearHistory(chatId: number): void {
  conversations.delete(chatId);
}

/**
 * Check if a message looks like a short follow-up that should skip the router.
 * Examples: "3", "post 2", "the second one", "yes", "that one", "go with B"
 */
export function isFollowUp(message: string, chatId: number): boolean {
  // No history means nothing to follow up on
  const state = conversations.get(chatId);
  if (!state || !state.lastAgentId || state.messages.length < 2) return false;

  // Check TTL
  if (Date.now() - state.lastActivity > TTL_MS) return false;

  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // Very short messages (under 40 chars) are likely follow-ups
  if (trimmed.length <= 40) {
    // Pure number: "1", "2", "3"
    if (/^\d{1,2}$/.test(trimmed)) return true;

    // Number-based selections: "post 2", "option 3", "go with 1", "#2"
    if (/^(post|option|go with|pick|choose|number|#)\s*\d{1,2}$/i.test(trimmed)) return true;

    // Ordinal selections: "the first one", "second", "the third"
    if (/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/i.test(lower)) return true;

    // Affirmative follow-ups
    if (/^(yes|yeah|yep|yup|sure|do it|go|post it|send it|ship it|go ahead|confirmed?|approve[d]?|lgtm|ok|okay)\.?$/i.test(trimmed)) return true;

    // Negative follow-ups
    if (/^(no|nah|nope|skip|cancel|nevermind|never mind|scratch that|don't|nix it)\.?$/i.test(trimmed)) return true;

    // Letter selections: "A", "B", "C"
    if (/^[A-Ca-c]\.?$/.test(trimmed)) return true;

    // Short edits/modifications: "make it shorter", "add a CTA", "more aggressive"
    if (trimmed.length <= 30 && !trimmed.includes('?') && state.lastAgentId !== 'alan-os') {
      // If the last agent was a specialist and the message is short without a question mark,
      // it's likely a follow-up instruction to that specialist
      return true;
    }
  }

  return false;
}

/**
 * Keep only the last MAX_PAIRS exchanges.
 */
function trimHistory(state: ConversationState): void {
  const maxMessages = MAX_PAIRS * 2;
  if (state.messages.length > maxMessages) {
    state.messages = state.messages.slice(-maxMessages);
  }
}

/**
 * Get stats for debugging.
 */
export function getStats(): { activeSessions: number; totalMessages: number } {
  cleanup();
  let totalMessages = 0;
  for (const state of conversations.values()) {
    totalMessages += state.messages.length;
  }
  return { activeSessions: conversations.size, totalMessages };
}
