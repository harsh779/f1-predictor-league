# Northflank API Deployment Guide

This file documents the Northflank portion of the final production setup.

Current production split:

- `f1-predictor-league` web app on Render
- `f1-live-api` on Northflank

## What Deploys Where

### Service 1: `f1-live-api`

- Repo: `https://github.com/harsh779/f1-live-api.git`
- Root directory: `/`
- Build source: `Dockerfile`
- Public HTTP port: `3000`
- Start command: handled by `Dockerfile`

Environment variables:

- `PORT=3000`
- `API_KEYS=<optional api key for the web app to use>`

Notes:

- The API writes cached state and saved results to local disk.
- On Northflank free services, disk should be treated as ephemeral unless you attach paid persistent storage.
- This API already backfills completed sessions from F1's archive on startup, so completed sessions can be rebuilt after restarts.
- The current live in-memory cache can still be lost during a restart and will rebuild once the F1 feed reconnects.

## Northflank Steps

1. Create a Northflank account and choose the free Sandbox workspace.
2. Click `Create project`.
3. Create a project named `f1`.
4. Add the `f1-live-api` service first.
5. Choose `Git repository`, connect GitHub if prompted, and select `harsh779/f1-live-api`.
6. Keep the root directory as `/`.
7. Choose the `Dockerfile` build option.
8. Expose HTTP port `3000`.
9. Add the API environment variables listed above.
10. Deploy the API and wait for it to become healthy.
11. Open the generated public URL and verify `/` returns JSON.
12. Copy the public API URL.
13. In Render, set the web app's `F1_TIMING_API` environment variable to that Northflank API URL.
14. Redeploy the Render web service for the app.

## Render App Pairing

The Render-hosted web app should use:

- `APP_URL=https://f1-predictor-league.onrender.com`
- `F1_TIMING_API=https://<northflank-api-domain>`

This keeps Google OAuth on an `onrender.com` domain while the live timing API runs separately on Northflank.

## Post-Deploy Checks

### API

- `GET /` returns API metadata JSON
- `GET /status` returns connection status JSON
- `GET /calendar/current` returns JSON and not an HTML error page
- `GET /stream/timing` stays connected

## Known Free-Tier Caveat

The API service does not have guaranteed persistent storage on the free tier. If Northflank restarts the container:

- completed results should repopulate from archive backfill
- current live cache may take a moment to rebuild
- any data that only exists on local disk between restarts should be treated as temporary
