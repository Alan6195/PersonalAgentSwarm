## Infrastructure State
- VPS: DigitalOcean, Docker Compose (4 containers: app, agent, db, caddy)
- DB: PostgreSQL 16, user mc
- Last deploy: Feb 16, all containers healthy

## Known Issues
- SEARCH_API_KEY not set on VPS (web search disabled for travel-agent)
- Google Calendar OAuth not configured
- Microsoft Graph (Outlook) not configured

## Recent Changes
- Added two-tier memory system (SOUL.md + MEMORY.md)
- XP system backfilled, leaderboard working
- Travel dates corrected to Jul 17-26
