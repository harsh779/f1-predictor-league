const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'f1_super_secret_key_2026'; // Match this in Render Env

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
    // Removed UNIQUE from auth_id to prevent SQLite crash on existing tables
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, auth_id TEXT, total_score INTEGER DEFAULT 0, has_participated INTEGER DEFAULT 0, is_vip INTEGER DEFAULT 0)`);
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN auth_id TEXT`); } catch(e) {}
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN has_participated INTEGER DEFAULT 0`); } catch(e) {}
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN is_vip INTEGER DEFAULT 0`); } catch(e) {}
    
    // P21 and P22 for the 22-car grid
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_predictions_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT UNIQUE, 
        p1 TEXT, p2 TEXT, p3 TEXT, p11 TEXT, p12 TEXT, p21 TEXT, p22 TEXT, 
        c1 TEXT, c2 TEXT, c5 TEXT, c6 TEXT, c10 TEXT, 
        w_race_loser TEXT, w_sprint_gainer TEXT, w_sprint_loser TEXT
    )`);
    
    await db.execute({ sql: "INSERT INTO f1_drivers (name, auth_id, is_vip) VALUES ('admin', 'admin_override', 1) ON CONFLICT(name) DO NOTHING" });
    console.log("✅ Database Synced for Google OAuth & 22-Car Grid.");
  } catch (e) { console.error("DB Error:", e); }
}
setupDatabase();

// --- 2. FULL 2026 CALENDAR ---
const f1Calendar2026 = [
  { round: 1, name: "Australian Grand Prix", hasSprint: false, date: "2026-03-06T07:00:00+05:30", circuit: "Albert Park Circuit", country: "Australia", trackDetails: { length: "5.278 km", laps: 58, corners: 14, firstGP: 1996, record: "1:19.813" }, sessions: { fp1: "2026-03-06T07:00:00+05:30", fp2: "2026-03-06T10:30:00+05:30", fp3: "2026-03-07T07:00:00+05:30", quali: "2026-03-07T10:30:00+05:30", race: "2026-03-08T09:30:00+05:30" } },
  { round: 2, name: "Chinese Grand Prix", hasSprint: true, date: "2026-03-13T09:00:00+05:30", circuit: "Shanghai International Circuit", country: "China", trackDetails: { length: "5.451 km", laps: 56, corners: 16, firstGP: 2004, record: "1:32.238" }, sessions: { fp1: "2026-03-13T09:00:00+05:30", sprintQuali: "2026-03-13T13:00:00+05:30", sprint: "2026-03-14T09:00:00+05:30", quali: "2026-03-14T13:00:00+05:30", race: "2026-03-15T12:30:00+05:30" } },
  { round: 3, name: "Japanese Grand Prix", hasSprint: false, date: "2026-03-27T08:00:00+05:30", circuit: "Suzuka International Racing Course", country: "Japan", trackDetails: { length: "5.807 km", laps: 53, corners: 18, firstGP: 1987, record: "1:30.983" }, sessions: { fp1: "2026-03-27T08:00:00+05:30", fp2: "2026-03-27T11:30:00+05:30", fp3: "2026-03-28T08:00:00+05:30", quali: "2026-03-28T11:30:00+05:30", race: "2026-03-29T10:30:00+05:30" } },
  { round: 4, name: "Bahrain Grand Prix", hasSprint: false, date: "2026-04-10T17:00:00+05:30", circuit: "Bahrain International Circuit", country: "Bahrain", trackDetails: { length: "5.412 km", laps: 57, corners: 15, firstGP: 2004, record: "1:31.447" }, sessions: { fp1: "2026-04-10T17:00:00+05:30", fp2: "2026-04-10T20:30:00+05:30", fp3: "2026-04-11T17:30:00+05:30", quali: "2026-04-11T21:30:00+05:30", race: "2026-04-12T20:30:00+05:30" } },
  { round: 5, name: "Saudi Arabian Grand Prix", hasSprint: false, date: "2026-04-17T19:00:00+05:30", circuit: "Jeddah Corniche Circuit", country: "Saudi Arabia", trackDetails: { length: "6.174 km", laps: 50, corners: 27, firstGP: 2021, record: "1:30.734" }, sessions: { fp1: "2026-04-17T19:00:00+05:30", fp2: "2026-04-17T22:30:00+05:30", fp3: "2026-04-18T19:00:00+05:30", quali: "2026-04-18T22:30:00+05:30", race: "2026-04-19T22:30:00+05:30" } },
  { round: 6, name: "Miami Grand Prix", hasSprint: true, date: "2026-05-01T22:00:00+05:30", circuit: "Miami International Autodrome", country: "United States", trackDetails: { length: "5.412 km", laps: 57, corners: 19, firstGP: 2022, record: "1:29.708" }, sessions: { fp1: "2026-05-01T22:00:00+05:30", sprintQuali: "2026-05-02T02:00:00+05:30", sprint: "2026-05-02T21:30:00+05:30", quali: "2026-05-03T01:30:00+05:30", race: "2026-05-04T01:30:00+05:30" } },
  { round: 7, name: "Canadian Grand Prix", hasSprint: true, date: "2026-05-22T23:00:00+05:30", circuit: "Circuit Gilles-Villeneuve", country: "Canada", trackDetails: { length: "4.361 km", laps: 70, corners: 14, firstGP: 1978, record: "1:13.078" }, sessions: { fp1: "2026-05-22T23:00:00+05:30", sprintQuali: "2026-05-23T03:00:00+05:30", sprint: "2026-05-23T21:30:00+05:30", quali: "2026-05-24T01:30:00+05:30", race: "2026-05-24T23:30:00+05:30" } }
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
    // 🔴 FIX: prompt=select_account is now properly attached to the end of the URL
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


// --- 6. SCORING ENGINE ---
async function sendDiscordNotification(msg) {
  const url = "https://discord.com/api/webhooks/1476880265409335306/3N7tM1n8LUYucuCYCEWF3UzfDt9adgtzGKdqV433CG95J57SOwcyXOzSEbOgAiYK3MK3";
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🏎️ **F1 Steward:** ${msg}` }) }); } catch (e) {}
}

async function performFinalization() {
  try {
    const raceRes = await fetch('https://api.jolpi.ca/ergast/f1/current/last/results.json').then(r => r.json());
    const races = raceRes.MRData.RaceTable.Races;
    if (!races || races.length === 0) return { success: false, message: "No data from F1 API." };
    
    const raceData = races[0];
    const results = raceData.Results;
    const check = await db.execute("SELECT count(*) as count FROM f1_predictions_v3");
    if (check.rows[0].count === 0) return { success: false, message: "No predictions found." };

    const actualDriverPositions = {};
    results.forEach(r => {
        const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
        let pos = parseInt(r.position);
        if (r.positionText === 'R' || r.positionText === 'D' || r.status.startsWith('Retired') || r.status.startsWith('Collision') || r.status.startsWith('Accident')) { pos = 22; }
        actualDriverPositions[name] = pos;
    });

    const constructorSums = {};
    results.forEach(r => {
      const c = normalizeConstructor(r.Constructor.name);
      let pos = parseInt(r.position);
       if (r.positionText === 'R' || r.positionText === 'D') pos = 22; 
      constructorSums[c] = (constructorSums[c] || 0) + pos;
    });

    const sortedC = Object.keys(constructorSums).sort((a, b) => constructorSums[a] - constructorSums[b]);
    const actualCRanks = {};
    for (let i = 0; i < sortedC.length; i++) {
        actualCRanks[sortedC[i]] = (i > 0 && constructorSums[sortedC[i]] === constructorSums[sortedC[i-1]]) ? actualCRanks[sortedC[i-1]] : i + 1;
    }

    let raceLosers = []; let maxDrop = -999;
    results.forEach(r => {
       if (parseInt(r.grid) > 0) {
           let finish = parseInt(r.position);
           if (r.positionText === 'R' || r.positionText === 'D') finish = 22;
           const drop = finish - parseInt(r.grid);
           const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
           if (drop > maxDrop) { maxDrop = drop; raceLosers = [name]; }
           else if (drop === maxDrop) raceLosers.push(name);
       }
    });

    const predictions = await db.execute("SELECT * FROM f1_predictions_v3").then(r => r.rows);
    let scores = {}; let lowest = Infinity;

    predictions.forEach(p => {
        let score = 0;
        const calc = (pred, actual) => {
            if (!actual) return 0;
            const diff = Math.abs(pred - actual);
            if (diff === 0) return 2;
            return -diff;
        };

        const driversToScore = [
            { pred: p.p1, rank: 1 }, { pred: p.p2, rank: 2 }, { pred: p.p3, rank: 3 },
            { pred: p.p11, rank: 11 }, { pred: p.p12, rank: 12 },
            { pred: p.p21, rank: 21 }, { pred: p.p22, rank: 22 }
        ];
        
        driversToScore.forEach(item => {
            const act = actualDriverPositions[normalizeStr(item.pred)];
            if (act) score += calc(item.rank, act);
        });

        const teamsToScore = [
            { pred: p.c1, rank: 1 }, { pred: p.c2, rank: 2 },
            { pred: p.c5, rank: 5 }, { pred: p.c6, rank: 6 }, { pred: p.c10, rank: 10 }
        ];
        
        teamsToScore.forEach(item => {
            const act = actualCRanks[normalizeConstructor(item.pred)];
            if (act) score += calc(item.rank, act);
        });

        if (p.w_race_loser && raceLosers.includes(normalizeStr(p.w_race_loser))) score += 5;

        scores[p.user_name] = score;
        if (score < lowest) lowest = score;
    });

    const penalty = (lowest === Infinity ? 0 : lowest) - 5;
    
    const activeDrivers = await db.execute("SELECT * FROM f1_drivers WHERE has_participated = 1").then(r => r.rows);
    
    for (const d of activeDrivers) {
        let fs = scores[d.name] !== undefined ? scores[d.name] : penalty;
        if (d.name !== 'admin') {
            await db.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?", args: [fs, d.name] });
        }
    }

    await db.execute("DELETE FROM f1_predictions_v3");
    await sendDiscordNotification(`🏁 **${raceData.raceName} Finalized!** Points have been officially updated on the Standings board.`);
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

  try {
      await db.execute({
          sql: `INSERT INTO f1_predictions_v3 (user_name, p1, p2, p3, p11, p12, p21, p22, c1, c2, c5, c6, c10, w_race_loser, w_sprint_gainer, w_sprint_loser) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                ON CONFLICT(user_name) DO UPDATE SET 
                p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p11=excluded.p11, p12=excluded.p12, p21=excluded.p21, p22=excluded.p22, 
                c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c10=excluded.c10, 
                w_race_loser=excluded.w_race_loser, w_sprint_gainer=excluded.w_sprint_gainer, w_sprint_loser=excluded.w_sprint_loser`,
          args: [userName, d.p1, d.p2, d.p3, d.p11, d.p12, d.p21, d.p22, d.c1, d.c2, d.c5, d.c6, d.c10, d.w_race_loser, d.w_sprint_gainer, d.w_sprint_loser]
      });
      
      await db.execute({ sql: `UPDATE f1_drivers SET has_participated = 1 WHERE name = ?`, args: [userName] });
      res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/finalize', async (req, res) => {
  if (req.body.password !== 'Open@0761') return res.status(403).json({ success: false });
  const result = await performFinalization();
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/api/predictions', async (req, res) => {
  const r = await db.execute("SELECT p.*, d.total_score FROM f1_predictions_v3 p JOIN f1_drivers d ON p.user_name = d.name");
  res.json(r.rows);
});

app.get('/api/season-leaderboard', async (req, res) => {
  // Added "AND has_participated = 1" to hide users who haven't submitted their first prediction yet
  const r = await db.execute("SELECT name, total_score, is_vip FROM f1_drivers WHERE name != 'admin' AND has_participated = 1 ORDER BY total_score DESC");
  res.json(r.rows);
});

// --- 8. ADMIN ROUTES ---
// --- 8. ADMIN ROUTES ---
app.get('/api/admin/users', async (req, res) => {
  if (req.query.pass !== 'Open@0761') return res.status(403).send("Unauthorized");
  try {
      // Added AND has_participated = 1
      const r = await db.execute("SELECT id, name, total_score, has_participated, is_vip FROM f1_drivers WHERE name != 'admin' AND has_participated = 1 ORDER BY name ASC");
      res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/toggle-vip', async (req, res) => {
  if (req.body.adminPass !== 'Open@0761') return res.status(403).send("Unauthorized");
  try {
      await db.execute({ sql: "UPDATE f1_drivers SET is_vip = ? WHERE name = ?", args: [req.body.vipStatus ? 1 : 0, req.body.targetUser] });
      res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/reset-user', async (req, res) => {
  if (req.body.adminPass !== 'Open@0761') return res.status(403).send("Unauthorized");
  try {
      await db.execute({ sql: "UPDATE f1_drivers SET total_score = 0, has_participated = 0 WHERE name = ?", args: [req.body.targetUser] });
      res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 9. AUTOMATED CRON JOB ---
setInterval(async () => {
  const now = new Date();
  const active = f1Calendar2026.find(r => { 
      const raceTime = new Date(r.sessions.race); 
      return now > raceTime && now - raceTime < (24 * 60 * 60 * 1000); 
  });
  if (active) await performFinalization();
  fetch(`${APP_URL}/api/next-race`).catch(() => {});
}, 15 * 60 * 1000);

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`🏁 Server 3000 (Google OAuth Secure)`));