# F1 Predictor League

A full-stack Formula 1 race prediction game where friends compete by predicting race results each Grand Prix weekend. Features real-time live timing, automated scoring, driver telemetry, and a season-long leaderboard — all wrapped in an installable PWA.

**Live:** [f1-predictor-league.onrender.com](https://f1-predictor-league.onrender.com)

---

## Features

### Predictions
- **Driver Predictions** — Pick who finishes P1, P2, P3, P10, P11, P21, and P22 each race weekend
- **Constructor Predictions** — Predict which constructors finish C1, C2, C5, C6, and C11 based on combined driver positions
- **Wildcards** — Race Biggest Loser, Sprint Biggest Gainer, Sprint Biggest Loser (+5 pts each if correct)
- **Season Predictions** — Lock in World Drivers' Champion (+50 pts) and World Constructors' Champion (+25 pts) before Round 1
- **Strategy Lockout** — Predictions lock 1 minute before Qualifying with a live countdown timer
- **Opponent Picks** — View locked-in strategies from other players after lockout

### Live Timing
- **Real-time leaderboard** — Driver positions, gaps, best lap times, and lap counts streamed via SSE with polling fallback
- **Tyre strategy** — Compound display (soft/medium/hard/inter/wet) with color coding per driver
- **Sector timing** — Three-sector breakdown with personal best and session best highlighting
- **Pit stop feed** — Live pit activity with stop durations and tyre changes
- **Race control messages** — Yellow flags, safety cars, penalties, and FIA decisions
- **Team radio** — Driver-to-team radio messages in real time
- **Connection status** — Shows SSE, Polling, or Offline indicator with auto-reconnect

### Driver Deep Dive
Tap any driver on the live timing board to open a detailed modal with four tabs:
- **Telemetry** — Speed, gear, RPM, throttle %, brake %, DRS status
- **Timing** — Position, gap, best lap, sector-by-sector breakdown
- **Strategy** — Pit stop stints, tyre compounds, stint lengths, pit durations
- **Radio** — Team radio messages for that specific driver

### Past Session Results
- Browse completed session results (practice, qualifying, sprint, race)
- Full classification with positions, gaps, best laps, tyre stints, and speed traps
- Fastest lap highlighting
- Driver names embedded in saved results for accurate historical display

### Standings
Three sub-tabs:
- **League** — Player leaderboard with cumulative scores and VIP badges
- **Drivers** — Live F1 Drivers' Championship (position, points, wins, podiums)
- **Constructors** — Live F1 Constructors' Championship

### Calendar
- Full 2026 season schedule with all 22 rounds
- Session times for FP1, FP2, FP3, Qualifying, Sprint Qualifying, Sprint, and Race
- Sprint weekend detection and labelling
- Countdown to next race with progress bar
- Live weather at track — temperature, humidity, wind speed, rainfall
- Track intelligence — circuit corners, length, and lap record

### 2026 Grid
- Complete team and driver lineup for the 2026 season
- Official team colors and driver numbers

### Scoring & Auto-Finalization
- Automated scoring triggered when a race session is finalised via the live timing API
- Detailed score breakdowns posted to Discord after each round
- No-submission penalty: lowest score of the round minus 5
- Incomplete submission penalty: 5 pts lower than lowest scorer

### Admin Panel
- Toggle VIP status (Constructors Club membership)
- Reset or manually set user scores
- View all predictions and scores from past rounds
- Manual finalization trigger

### Discord Integration
- Deploy update notifications when app version changes
- Detailed per-player score breakdowns after finalization
- Message chunking for Discord's 2000-character limit

### PWA & Mobile
- Installable on iOS and Android (Add to Home Screen)
- Service worker with network-first caching and offline fallback
- Responsive design — desktop table views and mobile card layouts
- Dark theme optimized for night viewing
- Skeleton loaders, toast notifications, and collapsible panels

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express
- **Database:** Turso (libSQL)
- **Auth:** Google OAuth 2.0 + JWT (30-day sessions)
- **Live Data:** [F1 Live Timing API](https://github.com/harsh779/f1-live-api) — SignalR WebSocket feed from F1
- **Frontend:** Vanilla HTML/CSS/JS (single-page, no build step)
- **Hosting:** Render (web app) + Northflank (F1 live timing API)
- **Notifications:** Discord webhooks

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `APP_URL` | Public URL of the app |
| `JWT_SECRET` | Secret key for JWT signing |
| `TURSO_DATABASE_URL` | Turso database connection URL. If unset, the app falls back to a local `local-preview.db` file |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `DISCORD_WEBHOOK` | Discord webhook URL for notifications |
| `F1_TIMING_API` | URL of the F1 Live Timing API |
| `F1_TIMING_API_KEY` | API key for the F1 Live Timing API, if that service has auth enabled |
| `API_SPORTS_KEY` | API-Sports key (optional, for weather fallback) |

---

## Production Hosting

Current production is split across two hosts:

- **Web app:** Render free web service
- **Live timing API:** Northflank free service

This split keeps the main app on a Google OAuth-compatible `onrender.com` domain while moving the always-on live API off Render's shared free-hours pool.

Required production env values for this app:

- `APP_URL=https://f1-predictor-league.onrender.com`
- `F1_TIMING_API=https://p01--f1-live-api--qc9w4mr468wb.code.run`

If you change the app host or domain, update Google OAuth:

- Authorized JavaScript origin: `https://<your-app-domain>`
- Authorized redirect URI: `https://<your-app-domain>/auth/google/callback`

Do not point Google OAuth at Northflank's default `code.run` web app domain unless Google accepts it for your client configuration.

---

## Running Locally

```bash
git clone https://github.com/harsh779/f1-predictor-league.git
cd f1-predictor-league
npm install
node server.js
```

Create a `.env` file with the variables listed above before starting.

---

## Testing

Run the full local verification pass:

```bash
npm test
```

Useful individual commands:

```bash
npm run test:syntax
npm run test:smoke
npm run test:all
```

`npm run test:smoke` starts the app on a local test port, validates the core public route contracts, and confirms that upstream-backed endpoints either return data or fail cleanly with JSON errors. It also verifies that protected routes reject unauthenticated access with `401`.

If your environment blocks child-process spawning, start the app separately and point the smoke test at it:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 npm run test:smoke
```

### Manual Smoke Checklist

After `npm test` passes, do one browser pass covering:

1. Open the app and confirm the home page renders without console/network errors.
2. Check the next race card shows the lock state, lock time, and next session correctly.
3. Log in and verify prediction submission, edit, and lockout behavior.
4. Open the live timing tab and confirm timing, race control, pits, weather, and team radio panels populate or show clear unavailable states.
5. Open past results and confirm the session cards and result-detail modal render correctly, including `DNF` vs `OUT`.
6. If Discord is configured, verify reminder and lockout notifications against a test round or controlled schedule.

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

**Season Predictions:**
- Correct WDC pick: **+50 points**
- Correct WCC pick: **+25 points**

**Penalties:**
- No submission: lowest score of the round minus 5
- Incomplete submission: 5 pts lower than lowest scorer

---

## Author

**harsh779**
