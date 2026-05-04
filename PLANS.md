# Dynamic F1 Calendar Timing Audit

## Scope
- Ensure app timing behavior follows the f1-live-api calendar response.
- Remove runtime dependence on local static session times for app locks and calendar endpoints.
- Preserve result archive lookups when F1 timing archive round numbers differ from displayed rounds.

## Constraints
- The app must keep fetching schedule data from the API.
- Calendar/session response values must remain ISO strings for frontend compatibility.
- Local static schedule data must not be used as an automatic timing fallback.

## Unknowns
- F1 may not expose future timing archive meeting numbers until a race is activated in the livetiming static index.
- F1.com and livetiming can temporarily disagree during a publishing window.

## Decisions
- Use API calendar as the app source of truth.
- Use API-provided `apiRound` for timing archive result lookups.
- Use last-good dynamic cache only when the API is temporarily unavailable.

## Implementation Sequence
- Normalize API session aliases in the app.
- Preserve `apiRound` from the API calendar.
- Remove static fallback from app runtime calendar fetch.
- Move season-pick lock timing to API-derived calendar data.
- Move API result backfill off static `calendar.js` and onto the dynamic calendar service.

## Validation Sequence
- Verify API `/calendar` returns 22 races without Bahrain/Saudi.
- Verify app `/api/calendar` matches API schedule values.
- Verify Miami displays as round 4 while result lookup uses timing archive round 6.
- Verify `/api/next-race` lock timing uses corrected Sprint Qualifying.
- Verify season-pick lock comes from the dynamic opening race.

## Risks
- Static track metadata cleanup remains separate from timing correctness.
- If both the API and last-good cache are unavailable, app timing endpoints should fail rather than serve stale static dates.
