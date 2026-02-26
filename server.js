const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); 

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// --- 1. DATABASE SETUP ---
async function setupDatabase() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, password TEXT, total_score INTEGER DEFAULT 0)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_predictions_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_name TEXT UNIQUE, 
        p1 TEXT, p2 TEXT, p3 TEXT, 
        p11 TEXT, p12 TEXT, 
        p19 TEXT, p20 TEXT, 
        c1 TEXT, c2 TEXT, c5 TEXT, c6 TEXT, c10 TEXT, 
        w_race_loser TEXT, 
        w_sprint_gainer TEXT, w_sprint_loser TEXT
    )`);
    try {
        await db.execute({ sql: "INSERT INTO f1_drivers (name, password) VALUES ('admin', 'Open@0761') ON CONFLICT(name) DO NOTHING" });
        console.log("✅ Admin Ready.");
    } catch (e) {}
    console.log("✅ Database Synced.");
  } catch (e) { console.error("DB Error:", e); }
}
setupDatabase();

// --- 2. 2026 CALENDAR (IST DEADLINES) ---
const f1Calendar2026 = [
  { round: 1, name: "Australian Grand Prix", hasSprint: false, date: "2026-03-06T07:00:00+05:30" },
  { round: 2, name: "Chinese Grand Prix", hasSprint: true, date: "2026-03-13T09:00:00+05:30" },
  { round: 3, name: "Japanese Grand Prix", hasSprint: false, date: "2026-03-27T08:00:00+05:30" },
  { round: 4, name: "Bahrain Grand Prix", hasSprint: false, date: "2026-04-10T17:00:00+05:30" },
  { round: 5, name: "Saudi Arabian Grand Prix", hasSprint: false, date: "2026-04-17T19:00:00+05:30" },
  { round: 6, name: "Miami Grand Prix", hasSprint: true, date: "2026-05-01T22:00:00+05:30" },
  { round: 7, name: "Canadian Grand Prix", hasSprint: true, date: "2026-05-22T23:00:00+05:30" },
  { round: 8, name: "Monaco Grand Prix", hasSprint: false, date: "2026-06-05T17:00:00+05:30" },
  { round: 9, name: "Spanish Grand Prix", hasSprint: false, date: "2026-06-12T17:00:00+05:30" },
  { round: 10, name: "Austrian Grand Prix", hasSprint: false, date: "2026-06-26T16:00:00+05:30" },
  { round: 11, name: "British Grand Prix", hasSprint: true, date: "2026-07-03T17:00:00+05:30" },
  { round: 12, name: "Belgian Grand Prix", hasSprint: false, date: "2026-07-17T17:00:00+05:30" },
  { round: 13, name: "Hungarian Grand Prix", hasSprint: false, date: "2026-07-24T17:00:00+05:30" },
  { round: 14, name: "Dutch Grand Prix", hasSprint: true, date: "2026-08-21T16:00:00+05:30" },
  { round: 15, name: "Italian Grand Prix", hasSprint: false, date: "2026-09-04T17:00:00+05:30" },
  { round: 16, name: "Madrid Grand Prix", hasSprint: false, date: "2026-09-11T17:00:00+05:30" },
  { round: 17, name: "Azerbaijan Grand Prix", hasSprint: false, date: "2026-09-25T15:00:00+05:30" },
  { round: 18, name: "Singapore Grand Prix", hasSprint: true, date: "2026-10-09T15:00:00+05:30" },
  { round: 19, name: "United States Grand Prix", hasSprint: false, date: "2026-10-23T23:00:00+05:30" },
  { round: 20, name: "Mexico City Grand Prix", hasSprint: false, date: "2026-10-31T00:30:00+05:30" },
  { round: 21, name: "São Paulo Grand Prix", hasSprint: false, date: "2026-11-06T20:00:00+05:30" },
  { round: 22, name: "Las Vegas Grand Prix", hasSprint: false, date: "2026-11-20T08:00:00+05:30" },
  { round: 23, name: "Qatar Grand Prix", hasSprint: false, date: "2026-11-27T19:00:00+05:30" },
  { round: 24, name: "Abu Dhabi Grand Prix", hasSprint: false, date: "2026-12-04T15:00:00+05:30" }
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
    return l;
}

async function sendDiscordNotification(msg) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return;
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🏎️ **F1 Steward:** ${msg}` }) });
    } catch (e) { console.error("Discord Error:", e); }
}

// --- 4. SCORING ENGINE (UPDATED TO MATCH IMAGE) ---
async function performFinalization() {
  try {
    const raceRes = await fetch('https://api.jolpi.ca/ergast/f1/current/last/results.json').then(r => r.json());
    const races = raceRes.MRData.RaceTable.Races;
    if (!races || races.length === 0) return { success: false, message: "No data." };
    
    const raceData = races[0];
    const results = raceData.Results;
    const check = await db.execute("SELECT count(*) as count FROM f1_predictions_v2");
    if (check.rows[0].count === 0) return { success: false, message: "No predictions." };

    // 1. Parse Driver Results (DNF = 20)
    const actualDriverPositions = {};
    results.forEach(r => {
        const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
        let pos = parseInt(r.position);
        
        // DNF LOGIC: If status is not "Finished" or "+1 Lap" etc, treat as DNF -> 20
        // The API returns 'R' in positionText for retirements often, but 'position' might be the classified rank.
        // To strictly follow "DNF -> 20":
        if (r.positionText === 'R' || r.positionText === 'D' || r.status.startsWith('Retired') || r.status.startsWith('Collision') || r.status.startsWith('Accident')) {
            pos = 20; 
        }
        
        actualDriverPositions[name] = pos;
    });

    // 2. Parse Constructor Results
    const constructorSums = {};
    results.forEach(r => {
      const c = normalizeConstructor(r.Constructor.name);
      // For constructors, we use the official classified position.
      // If a driver DNF'd, we still use their classified rank for team summation if available, 
      // otherwise, we use 20 for the calculation to punish DNF teams.
      let pos = parseInt(r.position);
       if (r.positionText === 'R' || r.positionText === 'D') pos = 20; 
      constructorSums[c] = (constructorSums[c] || 0) + pos;
    });

    const sortedC = Object.keys(constructorSums).sort((a, b) => constructorSums[a] - constructorSums[b]);
    const actualCRanks = {};
    for (let i = 0; i < sortedC.length; i++) {
        // Handle ties: if sums are equal, give same rank
        actualCRanks[sortedC[i]] = (i > 0 && constructorSums[sortedC[i]] === constructorSums[sortedC[i-1]]) ? actualCRanks[sortedC[i-1]] : i + 1;
    }

    // 3. Parse Biggest Loser
    let raceLosers = []; let maxDrop = -999;
    results.forEach(r => {
       if (parseInt(r.grid) > 0) {
           // For biggest loser, we use actual finishing position vs grid.
           // If DNF, we treat finish as 20.
           let finish = parseInt(r.position);
           if (r.positionText === 'R' || r.positionText === 'D') finish = 20;
           
           const drop = finish - parseInt(r.grid);
           const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
           if (drop > maxDrop) { maxDrop = drop; raceLosers = [name]; }
           else if (drop === maxDrop) raceLosers.push(name);
       }
    });

    // 4. Calculate Scores
    const predictions = await db.execute("SELECT * FROM f1_predictions_v2").then(r => r.rows);
    let scores = {}; let lowest = Infinity;

    predictions.forEach(p => {
        let score = 0;
        
        // Helper: Diff Logic (+2 if 0, else -Diff)
        const calc = (pred, actual) => {
            if (!actual) return 0; // Should not happen if data is complete
            const diff = Math.abs(pred - actual);
            if (diff === 0) return 2;
            return -diff;
        };

        // Drivers
        const driversToScore = [
            { pred: p.p1, rank: 1 }, { pred: p.p2, rank: 2 }, { pred: p.p3, rank: 3 },
            { pred: p.p11, rank: 11 }, { pred: p.p12, rank: 12 },
            { pred: p.p19, rank: 19 }, { pred: p.p20, rank: 20 }
        ];
        
        driversToScore.forEach(item => {
            const act = actualDriverPositions[normalizeStr(item.pred)];
            if (act) score += calc(item.rank, act);
        });

        // Constructors
        const teamsToScore = [
            { pred: p.c1, rank: 1 }, { pred: p.c2, rank: 2 },
            { pred: p.c5, rank: 5 }, { pred: p.c6, rank: 6 }, { pred: p.c10, rank: 10 }
        ];
        
        teamsToScore.forEach(item => {
            const act = actualCRanks[normalizeConstructor(item.pred)];
            if (act) score += calc(item.rank, act);
        });

        // Wildcard
        if (p.w_race_loser && raceLosers.includes(normalizeStr(p.w_race_loser))) score += 5;

        scores[p.user_name] = score;
        if (score < lowest) lowest = score;
    });

    // 5. Update Leaderboard
    const penalty = (lowest === Infinity ? 0 : lowest) - 5;
    const allDrivers = await db.execute("SELECT * FROM f1_drivers").then(r => r.rows);
    
    for (const d of allDrivers) {
        let fs = scores[d.name] !== undefined ? scores[d.name] : penalty;
        // Don't update admin score
        if (d.name !== 'admin') {
            await db.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?", args: [fs, d.name] });
        }
    }

    await db.execute("DELETE FROM f1_predictions_v2");
    await sendDiscordNotification(`🏁 **${raceData.raceName}** Finalized! Standings Updated.`);
    return { success: true, message: "Round Finalized." };
  } catch (e) { return { success: false, message: e.message }; }
}

// --- 5. ROUTES ---
app.get('/api/next-race', (req, res) => {
    const now = new Date();
    const next = f1Calendar2026.find(r => new Date(r.date) > now) || f1Calendar2026[f1Calendar2026.length-1];
    res.json(next);
});

app.get('/api/calendar', (req, res) => {
    res.json(f1Calendar2026);
});

app.post('/predict', async (req, res) => {
    const d = req.body;
    const auth = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [d.user_name, d.password] });
    if (auth.rows.length === 0) return res.status(401).json({ success: false, message: "Login failed" });

    // LOCK CHECK (IST)
    const now = new Date();
    const next = f1Calendar2026.find(r => new Date(r.date) > now); 
    if (!next) return res.status(403).json({ success: false, message: "Season Over" });

    try {
        await db.execute({
            sql: `INSERT INTO f1_predictions_v2 (user_name, p1, p2, p3, p11, p12, p19, p20, c1, c2, c5, c6, c10, w_race_loser, w_sprint_gainer, w_sprint_loser) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                  ON CONFLICT(user_name) DO UPDATE SET 
                  p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p11=excluded.p11, p12=excluded.p12, p19=excluded.p19, p20=excluded.p20, 
                  c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c10=excluded.c10, 
                  w_race_loser=excluded.w_race_loser, w_sprint_gainer=excluded.w_sprint_gainer, w_sprint_loser=excluded.w_sprint_loser`,
            args: [d.user_name, d.p1, d.p2, d.p3, d.p11, d.p12, d.p19, d.p20, d.c1, d.c2, d.c5, d.c6, d.c10, d.w_race_loser, d.w_sprint_gainer, d.w_sprint_loser]
        });
        res.json({ success: true });
    } catch (e) { 
        res.status(500).json({ success: false, message: e.message }); 
    }
});

app.post('/api/finalize', async (req, res) => {
    if (req.body.user_name !== 'admin' || req.body.password !== 'Open@0761') return res.status(403).json({ success: false });
    const result = await performFinalization();
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/register', async (req, res) => {
    try { await db.execute({ sql: "INSERT INTO f1_drivers (name, password) VALUES (?, ?)", args: [req.body.name, req.body.password] }); res.json({ success: true, message: "Registered!" }); } 
    catch (e) { res.status(400).json({ success: false, message: "Username Taken" }); }
});

app.post('/login', async (req, res) => {
    const r = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [req.body.name, req.body.password] });
    if (r.rows.length > 0) res.json({ success: true, driver: r.rows[0] });
    else res.status(401).json({ success: false });
});

app.get('/api/predictions', async (req, res) => {
    const r = await db.execute("SELECT p.*, d.total_score FROM f1_predictions_v2 p JOIN f1_drivers d ON p.user_name = d.name");
    res.json(r.rows);
});

app.get('/api/season-leaderboard', async (req, res) => {
    const r = await db.execute("SELECT name, total_score FROM f1_drivers WHERE name != 'admin' ORDER BY total_score DESC");
    res.json(r.rows);
});

const APP_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
setInterval(async () => {
    const now = new Date();
    const active = f1Calendar2026.find(r => { const d = new Date(r.date); return now > d && now - d < (48 * 60 * 60 * 1000); });
    if (active) await performFinalization();
    fetch(`${APP_URL}/api/next-race`).catch(() => {});
}, 15 * 60 * 1000);

app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`🏁 Server 3000`));