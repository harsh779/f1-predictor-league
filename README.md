# F1 Predictor League

**A full-stack Formula 1 prediction league built for serious race strategy fans.**

F1 Predictor League lets players predict race outcomes, compete across a full season, track live timing, and review automated scoring after every Grand Prix weekend. It combines a game layer, live motorsport data, admin controls, mobile/PWA support, and Discord notifications into one working product.

**Live app:** [f1-predictor-league.onrender.com](https://f1-predictor-league.onrender.com)  
**Related API:** [F1 Live API](https://github.com/harsh779/f1-live-api)

---

## Why this project matters

Most fantasy-style sports games simplify the experience. This app is designed for users who understand race strategy, driver deltas, DNFs, sprint weekends, timing gaps, and constructor-level outcomes.

It is built as a working product, not a static demo:

- users can log in
- predictions can be submitted and locked
- scores can be calculated automatically
- live race data can be streamed
- admins can manage users and results
- the app can be installed on mobile as a PWA

---

## Product snapshot

| Area | What it does |
|---|---|
| Prediction engine | Driver, constructor, wildcard, sprint, and season-long predictions |
| Live timing | Real-time leaderboard, gaps, tyres, sectors, pits, weather, and race control |
| Scoring | Automated round scoring with penalties and season standings |
| Admin tools | VIP toggles, score management, prediction review, manual finalisation |
| Mobile/PWA | Installable mobile experience with responsive layouts |
| Notifications | Discord updates for deployment, reminders, and score breakdowns |

---

## Core features

### Predictions

- Driver predictions for key finishing positions
- Constructor predictions based on combined driver results
- Wildcards for race and sprint movers
- Season predictions for WDC and WCC
- Strategy lockout before qualifying
- Opponent pick visibility after lockout

### Live timing

- Real-time leaderboard through SSE with polling fallback
- Tyre strategy and stint information
- Sector and mini-sector timing
- Pit stop feed
- Race control messages
- Team radio feed
- Connection status and reconnect handling

### Driver deep dive

Tap any driver to inspect:

- telemetry
- timing
- strategy
- team radio

### Standings

- Player league table
- F1 Drivers' Championship view
- F1 Constructors' Championship view

### Calendar

- 2026 race calendar
- sprint weekend detection
- session timing
- next-race countdown
- track intelligence and weather

---

## Tech stack

| Layer | Stack |
|---|---|
| Runtime | Node.js 18+ |
| Backend | Express |
| Database | Turso / libSQL |
| Auth | Google OAuth 2.0 + JWT |
| Live data | Custom F1 Live API using F1 timing feed |
| Frontend | Vanilla HTML, CSS, JavaScript SPA |
| Hosting | Render + Northflank |
| Notifications | Discord webhooks |

---

## Architecture

```txt
User browser / PWA
        │
        ▼
Express web app
        │
        ├── Auth and user sessions
        ├── Prediction submission and lockout logic
        ├── Scoring and admin controls
        ├── Turso/libSQL persistence
        └── Discord notification layer
        │
        ▼
F1 Live API
        │
        ▼
Formula 1 live timing feed
```

---

## Running locally

```bash
git clone https://github.com/harsh779/f1-predictor-league.git
cd f1-predictor-league
npm install
node server.js
```

Create a `.env` file before starting.

Required production-style variables:

| Variable | Description |
|---|---|
| `PORT` | Server port |
| `APP_URL` | Public app URL |
| `JWT_SECRET` | JWT signing secret |
| `TURSO_DATABASE_URL` | Turso database URL |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `DISCORD_WEBHOOK` | Discord webhook URL |
| `F1_TIMING_API` | F1 Live API URL |
| `F1_TIMING_API_KEY` | Optional API key for live timing API |
| `API_SPORTS_KEY` | Optional weather fallback key |

---

## Testing

```bash
npm test
```

Useful commands:

```bash
npm run test:syntax
npm run test:smoke
npm run test:all
```

Manual smoke test:

1. Open the app and confirm the home page renders.
2. Check next-race card, lock state, and session timing.
3. Log in and test prediction submission.
4. Open live timing and verify available panels.
5. Review past results and standings.
6. Confirm Discord notifications if configured.

---

## Scoring model

| Prediction type | Rule |
|---|---|
| Driver positions | Exact match: +2; off by N positions: -N |
| Constructor positions | Based on combined finishing positions |
| Wildcards | Correct pick: +5 |
| WDC prediction | Correct pick: +50 |
| WCC prediction | Correct pick: +25 |
| No submission | Lowest round score minus 5 |
| Incomplete submission | 5 points lower than lowest scorer |

DNF handling is built into the scoring logic so race incidents affect the prediction game meaningfully.

---

## Status

Live product. Actively improved across UI, scoring logic, admin tooling, race-data integration, and mobile experience.

---

## Author

Built by [Harsh Khandelwal](https://github.com/harsh779) as a portfolio-grade product showing full-stack application thinking, sports analytics, live data integration, and AI-assisted product development.
