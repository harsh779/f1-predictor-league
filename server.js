const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'f1_super_secret_key_2026'; 

app.use(express.json());

// 🚀 CACHE KILLER: Forces browsers to load the newest version instantly
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false })); 

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// --- 1. DATABASE SETUP ---
async function setupDatabase() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, auth_id TEXT, total_score INTEGER DEFAULT 0, has_participated INTEGER DEFAULT 0, is_vip INTEGER DEFAULT 0)`);
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN auth_id TEXT`); } catch(e) {}
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN has_participated INTEGER DEFAULT 0`); } catch(e) {}
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN is_vip INTEGER DEFAULT 0`); } catch(e) {}
    
    // 🌍 NEW: Columns for Season-Long Predictions
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN season_driver TEXT`); } catch(e) {}
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN season_constructor TEXT`); } catch(e) {}
    
    // 🚀 UPGRADED TO V4 FOR NEW SCORING RULES (P10, P11, C11)
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_predictions_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT UNIQUE, 
        p1 TEXT, p2 TEXT, p3 TEXT, p10 TEXT, p11 TEXT, p21 TEXT, p22 TEXT, 
        c1 TEXT, c2 TEXT, c5 TEXT, c6 TEXT, c11 TEXT, 
        w_race_loser TEXT, w_sprint_gainer TEXT, w_sprint_loser TEXT
    )`);
    
    await db.execute({ sql: "INSERT INTO f1_drivers (name, auth_id, is_vip) VALUES ('admin', 'admin_override', 1) ON CONFLICT(name) DO NOTHING" });
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_meta (key TEXT PRIMARY KEY, value TEXT)`);
    console.log("Database synced.");
  } catch (e) { console.error("DB Error:", e); }
}
setupDatabase();

// --- 2. FULL 2026 CALENDAR (FULLY UPDATED WITH ALL SESSIONS) ---
const f1Calendar2026 = [
  { round: 1, name: "Australian Grand Prix", hasSprint: false, date: "2026-03-08T09:30:00+05:30", circuit: "Albert Park Circuit", country: "Australia", trackDetails: { length: "5.278 km", laps: 58, corners: 14, firstGP: 1996, record: "1:19.813" }, sessions: { fp1: "2026-03-06T07:00:00+05:30", fp2: "2026-03-06T10:30:00+05:30", fp3: "2026-03-07T07:00:00+05:30", quali: "2026-03-07T10:30:00+05:30", race: "2026-03-08T09:30:00+05:30" } },
  { round: 2, name: "Chinese Grand Prix", hasSprint: true, date: "2026-03-15T12:30:00+05:30", circuit: "Shanghai International Circuit", country: "China", trackDetails: { length: "5.451 km", laps: 56, corners: 16, firstGP: 2004, record: "1:32.238" }, sessions: { fp1: "2026-03-13T09:00:00+05:30", sprintQuali: "2026-03-13T13:00:00+05:30", sprint: "2026-03-14T09:00:00+05:30", quali: "2026-03-14T13:00:00+05:30", race: "2026-03-15T12:30:00+05:30" } },
  { round: 3, name: "Japanese Grand Prix", hasSprint: false, date: "2026-03-29T10:30:00+05:30", circuit: "Suzuka International Racing Course", country: "Japan", trackDetails: { length: "5.807 km", laps: 53, corners: 18, firstGP: 1987, record: "1:30.983" }, sessions: { fp1: "2026-03-27T08:00:00+05:30", fp2: "2026-03-27T11:30:00+05:30", fp3: "2026-03-28T08:00:00+05:30", quali: "2026-03-28T11:30:00+05:30", race: "2026-03-29T10:30:00+05:30" } },
  { round: 4, name: "Bahrain Grand Prix", hasSprint: false, date: "2026-04-12T20:30:00+05:30", circuit: "Bahrain International Circuit", country: "Bahrain", trackDetails: { length: "5.412 km", laps: 57, corners: 15, firstGP: 2004, record: "1:31.447" }, sessions: { fp1: "2026-04-10T17:00:00+05:30", fp2: "2026-04-10T20:30:00+05:30", fp3: "2026-04-11T17:30:00+05:30", quali: "2026-04-11T21:30:00+05:30", race: "2026-04-12T20:30:00+05:30" } },
  { round: 5, name: "Saudi Arabian Grand Prix", hasSprint: false, date: "2026-04-19T22:30:00+05:30", circuit: "Jeddah Corniche Circuit", country: "Saudi Arabia", trackDetails: { length: "6.174 km", laps: 50, corners: 27, firstGP: 2021, record: "1:30.734" }, sessions: { fp1: "2026-04-17T19:00:00+05:30", fp2: "2026-04-17T22:30:00+05:30", fp3: "2026-04-18T19:00:00+05:30", quali: "2026-04-18T22:30:00+05:30", race: "2026-04-19T22:30:00+05:30" } },
  { round: 6, name: "Miami Grand Prix", hasSprint: true, date: "2026-05-04T01:30:00+05:30", circuit: "Miami International Autodrome", country: "United States", trackDetails: { length: "5.412 km", laps: 57, corners: 19, firstGP: 2022, record: "1:29.708" }, sessions: { fp1: "2026-05-01T22:00:00+05:30", sprintQuali: "2026-05-02T02:00:00+05:30", sprint: "2026-05-02T21:30:00+05:30", quali: "2026-05-03T01:30:00+05:30", race: "2026-05-04T01:30:00+05:30" } },
  { round: 7, name: "Canadian Grand Prix", hasSprint: true, date: "2026-05-24T23:30:00+05:30", circuit: "Circuit Gilles-Villeneuve", country: "Canada", trackDetails: { length: "4.361 km", laps: 70, corners: 14, firstGP: 1978, record: "1:13.078" }, sessions: { fp1: "2026-05-22T23:00:00+05:30", sprintQuali: "2026-05-23T03:00:00+05:30", sprint: "2026-05-23T21:30:00+05:30", quali: "2026-05-24T01:30:00+05:30", race: "2026-05-24T23:30:00+05:30" } },
  { round: 8, name: "Monaco Grand Prix", hasSprint: false, date: "2026-06-07T18:30:00+05:30", circuit: "Circuit de Monaco", country: "Monaco", trackDetails: { length: "3.337 km", laps: 78, corners: 19, firstGP: 1950, record: "1:12.909" }, sessions: { fp1: "2026-06-05T17:00:00+05:30", fp2: "2026-06-05T20:30:00+05:30", fp3: "2026-06-06T16:00:00+05:30", quali: "2026-06-06T19:30:00+05:30", race: "2026-06-07T18:30:00+05:30" } },
  { round: 9, name: "Spanish Grand Prix", hasSprint: false, date: "2026-06-14T18:30:00+05:30", circuit: "Circuit de Barcelona-Catalunya", country: "Spain", trackDetails: { length: "4.657 km", laps: 66, corners: 14, firstGP: 1991, record: "1:18.149" }, sessions: { fp1: "2026-06-12T17:00:00+05:30", fp2: "2026-06-12T20:30:00+05:30", fp3: "2026-06-13T16:00:00+05:30", quali: "2026-06-13T19:30:00+05:30", race: "2026-06-14T18:30:00+05:30" } },
  { round: 10, name: "Austrian Grand Prix", hasSprint: false, date: "2026-06-28T18:30:00+05:30", circuit: "Red Bull Ring", country: "Austria", trackDetails: { length: "4.318 km", laps: 71, corners: 10, firstGP: 1970, record: "1:05.619" }, sessions: { fp1: "2026-06-26T17:00:00+05:30", fp2: "2026-06-26T20:30:00+05:30", fp3: "2026-06-27T16:00:00+05:30", quali: "2026-06-27T19:00:00+05:30", race: "2026-06-28T18:30:00+05:30" } },
  { round: 11, name: "British Grand Prix", hasSprint: true, date: "2026-07-05T19:30:00+05:30", circuit: "Silverstone Circuit", country: "Great Britain", trackDetails: { length: "5.891 km", laps: 52, corners: 18, firstGP: 1950, record: "1:27.097" }, sessions: { fp1: "2026-07-03T18:00:00+05:30", sprintQuali: "2026-07-03T22:00:00+05:30", sprint: "2026-07-04T16:30:00+05:30", quali: "2026-07-04T20:00:00+05:30", race: "2026-07-05T19:30:00+05:30" } },
  { round: 12, name: "Belgian Grand Prix", hasSprint: false, date: "2026-07-19T18:30:00+05:30", circuit: "Circuit de Spa-Francorchamps", country: "Belgium", trackDetails: { length: "7.004 km", laps: 44, corners: 19, firstGP: 1950, record: "1:46.286" }, sessions: { fp1: "2026-07-17T17:00:00+05:30", fp2: "2026-07-17T20:30:00+05:30", fp3: "2026-07-18T16:00:00+05:30", quali: "2026-07-18T19:00:00+05:30", race: "2026-07-19T18:30:00+05:30" } },
  { round: 13, name: "Hungarian Grand Prix", hasSprint: false, date: "2026-07-26T18:30:00+05:30", circuit: "Hungaroring", country: "Hungary", trackDetails: { length: "4.381 km", laps: 70, corners: 14, firstGP: 1986, record: "1:16.627" }, sessions: { fp1: "2026-07-24T17:00:00+05:30", fp2: "2026-07-24T20:30:00+05:30", fp3: "2026-07-25T16:00:00+05:30", quali: "2026-07-25T19:30:00+05:30", race: "2026-07-26T18:30:00+05:30" } },
  { round: 14, name: "Dutch Grand Prix", hasSprint: true, date: "2026-08-23T18:30:00+05:30", circuit: "Circuit Zandvoort", country: "Netherlands", trackDetails: { length: "4.259 km", laps: 72, corners: 14, firstGP: 1952, record: "1:11.097" }, sessions: { fp1: "2026-08-21T16:00:00+05:30", sprintQuali: "2026-08-21T19:30:00+05:30", sprint: "2026-08-22T15:30:00+05:30", quali: "2026-08-22T18:30:00+05:30", race: "2026-08-23T18:30:00+05:30" } },
  { round: 15, name: "Italian Grand Prix", hasSprint: false, date: "2026-09-06T18:30:00+05:30", circuit: "Monza Circuit", country: "Italy", trackDetails: { length: "5.793 km", laps: 53, corners: 11, firstGP: 1950, record: "1:21.046" }, sessions: { fp1: "2026-09-04T17:00:00+05:30", fp2: "2026-09-04T20:30:00+05:30", fp3: "2026-09-05T16:00:00+05:30", quali: "2026-09-05T19:30:00+05:30", race: "2026-09-06T18:30:00+05:30" } },
  { round: 16, name: "Madrid Grand Prix", hasSprint: false, date: "2026-09-13T18:30:00+05:30", circuit: "IFEMA Madrid", country: "Spain", trackDetails: { length: "5.474 km", laps: 55, corners: 20, firstGP: 2026, record: "TBC" }, sessions: { fp1: "2026-09-11T17:00:00+05:30", fp2: "2026-09-11T20:30:00+05:30", fp3: "2026-09-12T16:00:00+05:30", quali: "2026-09-12T19:30:00+05:30", race: "2026-09-13T18:30:00+05:30" } },
  { round: 17, name: "Azerbaijan Grand Prix", hasSprint: false, date: "2026-09-26T16:30:00+05:30", circuit: "Baku City Circuit", country: "Azerbaijan", trackDetails: { length: "6.003 km", laps: 51, corners: 20, firstGP: 2016, record: "1:43.009" }, sessions: { fp1: "2026-09-24T15:00:00+05:30", fp2: "2026-09-24T18:30:00+05:30", fp3: "2026-09-25T14:30:00+05:30", quali: "2026-09-25T17:30:00+05:30", race: "2026-09-26T16:30:00+05:30" } },
  { round: 18, name: "Singapore Grand Prix", hasSprint: true, date: "2026-10-11T17:30:00+05:30", circuit: "Marina Bay Street Circuit", country: "Singapore", trackDetails: { length: "4.940 km", laps: 62, corners: 19, firstGP: 2008, record: "1:35.867" }, sessions: { fp1: "2026-10-09T15:00:00+05:30", sprintQuali: "2026-10-09T18:30:00+05:30", sprint: "2026-10-10T14:30:00+05:30", quali: "2026-10-10T18:30:00+05:30", race: "2026-10-11T17:30:00+05:30" } },
  { round: 19, name: "United States Grand Prix", hasSprint: false, date: "2026-10-26T00:30:00+05:30", circuit: "Circuit of the Americas", country: "USA", trackDetails: { length: "5.513 km", laps: 56, corners: 20, firstGP: 2012, record: "1:36.169" }, sessions: { fp1: "2026-10-23T23:00:00+05:30", fp2: "2026-10-24T02:30:00+05:30", fp3: "2026-10-24T23:30:00+05:30", quali: "2026-10-25T03:30:00+05:30", race: "2026-10-26T00:30:00+05:30" } },
  { round: 20, name: "Mexico City Grand Prix", hasSprint: false, date: "2026-11-02T02:30:00+05:30", circuit: "Autódromo Hermanos Rodríguez", country: "Mexico", trackDetails: { length: "4.304 km", laps: 71, corners: 17, firstGP: 1962, record: "1:17.774" }, sessions: { fp1: "2026-10-31T00:00:00+05:30", fp2: "2026-10-31T03:30:00+05:30", fp3: "2026-10-31T23:00:00+05:30", quali: "2026-11-01T03:30:00+05:30", race: "2026-11-02T02:30:00+05:30" } },
  { round: 21, name: "São Paulo Grand Prix", hasSprint: false, date: "2026-11-08T22:30:00+05:30", circuit: "Interlagos Circuit", country: "Brazil", trackDetails: { length: "4.309 km", laps: 71, corners: 15, firstGP: 1973, record: "1:10.540" }, sessions: { fp1: "2026-11-06T20:00:00+05:30", fp2: "2026-11-06T23:30:00+05:30", fp3: "2026-11-07T20:00:00+05:30", quali: "2026-11-07T23:30:00+05:30", race: "2026-11-08T22:30:00+05:30" } },
  { round: 22, name: "Las Vegas Grand Prix", hasSprint: false, date: "2026-11-22T11:30:00+05:30", circuit: "Las Vegas Strip Circuit", country: "USA", trackDetails: { length: "6.201 km", laps: 50, corners: 17, firstGP: 2023, record: "1:35.490" }, sessions: { fp1: "2026-11-20T08:00:00+05:30", fp2: "2026-11-20T11:30:00+05:30", fp3: "2026-11-21T08:00:00+05:30", quali: "2026-11-21T11:30:00+05:30", race: "2026-11-22T11:30:00+05:30" } },
  { round: 23, name: "Qatar Grand Prix", hasSprint: false, date: "2026-11-29T22:30:00+05:30", circuit: "Lusail International Circuit", country: "Qatar", trackDetails: { length: "5.419 km", laps: 57, corners: 16, firstGP: 2021, record: "1:24.319" }, sessions: { fp1: "2026-11-27T19:00:00+05:30", fp2: "2026-11-27T22:30:00+05:30", fp3: "2026-11-28T19:00:00+05:30", quali: "2026-11-28T22:30:00+05:30", race: "2026-11-29T22:30:00+05:30" } },
  { round: 24, name: "Abu Dhabi Grand Prix", hasSprint: false, date: "2026-12-06T18:30:00+05:30", circuit: "Yas Marina Circuit", country: "Abu Dhabi", trackDetails: { length: "5.281 km", laps: 58, corners: 16, firstGP: 2009, record: "1:26.103" }, sessions: { fp1: "2026-12-04T15:00:00+05:30", fp2: "2026-12-04T18:30:00+05:30", fp3: "2026-12-05T16:00:00+05:30", quali: "2026-12-05T19:30:00+05:30", race: "2026-12-06T18:30:00+05:30" } }
];

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
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access Denied: Missing Token" });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Access Denied: Invalid Token" });
    req.user = user;
    next();
  });
}

// --- 5. OAUTH ROUTES (GOOGLE ONLY) ---
app.get('/auth/google', (req, res) => {
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(APP_URL + '/auth/google/callback')}&response_type=code&scope=profile email&prompt=select_account`;
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    try {
        const { code } = req.query;
        const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            code, grant_type: 'authorization_code', redirect_uri: `${APP_URL}/auth/google/callback`
        });
        
        const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
        });
        
        const googleUser = userResponse.data;
        
        await db.execute({ sql: `INSERT INTO f1_drivers (name, auth_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET auth_id=excluded.auth_id`, args: [googleUser.name, `google_${googleUser.id}`] });
        
        const token = jwt.sign({ name: googleUser.name, id: `google_${googleUser.id}` }, JWT_SECRET, { expiresIn: '30d' });
        
        res.redirect(`/?token=${token}&name=${encodeURIComponent(googleUser.name)}`);
    } catch (error) { res.redirect('/?error=oauth_failed'); }
});

// --- 6. SCORING ENGINE (V4 NEW RULES) ---
async function sendDiscordNotification(msg) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url) return;
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🏎️ **F1 Steward:** ${msg}` }) }); } catch (e) {}
}

async function performFinalization() {
  try {
    // 1. Fetch Race Data — own API first, Ergast fallback
    let raceData = null;
    let results = null;
    let sprintResults = [];
    const gridMap = {};

    const _now = new Date();
    const latestCalRace = [...f1Calendar2026].reverse().find(r => new Date(r.sessions.race) < _now);
    if (latestCalRace) {
      try {
        const roundData = await axios.get(`${F1_TIMING_API}/results/round/${latestCalRace.round}`, { timeout: 15000 }).then(r => r.data);
        const raceSes = Array.isArray(roundData) ? roundData.find(s => s.meta?.session_type === 'Race') : null;
        if (raceSes?.results?.length) {
          const driverList = await axios.get(`${F1_TIMING_API}/drivers`, { timeout: 10000 }).then(r => r.data);
          const dMap = {};
          driverList.forEach(d => { dMap[String(d.driver_number)] = d; });
          const qualSes = roundData.find(s => s.meta?.session_type === 'Qualifying');
          if (qualSes?.results) qualSes.results.forEach(r => {
            const d = dMap[String(r.driver_number)];
            if (d) gridMap[normalizeStr(d.name)] = r.position;
          });

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
            sprintResults = sprintSes.results.map(r => {
              const d = dMap[String(r.driver_number)] || {};
              const parts = (d.name || '').split(' ');
              return {
                position: String(r.position), positionText: r.retired ? 'R' : String(r.position),
                grid: String(gridMap[normalizeStr(d.name || '')] || 0),
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
      try { races = await axios.get('https://api.jolpi.ca/ergast/f1/current/last/results.json', { timeout: 15000 }).then(r => r.data.MRData.RaceTable.Races); } catch(e) {}
      if (!races?.length) { try { races = await axios.get('https://api.jolpi.ca/ergast/f1/2026/last/results.json', { timeout: 15000 }).then(r => r.data.MRData.RaceTable.Races); } catch(e) {} }
      if (!races?.length) return { success: false, message: "No race data found." };
      raceData = races[0]; results = raceData.Results;
      try {
        const sprintRes = await axios.get('https://api.jolpi.ca/ergast/f1/current/last/sprint.json', { timeout: 15000 }).then(r => r.data);
        if (sprintRes.MRData.RaceTable.Races.length > 0) sprintResults = sprintRes.MRData.RaceTable.Races[0].SprintResults;
      } catch(e) {}
      try {
        let qr = null;
        try { qr = await axios.get('https://api.jolpi.ca/ergast/f1/current/last/qualifying.json', { timeout: 15000 }).then(r => r.data.MRData.RaceTable.Races); } catch(e) {}
        if (!qr?.length) { try { qr = await axios.get('https://api.jolpi.ca/ergast/f1/2026/last/qualifying.json', { timeout: 15000 }).then(r => r.data.MRData.RaceTable.Races); } catch(e) {} }
        if (qr?.length) qr[0].QualifyingResults.forEach(q => { gridMap[normalizeStr(`${q.Driver.givenName} ${q.Driver.familyName}`)] = parseInt(q.position); });
      } catch(e) {}
      console.log(`[FINALIZE] Ergast: ${raceData.raceName} (R${raceData.round}) — ${results.length} drivers`);
    }

    console.log(`[FINALIZE] Grid map: ${Object.keys(gridMap).length} drivers`);

    // 1b. Check if this round was already scored
    const roundCheck = `R${raceData.round}`;
    await db.execute("CREATE TABLE IF NOT EXISTS f1_round_history (id INTEGER PRIMARY KEY AUTOINCREMENT, round TEXT, race_name TEXT, user_name TEXT, prediction TEXT, score INTEGER, scored_at TEXT)");
    const alreadyScored = await db.execute({ sql: "SELECT count(*) as count FROM f1_round_history WHERE round = ?", args: [roundCheck] });
    if (alreadyScored.rows[0].count > 0) {
        console.log(`[FINALIZE] Round ${roundCheck} already scored — skipping`);
        return { success: false, message: "Already scored." };
    }

    const check = await db.execute("SELECT count(*) as count FROM f1_predictions_v4");
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
    const predictions = await db.execute("SELECT * FROM f1_predictions_v4").then(r => r.rows);
    let scores = {}; let lowest = Infinity;

    predictions.forEach(p => {
        let score = 0;

        const driversToScore = [
            { pred: p.p1, rank: 1 }, { pred: p.p2, rank: 2 }, { pred: p.p3, rank: 3 },
            { pred: p.p10, rank: 10 }, { pred: p.p11, rank: 11 },
            { pred: p.p21, rank: 21 }, { pred: p.p22, rank: 22 }
        ];
        
        driversToScore.forEach(item => {
            if (!item.pred) return;
            let act = actualDriverPositions[normalizeStr(item.pred)];
            if (!act) act = 22; // Replacement defaults
            
            const diff = Math.abs(item.rank - act);
            if (diff === 0) score += 2;
            else score -= diff;
        });

        const teamsToScore = [
            { pred: p.c1, rank: 1 }, { pred: p.c2, rank: 2 },
            { pred: p.c5, rank: 5 }, { pred: p.c6, rank: 6 }, { pred: p.c11, rank: 11 }
        ];
        
        teamsToScore.forEach(item => {
            if (!item.pred) return;
            const range = actualCRanges[normalizeConstructor(item.pred)];
            if (!range) return;
            
            let diff = 0;
            if (item.rank >= range.min && item.rank <= range.max) diff = 0;
            else if (item.rank < range.min) diff = range.min - item.rank;
            else diff = item.rank - range.max;
            
            if (diff === 0) score += 2;
            else score -= diff;
        });

        if (p.w_race_loser && raceLosers.includes(normalizeStr(p.w_race_loser))) score += 5;
        if (p.w_sprint_gainer && sprintGainers.includes(normalizeStr(p.w_sprint_gainer))) score += 5;
        if (p.w_sprint_loser && sprintLosers.includes(normalizeStr(p.w_sprint_loser))) score += 5;

        scores[p.user_name] = score;
        if (score < lowest) lowest = score;
    });

    // Apply "Lowest - 5" Penalty
    const penalty = (lowest === Infinity ? 0 : lowest) - 5;
    const activeDrivers = await db.execute("SELECT * FROM f1_drivers WHERE has_participated = 1").then(r => r.rows);

    const finalScores = {};
    for (const d of activeDrivers) {
        let fs = scores[d.name] !== undefined ? scores[d.name] : penalty;
        finalScores[d.name] = { score: fs, hadPrediction: scores[d.name] !== undefined };
        if (d.name !== 'admin') {
            await db.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?", args: [fs, d.name] });
        }
    }

    // --- SAVE ROUND HISTORY ---
    await db.execute("CREATE TABLE IF NOT EXISTS f1_round_history (id INTEGER PRIMARY KEY AUTOINCREMENT, round TEXT, race_name TEXT, user_name TEXT, prediction TEXT, score INTEGER, scored_at TEXT)");
    const roundLabel = `R${raceData.round}`;
    for (const p of predictions) {
        const predSnapshot = JSON.stringify({ p1: p.p1, p2: p.p2, p3: p.p3, p10: p.p10, p11: p.p11, p21: p.p21, p22: p.p22, c1: p.c1, c2: p.c2, c5: p.c5, c6: p.c6, c11: p.c11, w_race_loser: p.w_race_loser, w_sprint_gainer: p.w_sprint_gainer, w_sprint_loser: p.w_sprint_loser });
        await db.execute({ sql: "INSERT INTO f1_round_history (round, race_name, user_name, prediction, score, scored_at) VALUES (?, ?, ?, ?, ?, ?)", args: [roundLabel, raceData.raceName, p.user_name, predSnapshot, scores[p.user_name] ?? 0, new Date().toISOString()] });
    }
    // Save penalty entries for non-submitters
    for (const [name, data] of Object.entries(finalScores)) {
        if (!data.hadPrediction && name !== 'admin') {
            await db.execute({ sql: "INSERT INTO f1_round_history (round, race_name, user_name, prediction, score, scored_at) VALUES (?, ?, ?, ?, ?, ?)", args: [roundLabel, raceData.raceName, name, '{"penalty":"no submission"}', data.score, new Date().toISOString()] });
        }
    }
    console.log(`[FINALIZE] Round history saved for ${roundLabel}`);

    await db.execute("DELETE FROM f1_predictions_v4");

    // --- DISCORD SCORE BREAKDOWN ---
    const sorted = Object.entries(finalScores).filter(([n]) => n !== 'admin').sort((a, b) => b[1].score - a[1].score);
    let breakdown = `**${raceData.raceName} (${roundLabel}) — Score Breakdown**\n`;
    breakdown += `Race Loser: ${raceLosers.join(', ') || 'N/A'}\n`;
    if (sprintResults.length > 0) breakdown += `Sprint Gainer: ${sprintGainers.join(', ') || 'N/A'} | Sprint Loser: ${sprintLosers.join(', ') || 'N/A'}\n`;
    breakdown += `No-submission penalty: ${penalty}\n\n`;
    sorted.forEach(([name, data], i) => {
        const tag = data.hadPrediction ? '' : ' (no sub)';
        breakdown += `${i + 1}. ${name}: **${data.score >= 0 ? '+' : ''}${data.score}**${tag}\n`;
    });
    await sendDiscordNotification(breakdown);

    return { success: true, message: "Round Finalized." };
  } catch (e) { return { success: false, message: e.message }; }
}

// --- 7. SECURE CORE ROUTES ---
app.get('/api/next-race', (req, res) => {
  const now = new Date();
  const next = f1Calendar2026.find(r => {
      const raceEndBuffer = new Date(r.sessions.race);
      raceEndBuffer.setHours(raceEndBuffer.getHours() + 4);
      return raceEndBuffer > now;
  }) || f1Calendar2026[f1Calendar2026.length-1];
  
  const payload = { ...next, lockTime: next.sessions.quali };
  res.json(payload);
});

app.get('/api/calendar', (req, res) => { res.json(f1Calendar2026); });

// --- F1 Live Timing Widget Proxy (backed by direct F1 SignalR WebSocket feed) ---
const F1_TIMING_API = process.env.F1_TIMING_API || 'https://f1-live-api.onrender.com';
let widgetCache = null;
let widgetCacheTime = 0;
app.get('/api/live-widget', async (_req, res) => {
    if (widgetCache && Date.now() - widgetCacheTime < 10000) return res.json(widgetCache);
    try {
        const get = (path) => axios.get(`${F1_TIMING_API}${path}`, { timeout: 10000 }).then(r => r.data).catch(() => null);
        const [timing, status] = await Promise.all([get('/timing'), get('/status')]);
        if (!timing?.drivers?.length) return res.status(503).json({ error: 'No live timing data' });
        widgetCache = { timing, status };
        widgetCacheTime = Date.now();
        res.json(widgetCache);
    } catch(e) { res.status(500).json({ error: e.message }); }
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

// --- RACE PREDICTION SUBMIT ---
app.post('/predict', authenticateToken, async (req, res) => {
  const d = req.body;
  const userName = req.user.name;

  const now = new Date();
  const currentRace = f1Calendar2026.find(r => {
      const raceEndBuffer = new Date(r.sessions.race);
      raceEndBuffer.setHours(raceEndBuffer.getHours() + 4);
      return raceEndBuffer > now;
  }); 
  if (!currentRace) return res.status(403).json({ success: false, message: "Season Over" });

  const lockTime = new Date(currentRace.sessions.quali);
  if (now > lockTime) {
      return res.status(403).json({ success: false, message: "Parc Fermé: Predictions are officially locked for this session!" });
  }
  
  if (!d.p1 || !d.p10 || !d.c11 || !d.w_race_loser) {
      return res.status(400).json({ success: false, message: "Invalid: Incomplete predictions." });
  }

  try {
      await db.execute({
          sql: `INSERT INTO f1_predictions_v4 (user_name, p1, p2, p3, p10, p11, p21, p22, c1, c2, c5, c6, c11, w_race_loser, w_sprint_gainer, w_sprint_loser) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                ON CONFLICT(user_name) DO UPDATE SET 
                p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p10=excluded.p10, p11=excluded.p11, p21=excluded.p21, p22=excluded.p22, 
                c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c11=excluded.c11, 
                w_race_loser=excluded.w_race_loser, w_sprint_gainer=excluded.w_sprint_gainer, w_sprint_loser=excluded.w_sprint_loser`,
          args: [userName, d.p1, d.p2, d.p3, d.p10, d.p11, d.p21, d.p22, d.c1, d.c2, d.c5, d.c6, d.c11, d.w_race_loser, d.w_sprint_gainer, d.w_sprint_loser]
      });
      
      await db.execute({ sql: `UPDATE f1_drivers SET has_participated = 1 WHERE name = ?`, args: [userName] });
      res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/finalize', authenticateToken, async (req, res) => {
  if (!req.user.name.toLowerCase().includes('harsh')) return res.status(403).json({ success: false });
  const result = await performFinalization();
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/api/predictions', async (req, res) => {
  const r = await db.execute("SELECT p.*, d.total_score FROM f1_predictions_v4 p JOIN f1_drivers d ON p.user_name = d.name");
  res.json(r.rows);
});

app.get('/api/season-leaderboard', async (req, res) => {
  const r = await db.execute("SELECT name, total_score, is_vip, season_driver, season_constructor FROM f1_drivers WHERE name != 'admin' AND has_participated = 1 ORDER BY total_score DESC");
  res.json(r.rows);
});

// --- 8. ADMIN ROUTES ---
app.get('/api/admin/users', authenticateToken, async (req, res) => {
  if (!req.user.name.toLowerCase().includes('harsh')) return res.status(403).send("Unauthorized");
  try {
      const r = await db.execute("SELECT id, name, total_score, has_participated, is_vip FROM f1_drivers WHERE name != 'admin' AND has_participated = 1 ORDER BY name ASC");
      res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/toggle-vip', authenticateToken, async (req, res) => {
  if (!req.user.name.toLowerCase().includes('harsh')) return res.status(403).send("Unauthorized");
  try {
      await db.execute({ sql: "UPDATE f1_drivers SET is_vip = ? WHERE name = ?", args: [req.body.vipStatus ? 1 : 0, req.body.targetUser] });
      res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/reset-user', authenticateToken, async (req, res) => {
  if (!req.user.name.toLowerCase().includes('harsh')) return res.status(403).send("Unauthorized");
  try {
      await db.execute({ sql: "UPDATE f1_drivers SET total_score = 0, has_participated = 0 WHERE name = ?", args: [req.body.targetUser] });
      res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/round-history', authenticateToken, async (req, res) => {
  if (!req.user.name.toLowerCase().includes('harsh')) return res.status(403).send("Unauthorized");
  try {
      const rows = await db.execute("SELECT * FROM f1_round_history ORDER BY id DESC").then(r => r.rows);
      res.json(rows);
  } catch (e) { res.json([]); }
});

// --- 8b. LIVE API PROXY ROUTES ---
const liveProxy = async (apiPath, res) => {
    try {
        const r = await axios.get(`${F1_TIMING_API}${apiPath}`, { timeout: 10000 });
        res.json(r.data);
    } catch (e) {
        res.status(502).json({ error: 'API unavailable', detail: e.message });
    }
};

app.get('/api/live/timing', (_, res) => liveProxy('/timing', res));
app.get('/api/live/weather', (_, res) => liveProxy('/weather', res));
app.get('/api/live/track', (_, res) => liveProxy('/track', res));
app.get('/api/live/race-control', (_, res) => liveProxy('/race-control', res));
app.get('/api/live/pits', (_, res) => liveProxy('/pits', res));
app.get('/api/live/team-radio', (_, res) => liveProxy('/team-radio', res));
app.get('/api/live/telemetry', (_, res) => liveProxy('/telemetry', res));
app.get('/api/live/telemetry/:number', (req, res) => liveProxy(`/telemetry/${req.params.number}`, res));
app.get('/api/standings/drivers', (_, res) => liveProxy('/standings/drivers', res));
app.get('/api/standings/constructors', (_, res) => liveProxy('/standings/constructors', res));
app.get('/api/live/status', (_, res) => liveProxy('/status', res));

// SSE proxy: pipes live timing stream from own API to client
app.get('/api/live/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    const topic = req.query.topic || '';
    const url = topic ? `${F1_TIMING_API}/stream?topic=${encodeURIComponent(topic)}` : `${F1_TIMING_API}/stream/timing`;
    axios.get(url, { responseType: 'stream', timeout: 0, headers: { 'Accept': 'text/event-stream' } })
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
    axios.get(`${F1_TIMING_API}/telemetry/stream/${req.params.number}`, { responseType: 'stream', timeout: 0, headers: { 'Accept': 'text/event-stream' } })
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
    fetch(`${APP_URL}/api/next-race`).catch(() => {});
    fetch(`${F1_TIMING_API}/status`).catch(() => {});

    if (finalizationPending) return;

    try {
        const status = await axios.get(`${F1_TIMING_API}/status`, { timeout: 8000 }).then(r => r.data);
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

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`🏁 Server 3000 (Google OAuth Secure)`));