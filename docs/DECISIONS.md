# Decisions

Technical decisions for the F1 Predictor League app — what was decided,
why, what alternatives were weighed, and when. Append new entries at the
top. Established 2026-06-07.

---

## 2026-06-07 — Diagnose the API before touching the app

**Decision:** when "live race not reflecting in app" was reported, trace
the full data chain (`/api/live-widget` route → `f1TimingApiGet` helper
→ f1-live-api `/timing`+`/status`) and confirm exactly where it breaks,
*before* changing any app code.

**Reason:** the symptom (stale/missing live data) is consistent with a
fault on either side — app misreading good data, or API serving bad/no
data. Changing app code first, on a guess, risks masking the real fault
or adding code that has to be unwound once the actual cause surfaces.
Tracing first found the app's derivation logic
(`hasLiveDrivers`/`noLiveSession`/`error`, URL-rewriting chain,
`/api/live/radio-audio` allowlist) was already correct — the fault was
entirely upstream (f1-live-api was hitting a `401` from F1's retired
classic SignalR endpoint, so it had nothing live to relay).

**Alternatives considered:**
- *Patch the app's live-widget handling speculatively* — rejected; would
  not have fixed anything (the app was never the problem) and risked
  adding dead/confusing code.

**Commits:** none (investigation only — see f1-live-api CHANGELOG v3.5
and docs/DECISIONS.md for the actual fix)

---

## 2026-06-07 — Fix inside the user's own f1-live-api; reject third-party data sources

**Decision:** once the fault was isolated to F1's classic SignalR
endpoint being retired, fix it by migrating f1-live-api to F1's
replacement endpoint (SignalR Core) — not by routing the app to a
third-party live-timing API.

**Reason:** explicit project owner instruction: "API is also mine, I
want to use that and API works correctly." The user owns and controls
both repos end-to-end (no third-party dependency, no external rate
limits/ToS/availability risk), and f1-live-api already had the
infrastructure this needed (residential proxy for WAF bypass, connection
diagnostics, archive persistence) — replacing it with a third-party
source would have discarded all of that for no benefit.

**Alternatives considered:**
- *Point the app at a third-party live-timing API (e.g. OpenF1)* —
  explicitly rejected by the project owner.
- *Fix f1-live-api's connection to F1* — chosen; keeps the system
  fully first-party and reuses existing working infrastructure.

**Commits:** none in this repo (fix lives entirely in f1-live-api:
`c7dbd96`/`f59e9e2`, `40ca499`/`dc47445`, `de4b047`/`b6aeeb6`)
