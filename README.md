# Mission Control

Dark-themed dashboard for the Alan OS multi-agent system. Built with Next.js 15, PostgreSQL, Tailwind CSS, and Recharts.

## Pages

- **Dashboard** (`/`) — Stat cards, agent fleet grid, recent tasks, heartbeat status, wedding countdown
- **Task Board** (`/tasks`) — Kanban columns (pending, in progress, delegated, completed, failed) with priority filters
- **Cron Monitor** (`/crons`) — All heartbeat jobs with schedules, success rates, expandable run history
- **Cost Tracker** (`/costs`) — Daily spend chart (stacked by model), cost by agent bars, model pie chart
- **Analytics** (`/analytics`) — Task throughput, agent performance, delegation flow, channel breakdown, activity feed

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create the database
createdb mission_control

# 3. Copy env and set DATABASE_URL
cp .env.example .env.local

# 4. Run schema + seed agents/crons
npm run db:setup

# 5. Start dev server
npm run dev
```

## Database Schema

7 tables:
- `agents` — Registry of all 9 agents (alan-os + 8 specialists)
- `tasks` — Task board with status, priority, delegation tracking
- `cron_jobs` — Heartbeat job definitions and stats
- `cron_runs` — Execution history for each cron job
- `cost_events` — Per-request token and cost tracking
- `cost_daily` — Rolled-up daily cost summaries
- `activity_log` — Event stream for analytics

## Integrating with Alan OS

The dashboard reads from PostgreSQL. Your OpenClaw gateway and Claude Code agents write to the same database:

1. When alan-os receives a message and creates a task: `INSERT INTO tasks`
2. When a specialist completes work: `UPDATE tasks SET status = 'completed'`
3. On every API call: `INSERT INTO cost_events`
4. When cron runs: `INSERT INTO cron_runs`
5. On any notable event: `INSERT INTO activity_log`

The dashboard auto-refreshes every 10-30 seconds depending on the page.

## Tech Stack

- Next.js 15 (App Router)
- PostgreSQL (via `pg`)
- Tailwind CSS (dark theme with custom carbon/neon palette)
- Recharts (area, bar, pie charts)
- Lucide React (icons)
- JetBrains Mono + DM Sans (typography)
