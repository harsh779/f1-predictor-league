# F1 Prediction App

A full-stack Formula 1 race prediction game where friends compete by predicting race results each Grand Prix weekend. Features live timing data, automated scoring, and a season-long leaderboard.

---

## Features

- **Race Predictions** — Predict driver positions (P1, P2, P3, P10, P11, P21, P22), constructor rankings, and wildcard picks before qualifying locks submissions
- **Automated Scoring** — Points calculated automatically when a race is finalised, using a custom scoring system with bonuses and penalties
- **Season-Long Leaderboard** — Cumulative scores tracked across all 24 rounds of the 2026 season
- **Season Predictions** — Lock in your WDC and WCC picks before Round 1
- **Live Timing Widget** — Real-time race positions, gaps, tyre data, and lap counts powered by a direct F1 SignalR WebSocket feed
- **Full 2026 Calendar** — All sessions with countdown timers and track details
- **Google OAuth** — Secure login via Google accounts
- **Admin Panel** — VIP management, user resets, manual finalization
- **Discord Notifications** — Webhook alerts when scoring is finalized
- **Auto-Finalization** — Polls the live timing API and triggers scoring when a race session is finalised

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express
- **Database:** Turso (libSQL)
- **Auth:** Google OAuth 2.0 + JWT
- **Live Data:** Proxied from [F1 Live Timing API](https://github.com/harsh779/f1-live-api)
- **Frontend:** Vanilla HTML/CSS/JS (served as static files)

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `APP_URL` | Public URL of the app |
| `JWT_SECRET` | Secret key for JWT signing |
| `TURSO_DATABASE_URL` | Turso database connection URL |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `DISCORD_WEBHOOK` | Discord webhook URL for notifications |
| `F1_TIMING_API` | URL of the F1 Live Timing API |
| `API_SPORTS_KEY` | API-Sports key (optional, for fallback data) |

---

## Running Locally

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/harsh779/f1-prediction-app.git
cd f1-prediction-app
npm install
node server.js
```

Create a `.env` file with the variables listed above before starting.

---

## Scoring System

**Driver Predictions (P1, P2, P3, P10, P11, P21, P22):**
- Exact match: **+2 points**
- Off by N positions: **-N points**
- DNF drivers count as P22

**Constructor Predictions (C1, C2, C5, C6, C11):**
- Ranked by combined finishing positions of both drivers
- Tied constructors share a rank range — no penalty if prediction falls within range
- Exact match: **+2 points**, otherwise **-difference**

**Wildcards:**
- Race Biggest Loser, Sprint Biggest Gainer, Sprint Biggest Loser
- Correct pick: **+5 points** each

**No-Submission Penalty:** Lowest score of the round minus 5

---

## Author

**harsh779**
