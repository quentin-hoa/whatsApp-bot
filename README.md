# whatsapp-bot

A always-on WhatsApp bot running on a Raspberry Pi, built as a personal
notification dashboard. It started as a way to monitor Claude Code usage
limits from a phone, then grew into a small notification hub for other
home automation scripts.

## Features

- **Claude Code usage watchdog** — polls Anthropic's OAuth usage API every
  5 minutes and sends a WhatsApp message the moment a session (5h) or
  weekly limit is hit, then another one when it resets.
- **`usage`** — on-demand keyword that replies with a full breakdown of
  current usage (progress bars, reset times), without waiting for the next
  polling cycle.
- **`wake up`** — remote trigger that fires a minimal call to Claude (Haiku,
  the cheapest model) to pre-warm the 5h session window before getting back
  to a desk, so the session clock is already running on arrival. Rate-limited
  to one wake-up per 4 hours.
- **Daily crypto brief** — a cron job at 7:30 AM generates a market analysis
  (Claude Haiku + web search) and sends it automatically over WhatsApp.
- **Generic notification endpoint** — a small local HTTP server (port 3001)
  that other scripts on the Pi can call to push messages into a WhatsApp
  group or contact (e.g. a web page notifying that the cat has been fed).

## Architecture

```
┌─────────────────┐   cron 07:30    ┌──────────────────┐
│ warm_session.sh  │ ───────────────▶│  claude (Haiku)   │
└────────┬─────────┘                 └──────────────────┘
         │ POST /send-text
         ▼
┌───────────────────────────────────────────────────────┐
│                        bot.js                          │
│  - WhatsApp client (whatsapp-web.js + headless Chromium)│
│  - HTTP server :3001  (/send, /send-text, /check-claude)│
│  - polls Claude's OAuth usage API every 5 min            │
└───────────────────────────────────────────────────────┘
         ▲                                   │
         │ POST /send                        │ WhatsApp messages
         │                                    ▼
   (other scripts on the Pi)          WhatsApp group / contacts
```

It runs as a `systemd` service (`whatsapp-bot.service`), auto-restarting on
crash.

## Tech stack

- **Node.js** — no framework, plain `http` module for the server
- **[whatsapp-web.js](https://wwebjs.dev/)** — drives a WhatsApp Web session
  through a headless Chromium (Puppeteer under the hood); no official
  WhatsApp Business API needed, just a one-time QR code scan
- **Claude Code's OAuth API** (`api.anthropic.com/api/oauth/usage`) — the
  same access token the `claude` CLI uses, with automatic `refresh_token`
  handling
- **systemd** — keeps the bot alive, restarts it on failure
- **cron** — triggers the daily brief

## The pivot: from scraping to OAuth

The first version scraped the `claude.ai/settings/usage` page with Puppeteer,
reusing a logged-in session's cookies. It worked — until Cloudflare's bot
protection started blocking the automated requests, making the scraping
intermittent and unreliable.

The actual fix: Claude Code (the CLI) already authenticates via OAuth and
stores an access token locally. Anthropic exposes an internal API route that
returns usage percentages directly as JSON — no scraping, no browser, no
Cloudflare fight. The bot reuses that same token, refreshes it automatically
when it expires (rewriting the credentials file so the CLI keeps working
normally), and polls that API every 5 minutes instead.

Net result: a fragile scraping pipeline replaced by a single authenticated
HTTP call, and Puppeteer dropped entirely for this part of the bot.

## Other implementation details

- **Quiet hours** (07:30 → 01:30): no notifications overnight. Messages that
  would fire outside that window are queued to disk and delivered on the
  next allowed check.
- **Persistent retry queue**: if a WhatsApp send fails (bot disconnected,
  etc.), the message stays queued and is retried on the next cycle instead
  of being dropped.
- **`wake up`** runs the `claude` CLI from an empty, dedicated working
  directory, so it doesn't pick up any project's `CLAUDE.md` or hooks — just
  a minimal round trip to the API.

## Setup

```bash
git clone git@github.com:quentin-hoa/whatsapp-bot.git
cd whatsapp-bot
npm install
```

1. Open `bot.js` and replace `GROUP_ID`, `CRYPTO_RECIPIENTS` and
   `CLAUDE_RECIPIENTS` with real IDs — on first run (`node bot.js`), scan the
   printed QR code, and the console will list every group and contact with
   its ID.
2. Make sure the machine is logged in with `claude` (Claude Code CLI), so
   `~/.claude/.credentials.json` exists.
3. Copy `whatsapp-bot.service` into `/etc/systemd/system/`, fill in the
   `<YOUR_USERNAME>` placeholders, then:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now whatsapp-bot
   ```
4. (Optional) add `warm_session.sh` to crontab for the daily brief:
   ```
   30 7 * * * /home/<YOUR_USERNAME>/whatsapp-bot/warm_session.sh
   ```

## Files

| File                    | Role                                                    |
|--------------------------|----------------------------------------------------------|
| `bot.js`                 | WhatsApp client + HTTP server + Claude usage watchdog    |
| `warm_session.sh`        | Generates and sends the daily crypto brief               |
| `whatsapp-bot.service`   | systemd unit to keep the bot running                     |

## Privacy note

All WhatsApp IDs (group, contacts, phone numbers) and file paths in this
repo are placeholders. They're personal identifiers assigned on first run
and are never committed in plain text.
