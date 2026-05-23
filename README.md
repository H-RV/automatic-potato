# Scan My Trade

Upload a screenshot of your broker positions. Understand exactly what you own, what you risk, and what you make — in plain English.

## What it does

- **Screenshot → Cards** — AI reads any broker screenshot and extracts your trades
- **Review & Confirm** — check what the AI found before it populates your dashboard
- **Visual Trade Cards** — profit map, breakeven, scenarios, live P&L
- **Trade Journal** — auto-logged history of every trade, open and closed
- **Scan to Close** — upload a close screenshot, system matches and records P&L
- **CSV Export** — one-click export to Google Sheets

## Setup

### Requirements
- Node.js 18+
- Anthropic API key (free at console.anthropic.com)

### Install

```bash
npm install express
```

### Configure

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### Run

```bash
node server.js
```

Open `http://localhost:3000`

## Deployment

Deploy to Railway.app:
1. Push this repo to GitHub
2. Connect Railway to your GitHub repo
3. Set `ANTHROPIC_API_KEY` as an environment variable
4. Railway auto-deploys on every push

## Tech Stack

- **Frontend** — Vanilla HTML/CSS/JS, single file
- **Backend** — Node.js + Express
- **AI** — Anthropic Claude Vision (screenshot parsing)
- **Prices** — Yahoo Finance (15-min delayed, no API key needed)
- **Storage** — localStorage (client-side, no database needed)

## Supported Brokers

- IBKR (Interactive Brokers)
- Tastytrade
- ThinkorSwim
- Robinhood
- Webull
- E*Trade
- Any broker — AI adapts to any layout

## Roadmap

- [ ] User accounts + cloud sync (Supabase)
- [ ] Spreads and LEAPS support
- [ ] Monthly P&L dashboard
- [ ] Mobile layout
- [ ] Payments (Lemon Squeezy)
