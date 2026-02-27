const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); 

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// --- 1. DATABASE SETUP (UPGRADED FOR VIP FUND) ---
async function setupDatabase() {
  try {
    // Added is_vip flag to new databases
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, password TEXT, total_score INTEGER DEFAULT 0, has_participated INTEGER DEFAULT 0, is_vip INTEGER DEFAULT 0)`);
    
    // Safety catches to upgrade existing database without deleting user data
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN has_participated INTEGER DEFAULT 0`); } catch(e) {}
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN is_vip INTEGER DEFAULT 0`); } catch(e) {}

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
        await db.execute({ sql: "INSERT INTO f1_drivers (name, password, has_participated, is_vip) VALUES ('admin', 'Open@0761', 0, 1) ON CONFLICT(name) DO NOTHING" });
        console.log("✅ Admin Ready.");
    } catch (e) {}
    console.log("✅ Database Synced & VIP Active.");
  } catch (e) { console.error("DB Error:", e); }
}
setupDatabase();

// --- 2. 2026 CALENDAR WITH ENRICHED CIRCUIT DATA (IST) ---
const f1Calendar2026 = [
  { round: 1, name: "Australian Grand Prix", hasSprint: false, date: "2026-03-06T07:00:00+05:30", circuit: "Albert Park Circuit", country: "Australia", record: "Charles Leclerc (Ferrari) - 1:19.813 (2024)", sessions: { fp1: "2026-03-06T07:00:00+05:30", fp2: "2026-03-06T10:30:00+05:30", fp3: "2026-03-07T07:00:00+05:30", quali: "2026-03-07T10:30:00+05:30", race: "2026-03-08T09:30:00+05:30" } },
  { round: 2, name: "Chinese Grand Prix", hasSprint: true, date: "2026-03-13T09:00:00+05:30", circuit: "Shanghai International Circuit", country: "China", record: "Michael Schumacher (Ferrari) - 1:32.238 (2004)", sessions: { fp1: "2026-03-13T09:00:00+05:30", sprintQuali: "2026-03-13T13:00:00+05:30", sprint: "2026-03-14T09:00:00+05:30", quali: "2026-03-14T13:00:00+05:30", race: "2026-03-15T12:30:00+05:30" } },
  { round: 3, name: "Japanese Grand Prix", hasSprint: false, date: "2026-03-27T08:00:00+05:30", circuit: "Suzuka International Racing Course", country: "Japan", record: "Lewis Hamilton (Mercedes) - 1:30.983 (2019)", sessions: { fp1: "2026-03-27T08:00:00+05:30", fp2: "2026-03-27T11:30:00+05:30", fp3: "2026-03-28T08:00:00+05:30", quali: "2026-03-28T11:30:00+05:30", race: "2026-03-29T10:30:00+05:30" } },
  { round: 4, name: "Bahrain Grand Prix", hasSprint: false, date: "2026-04-10T17:00:00+05:30", circuit: "Bahrain International Circuit", country: "Bahrain", record: "Pedro de la Rosa (McLaren) - 1:31.447 (2005)", sessions: { fp1: "2026-04-10T17:00:00+05:30", fp2: "2026-04-10T20:30:00+05:30", fp3: "2026-04-11T17:30:00+05:30", quali: "2026-04-11T21:30:00+05:30", race: "2026-04-12T20:30:00+05:30" } },
  { round: 5, name: "Saudi Arabian Grand Prix", hasSprint: false, date: "2026-04-17T19:00:00+05:30", circuit: "Jeddah Corniche Circuit", country: "Saudi Arabia", record: "Lewis Hamilton (Mercedes) - 1:30.734 (2021)", sessions: { fp1: "2026-04-17T19:00:00+05:30", fp2: "2026-04-17T22:30:00+05:30", fp3: "2026-04-18T19:00:00+05:30", quali: "2026-04-18T22:30:00+05:30", race: "2026-04-19T22:30:00+05:30" } },
  { round: 6, name: "Miami Grand Prix", hasSprint: true, date: "2026-05-01T22:00:00+05:30", circuit: "Miami International Autodrome", country: "United States", record: "Max Verstappen (Red Bull) - 1:29.708 (2023)", sessions: { fp1: "2026-05-01T22:00:00+05:30", sprintQuali: "2026-05-02T02:00:00+05:30", sprint: "2026-05-02T21:30:00+05:30", quali: "2026-05-03T01:30:00+05:30", race: "2026-05-04T01:30:00+05:30" } },
  { round: 7, name: "Canadian Grand Prix", hasSprint: true, date: "2026-05-22T23:00:00+05:30", circuit: "Circuit Gilles-Villeneuve", country: "Canada", record: "Valtteri Bottas (Mercedes) - 1:13.078 (2019)", sessions: { fp1: "2026-05-22T23:00:00+05:30", sprintQuali: "2026-05-23T03:00:00+05:30", sprint: "2026-05-23T21:30:00+05:30", quali: "2026-05-24T01:30:00+05:30", race: "2026-05-24T23:30:00+05:30" } },
  { round: 8, name: "Monaco Grand Prix", hasSprint: false, date: "2026-06-05T17:00:00+05:30", circuit: "Circuit de Monaco", country: "Monaco", record: "Lewis Hamilton (Mercedes) - 1:12.909 (2021)", sessions: { fp1: "2026-06-05T17:00:00+05:30", fp2: "2026-06-05T20:30:00+05:30", fp3: "2026-06-06T16:00:00+05:30", quali: "2026-06-06T19:30:00+05:30", race: "2026-06-07T18:30:00+05:30" } },
  { round: 9, name: "Spanish Grand Prix", hasSprint: false, date: "2026-06-12T17:00:00+05:30", circuit: "Circuit de Barcelona-Catalunya", country: "Spain", record: "Oscar Piastri (McLaren) - 1:15.743 (2025)", sessions: { fp1: "2026-06-12T17:00:00+05:30", fp2: "2026-06-12T20:30:00+05:30", fp3: "2026-06-13T16:00:00+05:30", quali: "2026-06-13T19:30:00+05:30", race: "2026-06-14T18:30:00+05:30" } },
  { round: 10, name: "Austrian Grand Prix", hasSprint: false, date: "2026-06-26T16:00:00+05:30", circuit: "Red Bull Ring", country: "Austria", record: "Carlos Sainz (McLaren) - 1:05.619 (2020)", sessions: { fp1: "2026-06-26T16:00:00+05:30", fp2: "2026-06-26T19:30:00+05:30", fp3: "2026-06-27T16:00:00+05:30", quali: "2026-06-27T19:30:00+05:30", race: "2026-06-28T18:30:00+05:30" } },
  { round: 11, name: "British Grand Prix", hasSprint: true, date: "2026-07-03T17:00:00+05:30", circuit: "Silverstone Circuit", country: "Great Britain", record: "Max Verstappen (Red Bull) - 1:27.097 (2020)", sessions: { fp1: "2026-07-03T17:00:00+05:30", sprintQuali: "2026-07-03T21:00:00+05:30", sprint: "2026-07-04T16:30:00+05:30", quali: "2026-07-04T20:30:00+05:30", race: "2026-07-05T19:30:00+05:30" } },
  { round: 12, name: "Belgian Grand Prix", hasSprint: false, date: "2026-07-17T17:00:00+05:30", circuit: "Circuit de Spa-Francorchamps", country: "Belgium", record: "Valtteri Bottas (Mercedes) - 1:46.286 (2018)", sessions: { fp1: "2026-07-17T17:00:00+05:30", fp2: "2026-07-17T20:30:00+05:30", fp3: "2026-07-18T16:00:00+05:30", quali: "2026-07-18T19:30:00+05:30", race: "2026-07-19T18:30:00+05:30" } },
  { round: 13, name: "Hungarian Grand Prix", hasSprint: false, date: "2026-07-24T17:00:00+05:30", circuit: "Hungaroring", country: "Hungary", record: "Lewis Hamilton (Mercedes) - 1:16.627 (2020)", sessions: { fp1: "2026-07-24T17:00:00+05:30", fp2: "2026-07-24T20:30:00+05:30", fp3: "2026-07-25T16:00:00+05:30", quali: "2026-07-25T19:30:00+05:30", race: "2026-07-26T18:30:00+05:30" } },
  { round: 14, name: "Dutch Grand Prix", hasSprint: true, date: "2026-08-21T16:00:00+05:30", circuit: "Circuit Zandvoort", country: "Netherlands", record: "Lewis Hamilton (Mercedes) - 1:11.097 (2021)", sessions: { fp1: "2026-08-21T16:00:00+05:30", sprintQuali: "2026-08-21T20:00:00+05:30", sprint: "2026-08-22T15:30:00+05:30", quali: "2026-08-22T19:30:00+05:30", race: "2026-08-23T18:30:00+05:30" } },
  { round: 15, name: "Italian Grand Prix", hasSprint: false, date: "2026-09-04T17:00:00+05:30", circuit: "Autodromo Nazionale Monza", country: "Italy", record: "Lando Norris (McLaren) - 1:20.901 (2025)", sessions: { fp1: "2026-09-04T17:00:00+05:30", fp2: "2026-09-04T20:30:00+05:30", fp3: "2026-09-05T16:00:00+05:30", quali: "2026-09-05T19:30:00+05:30", race: "2026-09-06T18:30:00+05:30" } },
  { round: 16, name: "Madrid Grand Prix", hasSprint: false, date: "2026-09-11T17:00:00+05:30", circuit: "IFEMA Madrid", country: "Spain", record: "NEW CIRCUIT - No record set", sessions: { fp1: "2026-09-11T17:00:00+05:30", fp2: "2026-09-11T20:30:00+05:30", fp3: "2026-09-12T16:00:00+05:30", quali: "2026-09-12T19:30:00+05:30", race: "2026-09-13T18:30:00+05:30" } },
  { round: 17, name: "Azerbaijan Grand Prix", hasSprint: false, date: "2026-09-25T15:00:00+05:30", circuit: "Baku City Circuit", country: "Azerbaijan", record: "Charles Leclerc (Ferrari) - 1:43.009 (2019)", sessions: { fp1: "2026-09-25T15:00:00+05:30", fp2: "2026-09-25T18:30:00+05:30", fp3: "2026-09-26T15:00:00+05:30", quali: "2026-09-26T18:30:00+05:30", race: "2026-09-27T16:30:00+05:30" } },
  { round: 18, name: "Singapore Grand Prix", hasSprint: true, date: "2026-10-09T15:00:00+05:30", circuit: "Marina Bay Street Circuit", country: "Singapore", record: "Daniel Ricciardo (RB) - 1:34.486 (2024)", sessions: { fp1: "2026-10-09T15:00:00+05:30", sprintQuali: "2026-10-09T19:00:00+05:30", sprint: "2026-10-10T15:00:00+05:30", quali: "2026-10-10T19:00:00+05:30", race: "2026-10-11T17:30:00+05:30" } },
  { round: 19, name: "United States Grand Prix", hasSprint: false, date: "2026-10-23T23:00:00+05:30", circuit: "Circuit of The Americas", country: "United States", record: "Charles Leclerc (Ferrari) - 1:36.169 (2019)", sessions: { fp1: "2026-10-23T23:00:00+05:30", fp2: "2026-10-24T03:00:00+05:30", fp3: "2026-10-24T23:30:00+05:30", quali: "2026-10-25T03:30:00+05:30", race: "2026-10-26T00:30:00+05:30" } },
  { round: 20, name: "Mexico City Grand Prix", hasSprint: false, date: "2026-10-31T00:30:00+05:30", circuit: "Autódromo Hermanos Rodríguez", country: "Mexico", record: "Valtteri Bottas (Mercedes) - 1:17.774 (2021)", sessions: { fp1: "2026-10-31T00:30:00+05:30", fp2: "2026-10-31T04:00:00+05:30", fp3: "2026-10-31T23:00:00+05:30", quali: "2026-11-01T02:30:00+05:30", race: "2026-11-02T01:30:00+05:30" } },
  { round: 21, name: "São Paulo Grand Prix", hasSprint: false, date: "2026-11-06T20:00:00+05:30", circuit: "Autódromo José Carlos Pace", country: "Brazil", record: "Valtteri Bottas (Mercedes) - 1:10.540 (2018)", sessions: { fp1: "2026-11-06T20:00:00+05:30", fp2: "2026-11-06T23:30:00+05:30", fp3: "2026-11-07T19:00:00+05:30", quali: "2026-11-07T23:00:00+05:30", race: "2026-11-08T22:30:00+05:30" } },
  { round: 22, name: "Las Vegas Grand Prix", hasSprint: false, date: "2026-11-20T08:00:00+05:30", circuit: "Las Vegas Strip Circuit", country: "United States", record: "Oscar Piastri (McLaren) - 1:35.490 (2023)", sessions: { fp1: "2026-11-20T08:00:00+05:30", fp2: "2026-11-20T11:30:00+05:30", fp3: "2026-11-21T08:00:00+05:30", quali: "2026-11-21T11:30:00+05:30", race: "2026-11-22T11:30:00+05:30" } },
  { round: 23, name: "Qatar Grand Prix", hasSprint: false, date: "2026-11-27T19:00:00+05:30", circuit: "Lusail International Circuit", country: "Qatar", record: "Max Verstappen (Red Bull) - 1:24.319 (2023)", sessions: { fp1: "2026-11-27T19:00:00+05:30", fp2: "2026-11-27T22:30:00+05:30", fp3: "2026-11-28T18:30:00+05:30", quali: "2026-11-28T22:30:00+05:30", race: "2026-11-29T22:30:00+05:30" } },
  { round: 24, name: "Abu Dhabi Grand Prix", hasSprint: false, date: "2026-12-04T15:00:00+05:30", circuit: "Yas Marina Circuit", country: "United Arab Emirates", record: "Max Verstappen (Red Bull) - 1:26.103 (2021)", sessions: { fp1: "2026-12-04T15:00:00+05:30", fp2: "2026-12-04T18:30:00+05:30", fp3: "2026-12-05T16:00:00+05:30", quali: "2026-12-05T19:30:00+05:30", race: "2026-12-06T18:30:00+05:30" } }
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

async function sendDiscordNotification(msg) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) {
        console.log("Discord alert skipped: No DISCORD_WEBHOOK_URL set.");
        return;
    }
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🏎️ **F1 Steward:** ${msg}` }) });
    } catch (e) { console.error("Discord Error:", e); }
}

// --- 4. SCORING ENGINE ---
async function performFinalization() {
  try {
    const raceRes = await fetch('https://api.jolpi.ca/ergast/f1/2024/24/results.json').then(r => r.json());
    const races = raceRes.MRData.RaceTable.Races;
    if (!races || races.length === 0) return { success: false, message: "No data." };
    
    const raceData = races[0];
    const results = raceData.Results;
    const check = await db.execute("SELECT count(*) as count FROM f1_predictions_v2");
    if (check.rows[0].count === 0) return { success: false, message: "No predictions." };

    const actualDriverPositions = {};
    results.forEach(r => {
        const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
        let pos = parseInt(r.position);
        if (r.positionText === 'R' || r.positionText === 'D' || r.status.startsWith('Retired') || r.status.startsWith('Collision') || r.status.startsWith('Accident')) {
            pos = 20; 
        }
        actualDriverPositions[name] = pos;
    });

    const constructorSums = {};
    results.forEach(r => {
      const c = normalizeConstructor(r.Constructor.name);
      let pos = parseInt(r.position);
       if (r.positionText === 'R' || r.positionText === 'D') pos = 20; 
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
           if (r.positionText === 'R' || r.positionText === 'D') finish = 20;
           const drop = finish - parseInt(r.grid);
           const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
           if (drop > maxDrop) { maxDrop = drop; raceLosers = [name]; }
           else if (drop === maxDrop) raceLosers.push(name);
       }
    });

    const predictions = await db.execute("SELECT * FROM f1_predictions_v2").then(r => r.rows);
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
            { pred: p.p19, rank: 19 }, { pred: p.p20, rank: 20 }
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

    await db.execute("DELETE FROM f1_predictions_v2");
    
    // Send official Discord Alert
    await sendDiscordNotification(`🏁 The **${raceData.raceName}** has been finalized! Points have been calculated and the World Championship Standings are updated.`);
    
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
        
        await db.execute({ sql: `UPDATE f1_drivers SET has_participated = 1 WHERE name = ?`, args: [d.user_name] });
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
    try { 
        // Force is_vip to 0 on standard registration
        await db.execute({ sql: "INSERT INTO f1_drivers (name, password, has_participated, is_vip) VALUES (?, ?, 0, 0)", args: [req.body.name, req.body.password] }); 
        res.json({ success: true, message: "Registered!" }); 
    } 
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

// IMPORTANT VIP FIX: Added is_vip to the SELECT statement
app.get('/api/season-leaderboard', async (req, res) => {
    const r = await db.execute("SELECT name, total_score, is_vip FROM f1_drivers WHERE name != 'admin' AND has_participated = 1 ORDER BY total_score DESC");
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