# Dynamic F1 Calendar Changes

## Objective

Make the prediction app depend on the F1 live API for session timings, instead of local static schedule data. If FIA/F1 changes a session time, the API should pick it up and the app should reflect it automatically.

## Repositories

- API: `C:\Users\Harsh\Desktop\f1-calendar-dynamic-work\f1-live-api`
- App: `C:\Users\Harsh\Desktop\f1-calendar-dynamic-work\f1-predictor-league`

## API Changes

### Dynamic calendar service

Added `src/data/calendarService.js`.

It now:

- Fetches the 2026 calendar dynamically from F1.com race pages.
- Uses F1 livetiming static index as a confirmed-session source.
- Stores a last-good dynamic calendar cache on disk and in Turso KV when configured.
- Exposes `getCalendar()`, `refresh()`, `init()`, and `hookSessionInfo()`.
- Updates the in-memory/cache calendar from WebSocket `SessionInfo` events when F1 publishes live session data.

### Calendar routes

Updated `src/routes/calendar.js`.

It now:

- Serves `calendarService.getCalendar()` instead of static `calendar.js`.
- Adds `POST /calendar/refresh`.
- Keeps response shape compatible with the app.

### Startup refresh

Updated `src/index.js`.

It now:

- Initializes the dynamic calendar after Turso init.
- Hooks WebSocket `SessionInfo` into the calendar service.
- Refreshes the calendar every 15 minutes.
- Runs result backfill every 10 minutes.

### Result backfill

Updated `src/f1timing/backfill.js`.

It now:

- Uses the dynamic calendar instead of static `calendar.js`.
- Backfills each completed session independently.
- Uses F1 timing archive round numbers for filenames.
- Correctly includes Sprint Qualifying, Sprint, Qualifying, and Race once each session is complete.

### Persistence

Updated `src/f1timing/persistence.js`.

It now:

- Exposes `saveKV()` and `loadKV()` for the dynamic calendar cache.

### Track metadata

The API attaches static circuit metadata only:

- length
- laps
- corners
- first GP
- lap record

This metadata does not control schedule/session timings.

## App Changes

### API-first calendar

Updated `server.js`.

It now:

- Fetches `/calendar` from `f1-live-api`.
- Uses the API response directly as the app calendar.
- No longer falls back to static local schedule timings when the API and last-good dynamic cache are unavailable.
- Keeps a short 30-second calendar cache so API updates are reflected quickly.

### Session aliases

`normalizeCalendarEntry()` now supports both naming styles:

- `sprint_qualifying` and `sprintQuali`
- `qualifying` and `quali`

This keeps frontend code compatible while accepting API-style session keys.

### Timing archive round mapping

The app now preserves:

- `round`: display/game round
- `apiRound`: F1 timing archive round
- `timing_round`: original archive round for result files

Example:

- Miami displays as `R4`
- F1 timing archive uses `R6`
- Result files remain `2026_R06_*`
- UI shows Miami as `R4`

### Past Sessions

Updated `/api/live/results`.

It now:

- Fetches results from the API.
- Maps archive rounds back to app display rounds by matching both `apiRound` and meeting name.
- Prevents false mappings such as archive `R6` becoming Monaco.

Miami Past Sessions now includes:

- Sprint Qualifying
- Sprint
- Qualifying
- Race after F1 finalises/backfills it

### Season picks lock

Season-long picks no longer use a hardcoded Australian qualifying timestamp.

They now:

- Load the first race from the dynamic calendar.
- Use the normal prediction lock calculation.
- Return lock metadata to the frontend.

### Frontend copy/UI

Updated `public/index.html`.

It now:

- Displays dynamic season-pick lock timing.
- Removes the fixed “Australian GP Qualifying” frontend lock check.
- Uses API-provided track metadata to populate length/laps/corners/first GP/lap record.

## Validation Performed

Verified locally:

- API `/calendar` returns 22 races.
- App `/api/calendar` returns 22 races.
- Bahrain GP is absent.
- Saudi Arabian GP is absent.
- Miami displays as round `4`.
- Miami uses timing archive round `6`.
- Miami Past Sessions includes Sprint Qualifying, Sprint, and Qualifying.
- App tests pass with `npm test`.
- API syntax checks pass with `node --check`.

## Current Local URLs

- App: `http://localhost:3000`
- API: `http://localhost:3001`

## Important Notes

- No Miami-specific hardcoding was added.
- No fixed `R6 -> R4` mapping was added.
- Schedule/session times come from F1 sources and WebSocket updates.
- Static circuit metadata is only used for display facts, not timing logic.
