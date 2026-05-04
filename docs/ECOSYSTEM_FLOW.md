# API + App Ecosystem Flow

This diagram shows how the F1 Live API and F1 Predictor League app work together after the dynamic calendar and standings fixes.

```mermaid
flowchart TD
    subgraph EXT["External F1 Sources"]
        F1Live["F1 Live Timing WebSocket<br/>livetiming.formula1.com<br/>SignalR topic patches"]
        F1Static["F1 Static Archive<br/>livetiming.formula1.com/static<br/>Index + session JSON"]
        F1Results["Formula1.com Results Pages<br/>/en/results/2026/drivers<br/>/en/results/2026/team"]
        F1Racing["Formula1.com Racing Pages<br/>/en/racing/2026/*"]
    end

    subgraph API["f1-live-api"]
        APIStart["API startup<br/>src/index.js"]
        State["In-memory timing state<br/>DriverList, TimingData, Weather,<br/>RaceControl, LapCount, TeamRadio"]
        CalendarService["Dynamic calendar service<br/>src/data/calendarService.js"]
        Persistence["Persistence<br/>last_state.json<br/>src/data/results/*.json<br/>Turso KV when configured"]
        Backfill["Archive backfill<br/>src/f1timing/backfill.js"]
        CalendarRoutes["Calendar routes<br/>GET /calendar<br/>POST /calendar/refresh<br/>GET /calendar/next/current/:round"]
        StandingsRoutes["Standings routes<br/>GET /standings/drivers<br/>GET /standings/constructors"]
        LiveRoutes["Live routes<br/>/timing, /drivers, /weather,<br/>/track, /race-control, /pits,<br/>/team-radio, /telemetry"]
        ResultsRoutes["Results routes<br/>/results<br/>/results/:filename<br/>/results/round/:round"]
        Streams["SSE streams<br/>/stream<br/>/stream/timing<br/>/telemetry/stream/*"]
    end

    F1Live -->|"live patches"| APIStart
    APIStart -->|"deep merge"| State
    State -->|"debounced snapshots"| Persistence
    State -->|"live JSON"| LiveRoutes
    State -->|"push updates"| Streams
    State -->|"SessionInfo updates"| CalendarService

    F1Racing -->|"race pages + JSON-LD schedule"| CalendarService
    F1Static -->|"season Index.json session confirmations"| CalendarService
    CalendarService -->|"dynamic calendar + apiRound"| CalendarRoutes
    CalendarService -->|"completed session schedule"| Backfill

    F1Static -->|"SessionInfo, TimingData,<br/>DriverList, TimingStats, LapCount"| Backfill
    Backfill -->|"saved completed sessions"| Persistence
    Persistence -->|"stored result files"| ResultsRoutes

    F1Results -->|"official rank + points"| StandingsRoutes
    Persistence -->|"Race-only results"| RaceStats["Race-only enrichment<br/>driver wins<br/>driver podiums<br/>constructor wins"]
    RaceStats --> StandingsRoutes
    StandingsRoutes -->|"fallback if Formula1.com fails:<br/>points from Race + Sprint<br/>stats from Race only"| Persistence

    subgraph APP["f1-predictor-league"]
        AppServer["App server<br/>server.js"]
        ApiClient["F1 API client<br/>F1_TIMING_API"]
        AppProxy["App proxy routes<br/>/api/calendar<br/>/api/standings/*<br/>/api/live/*"]
        AppDB["Prediction DB<br/>Turso/libSQL or local-preview.db"]
        PredictionLogic["Prediction + lock logic<br/>race picks<br/>season picks<br/>drafts"]
        Scoring["Scoring/finalization<br/>actual results + predictions"]
        Admin["Admin tools<br/>VIP, score edits,<br/>merge users, resets"]
        Frontend["Frontend SPA<br/>public/index.html"]
    end

    ApiClient --> CalendarRoutes
    ApiClient --> StandingsRoutes
    ApiClient --> LiveRoutes
    ApiClient --> ResultsRoutes
    AppServer --> ApiClient
    AppServer --> AppDB
    AppServer --> AppProxy
    AppServer --> Frontend

    AppProxy -->|"calendar, standings, live data"| Frontend
    PredictionLogic --> AppDB
    Scoring --> AppDB
    Admin --> AppDB
    Scoring -->|"actual result lookup"| ApiClient

    subgraph UI["Browser / PWA"]
        StandingsTab["Standings tab<br/>drivers + constructors"]
        CalendarUI["Calendar / next race<br/>dynamic session timing"]
        PredictionsUI["Prediction forms<br/>dynamic lock timing"]
        LiveUI["Live timing panels"]
        LeaderboardUI["Player league standings"]
        AdminUI["Admin panel"]
    end

    Frontend --> StandingsTab
    Frontend --> CalendarUI
    Frontend --> PredictionsUI
    Frontend --> LiveUI
    Frontend --> LeaderboardUI
    Frontend --> AdminUI

    StandingsRoutes -->|"official points/rank<br/>Race-only wins/podiums"| StandingsTab
    CalendarRoutes -->|"22-race app calendar<br/>Miami display round 4<br/>apiRound 6"| CalendarUI
    CalendarRoutes -->|"first race lock calculation"| PredictionsUI
    LiveRoutes --> LiveUI
    AppDB --> LeaderboardUI
```

## Key Fixes Captured

- The API calendar is dynamic and sourced from F1 sources instead of hardcoded runtime schedule data.
- The app consumes the API calendar as source of truth and preserves `round` versus `apiRound`.
- Miami can display as round 4 while still using timing archive round 6 for result files.
- F1 standings rank and points are fetched from Formula1.com.
- Driver wins, driver podiums, and constructor wins are enriched from Race sessions only, so Sprint results do not inflate those stats.
