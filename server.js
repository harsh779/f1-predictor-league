const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production'
    ? (console.error('[FATAL] JWT_SECRET env var not set in production'), process.exit(1), '')
    : 'local_dev_only_secret_do_not_use_in_prod');
const F1_TIMING_API = process.env.F1_TIMING_API || 'https://f1-live-api.onrender.com';
const F1_TIMING_API_KEY = process.env.F1_TIMING_API_KEY || '';
const configuredAdminAuthIds = new Set((process.env.ADMIN_AUTH_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const SESSION_COOKIE_NAME = 'f1_session';
const DEFAULT_LOCAL_DB_URL = `file:${path.resolve(__dirname, 'local-preview.db').replace(/\\/g, '/')}`;

function buildF1TimingApiUrl(apiPath = '') {
    const base = F1_TIMING_API.replace(/\/+$/, '');
    return `${base}${String(apiPath).startsWith('/') ? '' : '/'}${apiPath}`;
}

function buildF1TimingApiConfig(config = {}) {
    const mergedHeaders = { ...(config.headers || {}) };
    if (F1_TIMING_API_KEY) mergedHeaders['x-api-key'] = F1_TIMING_API_KEY;
    return {
        ...config,
        headers: mergedHeaders
    };
}

async function f1TimingApiGet(apiPath, config = {}) {
    return axios.get(buildF1TimingApiUrl(apiPath), buildF1TimingApiConfig(config)).then(r => r.data);
}

app.use(express.json());

// ── Rate limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' } });
const predictLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' } });
const adminLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' } });

function parseCookies(req) {
    const header = req.headers.cookie || '';
    return header.split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx === -1) return acc;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key) acc[key] = decodeURIComponent(value);
        return acc;
    }, {});
}

function serializeCookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.httpOnly) parts.push('HttpOnly');
    if (options.secure) parts.push('Secure');
    if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
    if (options.path) parts.push(`Path=${options.path}`);
    if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
    return parts.join('; ');
}

function setSessionCookie(res, token) {
    const secure = APP_URL.startsWith('https://');
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'Lax',
        secure,
        path: '/',
        maxAge: 30 * 24 * 60 * 60
    }));
}

function clearSessionCookie(res) {
    const secure = APP_URL.startsWith('https://');
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'Lax',
        secure,
        path: '/',
        maxAge: 0
    }));
}

function decodeXmlEntities(value = '') {
    return String(value)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/gi, '/')
        .trim();
}

function stripTags(value = '') {
    return decodeXmlEntities(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractXmlTag(block, tagName) {
    const match = block.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match ? stripTags(match[1]) : '';
}

function extractXmlAttr(block, tagName, attrName) {
    const match = block.match(new RegExp(`<${tagName}\\b[^>]*\\s${attrName}="([^"]+)"[^>]*\\/?>`, 'i'));
    return match ? decodeXmlEntities(match[1]) : '';
}

function parseMotorsportRss(xml = '') {
    const items = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
    return items.slice(0, 4).map(([, block]) => {
        const title = extractXmlTag(block, 'title');
        const link = extractXmlTag(block, 'link');
        const pubDate = extractXmlTag(block, 'pubDate');
        const thumbnail = extractXmlAttr(block, 'media:thumbnail', 'url') || extractXmlAttr(block, 'enclosure', 'url');
        return { title, link, pubDate, thumbnail };
    }).filter(item => item.title && item.link);
}

// 🚀 CACHE KILLER: Forces browsers to load the newest version instantly
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: https:",
        "connect-src 'self' https://f1-live-api.onrender.com https://api.open-meteo.com https://v1.formula-1.api-sports.io https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com",
        "media-src 'self' https:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self' https://accounts.google.com"
    ].join('; '));
    next();
});

app.use('/assets/drivers', express.static(path.join(__dirname, 'Drivers'), { etag: false, lastModified: false }));
app.use('/assets/circuits', express.static(path.join(__dirname, 'Circuit Images'), { etag: false, lastModified: false }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));

function getDatabaseConfig() {
    const url = process.env.TURSO_DATABASE_URL || DEFAULT_LOCAL_DB_URL;
    if (url === DEFAULT_LOCAL_DB_URL) {
        console.log(`TURSO_DATABASE_URL not set. Using local database at ${DEFAULT_LOCAL_DB_URL}`);
        return { url };
    }
    return { url, authToken: process.env.TURSO_AUTH_TOKEN };
}

const db = createClient(getDatabaseConfig());

// --- 1. DATABASE SETUP ---
async function setupDatabase() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS f1_drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, auth_id TEXT, total_score INTEGER DEFAULT 0, has_participated INTEGER DEFAULT 0, is_vip INTEGER DEFAULT 0)`);
        try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN auth_id TEXT`); } catch (e) { }
        try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN has_participated INTEGER DEFAULT 0`); } catch (e) { }
        try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN is_vip INTEGER DEFAULT 0`); } catch (e) { }
        try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch (e) { }
        try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN auth_email TEXT`); } catch (e) { }

        // 🌍 NEW: Columns for Season-Long Predictions
        try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN season_driver TEXT`); } catch (e) { }
        try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN season_constructor TEXT`); } catch (e) { }

        // 🚀 UPGRADED TO V4 FOR NEW SCORING RULES (P10, P11, C11)
        await db.execute(`CREATE TABLE IF NOT EXISTS f1_predictions_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT UNIQUE, 
        prediction_round TEXT,
        p1 TEXT, p2 TEXT, p3 TEXT, p10 TEXT, p11 TEXT, p21 TEXT, p22 TEXT, 
        c1 TEXT, c2 TEXT, c5 TEXT, c6 TEXT, c11 TEXT, 
        w_race_loser TEXT, w_sprint_gainer TEXT, w_sprint_loser TEXT
    )`);
        try { await db.execute(`ALTER TABLE f1_predictions_v4 ADD COLUMN prediction_round TEXT`); } catch (e) { }

        await db.execute({ sql: "INSERT INTO f1_drivers (name, auth_id, is_vip, is_admin) VALUES ('admin', 'admin_override', 1, 1) ON CONFLICT(name) DO NOTHING" });
        await db.execute("UPDATE f1_drivers SET is_admin = 1 WHERE auth_id = 'admin_override'");
        if (configuredAdminAuthIds.size > 0) {
            await db.execute({ sql: `UPDATE f1_drivers SET is_admin = 1 WHERE auth_id IN (${Array.from(configuredAdminAuthIds).map(() => '?').join(',')})`, args: Array.from(configuredAdminAuthIds) });
        }
        await db.execute(`CREATE TABLE IF NOT EXISTS f1_meta (key TEXT PRIMARY KEY, value TEXT)`);
        await db.execute("CREATE TABLE IF NOT EXISTS f1_round_history (id INTEGER PRIMARY KEY AUTOINCREMENT, round TEXT, race_name TEXT, user_name TEXT, prediction TEXT, score INTEGER, scored_at TEXT)");
        await db.execute(`CREATE TABLE IF NOT EXISTS f1_draft_picks (
            user_name TEXT PRIMARY KEY,
            prediction_round TEXT,
            picks TEXT NOT NULL,
            saved_at TEXT NOT NULL
        )`);

        // Backfill round history if table is empty but users have scores
        const histCount = await db.execute("SELECT count(*) as count FROM f1_round_history").then(r => r.rows[0].count);
        if (histCount === 0) {
            const scored = await db.execute("SELECT name, total_score FROM f1_drivers WHERE name != 'admin' AND total_score != 0").then(r => r.rows);
            if (scored.length > 0) {
                for (const u of scored) {
                    await db.execute({ sql: "INSERT INTO f1_round_history (round, race_name, user_name, prediction, score, scored_at) VALUES (?, ?, ?, ?, ?, ?)", args: ['R1', 'Australian Grand Prix', u.name, '{"backfill":true}', u.total_score, '2026-03-08T10:00:00Z'] });
                }
                console.log(`[DB] Backfilled round history for ${scored.length} users`);
            }
        }

        // One-time fix: Paritosh new joiner penalty was -113 (post-round), should be -70 (pre-round)
        const pFix = await db.execute({ sql: "SELECT value FROM f1_meta WHERE key = 'fix_paritosh_r2'", args: [] });
        if (!pFix.rows[0]) {
            await db.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + 43 WHERE name = 'Paritosh Gohel'", args: [] });
            await db.execute({ sql: "UPDATE f1_round_history SET score = -70 WHERE round = 'R2' AND user_name = 'Paritosh Gohel' AND prediction LIKE '%new joiner%'", args: [] });
            await db.execute({ sql: "INSERT INTO f1_meta (key, value) VALUES ('fix_paritosh_r2', 'done')", args: [] });
            console.log("[DB] Fixed Paritosh R2 new joiner penalty: -113 -> -70 (delta +43)");
        }

        // One-time fix: Move Paritosh's new joiner penalty from R2 to R1
        const pFix2 = await db.execute({ sql: "SELECT value FROM f1_meta WHERE key = 'fix_paritosh_r2_round'", args: [] });
        if (!pFix2.rows[0]) {
            await db.execute({ sql: "UPDATE f1_round_history SET round = 'R1', race_name = 'New Joiner Penalty' WHERE round = 'R2' AND user_name = 'Paritosh Gohel' AND prediction LIKE '%new joiner%'", args: [] });
            await db.execute({ sql: "INSERT INTO f1_meta (key, value) VALUES ('fix_paritosh_r2_round', 'done')", args: [] });
            console.log("[DB] Moved Paritosh new joiner penalty from R2 to R1");
        }

        // One-time fix: Adithya +5 for Sprint Gainer (Liam Lawson) — was missed due to missing Sprint Qualifying grid
        const aFix = await db.execute({ sql: "SELECT value FROM f1_meta WHERE key = 'fix_adithya_r2_sg'", args: [] });
        if (!aFix.rows[0]) {
            await db.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + 5 WHERE name = 'Adithya Haniyamballi'", args: [] });
            await db.execute({ sql: "UPDATE f1_round_history SET score = 0 WHERE round = 'R2' AND user_name = 'Adithya Haniyamballi' AND prediction NOT LIKE '%penalty%'", args: [] });
            await db.execute({ sql: "INSERT INTO f1_meta (key, value) VALUES ('fix_adithya_r2_sg', 'done')", args: [] });
            console.log("[DB] Fixed Adithya R2 score: -5 -> 0 (Sprint Gainer +5 for Liam Lawson)");

            // Send apology + corrected scores to Discord (deferred to allow API to wake up)
            setTimeout(async () => {
                try {
                    let apology = `**Scoring Correction — Chinese Grand Prix (R2)**\n\n`;
                    apology += `Apologies everyone — Sprint Gainer and Sprint Loser wildcards were not scored in R2 due to a bug where Sprint Qualifying grid data was missing.\n\n`;
                    apology += `**Corrected wildcards:**\n`;
                    apology += `Sprint Gainer: **Liam Lawson** (SQ P13 → Sprint P7, gained 6 positions)\n`;
                    apology += `Sprint Loser: **Nico Hulkenberg** (SQ P11 → Sprint DNF, dropped 11 positions)\n\n`;
                    apology += `**Score changes:**\n`;
                    apology += `Adithya Haniyamballi: -5 → **0** (+5 for correctly predicting Liam Lawson as Sprint Gainer)\n`;
                    apology += `No other scores affected — no one predicted Nico Hulkenberg as Sprint Loser.\n\n`;
                    apology += `The bug has been fixed. Sprint wildcards will be scored correctly from the next sprint race onward.\n`;
                    await sendDiscordNotification(apology);
                    console.log('[DB] Sent R2 correction apology to Discord');
                } catch (e) { console.error('[DB] Failed to send apology:', e.message); }
            }, 15 * 1000);
        }

        console.log("Database synced.");
    } catch (e) { console.error("DB Error:", e); }
}
setupDatabase();

// --- 2. FULL 2026 CALENDAR (FULLY UPDATED WITH ALL SESSIONS) ---
const f1Calendar2026 = [
    { round: 1, name: "Australian Grand Prix", hasSprint: false, date: "2026-03-08T09:30:00+05:30", circuit: "Albert Park Circuit", country: "Australia", lat: -37.8497, lon: 144.9680, trackDetails: { length: "5.278 km", laps: 58, corners: 14, firstGP: 1996, record: "1:19.813" }, sessions: { fp1: "2026-03-06T07:00:00+05:30", fp2: "2026-03-06T10:30:00+05:30", fp3: "2026-03-07T07:00:00+05:30", quali: "2026-03-07T10:30:00+05:30", race: "2026-03-08T09:30:00+05:30" } },
    { round: 2, name: "Chinese Grand Prix", hasSprint: true, date: "2026-03-15T12:30:00+05:30", circuit: "Shanghai International Circuit", country: "China", lat: 31.3389, lon: 121.2197, trackDetails: { length: "5.451 km", laps: 56, corners: 16, firstGP: 2004, record: "1:32.238" }, sessions: { fp1: "2026-03-13T09:00:00+05:30", sprintQuali: "2026-03-13T13:00:00+05:30", sprint: "2026-03-14T08:30:00+05:30", quali: "2026-03-14T12:30:00+05:30", race: "2026-03-15T12:30:00+05:30" } },
    { round: 3, name: "Japanese Grand Prix", hasSprint: false, date: "2026-03-29T10:30:00+05:30", circuit: "Suzuka International Racing Course", country: "Japan", lat: 34.8431, lon: 136.5407, trackDetails: { length: "5.807 km", laps: 53, corners: 18, firstGP: 1987, record: "1:30.983" }, sessions: { fp1: "2026-03-27T08:00:00+05:30", fp2: "2026-03-27T11:30:00+05:30", fp3: "2026-03-28T08:00:00+05:30", quali: "2026-03-28T11:30:00+05:30", race: "2026-03-29T10:30:00+05:30" } },
    { round: 4, name: "Miami Grand Prix", hasSprint: true, date: "2026-05-04T01:30:00+05:30", circuit: "Miami International Autodrome", country: "United States", lat: 25.9581, lon: -80.2389, trackDetails: { length: "5.412 km", laps: 57, corners: 19, firstGP: 2022, record: "1:29.708" }, sessions: { fp1: "2026-05-01T21:30:00+05:30", sprintQuali: "2026-05-02T02:00:00+05:30", sprint: "2026-05-02T21:30:00+05:30", quali: "2026-05-03T01:30:00+05:30", race: "2026-05-04T01:30:00+05:30" } },
    { round: 5, name: "Canadian Grand Prix", hasSprint: true, date: "2026-05-25T01:30:00+05:30", circuit: "Circuit Gilles-Villeneuve", country: "Canada", lat: 45.5017, lon: -73.5228, trackDetails: { length: "4.361 km", laps: 70, corners: 14, firstGP: 1978, record: "1:13.078" }, sessions: { fp1: "2026-05-22T22:00:00+05:30", sprintQuali: "2026-05-23T02:00:00+05:30", sprint: "2026-05-23T21:30:00+05:30", quali: "2026-05-24T01:30:00+05:30", race: "2026-05-25T01:30:00+05:30" } },
    { round: 6, name: "Monaco Grand Prix", hasSprint: false, date: "2026-06-07T18:30:00+05:30", circuit: "Circuit de Monaco", country: "Monaco", lat: 43.7347, lon: 7.4206, trackDetails: { length: "3.337 km", laps: 78, corners: 19, firstGP: 1950, record: "1:12.909" }, sessions: { fp1: "2026-06-05T17:00:00+05:30", fp2: "2026-06-05T20:30:00+05:30", fp3: "2026-06-06T16:00:00+05:30", quali: "2026-06-06T19:30:00+05:30", race: "2026-06-07T18:30:00+05:30" } },
    { round: 7, name: "Spanish Grand Prix", hasSprint: false, date: "2026-06-14T18:30:00+05:30", circuit: "Circuit de Barcelona-Catalunya", country: "Spain", lat: 41.5700, lon: 2.2611, trackDetails: { length: "4.657 km", laps: 66, corners: 14, firstGP: 1991, record: "1:18.149" }, sessions: { fp1: "2026-06-12T17:00:00+05:30", fp2: "2026-06-12T20:30:00+05:30", fp3: "2026-06-13T16:00:00+05:30", quali: "2026-06-13T19:30:00+05:30", race: "2026-06-14T18:30:00+05:30" } },
    { round: 8, name: "Austrian Grand Prix", hasSprint: false, date: "2026-06-28T18:30:00+05:30", circuit: "Red Bull Ring", country: "Austria", lat: 47.2197, lon: 14.7647, trackDetails: { length: "4.318 km", laps: 71, corners: 10, firstGP: 1970, record: "1:05.619" }, sessions: { fp1: "2026-06-26T17:00:00+05:30", fp2: "2026-06-26T20:30:00+05:30", fp3: "2026-06-27T16:00:00+05:30", quali: "2026-06-27T19:30:00+05:30", race: "2026-06-28T18:30:00+05:30" } },
    { round: 9, name: "British Grand Prix", hasSprint: true, date: "2026-07-05T19:30:00+05:30", circuit: "Silverstone Circuit", country: "Great Britain", lat: 52.0786, lon: -1.0169, trackDetails: { length: "5.891 km", laps: 52, corners: 18, firstGP: 1950, record: "1:27.097" }, sessions: { fp1: "2026-07-03T17:00:00+05:30", sprintQuali: "2026-07-03T21:00:00+05:30", sprint: "2026-07-04T16:30:00+05:30", quali: "2026-07-04T20:30:00+05:30", race: "2026-07-05T19:30:00+05:30" } },
    { round: 10, name: "Belgian Grand Prix", hasSprint: false, date: "2026-07-19T18:30:00+05:30", circuit: "Circuit de Spa-Francorchamps", country: "Belgium", lat: 50.4372, lon: 5.9714, trackDetails: { length: "7.004 km", laps: 44, corners: 19, firstGP: 1950, record: "1:46.286" }, sessions: { fp1: "2026-07-17T17:00:00+05:30", fp2: "2026-07-17T20:30:00+05:30", fp3: "2026-07-18T16:00:00+05:30", quali: "2026-07-18T19:30:00+05:30", race: "2026-07-19T18:30:00+05:30" } },
    { round: 11, name: "Hungarian Grand Prix", hasSprint: false, date: "2026-07-26T18:30:00+05:30", circuit: "Hungaroring", country: "Hungary", lat: 47.5789, lon: 19.2486, trackDetails: { length: "4.381 km", laps: 70, corners: 14, firstGP: 1986, record: "1:16.627" }, sessions: { fp1: "2026-07-24T17:00:00+05:30", fp2: "2026-07-24T20:30:00+05:30", fp3: "2026-07-25T16:00:00+05:30", quali: "2026-07-25T19:30:00+05:30", race: "2026-07-26T18:30:00+05:30" } },
    { round: 12, name: "Dutch Grand Prix", hasSprint: true, date: "2026-08-23T18:30:00+05:30", circuit: "Circuit Zandvoort", country: "Netherlands", lat: 52.3888, lon: 4.5409, trackDetails: { length: "4.259 km", laps: 72, corners: 14, firstGP: 1952, record: "1:11.097" }, sessions: { fp1: "2026-08-21T16:00:00+05:30", sprintQuali: "2026-08-21T20:00:00+05:30", sprint: "2026-08-22T15:30:00+05:30", quali: "2026-08-22T19:30:00+05:30", race: "2026-08-23T18:30:00+05:30" } },
    { round: 13, name: "Italian Grand Prix", hasSprint: false, date: "2026-09-06T18:30:00+05:30", circuit: "Monza Circuit", country: "Italy", lat: 45.6156, lon: 9.2811, trackDetails: { length: "5.793 km", laps: 53, corners: 11, firstGP: 1950, record: "1:21.046" }, sessions: { fp1: "2026-09-04T16:00:00+05:30", fp2: "2026-09-04T19:30:00+05:30", fp3: "2026-09-05T16:00:00+05:30", quali: "2026-09-05T19:30:00+05:30", race: "2026-09-06T18:30:00+05:30" } },
    { round: 14, name: "Madrid Grand Prix", hasSprint: false, date: "2026-09-13T18:30:00+05:30", circuit: "IFEMA Madrid", country: "Spain", lat: 40.4653, lon: -3.6156, trackDetails: { length: "5.474 km", laps: 55, corners: 20, firstGP: 2026, record: "TBC" }, sessions: { fp1: "2026-09-11T17:00:00+05:30", fp2: "2026-09-11T20:30:00+05:30", fp3: "2026-09-12T16:00:00+05:30", quali: "2026-09-12T19:30:00+05:30", race: "2026-09-13T18:30:00+05:30" } },
    { round: 15, name: "Azerbaijan Grand Prix", hasSprint: false, date: "2026-09-26T16:30:00+05:30", circuit: "Baku City Circuit", country: "Azerbaijan", lat: 40.3725, lon: 49.8533, trackDetails: { length: "6.003 km", laps: 51, corners: 20, firstGP: 2016, record: "1:43.009" }, sessions: { fp1: "2026-09-24T14:00:00+05:30", fp2: "2026-09-24T17:30:00+05:30", fp3: "2026-09-25T14:00:00+05:30", quali: "2026-09-25T17:30:00+05:30", race: "2026-09-26T16:30:00+05:30" } },
    { round: 16, name: "Singapore Grand Prix", hasSprint: true, date: "2026-10-11T17:30:00+05:30", circuit: "Marina Bay Street Circuit", country: "Singapore", lat: 1.2914, lon: 103.8640, trackDetails: { length: "4.940 km", laps: 62, corners: 19, firstGP: 2008, record: "1:35.867" }, sessions: { fp1: "2026-10-09T14:00:00+05:30", sprintQuali: "2026-10-09T18:00:00+05:30", sprint: "2026-10-10T14:30:00+05:30", quali: "2026-10-10T18:30:00+05:30", race: "2026-10-11T17:30:00+05:30" } },
    { round: 17, name: "United States Grand Prix", hasSprint: false, date: "2026-10-26T01:30:00+05:30", circuit: "Circuit of the Americas", country: "USA", lat: 30.1328, lon: -97.6411, trackDetails: { length: "5.513 km", laps: 56, corners: 20, firstGP: 2012, record: "1:36.169" }, sessions: { fp1: "2026-10-23T23:00:00+05:30", fp2: "2026-10-24T02:30:00+05:30", fp3: "2026-10-24T23:00:00+05:30", quali: "2026-10-25T02:30:00+05:30", race: "2026-10-26T01:30:00+05:30" } },
    { round: 18, name: "Mexico City Grand Prix", hasSprint: false, date: "2026-11-02T01:30:00+05:30", circuit: "Autódromo Hermanos Rodríguez", country: "Mexico", lat: 19.4042, lon: -99.0907, trackDetails: { length: "4.304 km", laps: 71, corners: 17, firstGP: 1962, record: "1:17.774" }, sessions: { fp1: "2026-10-31T00:00:00+05:30", fp2: "2026-10-31T03:30:00+05:30", fp3: "2026-10-31T23:00:00+05:30", quali: "2026-11-01T02:30:00+05:30", race: "2026-11-02T01:30:00+05:30" } },
    { round: 19, name: "São Paulo Grand Prix", hasSprint: false, date: "2026-11-08T22:30:00+05:30", circuit: "Interlagos Circuit", country: "Brazil", lat: -23.7014, lon: -46.6969, trackDetails: { length: "4.309 km", laps: 71, corners: 15, firstGP: 1973, record: "1:10.540" }, sessions: { fp1: "2026-11-06T21:00:00+05:30", fp2: "2026-11-07T00:30:00+05:30", fp3: "2026-11-07T20:00:00+05:30", quali: "2026-11-07T23:30:00+05:30", race: "2026-11-08T22:30:00+05:30" } },
    { round: 20, name: "Las Vegas Grand Prix", hasSprint: false, date: "2026-11-22T09:30:00+05:30", circuit: "Las Vegas Strip Circuit", country: "USA", lat: 36.1147, lon: -115.1728, trackDetails: { length: "6.201 km", laps: 50, corners: 17, firstGP: 2023, record: "1:35.490" }, sessions: { fp1: "2026-11-20T06:00:00+05:30", fp2: "2026-11-20T09:30:00+05:30", fp3: "2026-11-21T06:00:00+05:30", quali: "2026-11-21T09:30:00+05:30", race: "2026-11-22T09:30:00+05:30" } },
    { round: 21, name: "Qatar Grand Prix", hasSprint: false, date: "2026-11-29T21:30:00+05:30", circuit: "Lusail International Circuit", country: "Qatar", lat: 25.4900, lon: 51.4542, trackDetails: { length: "5.419 km", laps: 57, corners: 16, firstGP: 2021, record: "1:24.319" }, sessions: { fp1: "2026-11-27T19:00:00+05:30", fp2: "2026-11-27T22:30:00+05:30", fp3: "2026-11-28T20:00:00+05:30", quali: "2026-11-28T23:30:00+05:30", race: "2026-11-29T21:30:00+05:30" } },
    { round: 22, name: "Abu Dhabi Grand Prix", hasSprint: false, date: "2026-12-06T18:30:00+05:30", circuit: "Yas Marina Circuit", country: "Abu Dhabi", lat: 24.4672, lon: 54.6031, trackDetails: { length: "5.281 km", laps: 58, corners: 16, firstGP: 2009, record: "1:26.103" }, sessions: { fp1: "2026-12-04T15:00:00+05:30", fp2: "2026-12-04T18:30:00+05:30", fp3: "2026-12-05T16:00:00+05:30", quali: "2026-12-05T19:30:00+05:30", race: "2026-12-06T18:30:00+05:30" } }
];

const SEASON_CALENDAR_CACHE_KEY = 'season_calendar_2026_v2';
const SEASON_CALENDAR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let seasonCalendarCache = { data: null, fetchedAt: 0 };
const UNAVAILABLE_2026_RACES = ['Bahrain Grand Prix', 'Saudi Arabian Grand Prix'];

const OFFICIAL_2026_CALENDAR_PLAN = [
    { round: 1, name: 'Australian Grand Prix', hasSprint: false },
    { round: 2, name: 'Chinese Grand Prix', hasSprint: true },
    { round: 3, name: 'Japanese Grand Prix', hasSprint: false },
    { round: 4, name: 'Bahrain Grand Prix', hasSprint: false },
    { round: 5, name: 'Saudi Arabian Grand Prix', hasSprint: false },
    { round: 6, name: 'Miami Grand Prix', hasSprint: true },
    { round: 7, name: 'Canadian Grand Prix', hasSprint: true },
    { round: 8, name: 'Monaco Grand Prix', hasSprint: false },
    { round: 9, name: 'Spanish Grand Prix', hasSprint: false },
    { round: 10, name: 'Austrian Grand Prix', hasSprint: false },
    { round: 11, name: 'British Grand Prix', hasSprint: true },
    { round: 12, name: 'Belgian Grand Prix', hasSprint: false },
    { round: 13, name: 'Hungarian Grand Prix', hasSprint: false },
    { round: 14, name: 'Dutch Grand Prix', hasSprint: true },
    { round: 15, name: 'Italian Grand Prix', hasSprint: false },
    { round: 16, name: 'Madrid Grand Prix', hasSprint: false },
    { round: 17, name: 'Azerbaijan Grand Prix', hasSprint: false },
    { round: 18, name: 'Singapore Grand Prix', hasSprint: true },
    { round: 19, name: 'United States Grand Prix', hasSprint: false },
    { round: 20, name: 'Mexico City Grand Prix', hasSprint: false },
    { round: 21, name: 'Sao Paulo Grand Prix', hasSprint: false },
    { round: 22, name: 'Las Vegas Grand Prix', hasSprint: false },
    { round: 23, name: 'Qatar Grand Prix', hasSprint: false },
    { round: 24, name: 'Abu Dhabi Grand Prix', hasSprint: false }
];

const OFFICIAL_2026_FALLBACK_EXTRAS = [
    {
        round: 4,
        name: 'Bahrain Grand Prix',
        hasSprint: false,
        date: '2026-04-12T20:30:00+05:30',
        circuit: 'Bahrain International Circuit',
        country: 'Bahrain',
        city: 'Sakhir',
        lat: 26.0325,
        lon: 50.5106,
        trackDetails: { length: '5.412 km', laps: 57, corners: 15, firstGP: 2004, record: '1:31.447' },
        sessions: {
            fp1: '2026-04-10T17:00:00+05:30',
            fp2: '2026-04-10T20:30:00+05:30',
            fp3: '2026-04-11T17:30:00+05:30',
            quali: '2026-04-11T20:30:00+05:30',
            race: '2026-04-12T20:30:00+05:30'
        }
    },
    {
        round: 5,
        name: 'Saudi Arabian Grand Prix',
        hasSprint: false,
        date: '2026-04-19T22:30:00+05:30',
        circuit: 'Jeddah Corniche Circuit',
        country: 'Saudi Arabia',
        city: 'Jeddah',
        lat: 21.6319,
        lon: 39.1044,
        trackDetails: { length: '6.174 km', laps: 50, corners: 27, firstGP: 2021, record: '1:30.734' },
        sessions: {
            fp1: '2026-04-17T19:00:00+05:30',
            fp2: '2026-04-17T22:30:00+05:30',
            fp3: '2026-04-18T19:00:00+05:30',
            quali: '2026-04-18T22:30:00+05:30',
            race: '2026-04-19T22:30:00+05:30'
        }
    }
];

function normalizeRaceName(name = '') {
    const raw = String(name || '').trim().toLowerCase();
    const aliases = {
        'sao paulo grand prix': 'saopaulograndprix',
        'são paulo grand prix': 'saopaulograndprix',
        'sÃ£o paulo grand prix': 'saopaulograndprix'
    };
    if (aliases[raw]) return aliases[raw];
    return raw
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '');
}

const OFFICIAL_2026_FALLBACK_MAP = new Map(
    [...f1Calendar2026, ...OFFICIAL_2026_FALLBACK_EXTRAS].map(r => [normalizeRaceName(r.name), r])
);

function buildOfficialCalendar(sourceCalendar = []) {
    const sourceMap = new Map(
        (Array.isArray(sourceCalendar) ? sourceCalendar : []).map(r => [normalizeRaceName(r.name), r])
    );

    const visibleCalendar = OFFICIAL_2026_CALENDAR_PLAN.filter(
        planRace => !UNAVAILABLE_2026_RACES.includes(planRace.name)
    );

    return visibleCalendar.map((planRace, index) => {
        const key = normalizeRaceName(planRace.name);
        const fallback = OFFICIAL_2026_FALLBACK_MAP.get(key);
        const source = sourceMap.get(key);
        const sessions = { ...(fallback?.sessions || {}), ...(source?.sessions || {}) };
        const trackDetails = source?.trackDetails || fallback?.trackDetails;
        const race = {
            ...(fallback || {}),
            ...(source || {}),
            round: index + 1,
            officialRound: planRace.round,
            apiRound: source ? Number(source.apiRound ?? source.round ?? 0) || null : null,
            name: planRace.name,
            hasSprint: planRace.hasSprint,
            date: sessions.race || source?.date || fallback?.date || null,
            sessions,
            trackDetails
        };
        return race.name && race.sessions?.race ? race : null;
    }).filter(Boolean);
}

function getTimingApiRound(race) {
    return Number(race?.apiRound || race?.officialRound || race?.round || 0) || null;
}

async function resolveCalendarRace(roundNum, raceName = null) {
    const seasonCalendar = await getSeasonCalendar();
    if (raceName) {
        const byName = seasonCalendar.find(r => normalizeRaceName(r.name) === normalizeRaceName(raceName));
        if (byName) return byName;
    }
    return seasonCalendar.find(r => Number(r.round) === Number(roundNum)) || null;
}

function normalizeCalendarEntry(entry) {
    if (!entry || !entry.round) return null;
    const sessions = entry.all_sessions || entry.sessions || {};
    const normalizedSessions = {
        fp1: sessions.fp1 || sessions.first_practice || null,
        fp2: sessions.fp2 || sessions.second_practice || null,
        fp3: sessions.fp3 || sessions.third_practice || null,
        sprintQuali: sessions.sprintQuali || sessions.sprint_qualifying || sessions.sprintShootout || null,
        sprint: sessions.sprint || null,
        quali: sessions.quali || sessions.qualifying || null,
        race: sessions.race || entry.session_time || entry.date || null
    };
    return {
        round: Number(entry.round),
        name: entry.name || entry.meeting,
        hasSprint: Boolean(entry.hasSprint ?? entry.has_sprint),
        date: normalizedSessions.race,
        circuit: entry.circuit,
        country: entry.country,
        city: entry.city,
        lat: entry.lat,
        lon: entry.lon,
        trackDetails: entry.trackDetails || (entry.track ? {
            length: entry.track.length_km ? `${entry.track.length_km} km` : undefined,
            laps: entry.track.laps,
            corners: entry.track.corners,
            firstGP: entry.track.first_gp,
            record: entry.track.lap_record
        } : undefined),
        sessions: normalizedSessions
    };
}

function isValidSeasonCalendar(calendar) {
    return Array.isArray(calendar)
        && calendar.length >= 20
        && calendar.every(r => r && r.round && r.name && r.sessions?.race);
}

async function persistSeasonCalendar(calendar) {
    try {
        await db.execute({
            sql: "INSERT INTO f1_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            args: [SEASON_CALENDAR_CACHE_KEY, JSON.stringify(calendar)]
        });
    } catch (e) {
        console.warn('[CAL] Failed to persist season calendar:', e.message);
    }
}

async function loadPersistedSeasonCalendar() {
    try {
        const row = await db.execute({
            sql: "SELECT value FROM f1_meta WHERE key = ?",
            args: [SEASON_CALENDAR_CACHE_KEY]
        }).then(r => r.rows[0]?.value);
        if (!row) return null;
        const parsed = JSON.parse(row);
        return isValidSeasonCalendar(parsed) ? parsed : null;
    } catch (e) {
        console.warn('[CAL] Failed to load persisted season calendar:', e.message);
        return null;
    }
}

async function fetchSeasonCalendarFromApi() {
    const remote = await f1TimingApiGet('/calendar', { timeout: 10000 });
    const normalized = Array.isArray(remote) ? remote.map(normalizeCalendarEntry).filter(Boolean) : [];
    normalized.sort((a, b) => a.round - b.round);
    if (!isValidSeasonCalendar(normalized)) throw new Error('Calendar API returned invalid data');
    const merged = buildOfficialCalendar(normalized);
    seasonCalendarCache = { data: merged, fetchedAt: Date.now() };
    await persistSeasonCalendar(merged);
    return merged;
}

async function getSeasonCalendar(options = {}) {
    const { forceRefresh = false } = options;
    if (!forceRefresh && seasonCalendarCache.data && (Date.now() - seasonCalendarCache.fetchedAt) < SEASON_CALENDAR_CACHE_TTL_MS) {
        return seasonCalendarCache.data;
    }

    try {
        return await fetchSeasonCalendarFromApi();
    } catch (e) {
        console.warn('[CAL] Live season calendar unavailable:', e.message);
    }

    if (seasonCalendarCache.data) return seasonCalendarCache.data;

    const persisted = await loadPersistedSeasonCalendar();
    if (persisted) {
        seasonCalendarCache = { data: buildOfficialCalendar(persisted), fetchedAt: Date.now() };
        return seasonCalendarCache.data;
    }

    return buildOfficialCalendar(f1Calendar2026);
}

function findUpcomingRace(calendar, now = new Date()) {
    return calendar.find(r => {
        const raceEndBuffer = new Date(r.sessions.race);
        raceEndBuffer.setHours(raceEndBuffer.getHours() + 4);
        return raceEndBuffer > now;
    }) || calendar[calendar.length - 1];
}

function findLatestCompletedRace(calendar, now = new Date()) {
    return [...calendar].reverse().find(r => new Date(r.sessions.race) < now) || null;
}

async function hasActivePredictions() {
    try {
        const count = await db.execute("SELECT COUNT(*) AS count FROM f1_predictions_v4").then(r => Number(r.rows[0]?.count || 0));
        return count > 0;
    } catch (e) {
        console.warn('[CAL] Failed to inspect active predictions:', e.message);
        return true;
    }
}

async function findStrategyRace(calendar, now = new Date()) {
    const current = findUpcomingRace(calendar, now);
    if (!current) return null;

    const raceTime = new Date(current.sessions.race);
    if (now > raceTime) {
        const activePredictions = await hasActivePredictions();
        if (!activePredictions) {
            const idx = calendar.findIndex(r => Number(r.round) === Number(current.round));
            if (idx >= 0 && idx < calendar.length - 1) return calendar[idx + 1];
        }
    }

    return current;
}

function getRoundLabel(raceOrRound) {
    const round = typeof raceOrRound === 'object' ? raceOrRound?.round : raceOrRound;
    if (round == null || round === '') return null;
    return String(round).startsWith('R') ? String(round) : `R${round}`;
}

async function hasRoundBeenScored(raceOrRound) {
    const roundLabel = getRoundLabel(raceOrRound);
    if (!roundLabel) return false;
    try {
        await db.execute("CREATE TABLE IF NOT EXISTS f1_round_history (id INTEGER PRIMARY KEY AUTOINCREMENT, round TEXT, race_name TEXT, user_name TEXT, prediction TEXT, score INTEGER, scored_at TEXT)");
        const result = await db.execute({
            sql: "SELECT COUNT(*) AS count FROM f1_round_history WHERE round = ?",
            args: [roundLabel]
        });
        return Number(result.rows[0]?.count || 0) > 0;
    } catch (e) {
        console.warn('[PREDICTIONS] Failed to inspect round history:', e.message);
        return false;
    }
}

function getPredictionLockSession(race) {
    if (!race?.sessions) return null;
    const usesSprintQuali = race.hasSprint && race.sessions.sprintQuali;
    const time = usesSprintQuali ? race.sessions.sprintQuali : race.sessions.quali;
    if (!time) return null;
    return {
        key: usesSprintQuali ? 'sprintQuali' : 'quali',
        label: usesSprintQuali ? 'Sprint Qualifying' : 'Qualifying',
        time,
        startsAt: new Date(time)
    };
}

function getPredictionLockInfo(race) {
    const session = getPredictionLockSession(race);
    if (!session || Number.isNaN(session.startsAt.getTime())) return null;
    const lockTime = new Date(session.startsAt);
    lockTime.setMinutes(lockTime.getMinutes() - 1);
    return { ...session, lockTime };
}

function getRaceNotificationScope(race, lockInfo) {
    const year = lockInfo?.startsAt?.getUTCFullYear?.() || 'unknown';
    return `${year}_r${Number(race?.round || 0)}`;
}

function formatDiscordTimestamp(date, style = 'F') {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'TBC';
    return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function getWeekendSessionTimeline(race) {
    if (!race?.sessions) return [];
    const entries = [
        { key: 'fp1', label: 'FP1', time: race.sessions.fp1 },
        { key: 'fp2', label: 'FP2', time: race.sessions.fp2 },
        { key: 'fp3', label: 'FP3', time: race.sessions.fp3 },
        { key: 'sprintQuali', label: 'Sprint Qualifying', time: race.sessions.sprintQuali },
        { key: 'sprint', label: 'Sprint', time: race.sessions.sprint },
        { key: 'quali', label: race.hasSprint ? 'Grand Prix Qualifying' : 'Qualifying', time: race.sessions.quali },
        { key: 'race', label: 'Race', time: race.sessions.race }
    ];

    return entries
        .filter(session => session.time)
        .map(session => ({ ...session, startsAt: new Date(session.time) }))
        .filter(session => !Number.isNaN(session.startsAt.getTime()))
        .sort((a, b) => a.startsAt - b.startsAt);
}

function findNextWeekendSession(race, now = new Date()) {
    return getWeekendSessionTimeline(race).find(session => session.startsAt > now) || null;
}

function normalizeWeatherPayload(raw) {
    if (!raw) return null;
    const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');
    const num = (v) => {
        const parsed = Number(v);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const airTemp = num(pick(raw.AirTemp, raw.air_temp, raw.temperature_2m));
    const trackTemp = num(pick(raw.TrackTemp, raw.track_temp, raw.surface_temp, airTemp));
    const humidity = num(pick(raw.Humidity, raw.humidity, raw.relative_humidity_2m));
    const windSpeed = num(pick(raw.WindSpeed, raw.wind_speed, raw.wind_speed_10m));
    const rainfall = num(pick(raw.Rainfall, raw.precipitation, 0));

    if ([trackTemp, airTemp, humidity, windSpeed].every(v => v === null)) return null;

    return {
        TrackTemp: trackTemp,
        AirTemp: airTemp,
        Humidity: humidity,
        WindSpeed: windSpeed,
        Rainfall: rainfall ?? 0,
        condition: raw.condition || (rainfall > 0 ? 'Showers nearby' : 'Trackside forecast stable'),
        source: raw.source || 'live'
    };
}

const F1_STATIC_BASE = 'https://livetiming.formula1.com/static/';

function toAbsoluteApiUrl(url) {
    if (!url || typeof url !== 'string') return null;
    if (/^https?:\/\//i.test(url)) return url;
    return buildF1TimingApiUrl(url);
}

// Rewrite F1 static audio URLs to go through our proxy (avoids CORS block)
function toProxiedAudioUrl(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith(F1_STATIC_BASE)) {
        const path = url.slice(F1_STATIC_BASE.length);
        return `/api/live/radio-audio?path=${encodeURIComponent(path)}`;
    }
    return url;
}

function normalizeRadioMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const text = raw.message || raw.Message || raw.transcript || raw.Transcript || raw.caption || raw.Caption || raw.title || raw.Title || '';
    const audioUrl = toProxiedAudioUrl(toAbsoluteApiUrl(raw.audio_url || raw.audioUrl || raw.url || raw.Url || raw.path || raw.Path || raw.recording_url || raw.recordingUrl));
    const timestamp = raw.timestamp || raw.Timestamp || raw.utc || raw.Utc || raw.time || raw.Time || null;
    const driverNumber = raw.driver_number || raw.driverNumber || raw.racing_number || raw.RacingNumber || raw.number || raw.Number || null;
    const name = raw.name || raw.driver_name || raw.driverName || raw.full_name || raw.FullName || raw.fullName || null;
    const acronym = raw.acronym || raw.tla || raw.Tla || raw.short_name || raw.ShortName || raw.broadcast_name || raw.BroadcastName || null;
    const team = raw.team || raw.Team || raw.team_name || raw.teamName || null;

    if (!text && !audioUrl && !timestamp && !driverNumber && !name && !acronym && !team) return null;

    return {
        text,
        audio_url: audioUrl,
        timestamp,
        driver_number: driverNumber,
        name,
        acronym,
        team
    };
}

function normalizeTeamRadioPayload(payload) {
    const rawMessages = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.messages)
            ? payload.messages
            : Array.isArray(payload?.Messages)
                ? payload.Messages
                : [];

    const messages = rawMessages.map(normalizeRadioMessage).filter(Boolean);

    return {
        timestamp: payload?.timestamp || payload?.Timestamp || null,
        session: payload?.session || payload?.Session || null,
        total: payload?.total ?? payload?.Total ?? messages.length,
        messages
    };
}

function isConfiguredAdmin(authId) {
    return Boolean(authId) && configuredAdminAuthIds.has(authId);
}

async function findUserByAuthId(authId) {
    if (!authId) return null;
    return db.execute({
        sql: "SELECT id, name, auth_id, auth_email, is_admin FROM f1_drivers WHERE auth_id = ? LIMIT 1",
        args: [authId]
    }).then(r => r.rows[0] || null);
}

async function shouldRevealPredictionsTo(user) {
    if (user?.isAdmin) return true;
    const now = new Date();
    const seasonCalendar = await getSeasonCalendar();
    const currentRace = await findStrategyRace(seasonCalendar, now);
    if (!currentRace) return true;
    const lockInfo = getPredictionLockInfo(currentRace);
    if (!lockInfo) return false;
    return now > lockInfo.lockTime;
}

function validateUniqueSelection(values) {
    const normalized = values.filter(Boolean).map(v => normalizeStr(String(v)));
    return new Set(normalized).size === normalized.length;
}

function validatePredictionPayload(payload) {
    const requiredDriverFields = ['p1', 'p2', 'p3', 'p10', 'p11', 'p21', 'p22'];
    const requiredTeamFields = ['c1', 'c2', 'c5', 'c6', 'c11'];
    const requiredWildcardFields = ['w_race_loser'];
    const allRequired = [...requiredDriverFields, ...requiredTeamFields, ...requiredWildcardFields];

    for (const field of allRequired) {
        if (!payload[field] || !String(payload[field]).trim()) {
            return `${field} is required`;
        }
    }

    const driverValues = requiredDriverFields.map(field => payload[field]);
    if (!validateUniqueSelection(driverValues)) return 'Driver predictions must be unique';

    const teamValues = requiredTeamFields.map(field => payload[field]);
    if (!validateUniqueSelection(teamValues)) return 'Constructor predictions must be unique';

    const wildcardValues = [payload.w_race_loser, payload.w_sprint_gainer, payload.w_sprint_loser].filter(Boolean);
    if (!validateUniqueSelection(wildcardValues)) return 'Wildcard predictions must be unique';

    const allValues = [...driverValues, ...teamValues, ...wildcardValues];
    if (allValues.some(v => String(v).length > 80)) return 'Prediction values are too long';

    return null;
}

async function ensureDriverRecord(executor, userName) {
    const trimmed = String(userName || '').trim();
    if (!trimmed) throw new Error('user_name is required');
    const existing = await executor.execute({
        sql: "SELECT id FROM f1_drivers WHERE name = ? LIMIT 1",
        args: [trimmed]
    }).then(r => r.rows[0] || null);

    if (existing) {
        await executor.execute({
            sql: "UPDATE f1_drivers SET has_participated = 1 WHERE id = ?",
            args: [existing.id]
        });
        return { created: false, userName: trimmed };
    }

    await executor.execute({
        sql: "INSERT INTO f1_drivers (name, has_participated) VALUES (?, 1)",
        args: [trimmed]
    });
    return { created: true, userName: trimmed };
}

async function upsertPredictionRecord(executor, userName, payload, predictionRound = null) {
    await executor.execute({
        sql: `INSERT INTO f1_predictions_v4 (user_name, prediction_round, p1, p2, p3, p10, p11, p21, p22, c1, c2, c5, c6, c11, w_race_loser, w_sprint_gainer, w_sprint_loser) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
            ON CONFLICT(user_name) DO UPDATE SET 
            prediction_round=excluded.prediction_round,
            p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p10=excluded.p10, p11=excluded.p11, p21=excluded.p21, p22=excluded.p22, 
            c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c11=excluded.c11, 
            w_race_loser=excluded.w_race_loser, w_sprint_gainer=excluded.w_sprint_gainer, w_sprint_loser=excluded.w_sprint_loser`,
        args: [
            userName,
            predictionRound,
            payload.p1,
            payload.p2,
            payload.p3,
            payload.p10,
            payload.p11,
            payload.p21,
            payload.p22,
            payload.c1,
            payload.c2,
            payload.c5,
            payload.c6,
            payload.c11,
            payload.w_race_loser,
            payload.w_sprint_gainer || null,
            payload.w_sprint_loser || null
        ]
    });
}

async function recalculateDriverTotal(executor, userName) {
    const row = await executor.execute({
        sql: "SELECT COALESCE(SUM(score), 0) AS total FROM f1_round_history WHERE user_name = ?",
        args: [userName]
    }).then(r => r.rows[0] || { total: 0 });

    await executor.execute({
        sql: "UPDATE f1_drivers SET total_score = ?, has_participated = CASE WHEN ? != 0 THEN 1 ELSE has_participated END WHERE name = ?",
        args: [Number(row.total || 0), Number(row.total || 0), userName]
    });

    return Number(row.total || 0);
}

async function replacePredictionsTable(executor, entries, predictionRound = null) {
    await executor.execute("DELETE FROM f1_predictions_v4");
    for (const entry of entries) {
        await ensureDriverRecord(executor, entry.userName);
        await upsertPredictionRecord(executor, entry.userName, entry.payload, entry.predictionRound ?? predictionRound);
    }
}

function normalizeImportSubmissions(rawSubmissions) {
    const submissions = Array.isArray(rawSubmissions) ? rawSubmissions : null;
    if (!submissions || submissions.length === 0) {
        throw new Error('submissions array required');
    }

    const normalized = [];
    for (let i = 0; i < submissions.length; i++) {
        const raw = submissions[i] || {};
        const userName = String(raw.user_name || raw.userName || '').trim();
        if (!userName) {
            throw new Error(`Entry ${i + 1}: user_name is required`);
        }

        const payload = {
            p1: raw.p1,
            p2: raw.p2,
            p3: raw.p3,
            p10: raw.p10,
            p11: raw.p11,
            p21: raw.p21,
            p22: raw.p22,
            c1: raw.c1,
            c2: raw.c2,
            c5: raw.c5,
            c6: raw.c6,
            c11: raw.c11,
            w_race_loser: raw.w_race_loser,
            w_sprint_gainer: raw.w_sprint_gainer,
            w_sprint_loser: raw.w_sprint_loser
        };

        const validationError = validatePredictionPayload(payload);
        if (validationError) {
            throw new Error(`Entry ${i + 1} (${userName}): ${validationError}`);
        }
        normalized.push({ userName, payload });
    }

    return normalized;
}

// --- 3. HELPERS ---
function normalizeStr(s) { return s ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : ""; }
function normalizeConstructor(c) {
    const l = normalizeStr(c);
    if (l.includes("mclaren")) return "mclaren";
    if (l.includes("red bull") || l.includes("redbull")) return "red bull";
    if (l.includes("ferrari")) return "ferrari";
    if (l.includes("mercedes")) return "mercedes";
    if (l.includes("aston")) return "aston martin";
    if (l.includes("alpine")) return "alpine";
    if (l.includes("haas")) return "haas";
    if (l.includes("rb") || l.includes("racing bulls")) return "racing bulls";
    if (l.includes("williams")) return "williams";
    if (l.includes("sauber") || l.includes("audi")) return "audi";
    if (l.includes("cadillac")) return "cadillac";
    return l;
}

// --- 4. JWT AUTHENTICATION MIDDLEWARE ---
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.split(' ')[1];
    const cookieToken = parseCookies(req)[SESSION_COOKIE_NAME];
    const token = headerToken || cookieToken;
    if (!token) return res.status(401).json({ error: "Access Denied: Missing Token" });

    try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        const authId = decoded.auth_id || decoded.id;
        const dbUser = await findUserByAuthId(authId);
        if (!dbUser) return res.status(403).json({ error: "Access Denied: Unknown User" });

        req.user = {
            driverId: dbUser.id,
            name: dbUser.name,
            auth_id: dbUser.auth_id,
            email: dbUser.auth_email || null,
            isAdmin: Number(dbUser.is_admin || 0) === 1 || isConfiguredAdmin(dbUser.auth_id)
        };
        next();
    } catch (err) {
        return res.status(403).json({ error: "Access Denied: Invalid Token" });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user?.isAdmin) return res.status(403).json({ success: false, error: 'Unauthorized' });
    next();
}

async function ensureLocalPreviewData() {
    const obsoletePreviewNames = [
        'Apex Strategist',
        'Pit Wall Wizard',
        'Velocity Predictor',
        'Redline Master',
        'Grid Guru',
        'Podium Picks',
        'Backmarkers',
        'Constructor Targets',
        'Wildcards',
        'Race Day Investor'
    ];
    const players = [
        ['Chaitanya Agarwal', 'preview_chaitanya', -25, 0, 0, 'Lewis Hamilton', 'Mercedes'],
        ['Adithya Haniyamballi', 'preview_adithya', -41, 0, 0, 'George Russell', 'Mercedes'],
        ['Niranchan Ramamoorthy', 'preview_niranchan', -52, 0, 0, 'George Russell', 'Mercedes'],
        ['Harsh khandelwal', 'admin_override', -61, 0, 1, 'George Russell', 'Mercedes'],
        ['Vikalp Khandelwal', 'preview_vikalp', -116, 0, 0, 'Charles Leclerc', 'Mercedes'],
        ['Paritosh Gohel', 'preview_paritosh', -137, 0, 0, 'Oscar Piastri', 'McLaren']
    ];

    await db.execute({
        sql: `UPDATE f1_drivers
              SET has_participated = 0, auth_id = NULL
              WHERE name IN (${obsoletePreviewNames.map(() => '?').join(',')})
                 OR auth_id LIKE 'preview_%'`,
        args: obsoletePreviewNames
    });

    for (const p of players) {
        await db.execute({
            sql: `INSERT INTO f1_drivers (name, auth_id, total_score, has_participated, is_vip, is_admin, season_driver, season_constructor)
                  VALUES (?, ?, ?, 1, ?, ?, ?, ?)
                  ON CONFLICT(name) DO UPDATE SET
                    auth_id = CASE WHEN f1_drivers.auth_id IS NULL OR f1_drivers.auth_id LIKE 'preview_%' OR f1_drivers.auth_id = 'admin_override' THEN excluded.auth_id ELSE f1_drivers.auth_id END,
                    total_score = CASE WHEN f1_drivers.total_score = 0 OR f1_drivers.auth_id LIKE 'preview_%' OR f1_drivers.auth_id = 'admin_override' THEN excluded.total_score ELSE f1_drivers.total_score END,
                    has_participated = 1,
                    is_vip = excluded.is_vip,
                    is_admin = CASE WHEN excluded.is_admin = 1 THEN 1 ELSE f1_drivers.is_admin END,
                    season_driver = COALESCE(f1_drivers.season_driver, excluded.season_driver),
                    season_constructor = COALESCE(f1_drivers.season_constructor, excluded.season_constructor)`,
            args: p
        });
    }

    const historyCount = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM f1_round_history WHERE user_name IN (?, ?, ?, ?, ?, ?)",
        args: players.map(p => p[0])
    }).then(r => Number(r.rows[0]?.count || 0)).catch(() => 0);

    if (historyCount < 18) {
        await db.execute({
            sql: `DELETE FROM f1_round_history
                  WHERE user_name IN (${players.map(() => '?').join(',')})
                     OR user_name IN (${obsoletePreviewNames.map(() => '?').join(',')})`,
            args: [...players.map(p => p[0]), ...obsoletePreviewNames]
        });

        const historyRows = [
            ['R1', 'Australian Grand Prix', 'Harsh khandelwal', '{"backfill":true}', -23],
            ['R1', 'Australian Grand Prix', 'Chaitanya Agarwal', '{"backfill":true}', -11],
            ['R1', 'Australian Grand Prix', 'Niranchan Ramamoorthy', '{"backfill":true}', -27],
            ['R1', 'Australian Grand Prix', 'Adithya Haniyamballi', '{"backfill":true}', -32],
            ['R1', 'Australian Grand Prix', 'Vikalp Khandelwal', '{"backfill":true}', -65],
            ['R2', 'Chinese Grand Prix', 'Paritosh Gohel', '{"p1":"George Russell","p2":"Charles Leclerc","p3":"Kimi Antonelli","p10":"Pierre Gasly","p11":"Lance Stroll","p21":"Valtteri Bottas","p22":"Sergio Perez","c1":"Mercedes","c2":"Ferrari","c5":"McLaren","c6":"Haas","c11":"Cadillac","w_race_loser":"Sergio Perez","w_sprint_gainer":"Lewis Hamilton","w_sprint_loser":"Liam Lawson"}', -42],
            ['R2', 'Chinese Grand Prix', 'Chaitanya Agarwal', '{"p1":"George Russell","p2":"Lewis Hamilton","p3":"Charles Leclerc","p10":"Nico Hulkenberg","p11":"Pierre Gasly","p21":"Fernando Alonso","p22":"Lance Stroll","c1":"Ferrari","c2":"Mercedes","c5":"Haas","c6":"Racing Bulls","c11":"Aston Martin","w_race_loser":"Sergio Perez","w_sprint_gainer":"Kimi Antonelli","w_sprint_loser":"Franco Colapinto"}', -7],
            ['R2', 'Chinese Grand Prix', 'Harsh khandelwal', '{"p1":"George Russell","p2":"Kimi Antonelli","p3":"Lewis Hamilton","p10":"Liam Lawson","p11":"Carlos Sainz","p21":"Lance Stroll","p22":"Sergio Perez","c1":"Mercedes","c2":"Ferrari","c5":"Red Bull Racing","c6":"Racing Bulls","c11":"Aston Martin","w_race_loser":"Isack Hadjar","w_sprint_gainer":"Lewis Hamilton","w_sprint_loser":"Esteban Ocon"}', -10],
            ['R2', 'Chinese Grand Prix', 'Adithya Haniyamballi', '{"p1":"George Russell","p2":"Lewis Hamilton","p3":"Kimi Antonelli","p10":"Esteban Ocon","p11":"Pierre Gasly","p21":"Fernando Alonso","p22":"Lance Stroll","c1":"Mercedes","c2":"Ferrari","c5":"Racing Bulls","c6":"Haas","c11":"Aston Martin","w_race_loser":"Fernando Alonso","w_sprint_gainer":"Liam Lawson","w_sprint_loser":"Lance Stroll"}', 0],
            ['R2', 'Chinese Grand Prix', 'Niranchan Ramamoorthy', '{"p1":"George Russell","p2":"Kimi Antonelli","p3":"Max Verstappen","p10":"Isack Hadjar","p11":"Oliver Bearman","p21":"Lance Stroll","p22":"Fernando Alonso","c1":"Mercedes","c2":"Ferrari","c5":"Racing Bulls","c6":"Alpine","c11":"Aston Martin","w_race_loser":"Lando Norris","w_sprint_gainer":"Max Verstappen","w_sprint_loser":"Kimi Antonelli"}', -23],
            ['R2', 'Chinese Grand Prix', 'Vikalp Khandelwal', '{"p1":"George Russell","p2":"Lando Norris","p3":"Kimi Antonelli","p10":"Isack Hadjar","p11":"Liam Lawson","p21":"Gabriel Bortoleto","p22":"Valtteri Bottas","c1":"Mercedes","c2":"Ferrari","c5":"Red Bull Racing","c6":"Haas","c11":"Cadillac","w_race_loser":"Carlos Sainz","w_sprint_gainer":"Carlos Sainz","w_sprint_loser":"Lewis Hamilton"}', -43],
            ['R1', 'New Joiner Penalty', 'Paritosh Gohel', '{"penalty":"new joiner"}', -70],
            ['R3', 'Japanese Grand Prix', 'Niranchan Ramamoorthy', '{"p1":"George Russell","p2":"Kimi Antonelli","p3":"Charles Leclerc","p10":"Isack Hadjar","p11":"Nico Hulkenberg","p21":"Fernando Alonso","p22":"Lance Stroll","c1":"Mercedes","c2":"Ferrari","c5":"Red Bull Racing","c6":"Audi","c11":"Aston Martin","w_race_loser":"Oscar Piastri","w_sprint_gainer":null,"w_sprint_loser":null}', -2],
            ['R3', 'Japanese Grand Prix', 'Chaitanya Agarwal', '{"p1":"George Russell","p2":"Kimi Antonelli","p3":"Charles Leclerc","p10":"Arvid Lindblad","p11":"Liam Lawson","p21":"Fernando Alonso","p22":"Lance Stroll","c1":"Mercedes","c2":"Ferrari","c5":"Haas F1 Team","c6":"Racing Bulls","c11":"Aston Martin","w_race_loser":"Lando Norris","w_sprint_gainer":null,"w_sprint_loser":null}', -7],
            ['R3', 'Japanese Grand Prix', 'Harsh khandelwal', '{"p1":"Kimi Antonelli","p2":"George Russell","p3":"Charles Leclerc","p10":"Oliver Bearman","p11":"Pierre Gasly","p21":"Nico Hulkenberg","p22":"Sergio Perez","c1":"Mercedes","c2":"Ferrari","c5":"Red Bull Racing","c6":"Racing Bulls","c11":"Cadillac","w_race_loser":"Lando Norris","w_sprint_gainer":null,"w_sprint_loser":null}', -28],
            ['R3', 'Japanese Grand Prix', 'Adithya Haniyamballi', '{"p1":"George Russell","p2":"Kimi Antonelli","p3":"Lewis Hamilton","p10":"Pierre Gasly","p11":"Liam Lawson","p21":"Fernando Alonso","p22":"Lance Stroll","c1":"Mercedes","c2":"Ferrari","c5":"Racing Bulls","c6":"Alpine","c11":"Cadillac","w_race_loser":"Liam Lawson","w_sprint_gainer":null,"w_sprint_loser":null}', -9],
            ['R3', 'Japanese Grand Prix', 'Vikalp Khandelwal', '{"p1":"George Russell","p2":"Kimi Antonelli","p3":"Lewis Hamilton","p10":"Liam Lawson","p11":"Arvid Lindblad","p21":"Fernando Alonso","p22":"Lance Stroll","c1":"Mercedes","c2":"Ferrari","c5":"Red Bull Racing","c6":"Racing Bulls","c11":"Aston Martin","w_race_loser":"Pierre Gasly","w_sprint_gainer":null,"w_sprint_loser":null}', -8],
            ['R3', 'Japanese Grand Prix', 'Paritosh Gohel', '{"p1":"Kimi Antonelli","p2":"George Russell","p3":"Charles Leclerc","p10":"Oliver Bearman","p11":"Pierre Gasly","p21":"Nico Hulkenberg","p22":"Sergio Perez","c1":"Mercedes","c2":"Ferrari","c5":"Red Bull Racing","c6":"Racing Bulls","c11":"Aston Martin","w_race_loser":"Lando Norris","w_sprint_gainer":null,"w_sprint_loser":null}', -25]
        ];

        for (const row of historyRows) {
            await db.execute({
                sql: "INSERT INTO f1_round_history (round, race_name, user_name, prediction, score) VALUES (?, ?, ?, ?, ?)",
                args: row
            });
        }
    }

    const predictionCount = await db.execute("SELECT COUNT(*) AS count FROM f1_predictions_v4").then(r => Number(r.rows[0]?.count || 0));
    if (predictionCount === 0) {
        const submissions = [
            ['Harsh khandelwal', 'R4', 'Kimi Antonelli', 'George Russell', 'Charles Leclerc', 'Oliver Bearman', 'Pierre Gasly', 'Nico Hulkenberg', 'Sergio Perez', 'Mercedes', 'Ferrari', 'Red Bull Racing', 'Racing Bulls', 'Cadillac', 'Lando Norris', '', ''],
            ['Chaitanya Agarwal', 'R4', 'George Russell', 'Kimi Antonelli', 'Charles Leclerc', 'Arvid Lindblad', 'Liam Lawson', 'Fernando Alonso', 'Lance Stroll', 'Mercedes', 'Ferrari', 'Haas F1 Team', 'Racing Bulls', 'Aston Martin', 'Lando Norris', '', ''],
            ['Paritosh Gohel', 'R4', 'Kimi Antonelli', 'George Russell', 'Charles Leclerc', 'Oliver Bearman', 'Pierre Gasly', 'Nico Hulkenberg', 'Sergio Perez', 'Mercedes', 'Ferrari', 'Red Bull Racing', 'Racing Bulls', 'Aston Martin', 'Lando Norris', '', '']
        ];
        for (const row of submissions) {
            await db.execute({
                sql: `INSERT INTO f1_predictions_v4
                    (user_name, prediction_round, p1, p2, p3, p10, p11, p21, p22, c1, c2, c5, c6, c11, w_race_loser, w_sprint_gainer, w_sprint_loser)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: row
            });
        }
    }
}

// --- 5. OAUTH ROUTES (GOOGLE ONLY) ---
app.get('/auth/google', authLimiter, (req, res) => {
    const state = jwt.sign({ type: 'oauth_state', nonce: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '10m' });
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(APP_URL + '/auth/google/callback')}&response_type=code&scope=profile email&prompt=select_account&state=${encodeURIComponent(state)}`;
    res.redirect(url);
});

app.get('/auth/google/callback', authLimiter, async (req, res) => {
    try {
        const { code, state } = req.query;
        const verifiedState = jwt.verify(String(state || ''), JWT_SECRET, { algorithms: ['HS256'] });
        if (verifiedState?.type !== 'oauth_state') throw new Error('Invalid OAuth state');
        const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            code, grant_type: 'authorization_code', redirect_uri: `${APP_URL}/auth/google/callback`
        });

        const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
        });

        const googleUser = userResponse.data;
        const authId = `google_${googleUser.id}`;
        const name = (googleUser.name || '').trim();
        const email = googleUser.email || null;
        const existingByAuth = await findUserByAuthId(authId);
        const existingByName = name
            ? await db.execute({ sql: "SELECT id, name, auth_id, is_admin FROM f1_drivers WHERE name = ? LIMIT 1", args: [name] }).then(r => r.rows[0] || null)
            : null;

        let effectiveName = name || existingByAuth?.name || 'Driver';
        const promotedAdmin = isConfiguredAdmin(authId);

        if (existingByAuth) {
            if (existingByName && existingByName.id !== existingByAuth.id && existingByName.auth_id && existingByName.auth_id !== authId) {
                effectiveName = existingByAuth.name;
            }
            await db.execute({
                sql: "UPDATE f1_drivers SET name = ?, auth_email = ?, is_admin = CASE WHEN ? THEN 1 ELSE is_admin END WHERE auth_id = ?",
                args: [effectiveName, email, promotedAdmin ? 1 : 0, authId]
            });
        } else if (existingByName && existingByName.auth_id && existingByName.auth_id !== authId) {
            return res.redirect('/?error=name_taken');
        } else if (existingByName) {
            await db.execute({
                sql: "UPDATE f1_drivers SET auth_id = ?, auth_email = ?, is_admin = CASE WHEN ? THEN 1 ELSE is_admin END WHERE id = ?",
                args: [authId, email, promotedAdmin ? 1 : 0, existingByName.id]
            });
        } else {
            await db.execute({
                sql: "INSERT INTO f1_drivers (name, auth_id, auth_email, is_admin) VALUES (?, ?, ?, ?)",
                args: [effectiveName, authId, email, promotedAdmin ? 1 : 0]
            });
        }

        const token = jwt.sign({ name: effectiveName, auth_id: authId }, JWT_SECRET, { expiresIn: '30d' });
        setSessionCookie(res, token);
        res.redirect('/');
    } catch (error) { res.redirect('/?error=oauth_failed'); }
});

app.post('/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ success: true });
});

app.get('/auth/local-dev', async (req, res) => {
    const host = String(req.headers.host || '').toLowerCase();
    const isLocalHost = host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('[::1]:');
    if (process.env.ENABLE_LOCAL_AUTH !== '1' || process.env.NODE_ENV === 'production' || !isLocalHost) {
        return res.status(404).send('Not found');
    }

    const authId = 'admin_override';
    const localName = process.env.LOCAL_AUTH_NAME || 'Harsh khandelwal';
    await ensureLocalPreviewData();
    await db.execute({ sql: "UPDATE f1_drivers SET auth_id = NULL WHERE auth_id = ? AND name != ?", args: [authId, localName] });
    await db.execute({ sql: "UPDATE f1_drivers SET auth_id = ?, is_admin = 1 WHERE name = ?", args: [authId, localName] });
    const token = jwt.sign({ name: localName, auth_id: authId }, JWT_SECRET, { expiresIn: '12h' });
    setSessionCookie(res, token);
    res.redirect('/');
});

// --- 6. SCORING ENGINE (V4 NEW RULES) ---
async function sendDiscordNotification(msg) {
    const url = process.env.DISCORD_WEBHOOK;
    if (!url) { console.warn('[DISCORD] No DISCORD_WEBHOOK env var set — skipping notification'); return; }
    const fullMsg = `🏎️ **F1 Steward:** ${msg}`;
    // Discord has a 2000 char limit — split if needed
    const chunks = [];
    if (fullMsg.length <= 2000) { chunks.push(fullMsg); }
    else { for (let i = 0; i < fullMsg.length; i += 2000) chunks.push(fullMsg.slice(i, i + 2000)); }
    for (const chunk of chunks) {
        try {
            await axios.post(url, { content: chunk }, { timeout: 10000 });
            console.log('[DISCORD] Message sent successfully');
        } catch (e) {
            console.error(`[DISCORD] Webhook error: ${e.response?.status || 'NO_RESPONSE'} — ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
        }
    }
}

function buildDiscordBreakdown(raceName, roundLabel, sorted, scoreBreakdowns, raceLosers, sprintResults, sprintGainers, sprintLosers, penalty, hasResults, seasonTotals) {
    let msg = `**${raceName} (${roundLabel}) — Score Breakdown**\n`;
    msg += `Race Loser: ${raceLosers.join(', ') || 'N/A'}\n`;
    if (sprintResults.length > 0) msg += `Sprint Gainer: ${sprintGainers.join(', ') || 'N/A'} | Sprint Loser: ${sprintLosers.join(', ') || 'N/A'}\n`;
    if (penalty !== undefined) msg += `No-sub penalty: ${penalty}\n`;
    msg += '\n';

    // Summary table
    const maxName = Math.max(...sorted.map(([n]) => n.length), 6);
    const hasSeason = seasonTotals && Object.keys(seasonTotals).length > 0;
    msg += '```\n';
    msg += hasSeason
        ? ` #  ${'Player'.padEnd(maxName)}  Round  Season    D    C    W\n`
        : ` #  ${'Player'.padEnd(maxName)}  Total    D    C    W\n`;
    msg += ' ' + '-'.repeat(maxName + (hasSeason ? 40 : 30)) + '\n';
    sorted.forEach(([name, data], i) => {
        const bd = scoreBreakdowns[name];
        const rank = String(i + 1).padStart(2);
        const roundScore = String(data.score).padStart(5);
        const season = hasSeason ? String(seasonTotals[name] ?? '?').padStart(6) : '';
        if (bd) {
            const d = String(bd.driverPts).padStart(4);
            const c = String(bd.constructorPts).padStart(4);
            const w = String(bd.wildcardPts).padStart(4);
            msg += hasSeason
                ? `${rank}  ${name.padEnd(maxName)}  ${roundScore}  ${season}  ${d}  ${c}  ${w}`
                : `${rank}  ${name.padEnd(maxName)}  ${roundScore}  ${d}  ${c}  ${w}`;
        } else {
            let tag = !data.hadPrediction ? '(no sub)' : '';
            msg += hasSeason
                ? `${rank}  ${name.padEnd(maxName)}  ${roundScore}  ${season}  ${tag}`
                : `${rank}  ${name.padEnd(maxName)}  ${roundScore}  ${tag}`;
        }
        if (data.newJoinerPenalty !== undefined) msg += `  [NJ: ${data.newJoinerPenalty}]`;
        msg += '\n';
    });
    msg += '```\n';

    // Detailed per-player breakdown
    if (hasResults) {
        sorted.forEach(([name]) => {
            const bd = scoreBreakdowns[name];
            if (!bd) return;
            msg += `**${name}** (Round: ${bd.total})\n`;
            msg += `> Drivers (${bd.driverPts}): ${bd.driverDetails.join(', ')}\n`;
            msg += `> Constructors (${bd.constructorPts}): ${bd.teamDetails.join(', ')}\n`;
            if (bd.wcDetails.length > 0) msg += `> Wildcards (${bd.wildcardPts}): ${bd.wcDetails.join(', ')}\n`;
            msg += '\n';
        });
    }

    return msg;
}

async function getMetaValue(key) {
    return db.execute({ sql: "SELECT value FROM f1_meta WHERE key = ?", args: [key] }).then(r => r.rows[0]?.value || null);
}

async function setMetaValue(key, value) {
    return db.execute({
        sql: "INSERT INTO f1_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        args: [key, value]
    });
}

async function sendDiscordNotificationChecked(msg) {
    const url = process.env.DISCORD_WEBHOOK;
    if (!url) {
        console.warn('[DISCORD] No DISCORD_WEBHOOK env var set - skipping notification');
        return false;
    }

    const fullMsg = `F1 Steward: ${msg}`;
    const chunks = [];
    if (fullMsg.length <= 2000) chunks.push(fullMsg);
    else {
        for (let i = 0; i < fullMsg.length; i += 2000) {
            chunks.push(fullMsg.slice(i, i + 2000));
        }
    }

    let allSent = true;
    for (const chunk of chunks) {
        try {
            await axios.post(url, { content: chunk }, { timeout: 10000 });
            console.log('[DISCORD] Message sent successfully');
        } catch (e) {
            allSent = false;
            console.error(`[DISCORD] Webhook error: ${e.response?.status || 'NO_RESPONSE'} - ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
        }
    }

    return allSent;
}

const PREDICTION_REMINDER_WINDOWS = [
    { key: '1h', label: '1 hour', ms: 1 * 60 * 60 * 1000 },
    { key: '1d', label: '1 day', ms: 24 * 60 * 60 * 1000 },
    { key: '3d', label: '3 days', ms: 3 * 24 * 60 * 60 * 1000 }
];

function buildPredictionReminderMessage(race, lockInfo, reminder) {
    const roundLabel = `R${race.round}`;
    const sessionLabel = lockInfo.label;
    return [
        `**Prediction Reminder - ${race.name} (${roundLabel})**`,
        `${reminder.label} to go before ${sessionLabel} starts ${formatDiscordTimestamp(lockInfo.startsAt, 'R')} (${formatDiscordTimestamp(lockInfo.startsAt, 'F')}).`,
        `Prediction lockout begins ${formatDiscordTimestamp(lockInfo.lockTime, 'R')} (${formatDiscordTimestamp(lockInfo.lockTime, 'F')}).`,
        `Get your picks in before the window closes.`
    ].join('\n');
}

function buildPredictionLockoutMessage(race, lockInfo) {
    const roundLabel = `R${race.round}`;
    return [
        `**Prediction Lockout Started - ${race.name} (${roundLabel})**`,
        `The prediction window is now closed for this race weekend.`,
        `${lockInfo.label} starts ${formatDiscordTimestamp(lockInfo.startsAt, 'R')} (${formatDiscordTimestamp(lockInfo.startsAt, 'F')}).`
    ].join('\n');
}

let predictionNotificationPending = false;
async function checkPredictionNotifications() {
    if (predictionNotificationPending) return;
    predictionNotificationPending = true;

    try {
        const now = new Date();
        const seasonCalendar = await getSeasonCalendar();
        const race = await findStrategyRace(seasonCalendar, now);
        if (!race) return;

        const lockInfo = getPredictionLockInfo(race);
        if (!lockInfo) return;

        const scope = getRaceNotificationScope(race, lockInfo);

        if (now >= lockInfo.lockTime) {
            const lockoutKey = `discord_prediction_lockout_${scope}`;
            if (await getMetaValue(lockoutKey)) return;

            const sent = await sendDiscordNotificationChecked(buildPredictionLockoutMessage(race, lockInfo));
            if (sent) {
                await setMetaValue(lockoutKey, new Date().toISOString());
                console.log(`[DISCORD] Sent prediction lockout notice for ${scope}`);
            }
            return;
        }

        for (let i = 0; i < PREDICTION_REMINDER_WINDOWS.length; i += 1) {
            const reminder = PREDICTION_REMINDER_WINDOWS[i];
            const reminderAt = new Date(lockInfo.startsAt.getTime() - reminder.ms);
            if (now < reminderAt) continue;

            const reminderKey = `discord_prediction_reminder_${scope}_${reminder.key}`;
            if (await getMetaValue(reminderKey)) continue;

            const sent = await sendDiscordNotificationChecked(buildPredictionReminderMessage(race, lockInfo, reminder));
            if (sent) {
                const sentAt = new Date().toISOString();
                for (let j = i; j < PREDICTION_REMINDER_WINDOWS.length; j += 1) {
                    await setMetaValue(`discord_prediction_reminder_${scope}_${PREDICTION_REMINDER_WINDOWS[j].key}`, sentAt);
                }
                console.log(`[DISCORD] Sent prediction reminder ${reminder.key} for ${scope}`);
            }
            return;
        }
    } catch (e) {
        console.error('[DISCORD] Prediction notification check failed:', e.message);
    } finally {
        predictionNotificationPending = false;
    }
}

function calcDetailedBreakdown(p, actualDriverPositions, actualCRanges, raceLosers, sprintGainers, sprintLosers) {
    let driverPts = 0, constructorPts = 0, wildcardPts = 0;
    const driverDetails = []; const teamDetails = []; const wcDetails = [];

    [{ pred: p.p1, rank: 1, label: 'P1' }, { pred: p.p2, rank: 2, label: 'P2' }, { pred: p.p3, rank: 3, label: 'P3' },
     { pred: p.p10, rank: 10, label: 'P10' }, { pred: p.p11, rank: 11, label: 'P11' },
     { pred: p.p21, rank: 21, label: 'P21' }, { pred: p.p22, rank: 22, label: 'P22' }
    ].forEach(({ pred, rank, label }) => {
        if (!pred) return;
        let act = actualDriverPositions[normalizeStr(pred)]; if (!act) act = 22;
        const diff = Math.abs(rank - act);
        const pts = diff === 0 ? 2 : -diff;
        driverPts += pts;
        const surname = pred.split(' ').pop();
        driverDetails.push(`${label} ${surname}→P${act}(${pts >= 0 ? '+' : ''}${pts})`);
    });

    [{ pred: p.c1, rank: 1, label: 'C1' }, { pred: p.c2, rank: 2, label: 'C2' },
     { pred: p.c5, rank: 5, label: 'C5' }, { pred: p.c6, rank: 6, label: 'C6' }, { pred: p.c11, rank: 11, label: 'C11' }
    ].forEach(({ pred, rank, label }) => {
        if (!pred) return;
        const range = actualCRanges[normalizeConstructor(pred)];
        if (!range) return;
        let diff = 0;
        if (rank >= range.min && rank <= range.max) diff = 0;
        else if (rank < range.min) diff = range.min - rank;
        else diff = rank - range.max;
        const pts = diff === 0 ? 2 : -diff;
        constructorPts += pts;
        const actPos = range.min === range.max ? `${range.min}` : `${range.min}-${range.max}`;
        teamDetails.push(`${label} ${pred}→${actPos}(${pts >= 0 ? '+' : ''}${pts})`);
    });

    if (p.w_race_loser) {
        const hit = raceLosers.includes(normalizeStr(p.w_race_loser));
        if (hit) wildcardPts += 5;
        wcDetails.push(`RL: ${p.w_race_loser.split(' ').pop()}(${hit ? '+5' : 'miss'})`);
    }
    if (p.w_sprint_gainer) {
        const hit = sprintGainers.includes(normalizeStr(p.w_sprint_gainer));
        if (hit) wildcardPts += 5;
        wcDetails.push(`SG: ${p.w_sprint_gainer.split(' ').pop()}(${hit ? '+5' : 'miss'})`);
    }
    if (p.w_sprint_loser) {
        const hit = sprintLosers.includes(normalizeStr(p.w_sprint_loser));
        if (hit) wildcardPts += 5;
        wcDetails.push(`SL: ${p.w_sprint_loser.split(' ').pop()}(${hit ? '+5' : 'miss'})`);
    }

    return { driverPts, constructorPts, wildcardPts, total: driverPts + constructorPts + wildcardPts, driverDetails, teamDetails, wcDetails };
}

async function performFinalization() {
    try {
        // 1. Fetch Race Data — own API first, Ergast fallback
        let raceData = null;
        let results = null;
        let sprintResults = [];
        const gridMap = {};

        const _now = new Date();
        const seasonCalendar = await getSeasonCalendar();
        const latestCalRace = findLatestCompletedRace(seasonCalendar, _now);
        if (latestCalRace) {
            try {
                const apiRound = getTimingApiRound(latestCalRace);
                const roundData = await f1TimingApiGet(`/results/round/${apiRound}`, { timeout: 15000 });
                const raceSes = Array.isArray(roundData) ? roundData.find(s => s.meta?.session_type === 'Race') : null;
                if (raceSes?.results?.length) {
                    const driverList = await f1TimingApiGet('/drivers', { timeout: 10000 });
                    const dMap = {};
                    driverList.forEach(d => { dMap[String(d.driver_number)] = d; });
                    const qualSes = roundData.find(s => s.meta?.session_type === 'Qualifying');
                    if (qualSes?.results) qualSes.results.forEach(r => {
                        const d = dMap[String(r.driver_number)];
                        if (d) gridMap[normalizeStr(d.name)] = r.position;
                    });
                    // Ergast qualifying fallback if own API qualifying not available
                    if (Object.keys(gridMap).length === 0) {
                        try {
                            const eqr = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/qualifying.json`, { timeout: 10000 }).then(r => r.data.MRData.RaceTable.Races);
                            if (eqr?.length) eqr[0].QualifyingResults.forEach(q => { gridMap[normalizeStr(`${q.Driver.givenName} ${q.Driver.familyName}`)] = parseInt(q.position); });
                            console.log(`[FINALIZE] Ergast qualifying fallback: ${Object.keys(gridMap).length} drivers`);
                        } catch (e) { console.log('[FINALIZE] Ergast qualifying fallback failed:', e.message); }
                    }

                    results = raceSes.results.map(r => {
                        const d = dMap[String(r.driver_number)] || {};
                        const parts = (d.name || '').split(' ');
                        return {
                            position: String(r.position), positionText: r.retired ? 'R' : (r.stopped ? 'D' : String(r.position)),
                            grid: String(gridMap[normalizeStr(d.name || '')] || 0),
                            status: r.retired ? 'Retired' : (r.stopped ? 'Collision' : 'Finished'),
                            Driver: { givenName: parts[0] || '', familyName: parts.slice(1).join(' ') || '' },
                            Constructor: { name: d.team || '' }
                        };
                    });
                    raceData = { round: String(latestCalRace.round), raceName: raceSes.meta?.meeting || latestCalRace.name, Results: results };

                    const sprintSes = roundData.find(s => s.meta?.session_type === 'Sprint');
                    if (sprintSes?.results) {
                        // Sprint grid comes from Sprint Qualifying, not regular Qualifying
                        const sprintGridMap = {};
                        const sqSes = roundData.find(s => s.meta?.session_type === 'Sprint Qualifying');
                        if (sqSes?.results) sqSes.results.forEach(r => {
                            const d = dMap[String(r.driver_number)];
                            if (d) sprintGridMap[normalizeStr(d.name)] = r.position;
                        });
                        console.log(`[FINALIZE] Sprint Qualifying grid: ${Object.keys(sprintGridMap).length} drivers`);

                        sprintResults = sprintSes.results.map(r => {
                            const d = dMap[String(r.driver_number)] || {};
                            const parts = (d.name || '').split(' ');
                            return {
                                position: String(r.position), positionText: r.retired ? 'R' : String(r.position),
                                grid: String(sprintGridMap[normalizeStr(d.name || '')] || gridMap[normalizeStr(d.name || '')] || 0),
                                status: r.retired ? 'Retired' : 'Finished',
                                Driver: { givenName: parts[0] || '', familyName: parts.slice(1).join(' ') || '' },
                                Constructor: { name: d.team || '' }
                            };
                        });
                    }
                    console.log(`[FINALIZE] Own API: ${raceData.raceName} (R${latestCalRace.round}) — ${results.length} drivers`);
                }
            } catch (e) { console.log('[FINALIZE] Own API failed:', e.message); }
        }

        if (!raceData) {
            let races;
            try { races = await axios.get('https://api.jolpi.ca/ergast/f1/current/last/results.json', { timeout: 15000 }).then(r => r.data.MRData.RaceTable.Races); } catch (e) { }
            if (!races?.length) { try { races = await axios.get('https://api.jolpi.ca/ergast/f1/2026/last/results.json', { timeout: 15000 }).then(r => r.data.MRData.RaceTable.Races); } catch (e) { } }
            if (!races?.length) return { success: false, message: "No race data found." };
            raceData = races[0]; results = raceData.Results;
            try {
                const sprintRes = await axios.get('https://api.jolpi.ca/ergast/f1/current/last/sprint.json', { timeout: 15000 }).then(r => r.data);
                if (sprintRes.MRData.RaceTable.Races.length > 0) sprintResults = sprintRes.MRData.RaceTable.Races[0].SprintResults;
            } catch (e) { }
            try {
                let qr = null;
                try { qr = await axios.get('https://api.jolpi.ca/ergast/f1/current/last/qualifying.json', { timeout: 15000 }).then(r => r.data.MRData.RaceTable.Races); } catch (e) { }
                if (!qr?.length) { try { qr = await axios.get('https://api.jolpi.ca/ergast/f1/2026/last/qualifying.json', { timeout: 15000 }).then(r => r.data.MRData.RaceTable.Races); } catch (e) { } }
                if (qr?.length) qr[0].QualifyingResults.forEach(q => { gridMap[normalizeStr(`${q.Driver.givenName} ${q.Driver.familyName}`)] = parseInt(q.position); });
            } catch (e) { }
            console.log(`[FINALIZE] Ergast: ${raceData.raceName} (R${raceData.round}) — ${results.length} drivers`);
        }

        console.log(`[FINALIZE] Grid map: ${Object.keys(gridMap).length} drivers`);

        // 1b. Check if this round was already scored
        const roundCheck = `R${raceData.round}`;
        await db.execute("CREATE TABLE IF NOT EXISTS f1_round_history (id INTEGER PRIMARY KEY AUTOINCREMENT, round TEXT, race_name TEXT, user_name TEXT, prediction TEXT, score INTEGER, scored_at TEXT)");
        const alreadyScored = await db.execute({ sql: "SELECT count(*) as count FROM f1_round_history WHERE round = ?", args: [roundCheck] });
        if (alreadyScored.rows[0].count > 0) {
            console.log(`[FINALIZE] Round ${roundCheck} already scored — skipping`);
            await db.execute("DELETE FROM f1_predictions_v4");
            return { success: false, message: "Already scored." };
        }

        const check = await db.execute({
            sql: "SELECT count(*) as count FROM f1_predictions_v4 WHERE prediction_round = ?",
            args: [roundCheck]
        });
        if (check.rows[0].count === 0) return { success: false, message: "No predictions found." };
        console.log(`[FINALIZE] ${check.rows[0].count} predictions to score`);

        // --- DRIVER MATH (DNFs = 22) ---
        const actualDriverPositions = {};
        results.forEach(r => {
            const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
            let pos = parseInt(r.position);
            if (r.positionText === 'R' || r.positionText === 'D' || r.positionText === 'W' || r.status.startsWith('Retired') || r.status.startsWith('Collision')) {
                pos = 22;
            }
            actualDriverPositions[name] = pos;
        });

        // --- CONSTRUCTOR MATH (Tie Range Logic) ---
        const constructorSums = {};
        results.forEach(r => {
            const c = normalizeConstructor(r.Constructor.name);
            let pos = parseInt(r.position);
            if (r.positionText === 'R' || r.positionText === 'D' || r.positionText === 'W') pos = 22;
            constructorSums[c] = (constructorSums[c] || 0) + pos;
        });

        const sumGroups = {};
        for (const [c, sum] of Object.entries(constructorSums)) {
            if (!sumGroups[sum]) sumGroups[sum] = [];
            sumGroups[sum].push(c);
        }

        const sortedSums = Object.keys(sumGroups).map(Number).sort((a, b) => a - b);
        const actualCRanges = {};
        let currentRank = 1;

        sortedSums.forEach(sum => {
            const teams = sumGroups[sum];
            const numTeams = teams.length;
            teams.forEach(team => {
                actualCRanges[team] = { min: currentRank, max: currentRank + numTeams - 1 };
            });
            currentRank += numTeams;
        });

        // --- WILDCARDS ---
        let raceLosers = []; let maxRaceDrop = -999;
        results.forEach(r => {
            const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
            const grid = parseInt(r.grid) || gridMap[name] || 0;
            if (grid > 0) {
                let finish = parseInt(r.position);
                if (r.positionText === 'R' || r.positionText === 'D') finish = 22;
                const drop = finish - grid;
                if (drop > maxRaceDrop) { maxRaceDrop = drop; raceLosers = [name]; }
                else if (drop === maxRaceDrop) raceLosers.push(name);
            }
        });

        let sprintGainers = []; let maxSprintGain = -999;
        let sprintLosers = []; let maxSprintDrop = -999;
        sprintResults.forEach(r => {
            const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
            const grid = parseInt(r.grid) || gridMap[name] || 0;
            if (grid > 0) {
                let finish = parseInt(r.position);
                if (r.positionText === 'R' || r.positionText === 'D') finish = 22;
                const gain = grid - finish;
                const drop = finish - grid;

                if (gain > maxSprintGain) { maxSprintGain = gain; sprintGainers = [name]; }
                else if (gain === maxSprintGain) sprintGainers.push(name);
                if (drop > maxSprintDrop) { maxSprintDrop = drop; sprintLosers = [name]; }
                else if (drop === maxSprintDrop) sprintLosers.push(name);
            }
        });

        console.log(`[FINALIZE] Race Loser(s): ${raceLosers.join(', ') || 'none'} (drop: ${maxRaceDrop})`);
        if (sprintResults.length > 0) {
            console.log(`[FINALIZE] Sprint Gainer(s): ${sprintGainers.join(', ') || 'none'} | Sprint Loser(s): ${sprintLosers.join(', ') || 'none'}`);
        }

        // --- SCORE CALCULATION ---
        const predictions = await db.execute({
            sql: "SELECT * FROM f1_predictions_v4 WHERE prediction_round = ?",
            args: [roundLabel]
        }).then(r => r.rows);
        let scores = {}; let scoreBreakdowns = {}; let lowest = Infinity;

        predictions.forEach(p => {
            const detail = calcDetailedBreakdown(p, actualDriverPositions, actualCRanges, raceLosers, sprintGainers, sprintLosers);
            scores[p.user_name] = detail.total;
            scoreBreakdowns[p.user_name] = detail;
            if (detail.total < lowest) lowest = detail.total;
        });

        // Apply "Lowest - 5" Penalty for players who missed this round
        const penalty = (lowest === Infinity ? 0 : lowest) - 5;
        const activeDrivers = await db.execute("SELECT * FROM f1_drivers WHERE has_participated = 1").then(r => r.rows);

        // Detect new joiners: players with no prior round history entries
        const playersWithHistory = await db.execute("SELECT DISTINCT user_name FROM f1_round_history").then(r => new Set(r.rows.map(x => x.user_name)));

        const finalScores = {};
        for (const d of activeDrivers) {
            const isNewJoiner = !playersWithHistory.has(d.name) && d.name !== 'admin';
            let fs = scores[d.name] !== undefined ? scores[d.name] : penalty;
            finalScores[d.name] = { score: fs, hadPrediction: scores[d.name] !== undefined, isNewJoiner };
        }

        const roundLabel = `R${raceData.round}`;
        const timestamp = new Date().toISOString();

        // Capture lowest standing BEFORE applying round scores (for new joiner penalty)
        const newJoiners = Object.entries(finalScores).filter(([name, data]) => data.isNewJoiner);
        let preRoundLowestStanding = 0;
        if (newJoiners.length > 0) {
            const establishedNames = Object.entries(finalScores).filter(([n, d]) => !d.isNewJoiner && n !== 'admin').map(([n]) => n);
            if (establishedNames.length > 0) {
                const estRows = await db.execute({ sql: "SELECT MIN(total_score) as min_score FROM f1_drivers WHERE name IN (" + establishedNames.map(() => '?').join(',') + ")", args: establishedNames }).then(r => r.rows[0]);
                preRoundLowestStanding = estRows?.min_score ?? 0;
            }
        }

        const tx = await db.transaction("write");
        try {
            for (const d of activeDrivers) {
                const scoreDelta = finalScores[d.name]?.score ?? 0;
                if (d.name !== 'admin') {
                    await tx.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?", args: [scoreDelta, d.name] });
                }
            }

            // New joiner penalty: pre-round lowest standing - 5 (applied once)
            if (newJoiners.length > 0) {
                const newJoinerPenalty = preRoundLowestStanding - 5;

                for (const [name] of newJoiners) {
                    await tx.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?", args: [newJoinerPenalty, name] });
                    finalScores[name].newJoinerPenalty = newJoinerPenalty;
                    console.log(`[FINALIZE] New joiner penalty of ${newJoinerPenalty} applied to ${name} (pre-round lowest: ${preRoundLowestStanding})`);
                }
            }

            // --- SAVE ROUND HISTORY ---
            await tx.execute("CREATE TABLE IF NOT EXISTS f1_round_history (id INTEGER PRIMARY KEY AUTOINCREMENT, round TEXT, race_name TEXT, user_name TEXT, prediction TEXT, score INTEGER, scored_at TEXT)");
            for (const p of predictions) {
                const predSnapshot = JSON.stringify({ p1: p.p1, p2: p.p2, p3: p.p3, p10: p.p10, p11: p.p11, p21: p.p21, p22: p.p22, c1: p.c1, c2: p.c2, c5: p.c5, c6: p.c6, c11: p.c11, w_race_loser: p.w_race_loser, w_sprint_gainer: p.w_sprint_gainer, w_sprint_loser: p.w_sprint_loser });
                await tx.execute({ sql: "INSERT INTO f1_round_history (round, race_name, user_name, prediction, score, scored_at) VALUES (?, ?, ?, ?, ?, ?)", args: [roundLabel, raceData.raceName, p.user_name, predSnapshot, scores[p.user_name] ?? 0, timestamp] });
            }
            for (const [name, data] of Object.entries(finalScores)) {
                if (!data.hadPrediction && name !== 'admin') {
                    await tx.execute({ sql: "INSERT INTO f1_round_history (round, race_name, user_name, prediction, score, scored_at) VALUES (?, ?, ?, ?, ?, ?)", args: [roundLabel, raceData.raceName, name, '{"penalty":"no submission"}', data.score, timestamp] });
                }
                if (data.newJoinerPenalty !== undefined && name !== 'admin') {
                    const penaltyRound = `R${parseInt(raceData.round) - 1}`;
                    await tx.execute({ sql: "INSERT INTO f1_round_history (round, race_name, user_name, prediction, score, scored_at) VALUES (?, ?, ?, ?, ?, ?)", args: [penaltyRound, 'New Joiner Penalty', name, '{"penalty":"new joiner"}', data.newJoinerPenalty, timestamp] });
                }
            }
            console.log(`[FINALIZE] Round history saved for ${roundLabel}`);

            await tx.execute("DELETE FROM f1_predictions_v4");
            await tx.commit();
        } catch (writeError) {
            try { await tx.rollback(); } catch (_) { }
            throw writeError;
        }

        // --- DISCORD SCORE BREAKDOWN ---
        const seasonRows = await db.execute("SELECT name, total_score FROM f1_drivers WHERE has_participated = 1 AND name != 'admin' ORDER BY total_score DESC").then(r => r.rows);
        const seasonTotals = {}; seasonRows.forEach(r => { seasonTotals[r.name] = r.total_score; });
        const sorted = Object.entries(finalScores).filter(([n]) => n !== 'admin').sort((a, b) => b[1].score - a[1].score);
        const breakdown = buildDiscordBreakdown(raceData.raceName, roundLabel, sorted, scoreBreakdowns, raceLosers, sprintResults, sprintGainers, sprintLosers, penalty, true, seasonTotals);
        try {
            await sendDiscordNotification(breakdown);
        } catch (notifyError) {
            console.warn('[FINALIZE] Discord notification failed after commit:', notifyError.message);
        }

        return { success: true, message: "Round Finalized." };
    } catch (e) { return { success: false, message: e.message }; }
}

// --- 7. SECURE CORE ROUTES ---
app.get('/api/next-race', async (req, res) => {
    const now = new Date();
    const seasonCalendar = await getSeasonCalendar();
    const next = await findStrategyRace(seasonCalendar, now);
    if (!next) return res.status(404).json({ error: 'No race available' });

    const lockInfo = getPredictionLockInfo(next);
    if (!lockInfo) return res.status(500).json({ error: 'Prediction lock session unavailable' });
    const isLocked = now > lockInfo.lockTime;
    const nextSession = findNextWeekendSession(next, now);
    const payload = {
        ...next,
        totalRounds: seasonCalendar.length,
        lockTime: lockInfo.lockTime.toISOString(),
        isLocked,
        lockStatus: isLocked ? 'locked' : 'open',
        nextSession: nextSession ? {
            key: nextSession.key,
            label: nextSession.label,
            time: nextSession.time
        } : null
    };
    res.json(payload);
});

app.get('/api/calendar', async (_req, res) => {
    try {
        const calendar = await getSeasonCalendar();
        res.json(calendar);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Driver Career Stats (verified against formula1.com, March 2026) ---
const DRIVER_CAREER = {
    'Max Verstappen':    { nationality: 'Dutch',       dob: '1997-09-30', championships: 4, wins: 71, podiums: 127, poles: 48, races: 235, debut: 2015 },
    'Lewis Hamilton':    { nationality: 'British',     dob: '1985-01-07', championships: 7, wins: 105, podiums: 203, poles: 104, races: 382, debut: 2007 },
    'Fernando Alonso':   { nationality: 'Spanish',     dob: '1981-07-29', championships: 2, wins: 32, podiums: 106, poles: 22, races: 429, debut: 2001 },
    'Charles Leclerc':   { nationality: 'Monegasque',  dob: '1997-10-16', championships: 0, wins: 8, podiums: 51, poles: 27, races: 173, debut: 2018 },
    'Lando Norris':      { nationality: 'British',     dob: '1999-11-13', championships: 1, wins: 11, podiums: 44, poles: 16, races: 154, debut: 2019 },
    'Oscar Piastri':     { nationality: 'Australian',  dob: '2001-04-06', championships: 0, wins: 9, podiums: 26, poles: 6, races: 72, debut: 2023 },
    'Carlos Sainz':      { nationality: 'Spanish',     dob: '1994-09-01', championships: 0, wins: 4, podiums: 29, poles: 6, races: 232, debut: 2015 },
    'George Russell':    { nationality: 'British',     dob: '1998-02-15', championships: 0, wins: 6, podiums: 26, poles: 8, races: 154, debut: 2019 },
    'Sergio Perez':      { nationality: 'Mexican',     dob: '1990-01-26', championships: 0, wins: 6, podiums: 39, poles: 3, races: 283, debut: 2011 },
    'Valtteri Bottas':   { nationality: 'Finnish',     dob: '1989-08-28', championships: 0, wins: 10, podiums: 67, poles: 20, races: 248, debut: 2013 },
    'Pierre Gasly':      { nationality: 'French',      dob: '1996-02-07', championships: 0, wins: 1, podiums: 5, poles: 0, races: 179, debut: 2017 },
    'Esteban Ocon':      { nationality: 'French',      dob: '1996-09-17', championships: 0, wins: 1, podiums: 4, poles: 0, races: 182, debut: 2016 },
    'Nico Hulkenberg':   { nationality: 'German',      dob: '1987-08-19', championships: 0, wins: 0, podiums: 1, poles: 1, races: 253, debut: 2010 },
    'Lance Stroll':      { nationality: 'Canadian',    dob: '1998-10-29', championships: 0, wins: 0, podiums: 3, poles: 1, races: 192, debut: 2017 },
    'Alexander Albon':   { nationality: 'Thai',        dob: '1996-03-23', championships: 0, wins: 0, podiums: 2, poles: 0, races: 130, debut: 2019 },
    'Liam Lawson':       { nationality: 'New Zealander', dob: '2002-02-11', championships: 0, wins: 0, podiums: 0, poles: 0, races: 37, debut: 2023 },
    'Franco Colapinto':  { nationality: 'Argentine',   dob: '2003-05-27', championships: 0, wins: 0, podiums: 0, poles: 0, races: 29, debut: 2024 },
    'Kimi Antonelli':    { nationality: 'Italian',     dob: '2006-08-25', championships: 0, wins: 1, podiums: 5, poles: 1, races: 26, debut: 2025 },
    'Isack Hadjar':      { nationality: 'French',      dob: '2004-09-28', championships: 0, wins: 0, podiums: 1, poles: 0, races: 25, debut: 2025 },
    'Oliver Bearman':    { nationality: 'British',     dob: '2005-05-08', championships: 0, wins: 0, podiums: 0, poles: 0, races: 29, debut: 2024 },
    'Gabriel Bortoleto': { nationality: 'Brazilian',   dob: '2004-10-14', championships: 0, wins: 0, podiums: 0, poles: 0, races: 26, debut: 2025 },
    'Arvid Lindblad':    { nationality: 'British',     dob: '2006-09-17', championships: 0, wins: 0, podiums: 0, poles: 0, races: 2, debut: 2026, rookie: true }
};

let driverHeadshotCache = null;
let driverHeadshotCacheTime = 0;

async function fetchDriverHeadshots() {
    if (driverHeadshotCache && Date.now() - driverHeadshotCacheTime < 6 * 60 * 60 * 1000) return driverHeadshotCache;
    try {
        const list = await f1TimingApiGet('/drivers', { timeout: 10000 });
        const map = {};
        list.forEach(d => { if (d.name) map[d.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')] = d; });
        driverHeadshotCache = map;
        driverHeadshotCacheTime = Date.now();
        return map;
    } catch { return driverHeadshotCache || {}; }
}

app.get('/api/driver-stats/:name', async (req, res) => {
    const name = decodeURIComponent(req.params.name).trim();
    const career = DRIVER_CAREER[name];

    try {
        const headshots = await fetchDriverHeadshots();
        const h = headshots[name] || Object.values(headshots).find(d => d.name && d.name.toLowerCase().includes(name.split(' ').pop().toLowerCase()));

        const stats = {
            name,
            number: h?.driver_number || null,
            team: h?.team || null,
            teamColour: h?.team_colour || null,
            headshot: h?.headshot_url || null,
            nationality: career?.nationality || null,
            dateOfBirth: career?.dob || null,
            championships: career?.championships || 0,
            wins: career?.wins || 0,
            podiums: career?.podiums || 0,
            poles: career?.poles || 0,
            totalRaces: career?.races || 0,
            debut: career?.debut || null,
            rookie: career?.rookie || false
        };
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch driver stats', detail: e.message });
    }
});

// --- F1 Live Timing Widget Proxy (backed by direct F1 SignalR WebSocket feed) ---
let widgetCache = null;
let widgetCacheTime = 0;
app.get('/api/live-widget', async (_req, res) => {
    if (widgetCache && Date.now() - widgetCacheTime < 10000) return res.json(widgetCache);
    try {
        const get = (path) => f1TimingApiGet(path, { timeout: 10000 }).catch(() => null);
        const [timing, status] = await Promise.all([get('/timing'), get('/status')]);
        if (!timing?.drivers?.length) return res.status(503).json({ error: 'No live timing data' });
        widgetCache = { timing, status };
        widgetCacheTime = Date.now();
        res.json(widgetCache);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API-Sports Live Proxy (For Widget ONLY with 2025 Fallback) ---
app.get('/api/live-sessions', async (req, res) => {
    try {
        const apiKey = process.env.API_SPORTS_KEY;

        let sessionsRes = await axios.get('https://v1.formula-1.api-sports.io/races', {
            params: { season: '2026' },
            headers: { 'x-apisports-key': apiKey }
        });

        let completed = sessionsRes.data.response.filter(s => s.status === 'Completed');
        let displaySessionName = "";

        if (completed.length === 0) {
            sessionsRes = await axios.get('https://v1.formula-1.api-sports.io/races', {
                params: { season: '2025' },
                headers: { 'x-apisports-key': apiKey }
            });
            completed = sessionsRes.data.response.filter(s => s.status === 'Completed');
            displaySessionName = "2025 Abu Dhabi (Standby)";
        } else {
            displaySessionName = completed[completed.length - 1].type;
        }

        const lastSessionId = completed[completed.length - 1].id;

        const rankRes = await axios.get('https://v1.formula-1.api-sports.io/rankings/races', {
            params: { race: lastSessionId },
            headers: { 'x-apisports-key': apiKey }
        });

        res.json({ sessionName: displaySessionName, data: rankRes.data.response });
    } catch (e) {
        res.status(500).json({ error: "Live fetch failed" });
    }
});

// --- NEW: SEASON-LONG PREDICTIONS ROUTES ---
app.get('/api/season-picks', authenticateToken, async (req, res) => {
    try {
        const r = await db.execute({ sql: "SELECT season_driver, season_constructor FROM f1_drivers WHERE name = ?", args: [req.user.name] });
        res.json(r.rows[0] || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/season-picks', authenticateToken, async (req, res) => {
    const ausQuali = new Date("2026-03-07T10:30:00+05:30");
    if (new Date() > ausQuali) {
        return res.status(403).json({ success: false, message: "Season predictions are permanently locked." });
    }

    try {
        await db.execute({
            sql: "UPDATE f1_drivers SET season_driver = ?, season_constructor = ? WHERE name = ?",
            args: [req.body.season_driver, req.body.season_constructor, req.user.name]
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/me', authenticateToken, async (req, res) => {
    res.json({
        name: req.user.name,
        isAdmin: req.user.isAdmin
    });
});

// --- RACE PREDICTION SUBMIT ---
app.post('/predict', predictLimiter, authenticateToken, async (req, res) => {
    const d = req.body;
    const userName = req.user.name;

    const now = new Date();
    const seasonCalendar = await getSeasonCalendar();
    const currentRace = await findStrategyRace(seasonCalendar, now);
    if (!currentRace) return res.status(403).json({ success: false, message: "Season Over" });

    const lockInfo = getPredictionLockInfo(currentRace);
    if (!lockInfo) return res.status(503).json({ success: false, message: "Prediction lock timing unavailable right now." });
    if (now > lockInfo.lockTime) {
        return res.status(403).json({ success: false, message: "Parc Fermé: Predictions are officially locked for this session!" });
    }

    const validationError = validatePredictionPayload(d);
    if (validationError) {
        return res.status(400).json({ success: false, message: `Invalid: ${validationError}.` });
    }

    try {
        await upsertPredictionRecord(db, userName, d, getRoundLabel(currentRace));
        await db.execute({ sql: `UPDATE f1_drivers SET has_participated = 1 WHERE name = ?`, args: [userName] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/finalize', authenticateToken, requireAdmin, async (req, res) => {
    const result = await performFinalization();
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/test-discord', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const webhook = process.env.DISCORD_WEBHOOK;
        if (!webhook) return res.json({ success: false, message: 'DISCORD_WEBHOOK not set' });
        await sendDiscordNotification('Test message — webhook is working.');
        res.json({ success: true, message: 'Test sent' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/rescore', authenticateToken, requireAdmin, async (req, res) => {
    const { round } = req.body;
    if (!round) return res.status(400).json({ success: false, message: "Missing 'round' (e.g. R2)" });

    res.json({ success: true, message: `Re-scoring ${round} — Discord will update shortly.` });

    try {
        const roundNum = parseInt(round.replace('R', ''));
        const rows = await db.execute({ sql: "SELECT * FROM f1_round_history WHERE round = ? ORDER BY id ASC", args: [round] }).then(r => r.rows);
        if (rows.length === 0) { console.log(`[RESCORE] No history for ${round}`); return; }

        const raceName = rows[0].race_name;
        const calendarRace = await resolveCalendarRace(roundNum, raceName);
        const apiRound = getTimingApiRound(calendarRace) || roundNum;

        // Fetch race data (same logic as resend-discord)
        let results = null, sprintResults = [], gridMap = {};
        try {
            const roundData = await f1TimingApiGet(`/results/round/${apiRound}`, { timeout: 8000 });
            const raceSes = Array.isArray(roundData) ? roundData.find(s => s.meta?.session_type === 'Race') : null;
            if (raceSes?.results?.length) {
                const driverList = await f1TimingApiGet('/drivers', { timeout: 8000 });
                const dMap = {}; driverList.forEach(d => { dMap[String(d.driver_number)] = d; });
                const qualSes = roundData.find(s => s.meta?.session_type === 'Qualifying');
                if (qualSes?.results) qualSes.results.forEach(r => { const d = dMap[String(r.driver_number)]; if (d) gridMap[normalizeStr(d.name)] = r.position; });
                if (Object.keys(gridMap).length === 0) {
                    try { const eqr = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/qualifying.json`, { timeout: 8000 }).then(r => r.data.MRData.RaceTable.Races); if (eqr?.length) eqr[0].QualifyingResults.forEach(q => { gridMap[normalizeStr(`${q.Driver.givenName} ${q.Driver.familyName}`)] = parseInt(q.position); }); } catch (_) { }
                }
                results = raceSes.results.map(r => {
                    const d = dMap[String(r.driver_number)] || {};
                    const parts = (d.name || '').split(' ');
                    return { position: String(r.position), positionText: r.retired ? 'R' : (r.stopped ? 'D' : String(r.position)), grid: String(gridMap[normalizeStr(d.name || '')] || 0), status: r.retired ? 'Retired' : (r.stopped ? 'Collision' : 'Finished'), Driver: { givenName: parts[0] || '', familyName: parts.slice(1).join(' ') || '' }, Constructor: { name: d.team || '' } };
                });
                const sprintSes = roundData.find(s => s.meta?.session_type === 'Sprint');
                if (sprintSes?.results) {
                    const sprintGridMap = {};
                    const sqSes = roundData.find(s => s.meta?.session_type === 'Sprint Qualifying');
                    if (sqSes?.results) sqSes.results.forEach(r => { const d = dMap[String(r.driver_number)]; if (d) sprintGridMap[normalizeStr(d.name)] = r.position; });
                    sprintResults = sprintSes.results.map(r => {
                        const d = dMap[String(r.driver_number)] || {};
                        const parts = (d.name || '').split(' ');
                        return { position: String(r.position), positionText: r.retired ? 'R' : String(r.position), grid: String(sprintGridMap[normalizeStr(d.name || '')] || gridMap[normalizeStr(d.name || '')] || 0), status: r.retired ? 'Retired' : 'Finished', Driver: { givenName: parts[0] || '', familyName: parts.slice(1).join(' ') || '' }, Constructor: { name: d.team || '' } };
                    });
                }
                console.log(`[RESCORE] Own API: ${results.length} race results`);
            }
        } catch (e) { console.log('[RESCORE] Own API failed:', e.message); }

        if (!results) {
            try {
                const races = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/results.json`, { timeout: 8000 }).then(r => r.data.MRData.RaceTable.Races);
                if (races?.length) { results = races[0].Results; }
                try { const sr = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/sprint.json`, { timeout: 8000 }).then(r => r.data); if (sr.MRData.RaceTable.Races.length > 0) sprintResults = sr.MRData.RaceTable.Races[0].SprintResults; } catch (_) { }
                try { const qr = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/qualifying.json`, { timeout: 8000 }).then(r => r.data.MRData.RaceTable.Races); if (qr?.length) qr[0].QualifyingResults.forEach(q => { gridMap[normalizeStr(`${q.Driver.givenName} ${q.Driver.familyName}`)] = parseInt(q.position); }); } catch (_) { }
            } catch (_) { }
        }

        if (!results) { console.log(`[RESCORE] No race data found for ${round}`); return; }

        // Build actual positions
        let actualDriverPositions = {}, actualCRanges = {}, raceLosers = [], sprintGainers = [], sprintLosers = [];
        results.forEach(r => { const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`); let pos = parseInt(r.position); if (r.positionText === 'R' || r.positionText === 'D' || r.positionText === 'W' || r.status.startsWith('Retired') || r.status.startsWith('Collision')) pos = 22; actualDriverPositions[name] = pos; });
        const constructorSums = {}; results.forEach(r => { const c = normalizeConstructor(r.Constructor.name); let pos = parseInt(r.position); if (r.positionText === 'R' || r.positionText === 'D' || r.positionText === 'W') pos = 22; constructorSums[c] = (constructorSums[c] || 0) + pos; });
        const sumGroups = {}; for (const [c, sum] of Object.entries(constructorSums)) { if (!sumGroups[sum]) sumGroups[sum] = []; sumGroups[sum].push(c); }
        let currentRank = 1; Object.keys(sumGroups).map(Number).sort((a, b) => a - b).forEach(sum => { const teams = sumGroups[sum]; teams.forEach(team => { actualCRanges[team] = { min: currentRank, max: currentRank + teams.length - 1 }; }); currentRank += teams.length; });

        let maxRaceDrop = -999; results.forEach(r => { const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`); const grid = parseInt(r.grid) || gridMap[name] || 0; if (grid > 0) { let finish = parseInt(r.position); if (r.positionText === 'R' || r.positionText === 'D') finish = 22; const drop = finish - grid; if (drop > maxRaceDrop) { maxRaceDrop = drop; raceLosers = [name]; } else if (drop === maxRaceDrop) raceLosers.push(name); } });
        let maxSprintGain = -999, maxSprintDrop = -999; sprintResults.forEach(r => { const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`); const grid = parseInt(r.grid) || gridMap[name] || 0; if (grid > 0) { let finish = parseInt(r.position); if (r.positionText === 'R' || r.positionText === 'D') finish = 22; const gain = grid - finish; const drop = finish - grid; if (gain > maxSprintGain) { maxSprintGain = gain; sprintGainers = [name]; } else if (gain === maxSprintGain) sprintGainers.push(name); if (drop > maxSprintDrop) { maxSprintDrop = drop; sprintLosers = [name]; } else if (drop === maxSprintDrop) sprintLosers.push(name); } });

        console.log(`[RESCORE] Race Loser(s): ${raceLosers.join(', ') || 'none'} | Sprint Gainer(s): ${sprintGainers.join(', ') || 'none'} | Sprint Loser(s): ${sprintLosers.join(', ') || 'none'}`);

        // Re-score each player
        const playerScores = {};
        const scoreBreakdowns = {};
        let newLowest = Infinity;

        for (const row of rows) {
            const pred = JSON.parse(row.prediction || '{}');
            if (pred.penalty) continue; // skip penalty/no-sub entries for now

            const detail = calcDetailedBreakdown(pred, actualDriverPositions, actualCRanges, raceLosers, sprintGainers, sprintLosers);
            const newScore = detail.total;
            const oldScore = row.score;
            const scoreDiff = newScore - oldScore;

            playerScores[row.user_name] = { score: newScore, oldScore, scoreDiff, hadPrediction: true };
            scoreBreakdowns[row.user_name] = detail;
            if (newScore < newLowest) newLowest = newScore;
        }

        // Recalculate no-submission penalty
        const newPenalty = (newLowest === Infinity ? 0 : newLowest) - 5;
        for (const row of rows) {
            const pred = JSON.parse(row.prediction || '{}');
            if (pred.penalty === 'no submission') {
                const oldScore = row.score;
                playerScores[row.user_name] = { score: newPenalty, oldScore, scoreDiff: newPenalty - oldScore, hadPrediction: false };
            }
            if (pred.penalty === 'new joiner') {
                if (playerScores[row.user_name]) playerScores[row.user_name].newJoinerPenalty = row.score;
            }
        }

        // Update DB
        const tx = await db.transaction("write");
        try {
            for (const [name, data] of Object.entries(playerScores)) {
                if (data.scoreDiff !== 0) {
                    await tx.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?", args: [data.scoreDiff, name] });
                }
                await tx.execute({ sql: "UPDATE f1_round_history SET score = ? WHERE round = ? AND user_name = ? AND prediction NOT LIKE '%new joiner%'", args: [data.score, round, name] });
            }
            await tx.commit();
            console.log(`[RESCORE] DB updated for ${round}`);
        } catch (writeError) {
            try { await tx.rollback(); } catch (_) { }
            throw writeError;
        }

        // Fetch updated season totals
        const seasonRows = await db.execute("SELECT name, total_score FROM f1_drivers WHERE has_participated = 1 AND name != 'admin' ORDER BY total_score DESC").then(r => r.rows);
        const seasonTotals = {};
        seasonRows.forEach(r => { seasonTotals[r.name] = r.total_score; });

        // Build detailed Discord message
        const sorted = Object.entries(playerScores).filter(([n]) => n !== 'admin').sort((a, b) => b[1].score - a[1].score);
        let msg = `**${raceName} (${round}) — RESCORED**\n`;
        msg += `Race Loser: ${raceLosers.join(', ') || 'N/A'}\n`;
        if (sprintResults.length > 0) msg += `Sprint Gainer: ${sprintGainers.join(', ') || 'N/A'} | Sprint Loser: ${sprintLosers.join(', ') || 'N/A'}\n`;
        msg += `No-sub penalty: ${newPenalty}\n\n`;

        // Summary table with season totals
        const maxName = Math.max(...sorted.map(([n]) => n.length), 6);
        msg += '```\n';
        msg += ` #  ${'Player'.padEnd(maxName)}  Round  Season    D    C    W\n`;
        msg += ' ' + '-'.repeat(maxName + 40) + '\n';
        sorted.forEach(([name, data], i) => {
            const bd = scoreBreakdowns[name];
            const rank = String(i + 1).padStart(2);
            const roundScore = String(data.score).padStart(5);
            const season = String(seasonTotals[name] ?? '?').padStart(6);
            if (bd) {
                const d = String(bd.driverPts).padStart(4);
                const c = String(bd.constructorPts).padStart(4);
                const w = String(bd.wildcardPts).padStart(4);
                msg += `${rank}  ${name.padEnd(maxName)}  ${roundScore}  ${season}  ${d}  ${c}  ${w}`;
            } else {
                let tag = !data.hadPrediction ? '(no sub)' : '';
                msg += `${rank}  ${name.padEnd(maxName)}  ${roundScore}  ${season}  ${tag}`;
            }
            if (data.newJoinerPenalty !== undefined) msg += `  [NJ: ${data.newJoinerPenalty}]`;
            msg += '\n';
        });
        msg += '```\n';

        // Per-player detailed breakdown
        sorted.forEach(([name]) => {
            const bd = scoreBreakdowns[name];
            if (!bd) return;
            msg += `**${name}** (Round: ${bd.total})\n`;
            msg += `> Drivers (${bd.driverPts}): ${bd.driverDetails.join(', ')}\n`;
            msg += `> Constructors (${bd.constructorPts}): ${bd.teamDetails.join(', ')}\n`;
            if (bd.wcDetails.length > 0) msg += `> Wildcards (${bd.wildcardPts}): ${bd.wcDetails.join(', ')}\n`;
            msg += '\n';
        });

        await sendDiscordNotification(msg);
        console.log(`[RESCORE] Discord sent for ${round}`);
    } catch (e) { console.error(`[RESCORE] Error:`, e.message); }
});

app.post('/api/resend-discord', authenticateToken, requireAdmin, async (req, res) => {
    const { round } = req.body;
    if (!round) return res.status(400).json({ success: false, message: "Missing 'round' (e.g. R2)" });

    // Respond immediately, do heavy work in background
    res.json({ success: true, message: `Processing ${round} — Discord message will arrive shortly.` });

    try {
        const roundNum = parseInt(round.replace('R', ''));
        const rows = await db.execute({ sql: "SELECT * FROM f1_round_history WHERE round = ? ORDER BY id ASC", args: [round] }).then(r => r.rows);
        if (rows.length === 0) { console.log(`[RESEND] No history for ${round}`); return; }

        const raceName = rows[0].race_name;
        const calendarRace = await resolveCalendarRace(roundNum, raceName);
        const apiRound = getTimingApiRound(calendarRace) || roundNum;
        const playerScores = {};
        const penalties = {};
        const scoreBreakdowns = {};

        // Fetch actual race results (shorter timeouts)
        let results = null, sprintResults = [], gridMap = {};
        try {
            console.log('[RESEND] Fetching from own API...');
            const roundData = await f1TimingApiGet(`/results/round/${apiRound}`, { timeout: 8000 });
            const raceSes = Array.isArray(roundData) ? roundData.find(s => s.meta?.session_type === 'Race') : null;
            if (raceSes?.results?.length) {
                const driverList = await f1TimingApiGet('/drivers', { timeout: 8000 });
                const dMap = {}; driverList.forEach(d => { dMap[String(d.driver_number)] = d; });
                const qualSes = roundData.find(s => s.meta?.session_type === 'Qualifying');
                if (qualSes?.results) qualSes.results.forEach(r => { const d = dMap[String(r.driver_number)]; if (d) gridMap[normalizeStr(d.name)] = r.position; });
                if (Object.keys(gridMap).length === 0) {
                    try { const eqr = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/qualifying.json`, { timeout: 8000 }).then(r => r.data.MRData.RaceTable.Races); if (eqr?.length) eqr[0].QualifyingResults.forEach(q => { gridMap[normalizeStr(`${q.Driver.givenName} ${q.Driver.familyName}`)] = parseInt(q.position); }); } catch (_) { }
                }
                results = raceSes.results.map(r => {
                    const d = dMap[String(r.driver_number)] || {};
                    const parts = (d.name || '').split(' ');
                    return { position: String(r.position), positionText: r.retired ? 'R' : (r.stopped ? 'D' : String(r.position)), grid: String(gridMap[normalizeStr(d.name || '')] || 0), status: r.retired ? 'Retired' : (r.stopped ? 'Collision' : 'Finished'), Driver: { givenName: parts[0] || '', familyName: parts.slice(1).join(' ') || '' }, Constructor: { name: d.team || '' } };
                });
                const sprintSes = roundData.find(s => s.meta?.session_type === 'Sprint');
                if (sprintSes?.results) {
                    const sprintGridMap = {};
                    const sqSes = roundData.find(s => s.meta?.session_type === 'Sprint Qualifying');
                    if (sqSes?.results) sqSes.results.forEach(r => { const d = dMap[String(r.driver_number)]; if (d) sprintGridMap[normalizeStr(d.name)] = r.position; });
                    sprintResults = sprintSes.results.map(r => {
                        const d = dMap[String(r.driver_number)] || {};
                        const parts = (d.name || '').split(' ');
                        return { position: String(r.position), positionText: r.retired ? 'R' : String(r.position), grid: String(sprintGridMap[normalizeStr(d.name || '')] || gridMap[normalizeStr(d.name || '')] || 0), status: r.retired ? 'Retired' : 'Finished', Driver: { givenName: parts[0] || '', familyName: parts.slice(1).join(' ') || '' }, Constructor: { name: d.team || '' } };
                    });
                }
                console.log(`[RESEND] Own API: ${results.length} race results`);
            }
        } catch (e) { console.log('[RESEND] Own API failed:', e.message); }

        if (!results) {
            try {
                console.log('[RESEND] Trying Ergast...');
                const races = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/results.json`, { timeout: 8000 }).then(r => r.data.MRData.RaceTable.Races);
                if (races?.length) { results = races[0].Results; console.log(`[RESEND] Ergast: ${results.length} results`); }
                try { const sr = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/sprint.json`, { timeout: 8000 }).then(r => r.data); if (sr.MRData.RaceTable.Races.length > 0) sprintResults = sr.MRData.RaceTable.Races[0].SprintResults; } catch (_) { }
                try { const qr = await axios.get(`https://api.jolpi.ca/ergast/f1/2026/${apiRound}/qualifying.json`, { timeout: 8000 }).then(r => r.data.MRData.RaceTable.Races); if (qr?.length) qr[0].QualifyingResults.forEach(q => { gridMap[normalizeStr(`${q.Driver.givenName} ${q.Driver.familyName}`)] = parseInt(q.position); }); } catch (_) { }
            } catch (_) { console.log('[RESEND] Ergast also failed'); }
        }

        // Build actual positions if results available
        let actualDriverPositions = {}, actualCRanges = {}, raceLosers = [], sprintGainers = [], sprintLosers = [];
        if (results) {
            results.forEach(r => { const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`); let pos = parseInt(r.position); if (r.positionText === 'R' || r.positionText === 'D' || r.positionText === 'W' || r.status.startsWith('Retired') || r.status.startsWith('Collision')) pos = 22; actualDriverPositions[name] = pos; });
            const constructorSums = {}; results.forEach(r => { const c = normalizeConstructor(r.Constructor.name); let pos = parseInt(r.position); if (r.positionText === 'R' || r.positionText === 'D' || r.positionText === 'W') pos = 22; constructorSums[c] = (constructorSums[c] || 0) + pos; });
            const sumGroups = {}; for (const [c, sum] of Object.entries(constructorSums)) { if (!sumGroups[sum]) sumGroups[sum] = []; sumGroups[sum].push(c); }
            let currentRank = 1; Object.keys(sumGroups).map(Number).sort((a, b) => a - b).forEach(sum => { const teams = sumGroups[sum]; teams.forEach(team => { actualCRanges[team] = { min: currentRank, max: currentRank + teams.length - 1 }; }); currentRank += teams.length; });
            let maxRaceDrop = -999; results.forEach(r => { const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`); const grid = parseInt(r.grid) || gridMap[name] || 0; if (grid > 0) { let finish = parseInt(r.position); if (r.positionText === 'R' || r.positionText === 'D') finish = 22; const drop = finish - grid; if (drop > maxRaceDrop) { maxRaceDrop = drop; raceLosers = [name]; } else if (drop === maxRaceDrop) raceLosers.push(name); } });
            let maxSprintGain = -999, maxSprintDrop = -999; sprintResults.forEach(r => { const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`); const grid = parseInt(r.grid) || gridMap[name] || 0; if (grid > 0) { let finish = parseInt(r.position); if (r.positionText === 'R' || r.positionText === 'D') finish = 22; const gain = grid - finish; const drop = finish - grid; if (gain > maxSprintGain) { maxSprintGain = gain; sprintGainers = [name]; } else if (gain === maxSprintGain) sprintGainers.push(name); if (drop > maxSprintDrop) { maxSprintDrop = drop; sprintLosers = [name]; } else if (drop === maxSprintDrop) sprintLosers.push(name); } });
        }

        for (const row of rows) {
            const pred = JSON.parse(row.prediction || '{}');
            if (pred.penalty === 'new joiner') {
                penalties[row.user_name] = { type: 'new joiner', value: row.score };
            } else if (pred.penalty === 'no submission') {
                playerScores[row.user_name] = { score: row.score, hadPrediction: false };
            } else {
                playerScores[row.user_name] = { score: row.score, hadPrediction: true };
                if (results && !pred.backfill) {
                    const detail = calcDetailedBreakdown(pred, actualDriverPositions, actualCRanges, raceLosers, sprintGainers, sprintLosers);
                    scoreBreakdowns[row.user_name] = detail;
                }
            }
        }

        for (const [name, pen] of Object.entries(penalties)) {
            if (playerScores[name]) playerScores[name].newJoinerPenalty = pen.value;
        }

        const seasonRows = await db.execute("SELECT name, total_score FROM f1_drivers WHERE has_participated = 1 AND name != 'admin' ORDER BY total_score DESC").then(r => r.rows);
        const seasonTotals = {}; seasonRows.forEach(r => { seasonTotals[r.name] = r.total_score; });
        const sorted = Object.entries(playerScores).sort((a, b) => b[1].score - a[1].score);
        const breakdown = buildDiscordBreakdown(raceName, round, sorted, scoreBreakdowns, raceLosers, sprintResults, sprintGainers, sprintLosers, undefined, !!results, seasonTotals);

        await sendDiscordNotification(breakdown);
        console.log(`[RESEND] Discord notification sent for ${round}`);
    } catch (e) { console.error(`[RESEND] Background error for ${round}:`, e.message); }
});

app.get('/api/my-prediction', authenticateToken, async (req, res) => {
    try {
        const seasonCalendar = await getSeasonCalendar();
        const currentRace = await findStrategyRace(seasonCalendar, new Date());
        const currentRound = getRoundLabel(currentRace);
        if (!currentRound) return res.json(null);
        const r = await db.execute({
            sql: "SELECT * FROM f1_predictions_v4 WHERE user_name = ? AND prediction_round = ?",
            args: [req.user.name, currentRound]
        });
        res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Draft picks (auto-save, no lock check) ────────────────────────────────────
app.post('/api/draft-picks', authenticateToken, async (req, res) => {
    try {
        const seasonCalendar = await getSeasonCalendar();
        const currentRace = await findStrategyRace(seasonCalendar, new Date());
        const currentRound = getRoundLabel(currentRace);
        if (!currentRound) return res.json({ success: false, message: 'No active round' });
        await db.execute({
            sql: `INSERT INTO f1_draft_picks (user_name, prediction_round, picks, saved_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_name) DO UPDATE SET
                    prediction_round = excluded.prediction_round,
                    picks = excluded.picks,
                    saved_at = excluded.saved_at`,
            args: [req.user.name, currentRound, JSON.stringify(req.body), new Date().toISOString()]
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/draft-picks', authenticateToken, async (req, res) => {
    try {
        const seasonCalendar = await getSeasonCalendar();
        const currentRace = await findStrategyRace(seasonCalendar, new Date());
        const currentRound = getRoundLabel(currentRace);
        if (!currentRound) return res.json(null);
        const r = await db.execute({
            sql: 'SELECT picks, saved_at FROM f1_draft_picks WHERE user_name = ? AND prediction_round = ?',
            args: [req.user.name, currentRound]
        });
        if (!r.rows[0]) return res.json(null);
        res.json({ ...JSON.parse(r.rows[0].picks), saved_at: r.rows[0].saved_at });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin route rate limiter (applies to all /api/admin/* routes)
app.use('/api/admin', adminLimiter);

// ── Admin full data export ─────────────────────────────────────────────────────
app.get('/api/admin/export', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const [drivers, predictions, drafts, history, meta] = await Promise.all([
            db.execute("SELECT * FROM f1_drivers WHERE name != 'admin' ORDER BY total_score DESC"),
            db.execute("SELECT * FROM f1_predictions_v4 ORDER BY user_name"),
            db.execute("SELECT * FROM f1_draft_picks ORDER BY saved_at DESC"),
            db.execute("SELECT * FROM f1_round_history ORDER BY id ASC"),
            db.execute("SELECT * FROM f1_meta"),
        ]);
        const exported_at = new Date().toISOString();
        res.setHeader('Content-Disposition', `attachment; filename="f1-league-backup-${exported_at.slice(0,10)}.json"`);
        res.json({
            exported_at,
            drivers:     drivers.rows,
            predictions: predictions.rows,
            drafts:      drafts.rows,
            history:     history.rows,
            meta:        meta.rows,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/predictions', authenticateToken, async (req, res) => {
    const seasonCalendar = await getSeasonCalendar();
    const currentRace = await findStrategyRace(seasonCalendar, new Date());
    const currentRound = getRoundLabel(currentRace);
    if (currentRound && await hasRoundBeenScored(currentRound)) {
        return res.json([]);
    }

    if (!await shouldRevealPredictionsTo(req.user)) {
        return res.status(403).json({ error: 'Predictions unlock after strategy lockout.' });
    }
    if (!currentRound) return res.json([]);

    const r = await db.execute({
        sql: "SELECT p.*, d.total_score FROM f1_predictions_v4 p JOIN f1_drivers d ON p.user_name = d.name WHERE p.prediction_round = ?",
        args: [currentRound]
    });
    res.json(r.rows);
});

app.get('/api/season-leaderboard', async (req, res) => {
    const r = await db.execute("SELECT name, total_score, is_vip FROM f1_drivers WHERE name != 'admin' AND has_participated = 1 ORDER BY total_score DESC");
    res.json(r.rows);
});

app.get('/api/round-scores', authenticateToken, async (req, res) => {
    try {
        const rows = await db.execute("SELECT round, race_name, user_name, prediction, score FROM f1_round_history ORDER BY id ASC").then(r => r.rows);
        res.json(rows);
    } catch (e) { res.json([]); }
});

// --- 8. ADMIN ROUTES ---
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const r = await db.execute("SELECT id, name, total_score, has_participated, is_vip FROM f1_drivers WHERE name != 'admin' AND has_participated = 1 ORDER BY name ASC");
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/toggle-vip', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await db.execute({ sql: "UPDATE f1_drivers SET is_vip = ? WHERE name = ?", args: [req.body.vipStatus ? 1 : 0, req.body.targetUser] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/reset-user', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await db.execute({ sql: "UPDATE f1_drivers SET total_score = 0, has_participated = 0 WHERE name = ?", args: [req.body.targetUser] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/set-score', authenticateToken, requireAdmin, async (req, res) => {
    const { targetUser, score } = req.body;
    if (!targetUser || score === undefined) return res.status(400).json({ error: 'targetUser and score required' });
    const safeScore = parseInt(score, 10);
    if (isNaN(safeScore) || safeScore < -1000 || safeScore > 10000) {
        return res.status(400).json({ error: 'score must be an integer between -1000 and 10000' });
    }
    try {
        await db.execute({ sql: "UPDATE f1_drivers SET total_score = ? WHERE name = ?", args: [safeScore, targetUser] });
        res.json({ success: true, user: targetUser, newScore: safeScore });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/merge-driver', authenticateToken, requireAdmin, async (req, res) => {
    const sourceName = String(req.body?.sourceName || '').trim();
    const targetName = String(req.body?.targetName || '').trim();
    if (!sourceName || !targetName) {
        return res.status(400).json({ success: false, message: 'sourceName and targetName are required' });
    }
    if (sourceName === targetName) {
        return res.status(400).json({ success: false, message: 'sourceName and targetName must be different records' });
    }

    const source = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? LIMIT 1", args: [sourceName] }).then(r => r.rows[0] || null);
    const target = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? LIMIT 1", args: [targetName] }).then(r => r.rows[0] || null);
    if (!source || !target) {
        return res.status(404).json({ success: false, message: 'Both source and target drivers must exist' });
    }

    const tx = await db.transaction("write");
    try {
        const sourcePrediction = await tx.execute({
            sql: "SELECT * FROM f1_predictions_v4 WHERE user_name = ? LIMIT 1",
            args: [sourceName]
        }).then(r => r.rows[0] || null);
        const targetPrediction = await tx.execute({
            sql: "SELECT * FROM f1_predictions_v4 WHERE user_name = ? LIMIT 1",
            args: [targetName]
        }).then(r => r.rows[0] || null);

        const actualRounds = await tx.execute({
            sql: `SELECT DISTINCT round FROM f1_round_history 
                  WHERE user_name = ? AND prediction NOT LIKE '%"penalty"%'`,
            args: [sourceName]
        }).then(r => r.rows.map(row => String(row.round)));

        if (sourcePrediction && !targetPrediction) {
            await tx.execute({
                sql: "UPDATE f1_predictions_v4 SET user_name = ? WHERE user_name = ?",
                args: [targetName, sourceName]
            });
        } else {
            await tx.execute({
                sql: "DELETE FROM f1_predictions_v4 WHERE user_name = ?",
                args: [sourceName]
            });
        }

        await tx.execute({
            sql: `UPDATE f1_round_history
                  SET user_name = ?
                  WHERE user_name = ? AND prediction NOT LIKE '%"penalty"%'`,
            args: [targetName, sourceName]
        });

        for (const round of actualRounds) {
            await tx.execute({
                sql: `DELETE FROM f1_round_history
                      WHERE user_name = ? AND round = ? AND prediction = '{"penalty":"no submission"}'`,
                args: [targetName, round]
            });
        }

        await tx.execute({
            sql: `DELETE FROM f1_round_history
                  WHERE user_name = ? AND prediction LIKE '%"new joiner"%'`,
            args: [sourceName]
        });

        await recalculateDriverTotal(tx, targetName);
        await tx.execute({
            sql: "DELETE FROM f1_drivers WHERE name = ?",
            args: [sourceName]
        });

        await tx.commit();
        const refreshed = await db.execute({
            sql: "SELECT name, total_score, has_participated FROM f1_drivers WHERE name = ? LIMIT 1",
            args: [targetName]
        }).then(r => r.rows[0] || null);
        return res.json({
            success: true,
            mergedFrom: sourceName,
            mergedInto: targetName,
            affectedRounds: actualRounds,
            target: refreshed
        });
    } catch (e) {
        try { await tx.rollback(); } catch (_) { }
        return res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/import-predictions', authenticateToken, requireAdmin, async (req, res) => {
    const clearExisting = !!req.body?.clearExisting;
    const seasonCalendar = await getSeasonCalendar();
    const currentRace = await findStrategyRace(seasonCalendar, new Date());
    const predictionRound = getRoundLabel(currentRace);
    let normalized;
    try {
        normalized = normalizeImportSubmissions(req.body?.submissions);
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }

    const tx = await db.transaction("write");
    try {
        if (clearExisting) {
            await tx.execute("DELETE FROM f1_predictions_v4");
        }

        let createdUsers = 0;
        for (const entry of normalized) {
            const ensured = await ensureDriverRecord(tx, entry.userName);
            if (ensured.created) createdUsers += 1;
            await upsertPredictionRecord(tx, entry.userName, entry.payload, predictionRound);
        }

        await tx.commit();
        res.json({
            success: true,
            imported: normalized.length,
            createdUsers,
            clearedExisting: clearExisting
        });
    } catch (e) {
        try { await tx.rollback(); } catch (_) { }
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/manual-finalize', authenticateToken, requireAdmin, async (req, res) => {
    const seasonCalendar = await getSeasonCalendar();
    const currentRace = await findStrategyRace(seasonCalendar, new Date());
    const predictionRound = getRoundLabel(currentRace);
    let normalized;
    try {
        normalized = normalizeImportSubmissions(req.body?.submissions);
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }

    const backupRows = await db.execute("SELECT * FROM f1_predictions_v4 ORDER BY id ASC").then(r => r.rows);
    const backupEntries = backupRows.map(row => ({
        userName: row.user_name,
        predictionRound: row.prediction_round,
        payload: {
            p1: row.p1,
            p2: row.p2,
            p3: row.p3,
            p10: row.p10,
            p11: row.p11,
            p21: row.p21,
            p22: row.p22,
            c1: row.c1,
            c2: row.c2,
            c5: row.c5,
            c6: row.c6,
            c11: row.c11,
            w_race_loser: row.w_race_loser,
            w_sprint_gainer: row.w_sprint_gainer,
            w_sprint_loser: row.w_sprint_loser
        }
    }));

    let staged = false;
    try {
        const stageTx = await db.transaction("write");
        try {
            await replacePredictionsTable(stageTx, normalized, predictionRound);
            await stageTx.commit();
            staged = true;
        } catch (stageError) {
            try { await stageTx.rollback(); } catch (_) { }
            throw stageError;
        }

        const finalizeResult = await performFinalization();

        const restoreTx = await db.transaction("write");
        try {
            if (backupEntries.length > 0) {
                await replacePredictionsTable(restoreTx, backupEntries);
            } else {
                await restoreTx.execute("DELETE FROM f1_predictions_v4");
            }
            await restoreTx.commit();
        } catch (restoreError) {
            try { await restoreTx.rollback(); } catch (_) { }
            return res.status(500).json({
                success: false,
                message: `Manual finalization completed with restore failure: ${restoreError.message}`,
                finalizeResult
            });
        }

        return res.json({
            ...finalizeResult,
            stagedImportCount: normalized.length,
            restoredPredictionCount: backupEntries.length
        });
    } catch (e) {
        if (staged) {
            const restoreTx = await db.transaction("write");
            try {
                if (backupEntries.length > 0) {
                    await replacePredictionsTable(restoreTx, backupEntries);
                } else {
                    await restoreTx.execute("DELETE FROM f1_predictions_v4");
                }
                await restoreTx.commit();
            } catch (_) {
                try { await restoreTx.rollback(); } catch (_) { }
            }
        }
        return res.status(500).json({ success: false, message: e.message });
    }
});


app.get('/api/admin/round-history', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const rows = await db.execute("SELECT * FROM f1_round_history ORDER BY id DESC").then(r => r.rows);
        res.json(rows);
    } catch (e) { res.json([]); }
});

// --- 8b. LIVE API PROXY ROUTES ---
const liveProxy = async (apiPath, res) => {
    try {
        const r = await axios.get(buildF1TimingApiUrl(apiPath), buildF1TimingApiConfig({ timeout: 10000 }));
        res.status(r.status).json(r.data);
    } catch (e) {
        if (e.response) {
            const upstreamBody = e.response.data;
            if (upstreamBody && typeof upstreamBody === 'object') {
                return res.status(e.response.status).json(upstreamBody.error ? upstreamBody : { ...upstreamBody, error: 'API request failed' });
            }
            return res.status(e.response.status).json({ error: upstreamBody || 'API request failed' });
        }
        res.status(502).json({ error: 'API unavailable', detail: e.message });
    }
};

const OFFICIAL_2026_GRID = [
    { team: 'Red Bull Racing', drivers: ['Max Verstappen', 'Isack Hadjar'] },
    { team: 'McLaren', drivers: ['Lando Norris', 'Oscar Piastri'] },
    { team: 'Ferrari', drivers: ['Charles Leclerc', 'Lewis Hamilton'] },
    { team: 'Mercedes', drivers: ['George Russell', 'Kimi Antonelli'] },
    { team: 'Aston Martin', drivers: ['Fernando Alonso', 'Lance Stroll'] },
    { team: 'Williams', drivers: ['Carlos Sainz', 'Alexander Albon'] },
    { team: 'Alpine', drivers: ['Pierre Gasly', 'Franco Colapinto'] },
    { team: 'Racing Bulls', drivers: ['Liam Lawson', 'Arvid Lindblad'] },
    { team: 'Haas', drivers: ['Esteban Ocon', 'Oliver Bearman'] },
    { team: 'Audi', drivers: ['Nico Hulkenberg', 'Gabriel Bortoleto'] },
    { team: 'Cadillac', drivers: ['Sergio Perez', 'Valtteri Bottas'] }
];

const STATIC_DRIVER_STANDINGS = [
    { position: 1, driver_number: '12', name: 'Kimi ANTONELLI', acronym: 'ANT', team: 'Mercedes', team_colour: '00D7B6', points: 47, wins: 1, podiums: 2 },
    { position: 2, driver_number: '63', name: 'George RUSSELL', acronym: 'RUS', team: 'Mercedes', team_colour: '00D7B6', points: 45, wins: 2, podiums: 2 },
    { position: 3, driver_number: '16', name: 'Charles LECLERC', acronym: 'LEC', team: 'Ferrari', team_colour: 'ED1131', points: 37, wins: 0, podiums: 3 },
    { position: 4, driver_number: '44', name: 'Lewis HAMILTON', acronym: 'HAM', team: 'Ferrari', team_colour: 'ED1131', points: 26, wins: 0, podiums: 1 },
    { position: 5, driver_number: '1', name: 'Lando NORRIS', acronym: 'NOR', team: 'McLaren', team_colour: 'F47600', points: 25, wins: 0, podiums: 0 },
    { position: 6, driver_number: '81', name: 'Oscar PIASTRI', acronym: 'PIA', team: 'McLaren', team_colour: 'F47600', points: 21, wins: 0, podiums: 1 },
    { position: 7, driver_number: '3', name: 'Max VERSTAPPEN', acronym: 'VER', team: 'Red Bull Racing', team_colour: '4781D7', points: 12, wins: 0, podiums: 0 },
    { position: 8, driver_number: '10', name: 'Pierre GASLY', acronym: 'GAS', team: 'Alpine', team_colour: '00A1E8', points: 7, wins: 0, podiums: 0 },
    { position: 9, driver_number: '87', name: 'Oliver BEARMAN', acronym: 'BEA', team: 'Haas F1 Team', team_colour: '9C9FA2', points: 7, wins: 0, podiums: 0 },
    { position: 10, driver_number: '30', name: 'Liam LAWSON', acronym: 'LAW', team: 'Racing Bulls', team_colour: '6C98FF', points: 4, wins: 0, podiums: 0 },
    { position: 11, driver_number: '41', name: 'Arvid LINDBLAD', acronym: 'LIN', team: 'Racing Bulls', team_colour: '6C98FF', points: 4, wins: 0, podiums: 0 },
    { position: 12, driver_number: '5', name: 'Gabriel BORTOLETO', acronym: 'BOR', team: 'Audi', team_colour: 'F50537', points: 2, wins: 0, podiums: 0 },
    { position: 13, driver_number: '31', name: 'Esteban OCON', acronym: 'OCO', team: 'Haas F1 Team', team_colour: '9C9FA2', points: 1, wins: 0, podiums: 0 },
    { position: 14, driver_number: '6', name: 'Isack HADJAR', acronym: 'HAD', team: 'Red Bull Racing', team_colour: '4781D7', points: 0, wins: 0, podiums: 0 },
    { position: 15, driver_number: '11', name: 'Sergio PEREZ', acronym: 'PER', team: 'Cadillac', team_colour: '909090', points: 0, wins: 0, podiums: 0 },
    { position: 16, driver_number: '14', name: 'Fernando ALONSO', acronym: 'ALO', team: 'Aston Martin', team_colour: '229971', points: 0, wins: 0, podiums: 0 },
    { position: 17, driver_number: '18', name: 'Lance STROLL', acronym: 'STR', team: 'Aston Martin', team_colour: '229971', points: 0, wins: 0, podiums: 0 },
    { position: 18, driver_number: '23', name: 'Alexander ALBON', acronym: 'ALB', team: 'Williams', team_colour: '1868DB', points: 0, wins: 0, podiums: 0 },
    { position: 19, driver_number: '27', name: 'Nico HULKENBERG', acronym: 'HUL', team: 'Audi', team_colour: 'F50537', points: 0, wins: 0, podiums: 0 },
    { position: 20, driver_number: '43', name: 'Franco COLAPINTO', acronym: 'COL', team: 'Alpine', team_colour: '00A1E8', points: 0, wins: 0, podiums: 0 },
    { position: 21, driver_number: '55', name: 'Carlos SAINZ', acronym: 'SAI', team: 'Williams', team_colour: '1868DB', points: 0, wins: 0, podiums: 0 },
    { position: 22, driver_number: '77', name: 'Valtteri BOTTAS', acronym: 'BOT', team: 'Cadillac', team_colour: '909090', points: 0, wins: 0, podiums: 0 }
];

const STATIC_CONSTRUCTOR_STANDINGS = [
    { position: 1, team: 'Mercedes', points: 92, wins: 3 },
    { position: 2, team: 'Ferrari', points: 63, wins: 0 },
    { position: 3, team: 'McLaren', points: 46, wins: 0 },
    { position: 4, team: 'Red Bull Racing', points: 12, wins: 0 },
    { position: 5, team: 'Racing Bulls', points: 8, wins: 0 },
    { position: 6, team: 'Haas F1 Team', points: 8, wins: 0 },
    { position: 7, team: 'Alpine', points: 7, wins: 0 },
    { position: 8, team: 'Audi', points: 2, wins: 0 },
    { position: 9, team: 'Williams', points: 0, wins: 0 },
    { position: 10, team: 'Cadillac', points: 0, wins: 0 },
    { position: 11, team: 'Aston Martin', points: 0, wins: 0 }
];

const liveProxyWithFallback = async (apiPath, res, fallback) => {
    const hasPoints = arr => Array.isArray(arr) && arr.some(s => (s.points || 0) > 0);
    try {
        const r = await axios.get(buildF1TimingApiUrl(apiPath), buildF1TimingApiConfig({ timeout: 10000 }));
        const data = r.data;
        const arr = Array.isArray(data) ? data : (data && Array.isArray(data.standings) ? data.standings : null);
        if (hasPoints(arr)) {
            return res.json({ standings: arr, source: 'live' });
        }
        res.json({ standings: fallback, source: 'deployed-current-fallback' });
    } catch (e) {
        res.json({ standings: fallback, source: 'deployed-current-fallback', upstreamError: e.response?.status || e.message });
    }
};

app.get('/api/live/timing', (_, res) => liveProxy('/timing', res));
app.get('/api/live/weather', async (_, res) => {
    // Prefer live timing weather whenever the upstream has a valid payload.
    try {
        const live = await f1TimingApiGet('/weather', { timeout: 5000 });
        const normalizedLive = normalizeWeatherPayload({ ...live, source: 'live' });
        if (normalizedLive) return res.json(normalizedLive);
    } catch (e) { }
    // Fallback: Open-Meteo for the next race's circuit location (free, no API key)
    try {
        const now = new Date();
        const seasonCalendar = await getSeasonCalendar();
        const next = await findStrategyRace(seasonCalendar, now);
        if (!next?.lat || !next?.lon) throw new Error('No circuit coordinates available');
        const meteo = await axios.get(`https://api.open-meteo.com/v1/forecast`, {
            params: { latitude: next.lat, longitude: next.lon, current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation' },
            headers: { 'User-Agent': 'F1PredictionApp/1.0 (https://f1-prediction-app.onrender.com)' },
            timeout: 8000
        }).then(r => r.data);
        const fallbackWeather = normalizeWeatherPayload({
            ...meteo.current,
            TrackTemp: Math.round(Number(meteo.current.temperature_2m) * 1.15),
            Rainfall: meteo.current.precipitation > 0 ? 1 : 0,
            source: 'open-meteo'
        });
        if (fallbackWeather) return res.json(fallbackWeather);
        res.status(503).json({ error: 'Weather unavailable' });
    } catch (e) {
        console.error('[Weather Fallback]', e.message);
        res.status(503).json({ error: 'Weather unavailable', detail: e.message });
    }
});
app.get('/api/live/track', (_, res) => liveProxy('/track', res));
app.get('/api/live/race-control', (_, res) => liveProxy('/race-control', res));
app.get('/api/live/pits', (_, res) => liveProxy('/pits', res));
app.get('/api/live/radio-audio', async (req, res) => {
    const audioPath = req.query.path;
    // Allowlist: must start with a 4-digit year prefix and end with a known audio extension
    const AUDIO_PATH_RE = /^20\d{2}\/[\w\-./]+\.(mp3|aac|m4a|ogg)$/i;
    if (!audioPath || !AUDIO_PATH_RE.test(audioPath) || audioPath.includes('..')) {
        return res.status(400).end();
    }
    try {
        const upstream = await axios.get(`${F1_STATIC_BASE}${audioPath}`, { responseType: 'stream', timeout: 15000 });
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        upstream.data.pipe(res);
    } catch (e) { res.status(502).end(); }
});

app.get('/api/live/team-radio', async (_, res) => {
    try {
        const payload = await f1TimingApiGet('/team-radio', { timeout: 10000 });
        res.json(normalizeTeamRadioPayload(payload));
    } catch (e) {
        if (e.response) {
            return res.status(e.response.status).json({ timestamp: null, session: null, total: 0, messages: [], error: e.response.data?.error || 'API request failed' });
        }
        res.status(502).json({ timestamp: null, session: null, total: 0, messages: [], error: 'API unavailable', detail: e.message });
    }
});
app.get('/api/live/telemetry', (_, res) => liveProxy('/telemetry', res));
app.get('/api/live/telemetry/:number', (req, res) => {
    if (!/^\d{1,3}$/.test(req.params.number)) return res.status(400).json({ error: 'Invalid driver number' });
    liveProxy(`/telemetry/${req.params.number}`, res);
});
app.get('/api/standings/drivers', (_, res) => liveProxyWithFallback('/standings/drivers', res, STATIC_DRIVER_STANDINGS));
app.get('/api/standings/constructors', (_, res) => liveProxyWithFallback('/standings/constructors', res, STATIC_CONSTRUCTOR_STANDINGS));
app.get('/api/last-race-results', async (_req, res) => {
    try {
        const historyRows = await db.execute(`
            SELECT round, race_name, user_name, prediction, score
            FROM f1_round_history
            WHERE race_name IS NOT NULL
              AND race_name != 'New Joiner Penalty'
            ORDER BY CAST(REPLACE(round, 'R', '') AS INTEGER) DESC, id ASC
        `).then(r => r.rows || []);

        const latestHistory = historyRows[0];
        if (latestHistory) {
            const latestRound = latestHistory.round;
            const latestRaceName = latestHistory.race_name;
            const roundRows = historyRows.filter(row => row.round === latestRound && row.race_name === latestRaceName);
            return res.json({
                race: {
                    round: Number(String(latestRound).replace(/^R/i, '')) || latestRound,
                    name: latestRaceName
                },
                roundScores: roundRows,
                source: 'round-history'
            });
        }

        try {
            const results = await f1TimingApiGet('/results', { timeout: 7000 });
            const resultList = Array.isArray(results) ? results : [];
            const match = resultList.find(r => /race/i.test(String(r.session_name || r.session_type || r.filename || '')));
            if (match) return res.json({ race: { round: match.round, name: match.meeting, circuit: match.circuit }, sessions: [match], source: 'live-archive' });
        } catch (_) { }
        res.json({ race: null, roundScores: [], sessions: [], source: 'none' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/live/status', (_, res) => liveProxy('/status', res));
app.get('/api/live/calendar-current', (_, res) => liveProxy('/calendar/current', res));
app.get('/api/live/results', (_, res) => liveProxy('/results', res));
app.get('/api/live/results/:filename', (req, res) => {
    const RESULT_FILENAME_RE = /^\d{4}_R\d{2}_[\w]+\.json$/;
    if (!RESULT_FILENAME_RE.test(req.params.filename)) return res.status(400).json({ error: 'Invalid filename' });
    liveProxy(`/results/${req.params.filename}`, res);
});
app.get('/api/live/pits/:number', (req, res) => {
    if (!/^\d{1,3}$/.test(req.params.number)) return res.status(400).json({ error: 'Invalid driver number' });
    liveProxy(`/pits/${req.params.number}`, res);
});
app.get('/api/live/team-radio/:number', async (req, res) => {
    if (!/^\d{1,3}$/.test(req.params.number)) return res.status(400).json({ error: 'Invalid driver number' });
    try {
        const payload = await f1TimingApiGet(`/team-radio/${encodeURIComponent(req.params.number)}`, { timeout: 10000 });
        res.json(normalizeTeamRadioPayload(payload));
    } catch (e) {
        const upstreamStatus = e.response?.status;
        const upstreamError = e.response?.data?.error;
        if (upstreamStatus === 404 && typeof upstreamError === 'string' && upstreamError.toLowerCase().includes('no team radio')) {
            return res.json({ timestamp: null, session: null, total: 0, messages: [] });
        }
        if (e.response) {
            return res.status(e.response.status).json({ timestamp: null, session: null, total: 0, messages: [], error: e.response.data?.error || 'API request failed' });
        }
        res.status(502).json({ timestamp: null, session: null, total: 0, messages: [], error: 'API unavailable', detail: e.message });
    }
});
app.get('/api/live/timing/:number', (req, res) => {
    if (!/^\d{1,3}$/.test(req.params.number)) return res.status(400).json({ error: 'Invalid driver number' });
    liveProxy(`/timing/${req.params.number}`, res);
});

app.get('/api/paddock-news', async (_, res) => {
    try {
        const xml = await axios.get('https://www.motorsport.com/rss/f1/news/', {
            timeout: 10000,
            responseType: 'text',
            headers: { 'User-Agent': 'F1PredictionApp/1.0' }
        }).then(r => r.data);
        const items = parseMotorsportRss(xml);
        if (!items.length) {
            return res.status(502).json({ error: 'News feed unavailable', items: [] });
        }
        res.json({ source: 'motorsport-rss', items });
    } catch (e) {
        console.error('[Paddock News]', e.message);
        res.status(502).json({ error: 'News feed unavailable', items: [] });
    }
});

// SSE proxy: pipes live timing stream from own API to client
app.get('/api/live/stream', authenticateToken, (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const topic = req.query.topic || '';
    const url = topic ? buildF1TimingApiUrl(`/stream?topic=${encodeURIComponent(topic)}`) : buildF1TimingApiUrl('/stream/timing');
    axios.get(url, buildF1TimingApiConfig({ responseType: 'stream', timeout: 0, headers: { 'Accept': 'text/event-stream' } }))
        .then(upstream => { upstream.data.pipe(res); req.on('close', () => upstream.data.destroy()); })
        .catch(e => { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); });
});

// SSE proxy: telemetry stream for individual driver
app.get('/api/live/telemetry/stream/:number', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    axios.get(buildF1TimingApiUrl(`/telemetry/stream/${req.params.number}`), buildF1TimingApiConfig({ responseType: 'stream', timeout: 0, headers: { 'Accept': 'text/event-stream' } }))
        .then(upstream => { upstream.data.pipe(res); req.on('close', () => upstream.data.destroy()); })
        .catch(e => { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); });
});

// --- 9. AUTOMATED RACE DETECTION & FINALIZATION ---
// Polls the F1 live timing API every 6 minutes (2 min on retry after failure).
// When a Race session transitions to "Finalised", scoring is triggered automatically.
let finalizationPending = false;
let lastKnownFinalizedSession = null; // in-memory cache to avoid repeated DB hits + log spam

async function checkAndFinalize() {
    // Keep both Render servers awake
    fetch(`${APP_URL}/api/next-race`).catch(() => { });
    f1TimingApiGet('/status', { timeout: 5000 }).catch(() => { });

    if (finalizationPending) return;

    try {
        const status = await f1TimingApiGet('/status', { timeout: 8000 });
        const session = status?.session;

        if (!session || session.Type !== 'Race') return;
        if (session.SessionStatus !== 'Finalised') { console.log(`[AUTO] Race status: ${session.SessionStatus} — waiting`); return; }

        const sessionKey = String(session.Key);

        // Skip silently if we already handled this session (in-memory fast path)
        if (lastKnownFinalizedSession === sessionKey) return;

        // Check DB in case server restarted and memory was lost
        const meta = await db.execute({ sql: "SELECT value FROM f1_meta WHERE key = 'last_finalized_session'", args: [] });
        if (meta.rows[0]?.value === sessionKey) {
            lastKnownFinalizedSession = sessionKey; // cache it so we never hit DB again for this session
            console.log(`[AUTO] Session ${sessionKey} already finalized — skipping future checks`);
            return;
        }

        console.log(`[AUTO] Race session ${sessionKey} finalised — triggering scoring`);
        finalizationPending = true;

        const result = await performFinalization();

        if (result.success || result.message === "Already scored." || result.message === "No predictions found.") {
            await db.execute({ sql: "INSERT INTO f1_meta (key, value) VALUES ('last_finalized_session', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [sessionKey] });
            lastKnownFinalizedSession = sessionKey; // cache after successful DB write
            if (result.success) console.log(`[AUTO] Scoring complete for session ${sessionKey}`);
            else console.log(`[AUTO] Session ${sessionKey} marked done (${result.message})`);
        } else {
            console.warn(`[AUTO] Scoring failed: ${result.message} — retrying in 2 min`);
            setTimeout(checkAndFinalize, 2 * 60 * 1000);
        }
    } catch (e) {
        console.error('[AUTO] Race detection error:', e.message, '— retrying in 2 min');
        setTimeout(checkAndFinalize, 2 * 60 * 1000);
    } finally {
        finalizationPending = false;
    }
}

// Regular 6-min polling
setInterval(checkAndFinalize, 6 * 60 * 1000);

// Run once on startup (catches races finalized while server was cold)
setTimeout(checkAndFinalize, 10 * 1000);

// Check Discord reminders/lockout every minute.
setInterval(checkPredictionNotifications, 60 * 1000);
setTimeout(checkPredictionNotifications, 15 * 1000);

if (process.env.ENABLE_LOCAL_AUTH === '1' && process.env.NODE_ENV !== 'production') {
    setTimeout(() => {
        ensureLocalPreviewData().catch(e => console.error('[LOCAL PREVIEW] Failed to sync preview data:', e.message));
    }, 1000);
}

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- DEPLOY UPDATE NOTIFICATION ---
const APP_VERSION = 'v8.0';
const APP_CHANGELOG = [
    'Fixed driver career stats: verified all 22 drivers against official F1 website',
    'Corrected pole positions, race counts, and championship data (Norris 2025 WDC)',
    'Hadjar & Bortoleto no longer marked as rookies (debuted 2025)',
];
async function notifyDeployUpdate() {
    try {
        const meta = await db.execute({ sql: "SELECT value FROM f1_meta WHERE key = 'app_version'", args: [] });
        const storedVersion = meta.rows[0]?.value || 'none';
        console.log(`[DEPLOY] Current: ${APP_VERSION}, Stored: ${storedVersion}`);
        if (storedVersion === APP_VERSION) { console.log('[DEPLOY] Version unchanged — skipping notification'); return; }
        let msg = `**App Update — ${APP_VERSION}**\n`;
        APP_CHANGELOG.forEach(c => { msg += `• ${c}\n`; });
        console.log('[DEPLOY] Sending Discord notification...');
        await sendDiscordNotification(msg);
        await db.execute({ sql: "INSERT INTO f1_meta (key, value) VALUES ('app_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [APP_VERSION] });
        console.log(`[DEPLOY] Update notification sent for ${APP_VERSION}`);
    } catch (e) { console.error('[DEPLOY] Failed to send update notification:', e.message); }
}
setTimeout(notifyDeployUpdate, 5 * 1000);

app.listen(port, () => {
    console.log(`🏁 Server 3000 (Google OAuth Secure)`);
    console.log(`[ENV] DISCORD_WEBHOOK: ${process.env.DISCORD_WEBHOOK ? 'SET (' + process.env.DISCORD_WEBHOOK.substring(0, 30) + '...)' : 'NOT SET'}`);
});
