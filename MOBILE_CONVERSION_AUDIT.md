# F1 Prediction App -- Mobile Conversion Audit

**Date:** 2026-03-07
**Codebase:** `f1-predictor-league` (Prediction App) + `f1-live-api` (Live Timing API)

---

## 1. TECH STACK & ARCHITECTURE

### Frontend
| Layer | Technology | Details |
|---|---|---|
| **Framework** | Vanilla HTML/CSS/JS | Single monolithic `public/index.html` (~96KB, 1374 lines). No framework, no build step. |
| **UI Library** | None | All hand-written CSS with CSS variables. Font: Titillium Web (Google Fonts). |
| **State Management** | None (globals) | All state lives in global JS variables (`f1_token`, `f1_name`, `raceLock`, `teamsData`, `timingInterval`). |
| **HTTP Client** | `fetch()` (browser) | All API calls use native `fetch()` with Bearer token auth. No axios on client side. |
| **Authentication** | Google OAuth 2.0 + JWT | Server-side OAuth flow. Token stored in `localStorage`. 30-day expiry. |
| **Database** | Turso (LibSQL/SQLite) | `@libsql/client` -- cloud-hosted SQLite. 3 tables: `f1_drivers`, `f1_predictions_v4`, `f1_meta`. |
| **Build Tool** | None | No bundler, no transpiler. Raw files served via Express static. |
| **Testing** | None | `package.json` has placeholder: `"test": "echo \"Error: no test specified\""` |

### Backend (`server.js` -- single file, ~519 lines)
| Layer | Technology |
|---|---|
| **Runtime** | Node.js (CommonJS) |
| **Server** | Express 5.2.1 |
| **Auth** | `jsonwebtoken` (JWT verify/sign) |
| **HTTP Client (server)** | `axios` (for OAuth + live timing proxy) |
| **AI** | `openai` (listed in deps but **unused** in current code) |

### Live Timing API (separate repo, `C:\Users\Harsh\Desktop\API`)
| Layer | Technology |
|---|---|
| **Server** | Express 5.2.1 |
| **Real-time** | `ws` (WebSocket client to F1 SignalR) |
| **Persistence** | JSON files on disk (`src/data/results/`, `src/data/last_state.json`) |
| **Streaming** | Server-Sent Events (SSE) for `/stream`, `/stream/timing`, `/telemetry/stream/*` |

---

## 2. CORE FEATURES (PRIORITIZED)

| # | Feature | Files/Components | Complexity | Mobile-Blocking Issues |
|---|---|---|---|---|
| 1 | **Google OAuth Login** | `server.js:112-139`, `index.html:654-666` | Medium | OAuth redirect flow needs deep linking or in-app browser. `redirect_uri` is web URL. |
| 2 | **Race Prediction Form** | `server.js:397-432`, `index.html:410-478, 1236-1265` | Complex | 15 field picker modal. Touch-optimized bottom sheet already exists. Works well on mobile. |
| 3 | **Season-Long Predictions** | `server.js:373-394`, `index.html:411-424, 1080-1119` | Simple | No blocking issues. |
| 4 | **League Leaderboard** | `server.js:445-448`, `index.html:535-546, 1166-1187` | Simple | Table-based. Needs responsive list for mobile. |
| 5 | **Live Timing Dashboard** | `server.js:324-334`, `index.html:494-533, 838-974` | Complex | Already has separate mobile (cards) and desktop (table) views. Polls every 30s. |
| 6 | **Home Dashboard** | `index.html:351-408, 977-1048` | Medium | Grid layout, weather widget, news feed, top-5 leaderboard. |
| 7 | **Prediction Viewer (Picks)** | `server.js:440-443`, `index.html:480-492, 1121-1164` | Simple | No blocking issues. |
| 8 | **Season Calendar** | `server.js:318`, `index.html:548-558, 1189-1217` | Simple | Table with session times. |
| 9 | **2026 Driver Grid** | `index.html:560-564, 1219-1234` | Simple | Static data, card layout. |
| 10 | **Admin Panel** | `server.js:451-471`, `index.html:485-491, 1285-1345` | Medium | VIP toggle, score reset, finalize. Name-based admin check ("harsh"). |

---

## 3. API INTEGRATION MAP

### Base URLs
- **Prediction App API:** `https://f1-predictor-league.onrender.com` (self-hosted, same server)
- **Live Timing API:** `https://f1-live-api.onrender.com` (separate Render service)

### All Endpoints (Prediction App -- `server.js`)

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/next-race` | GET | No | Returns next race object with calendar data, lock time |
| `/api/calendar` | GET | No | Full 24-race 2026 calendar array |
| `/api/live-widget` | GET | No | Proxied live timing data (10s cache) |
| `/api/live-sessions` | GET | No | API-Sports race results (fallback to 2025) |
| `/api/season-picks` | GET | JWT | User's season-long WDC/WCC predictions |
| `/api/season-picks` | POST | JWT | Save/update season-long predictions |
| `/predict` | POST | JWT | Submit race weekend predictions (15 fields) |
| `/api/finalize` | POST | JWT+Admin | Trigger scoring engine for latest race |
| `/api/predictions` | GET | No | All current predictions with total scores |
| `/api/season-leaderboard` | GET | No | League standings (name, score, VIP, season picks) |
| `/api/admin/users` | GET | JWT+Admin | List all participating users |
| `/api/admin/toggle-vip` | POST | JWT+Admin | Toggle VIP badge for a user |
| `/api/admin/reset-user` | POST | JWT+Admin | Reset user score to 0 |
| `/auth/google` | GET | No | Initiate Google OAuth redirect |
| `/auth/google/callback` | GET | No | OAuth callback, issues JWT, redirects to `/?token=...&name=...` |

### All Endpoints (Live Timing API -- `API/src/routes/`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/status` | GET | Connection state, session info, flags |
| `/timing` | GET | Full leaderboard (22 drivers, all timing data) |
| `/timing/:number` | GET | Single driver timing |
| `/weather` | GET | Current weather data |
| `/track` | GET | Track status and flags |
| `/race-control` | GET | Race director messages |
| `/drivers` | GET | Full driver list with headshots |
| `/car/:number` | GET | Telemetry for one driver |
| `/snapshot` | GET | Raw dump of all 15 F1 topics |
| `/stream` | GET (SSE) | All raw topic updates |
| `/stream/timing` | GET (SSE) | Merged leaderboard on timing changes |
| `/calendar` | GET | Full calendar |
| `/calendar/next` | GET | Next upcoming session |
| `/calendar/current` | GET | Current active race weekend |
| `/calendar/:round` | GET | Specific round details |
| `/results` | GET | List all saved session results |
| `/results/:filename` | GET | Specific saved result |
| `/results/round/:round` | GET | All sessions for a round |
| `/standings/drivers` | GET | Calculated driver championship standings |
| `/standings/constructors` | GET | Calculated constructor standings |
| `/telemetry` | GET | Latest telemetry for all drivers |
| `/telemetry/:number` | GET | Latest telemetry for one driver |
| `/telemetry/stream/all` | GET (SSE) | Real-time telemetry ~3.7Hz |
| `/telemetry/stream/:number` | GET (SSE) | Real-time telemetry for one driver |

### Authentication Strategy
- **Token Type:** JWT (Bearer token in `Authorization` header)
- **Signing:** `jsonwebtoken` with `JWT_SECRET` env var
- **Expiry:** 30 days
- **Storage:** `localStorage` keys: `f1_token`, `f1_name`
- **Admin Check:** `req.user.name.toLowerCase().includes('harsh')` (name-based, not role-based)

### External APIs Called (Server-Side)
| API | Purpose | Auth |
|---|---|---|
| Google OAuth (`accounts.google.com`, `oauth2.googleapis.com`) | User login | Client ID/Secret |
| Ergast F1 API (`api.jolpi.ca/ergast`) | Race results for scoring | None |
| API-Sports F1 (`v1.formula-1.api-sports.io`) | Race session results | `x-apisports-key` header |
| Open-Meteo (`api.open-meteo.com`) | Weather at circuit | None (client-side) |
| RSS2JSON (`api.rss2json.com`) | Motorsport.com news feed | None (client-side) |
| Discord Webhook | Post-finalization notifications | Webhook URL |

### Real-Time Needs
- **Live Timing:** Currently uses **polling** (30s interval via `setInterval`) from client to `/api/live-widget`
- **Live Timing API internally:** Uses **WebSocket** (SignalR) to F1 live timing servers
- **Live Timing API exposes:** **SSE** streams at `/stream`, `/stream/timing`, `/telemetry/stream/*`
- **Note:** The prediction app does NOT use SSE -- it proxies and polls instead

### Error Handling Pattern
- Server: try/catch with `res.status(code).json({ error/message })` or `{ success: false, message }`
- Client: `showToast(message, 'error'|'success')` -- toast notifications (top-right, 4s auto-dismiss)

---

## 4. USER FLOWS & NAVIGATION

### 5 Critical User Flows

**Flow 1: Authentication**
```
Landing page → Google OAuth button → Google consent screen →
Redirect to /auth/google/callback → JWT issued →
Redirect to /?token=...&name=... → Token saved to localStorage →
App loads (start() called)
```
- **Mobile concern:** OAuth redirect works fine in mobile browsers. For native app, needs `expo-auth-session` or similar with deep link callback.

**Flow 2: Submit Race Predictions**
```
Navigate to "Predict" tab → Select 7 drivers (modal picker) →
Select 5 constructors (modal picker) → Select 1-3 wildcards →
Submit → POST /predict with JWT → Toast confirmation
```
- Lock check: Form auto-locks when `new Date() >= raceLock` (re-checked every 30s)
- Sprint weekends show extra wildcard fields

**Flow 3: View Live Timing**
```
Navigate to "Live" tab → fetch /api/live-widget →
Render table (desktop) or cards (mobile) →
Auto-refresh every 30s while tab active
```

**Flow 4: Check League Standings**
```
Navigate to "Standings" tab → fetch /api/season-leaderboard →
Render table with position, name, VIP badge, score, season picks
```

**Flow 5: Admin Finalization**
```
Admin logs in (name contains "harsh") → Admin panel visible on "Picks" tab →
Click "Finalize Race Weekend" → confirm() dialog →
POST /api/finalize → Scoring engine runs → Toast result
```

### Navigation Structure
- **Tab-based SPA:** 9 tabs controlled via `tab(name)` function
- Tabs: `home`, `predict`, `live` (Picks), `timing` (Live), `standings`, `calendar`, `grid`, `rules`, `archive`
- Active tab persisted in `localStorage` key `f1_active_tab`
- Additional: `install-btn` (PWA install), user dropdown menu (logout)

### Deep Linking
- Currently **none**. Only URL param handled: `?token=...&name=...` (OAuth callback).
- Catch-all route: `app.get(/.*/, ...)` serves `index.html` for all paths.

---

## 5. EXTERNAL INTEGRATIONS

### Third-Party Services
| Service | Type | Env Var / Config | Mobile Equivalent |
|---|---|---|---|
| **Google OAuth** | Auth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `expo-auth-session` or `@react-native-google-signin` |
| **Turso (LibSQL)** | Database | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | No change (server-side) |
| **Discord Webhook** | Notifications | `DISCORD_WEBHOOK` | No change (server-side) |
| **API-Sports F1** | Data | `API_SPORTS_KEY` | No change (server-side) |
| **Ergast F1 API** | Data | None | No change (server-side) |
| **Open-Meteo** | Weather | None | Can call directly from RN |
| **RSS2JSON** | News | None | Can call directly from RN |
| **Google Fonts** | Typography | CDN link | Use `expo-font` or bundled Titillium Web |
| **F1 Live Timing (SignalR)** | Real-time | Internal WebSocket | No change (API-side) |

### Environment Variables (Prediction App)
```
PORT, APP_URL, JWT_SECRET, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, API_SPORTS_KEY,
DISCORD_WEBHOOK, F1_TIMING_API
```

---

## 6. DATA & STATE PERSISTENCE

### Client-Side Storage
| Key | Storage | Purpose |
|---|---|---|
| `f1_token` | `localStorage` | JWT auth token |
| `f1_name` | `localStorage` | Logged-in user display name |
| `f1_active_tab` | `localStorage` | Last active tab (restored on reload) |
| `app_version` | `localStorage` | Cache-busting version check (currently "6.6") |

**React Native equivalent:** `AsyncStorage` or `expo-secure-store` (for tokens)

### Offline/Sync Requirements
- **Service Worker** exists (`sw.js`) but network-first only (no meaningful offline support)
- App is **online-only** -- all data comes from API calls
- **No offline mode needed** for MVP

### Session Management
- JWT token with 30-day expiry
- No refresh token mechanism
- Logout = `localStorage.clear()` + page reload

---

## 7. VISUAL/UX PATTERNS

### Custom UI Components
| Component | Location | Mobile Equivalent |
|---|---|---|
| **Bottom-sheet Modal Picker** | `index.html:316-324, 747-798` | React Navigation bottom sheet or `@gorhom/bottom-sheet` |
| **Toast Notifications** | `index.html:712-719` | `react-native-toast-message` |
| **Skeleton Loaders** | CSS shimmer animation | `react-native-skeleton-placeholder` |
| **Sticky Header + Tab Nav** | `header` with `position: sticky` | React Navigation tab bar |
| **Timing Cards (Mobile)** | `.tr-block` card layout | FlatList with card items |
| **Timing Table (Desktop)** | `#timing-table` | Not needed for mobile |
| **User Dropdown Menu** | `.user-dropdown` | Settings screen or drawer |

### Gestures/Animations
- `slideUp` animation (CSS keyframes) on tab switch
- `slideUpModal` on bottom-sheet open
- `slideInRight` + `fadeOut` on toast
- Hover effects (transform, box-shadow) -- irrelevant for mobile
- No swipe gestures, no pull-to-refresh

### Responsive Breakpoints
| Breakpoint | Purpose |
|---|---|
| `@media (max-width: 850px)` | Mobile layout: header wraps, nav scrolls horizontally, grids collapse to 1 column |
| `@media (min-width: 1000px)` | Desktop: larger fonts, more padding |
| `@media (max-width: 640px)` | Timing tab: hide table, show cards |
| `@media (min-width: 768px)` | Modal: centered instead of bottom-sheet |

### Design System / Color Tokens
```
--red: #e10600          (primary/accent)
--bg-light: #f5f5f7     (background)
--surface: #ffffff       (cards)
--text-main: #15151e     (primary text)
--text-muted: #666677    (secondary text)
--border: #d1d1d6        (dividers)
--gold: #c59b27          (VIP/premium)
```

---

## 8. DEPLOYMENT & PERFORMANCE

### Current Bundle
| File | Size | Notes |
|---|---|---|
| `index.html` | 96 KB | Entire SPA in one file (HTML + CSS + JS) |
| `server.js` | 33 KB | Entire backend in one file |
| `sw.js` | 0.6 KB | Service worker |
| `manifest.json` | 0.3 KB | PWA manifest |
| `icon.svg` | ~1 KB | App icon |
| **Total source** | ~131 KB | Extremely lightweight |

### PWA Status
- Has `manifest.json` with `display: standalone`
- Service worker registered (network-first strategy)
- Apple meta tags present (`apple-mobile-web-app-capable`)
- Install prompt handled (`beforeinstallprompt`)
- Already installable as home screen app on iOS/Android

### SEO/Web Features NOT Needed for Mobile
- Service worker cache-busting logic
- Browser install prompt (`beforeinstallprompt`)
- CSS scrollbar styling
- `viewport` meta tags
- Sticky header with `backdrop-filter`

### Performance Notes
- No build step = no minification, no tree-shaking
- Google Fonts loaded from CDN (render-blocking)
- All API calls use cache-busting `?t=timestamp` query params
- Server sends `Cache-Control: no-store` on all responses
- Live timing polls every 30s (not using available SSE streams)

---

## MOBILE MVP -- PRIORITIZED FEATURE LIST

### Tier 1: Must-Have (Launch MVP)
1. **Google OAuth Login** -- Use `expo-auth-session`. The backend OAuth flow stays as-is; mobile just opens the auth URL in a browser and captures the redirect with a deep link.
2. **Race Prediction Form** -- Core feature. Port the 15-field picker modal. Use `@gorhom/bottom-sheet` for driver/team selection.
3. **League Leaderboard** -- FlatList with position, name, VIP badge, score.
4. **Home Dashboard** -- Next race info, countdown, top-5 standings. Skip news feed for MVP.
5. **Prediction Viewer (Picks)** -- See other users' predictions.

### Tier 2: Should-Have (v1.1)
6. **Live Timing** -- Port the mobile card layout to a FlatList. Consider using SSE (`/stream/timing`) instead of polling for better UX.
7. **Season Calendar** -- Simple scrollable list.
8. **Season-Long Predictions** -- WDC/WCC picker (2 fields).
9. **Push Notifications** -- Replace Discord webhook with push (e.g. Expo Push). Notify when predictions lock, race finalized, scores updated.

### Tier 3: Nice-to-Have (v1.2+)
10. **Admin Panel** -- Finalize, VIP toggle, user management.
11. **Driver Grid** -- Static team/driver cards.
12. **Rules/Archive** -- Static content screens.
13. **Weather Widget** -- Open-Meteo API call.
14. **News Feed** -- RSS integration.

---

## KEY RECOMMENDATIONS

### Architecture for React Native
```
f1-mobile/
  src/
    api/           -- API client (axios/fetch wrapper, auth interceptor)
    screens/       -- HomeScreen, PredictScreen, StandingsScreen, TimingScreen, etc.
    components/    -- DriverPicker, TeamPicker, TimingCard, LeaderboardRow, Toast
    navigation/    -- Tab navigator (Home, Predict, Standings, Live, More)
    hooks/         -- useAuth, useNextRace, useLeaderboard, useLiveTiming
    constants/     -- teams.js, colors.js (port teamsData + CSS vars)
    storage/       -- AsyncStorage wrappers for token persistence
  App.tsx
```

### Backend Changes Required
1. **None for MVP.** The existing REST API is already mobile-ready -- all JSON endpoints, JWT auth.
2. **One addition:** Add a `/auth/mobile-google` endpoint that accepts a Google ID token (from the mobile Google Sign-In SDK) and returns a JWT, bypassing the redirect flow.
3. **Optional improvement:** Expose an SSE or WebSocket endpoint the mobile app can consume for live timing instead of polling.

### Key Porting Notes
- The app is **extremely simple** -- ~130KB total source, no framework, no build system. This makes conversion straightforward.
- All business logic (scoring, finalization, data fetching) lives **server-side**. The mobile app is purely a UI client.
- The existing CSS already has a mobile-responsive design at 850px and 640px breakpoints. The visual language translates directly to React Native StyleSheet.
- `teamsData` array (11 teams, 22 drivers, team colors) is the core static dataset -- port as a constants file.
- The bottom-sheet driver picker pattern already mirrors mobile native patterns -- minimal UX redesign needed.
