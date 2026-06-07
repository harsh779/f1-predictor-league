# Changelog

Notable updates to the F1 Predictor League app. Established 2026-06-07 —
entries before this date were not logged; this file starts from the
session that introduced the practice and back-fills that day's commits.

---

## 2026-06-07 — Live race widget fixes (pre-investigation)

Eight commits landed today fixing how the live widget falls back to the
last-completed session's classification when no live timing feed is
active (stale data, sort order, gap-column display, archive lookups):

- `7d20170` — fix: keep stale final classification in live widget response
- `c11c70d` — fix: load last session classification from archive when no live timing data
- `fdd8637` — fix: gap column shows WINNER only for P1 in final classification
- `9c825bc` — fix: proper final classification when no live session
- `be847db` — fix: use API's own sort order for last session, restore original columns
- `dc67796` — fix: sort by app round not filename to find most recent session
- `4e7799c` — Fix live session and picks visibility
- `2aff1d1` — Show archived qualifying timing detail

## 2026-06-07 — Live race investigation: no app-side fix needed

User reported the live race not reflecting in the app. Investigated the
full chain (`/api/live-widget` → `f1TimingApiGet` → f1-live-api). Found
the app's handling was correct throughout — `hasLiveDrivers`/
`noLiveSession`/`error` derivation, `toAbsoluteApiUrl`/
`toProxiedAudioUrl`/`normalizeTeamRadioPayload` URL-rewriting chain, and
the `/api/live/radio-audio` allowlist (`AUDIO_PATH_RE`) all already
correct for a properly-functioning upstream. The defect was entirely
upstream, in f1-live-api (see that repo's CHANGELOG v3.5 and
docs/DECISIONS.md): the classic SignalR endpoint F1 used had been
retired (hard `401`), so the API had no live data to relay no matter how
correctly the app processed it. **No app code changes were made or
required** — fix was migrating the API to SignalR Core
(f1-live-api commits `c7dbd96`/`f59e9e2`, `40ca499`/`dc47445`,
`de4b047`/`b6aeeb6`).
