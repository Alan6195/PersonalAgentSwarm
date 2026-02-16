# PersonalAgentSwarm

A multi-agent AI system orchestrated through Telegram, with a dark-themed Mission Control dashboard. 10 specialized agents handle everything from daily life admin to code deployment, wedding planning, travel booking, and social media management.

Built with Next.js 15, Node.js agent service, PostgreSQL 16, Docker Compose, and the Anthropic Claude API (Sonnet 4 + Opus 4).

## Architecture

```
Telegram Bot <-> Router (alan-os) <-> Specialist Agents (9)
                      |
                      v
              Task Manager + XP System
                      |
                      v
    PostgreSQL <-> Mission Control Dashboard
```

**Agent Service** (`agent-service/`): Node.js/TypeScript service that runs the Telegram bot, routes messages to agents, executes Claude API calls, manages tasks, tracks costs, and runs scheduled cron jobs.

**Dashboard** (`src/`): Next.js 15 App Router dashboard with real-time monitoring of all agent activity, costs, tasks, leaderboards, wedding planning, travel itineraries, and analytics.

## The 10 Agents

| Agent | Model | Role |
|-------|-------|------|
| **Alan OS** | Sonnet 4 | Router and general assistant. Classifies messages, delegates to specialists, handles direct responses |
| **Ascend Builder** | Sonnet 4 | Business strategy for Ascend Intuition (Alan's company). Ship Protocol, app architecture |
| **Gilfoyle** | Opus 4 | Developer agent with full Agent SDK agentic loop. Reads/writes code, runs bash, deploys via Docker. Has full repo access including git push, merge, and docker compose |
| **Legal Advisor** | Sonnet 4 | Custody, co-parenting, child support, legal matters. Drafts responses to the ex |
| **Research Analyst** | Opus 4 | Deep research, competitive intel, market analysis, X/Twitter trend analysis |
| **Social Media** | Sonnet 4 | X/Twitter posting, content creation, feed scanning, engagement strategy |
| **Wedding Planner** | Sonnet 4 | July 12, 2026 wedding coordination. Gmail integration for vendor emails, budget tracking |
| **Life Admin** | Sonnet 4 | Finances, household logistics, Outlook email management, inbox triage |
| **Comms Drafter** | Sonnet 4 | Email drafting, proposals, professional written communications |
| **Travel Agent** | Opus 4 | Portugal honeymoon planning (Jul 17-26, 2026). Live web search for hotel pricing, persistent itinerary state |

## Key Features

### Agent XP and Gamification
Agents earn XP for completing tasks (10 XP base, bonuses for speed and efficiency, streak multipliers up to 2x). 10 level tiers from Intern to Singularity. Top performers get fire indicators, bottom performers get nudged to improve. Each agent sees their rank and is motivated to climb the leaderboard.

### Gilfoyle Ship Mode
Autonomous overnight development. `/ship [description]` queues a task. Gilfoyle works with 100 turns and a $25 budget, reports progress every 10 turns, and auto-commits changes.

### Travel Agent with Live Search
The travel agent uses Brave Search API to get live hotel pricing, transport options, and restaurant data. Persistent state tracks hotels, activities, restaurants, and transport across Porto, Lisbon, Alentejo, and Algarve. Dashboard shows hotel photos, bed types, and booking links.

### Wedding Planning Suite
Gmail integration for vendor communications. Budget tracker with 20+ categories. Vendor management. Countdown timer. The wedding planner agent can read, draft, and send emails through the wedding Gmail account.

### Proactive Intelligence
Three daily sweeps (7am, 1pm, 6pm) aggregate email counts, wedding deadlines, calendar events, cost tracking, and agent health into actionable briefings.

### Two-Tier Persistent Memory
All agents have persistent memory across conversations using a two-tier architecture:

**Tier 1 (Always-On):** Each agent has two markdown files loaded into every single message:
- `SOUL.md`: Agent identity, personality, instructions, capabilities. Hot-reloadable from disk without Docker rebuild. Gilfoyle can edit these at runtime for self-improvement.
- `MEMORY.md`: Working scratchpad with active projects, recent decisions, pending actions. Agents self-update via `[MEMORY_UPDATE]` blocks in their responses. Capped at 3000 chars with automatic compaction.

**Tier 2 (On-Demand Recall):** Keyword-matched historical memories from PostgreSQL `agent_memory` table. Past conversations, decisions, and preferences are recalled automatically when relevant keywords appear in the current message.

### Cost Guardrails
Daily budget limits ($50/day, $10/agent). Alerts at 80% threshold. Cron jobs auto-skip when over budget.

### Multi-Agent Collaboration
Complex requests can be routed to multiple agents in parallel. Alan OS synthesizes their responses into a unified answer.

## Dashboard Pages

| Page | Route | Description |
|------|-------|-------------|
| Dashboard | `/` | Stat cards, agent fleet with XP/level badges, recent tasks, system health |
| Task Board | `/tasks` | Kanban columns (pending, in progress, delegated, completed, failed) |
| Leaderboard | `/leaderboard` | Agent rankings with XP bars, streaks, fire/performance indicators |
| Cron Monitor | `/crons` | Scheduled jobs with success rates and run history |
| Cost Tracker | `/costs` | Daily spend charts, cost by agent, model breakdown, budget meters |
| Analytics | `/analytics` | Task throughput, delegation flow, channel breakdown |
| Wedding | `/wedding` | Budget tracker, vendor management, timeline, countdown |
| Travel | `/travel` | Day-by-day Portugal itinerary, hotel photos, transport cards, budget breakdown |

## Tech Stack

- **Runtime**: Node.js 20, TypeScript (strict)
- **Frontend**: Next.js 15 (App Router), Tailwind CSS, Recharts, Lucide React
- **Backend**: Telegram Bot API (node-telegram-bot-api), Anthropic Claude API
- **Developer Agent**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for agentic tool-use loops
- **Database**: PostgreSQL 16 with pgvector for semantic memory
- **Integrations**: Outlook (Microsoft Graph), Gmail (Google APIs), X/Twitter API, Brave Search, Google Calendar
- **Deployment**: Docker Compose, Caddy (reverse proxy + auto SSL), DigitalOcean VPS
- **Typography**: JetBrains Mono + DM Sans

## Memory File Structure

```
agent-service/data/
  souls/              # SOUL.md files (agent identity, hot-reloadable)
    alan-os.md
    ascend-builder.md
    gilfoyle.md
    legal-advisor.md
    research-analyst.md
    social-media.md
    wedding-planner.md
    life-admin.md
    comms-drafter.md
    travel-agent.md
  memory/             # MEMORY.md files (working scratchpad, Docker volume)
    alan-os.md
    ascend-builder.md
    gilfoyle.md
    ...
```

SOUL.md files are copied into the container at build time. MEMORY.md files live on a named Docker volume (`agent_memory`) so they persist across container rebuilds.

The registry (`agent-service/src/agents/registry.ts`) loads SOUL.md from disk at runtime, falling back to compiled `.ts` prompt exports if no `.md` file exists. This means you can edit an agent's personality by modifying its SOUL.md and the change takes effect on the next message, with no rebuild needed.

## Database Schema

12 tables:
- `agents`: Registry of all 10 agents with XP, level, streak, task counts
- `tasks`: Task board with status, priority, delegation tracking, cost/duration
- `cron_jobs`: Scheduled job definitions with prompt overrides
- `cron_runs`: Execution history for each cron job
- `cost_events`: Per-request token and cost tracking
- `cost_daily`: Rolled-up daily cost summaries
- `activity_log`: Event stream for analytics
- `agent_memory`: Keyword-matched historical memory (Tier 2 recall)
- `travel_trips`: Trip state (status, budget, preferences, notes)
- `travel_items`: Hotels, activities, restaurants, transport with JSONB metadata
- `travel_vetoes`: Items ruled out (never suggested again)
- `dev_queue`: Gilfoyle's autonomous work queue (ship mode)

Plus wedding tables: `wedding_budget`, `wedding_vendors`

## Setup

```bash
# 1. Clone and install
git clone https://github.com/Alan6195/PersonalAgentSwarm.git
cd PersonalAgentSwarm
npm install
cd agent-service && npm install && cd ..

# 2. Create database
createdb mission_control

# 3. Configure environment
cp .env.example .env.local
# Set: DATABASE_URL, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, etc.

# 4. Run schema + migrations
npm run db:setup
node scripts/migrate-v2.js
node scripts/migrate-v3.js
node scripts/migrate-v4.js

# 5. Start everything with Docker
docker compose -f docker-compose.prod.yml up --build -d
```

## Deployment

Hosted on a DigitalOcean VPS. Docker Compose manages 4 containers: `app` (Next.js dashboard), `agent` (agent service + Telegram bot), `db` (PostgreSQL 16), `caddy` (reverse proxy with auto SSL).

```bash
# Deploy updates
ssh root@your-vps "cd /opt/mission-control && git pull && docker compose -f docker-compose.prod.yml up --build -d"
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| Any message | Routed by Alan OS to the appropriate agent |
| `/leaderboard` or `/xp` | Show agent XP rankings |
| `/ship [description]` | Queue autonomous dev work for Gilfoyle |
| `/queue` | View Gilfoyle's dev queue |
| `/costs` | Today's cost summary |
