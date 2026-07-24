# Sentinel Stoat Moderator (Puter.js + SQLite)

A semi-auto / auto moderation Stoat bot that:

- Reads server chat messages in real time
- Uses Puter.js AI to detect rule violations and choose actions
- Stores all monitored messages and user violation history in SQLite
- Posts flagged logs to a moderation channel
- Supports moderator commands directly in the moderation channel
- Can auto-apply moderation actions within configured limits
- Includes a web dashboard with message/flag filters and settings management

## Features

- AI-driven moderation categories (harassment, self-harm, spam, etc.)
- Per-user historical enforcement counts (warn/timeout/kick/ban)
- Recent user context included in moderation decisions
- Policy guardrails:
  - allowed actions list
  - maximum auto action cap
  - excluded channels list
- Dashboard filters:
  - flagged or non-flagged
  - reason category
  - message limit
- In-channel moderator command:
  - `!mod <flagId> approve|dismiss|escalate|warn|delete|timeout|kick|ban`
  - `/mod <flagId> approve|dismiss|escalate|warn|delete|timeout|kick|ban`
  - Short aliases: `/approve <flagId>`, `/dismiss <flagId>`, `/escalate <flagId>`, `/delete <flagId>`
  - `!mod help`
  - `/mod help`
- Reaction controls on each moderation log:
  - approve suggested action
  - dismiss with no punishment
  - escalate to stricter action

## Tech Stack

- Node.js
- stoat.js
- Puter.js (`@heyputer/puter.js`)
- SQLite (`better-sqlite3`)
- Express dashboard

## 1) Setup

1. Install Node.js 22.15+ (Stoat SDK requirement).
2. Create a Stoat bot token.
3. Add bot to your target server(s) with moderation permissions:
   - View channels
   - Send messages
   - Timeout members
   - Kick members
   - Ban members
4. Create/select one channel for moderation logs.
5. Copy `.env.example` to `.env`.
6. Start app and open dashboard. Runtime settings can be configured there and are saved to SQLite.

## 2) Environment Variables

Startup env (optional defaults, used to seed the database on first run):

- `STOAT_BOT_TOKEN`
- `STOAT_MODERATION_CHANNEL_ID`
- `PUTER_AUTH_TOKEN`
- `PUTER_MODEL` (default: `meta-llama/llama-3.1-8b-instruct`)
- `PUTER_TEMPERATURE` (default: `0.1`)
- `AUTO_MODERATION` (`true` or `false`)
- `ALLOWED_ACTIONS` (comma-separated, e.g. `warn,delete,timeout,kick,ban`)
- `MAX_AUTO_ACTION` (`warn|delete|timeout|kick|ban`)
- `DEFAULT_TIMEOUT_MINUTES` (default `30`)
- `DASHBOARD_PORT` (default `3000`)
- `DASHBOARD_HOST` (default `127.0.0.1`)
- `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` (basic auth)
- `RECENT_CONTEXT_MESSAGES` (default `12`)
- `SQLITE_PATH` (default `./data/moderation.db`)

After first run:

- Configure/update bot token, moderation channel ID, Puter token, model, and moderation policy from the dashboard Settings page.
- Values are stored in SQLite and reused across restarts.
- If token/auth settings are missing, the dashboard still starts and the bot stays offline until configured.

## 3) Puter Open-Source Models

The project defaults to an open-source model name for moderation decisions.

You can change `PUTER_MODEL` to any Puter-supported OSS model you prefer.
Model availability, throughput, and billing policy are controlled by Puter/provider policy and can change over time.

## 4) Run

```bash
npm install
npm start
```

Dashboard:

- `http://127.0.0.1:3000`
- Use the dashboard basic-auth credentials from Settings (seeded from `.env` on first run)

## 5) Moderation Flow

1. Every non-bot server message in monitored channels is saved to SQLite.
2. AI classifies it and recommends action.
3. If flagged:
   - a flag record is created
   - a moderation log is sent to the moderation channel
4. Moderators resolve flags in the moderation channel with reactions or `!mod`/`/mod` commands.
5. On startup the bot posts a health report in the moderation channel with permission checks.
6. If auto moderation is enabled, the bot applies allowed actions immediately.

## 6) Dashboard Capabilities

- View all monitored messages (flagged and non-flagged)
- Filter by flagged status and reason category
- View pending/resolved flags
- Trigger manual moderation actions (approve/dismiss/escalate/warn/delete/timeout/kick/ban)
- Update persisted settings:
  - Stoat bot token and moderation channel ID
  - Puter auth token/model/temperature
  - auto moderation policy and allowed actions
  - timeout minutes and recent context size
  - excluded channels and rules
  - dashboard host/port/credentials

## Important Notes

- Ensure the bot has the right server-level permissions before enabling auto moderation.
- AI decisions are advisory and policy-bound, not absolute.
- SQLite database is stored at `./data/moderation.db` by default.
