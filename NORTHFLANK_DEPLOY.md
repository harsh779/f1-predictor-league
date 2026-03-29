# Northflank Deployment Guide

This repo and `C:\Users\Harsh\Desktop\API` can be deployed to Northflank's free Sandbox tier as two services:

- `f1-live-api`
- `f1-predictor-league`

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

### Service 2: `f1-predictor-league`

- Repo: `https://github.com/harsh779/f1-predictor-league.git`
- Root directory: `/`
- Build source: `Dockerfile`
- Public HTTP port: `3000`
- Start command: handled by `Dockerfile`

Environment variables:

- `PORT=3000`
- `APP_URL=https://<northflank-web-app-domain>`
- `JWT_SECRET=<long random secret>`
- `TURSO_DATABASE_URL=<your Turso database url>`
- `TURSO_AUTH_TOKEN=<your Turso auth token>`
- `GOOGLE_CLIENT_ID=<your google oauth client id>`
- `GOOGLE_CLIENT_SECRET=<your google oauth client secret>`
- `DISCORD_WEBHOOK=<optional discord webhook>`
- `F1_TIMING_API=https://<northflank-api-domain>`
- `F1_TIMING_API_KEY=<same optional api key as above>`
- `API_SPORTS_KEY=<optional>`

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
12. Add the `f1-predictor-league` service in the same project.
13. Choose `Git repository` and select `harsh779/f1-predictor-league`.
14. Choose the `Dockerfile` build option.
15. Expose HTTP port `3000`.
16. Add the app environment variables listed above.
17. Set `F1_TIMING_API` to the live Northflank URL of the API service.
18. Deploy the app and wait for it to become healthy.
19. Open the app URL and verify the home page loads.

## Google OAuth Update

After the web app service is live, update your Google OAuth app:

1. Open Google Cloud Console.
2. Go to `APIs & Services` -> `Credentials`.
3. Open your OAuth 2.0 Client ID.
4. Add the Northflank app URL to `Authorized JavaScript origins`.
5. Add `https://<northflank-web-app-domain>/auth/google/callback` to `Authorized redirect URIs`.
6. Save the changes.
7. Redeploy the web app only if you changed `APP_URL` after the initial deploy.

## Post-Deploy Checks

### API

- `GET /` returns API metadata JSON
- `GET /status` returns connection status JSON
- `GET /calendar/current` returns JSON and not an HTML error page
- `GET /stream/timing` stays connected

### Web app

- Home page renders
- Google login works
- `/api/live/status` returns JSON
- Live timing loads
- Predictions save correctly
- Admin actions still work

## Known Free-Tier Caveat

The API service does not have guaranteed persistent storage on the free tier. If Northflank restarts the container:

- completed results should repopulate from archive backfill
- current live cache may take a moment to rebuild
- any data that only exists on local disk between restarts should be treated as temporary
