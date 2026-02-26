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

// --- DATABASE SETUP ---
async function setupDatabase() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, password TEXT, total_score INTEGER DEFAULT 0)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_predictions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT UNIQUE, p1 TEXT, p2 TEXT, p3 TEXT, p11 TEXT, p12 TEXT, p19 TEXT, p20 TEXT, c1 TEXT, c2 TEXT, c5 TEXT, c6 TEXT, c10 TEXT, w_race_loser TEXT)`);
    console.log("✅ Database Synced with P11/P12 schema.");
  } catch (e) { console.error("DB Error:", e); }
}
setupDatabase();

// --- 2026 CALENDAR ---
const f1Calendar2026 = [
  { round: 1, name: "Australian Grand Prix", date: "2026-03-08T00:00:00Z" },
  { round: 2, name: "Chinese Grand Prix", date: "2026-03-15T00:00:00Z" },
  { round: 3, name: "Japanese Grand Prix", date: "2026-03-29T00:00:00Z" },
  { round: 4, name: "Bahrain Grand Prix", date: "2026-04-12T00:00:00Z" },
  { round: 5, name: "Saudi Arabian Grand Prix", date: "2026-04-19T00:00:00Z" },
  { round: 6, name: "Miami Grand Prix", date: "2026-05-03T00:00:00Z" },
  { round: 7, name: "Canadian Grand Prix", date: "2026-05-24T00:00:00Z" },
  { round: 8, name: "Monaco Grand Prix", date: "2026-06-07T00:00:00Z" },
  { round: 9, name: "Spanish Grand Prix (Barcelona)", date: "2026-06-14T00:00:00Z" },
  { round: 10, name: "Austrian Grand Prix", date: "2026-06-28T00:00:00Z" },
  { round: 11, name: "British Grand Prix", date: "2026-07-05T00:00:00Z" },
  { round: 12, name: "Belgian Grand Prix", date: "2026-07-19T00:00:00Z" },
  { round: 13, name: "Hungarian Grand Prix", date: "2026-07-26T00:00:00Z" },
  { round: 14, name: "Dutch Grand Prix", date: "2026-08-23T00:00:00Z" },
  { round: 15, name: "Italian Grand Prix", date: "2026-09-06T00:00:00Z" },
  { round: 16, name: "Spanish Grand Prix (Madrid)", date: "2026-09-13T00:00:00Z" },
  { round: 17, name: "Azerbaijan Grand Prix", date: "2026-09-26T00:00:00Z" },
  { round: 18, name: "Singapore Grand Prix", date: "2026-10-11T00:00:00Z" },
  { round: 19, name: "United States Grand Prix (Austin)", date: "2026-10-25T00:00:00Z" },
  { round: 20, name: "Mexico City Grand Prix", date: "2026-11-01T00:00:00Z" },
  { round: 21, name: "São Paulo Grand Prix", date: "2026-11-08T00:00:00Z" },
  { round: 22, name: "Las Vegas Grand Prix", date: "2026-11-21T00:00:00Z" },
  { round: 23, name: "Qatar Grand Prix", date: "2026-11-29T00:00:00Z" },
  { round: 24, name: "Abu Dhabi Grand Prix", date: "2026-12-06T00:00:00Z" }
];

// --- HELPERS ---
function normalizeStr(s) { return s ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : ""; }
function normalizeConstructor(c) {
    const l = normalizeStr(c);
    if (l.includes("mclaren")) return "mclaren";
    if (l.includes("red bull")) return "red bull";
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

// --- DISCORD WEBHOOK ---
async function sendDiscordNotification(msg) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return;
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🏎️ **F1 Steward Bot:** ${msg}` }) });
    } catch (e) { console.error("Discord Error:", e); }
}

// --- MASTER SCORING LOGIC ---
async function performFinalization() {
  try {
    const raceRes = await fetch('https://api.jolpi.ca/ergast/f1/current/last/results.json').then(r => r.json());
    const races = raceRes.MRData.RaceTable.Races;
    if (!races || races.length === 0) return { success: false, message: "No API data yet." };
    
    const raceData = races[0];
    const results = raceData.Results;

    const check = await db.execute("SELECT count(*) as count FROM f1_predictions");
    if (check.rows[0].count === 0) return { success: false, message: "No active predictions." };

    const actualDriverPositions = {};
    results.forEach(r => { actualDriverPositions[normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`)] = parseInt(r.position); });

    const constructorSums = {};
    results.forEach(r => {
      const c = normalizeConstructor(r.Constructor.name);
      constructorSums[c] = (constructorSums[c] || 0) + parseInt(r.position);
    });

    const sortedC = Object.keys(constructorSums).sort((a, b) => constructorSums[a] - constructorSums[b]);
    const actualCRanks = {};
    for (let i = 0; i < sortedC.length; i++) {
        actualCRanks[sortedC[i]] = (i > 0 && constructorSums[sortedC[i]] === constructorSums[sortedC[i-1]]) ? actualCRanks[sortedC[i-1]] : i + 1;
    }

    let raceLosers = []; let maxDrop = -999;
    results.forEach(r => {
       if (parseInt(r.grid) > 0) {
           const drop = parseInt(r.position) - parseInt(r.grid);
           const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
           if (drop > maxDrop) { maxDrop = drop; raceLosers = [name]; }
           else if (drop === maxDrop) raceLosers.push(name);
       }
    });

    const predictions = await db.execute("SELECT * FROM f1_predictions").then(r => r.rows);
    let scores = {}; let lowest = Infinity;

    predictions.forEach(p => {
        let score = 0;
        const evalP = (pr, t) => {
            const act = actualDriverPositions[normalizeStr(pr)];
            if (!act) return;
            const diff = Math.abs(t - act);
            score -= diff; if (diff === 0) score += 2;
        };
        const evalC = (pr, t) => {
            const act = actualCRanks[normalizeConstructor(pr)];
            if (!act) return;
            const diff = Math.abs(t - act);
            score -= diff; if (diff === 0) score += 2;
        };

        evalP(p.p1, 1); evalP(p.p2, 2); evalP(p.p3, 3); 
        evalP(p.p11, 11); evalP(p.p12, 12); 
        evalP(p.p19, 19); evalP(p.p20, 20);
        
        evalC(p.c1, 1); evalC(p.c2, 2); evalC(p.c5, 5); evalC(p.c6, 6); evalC(p.c10, 10);
        if (p.w_race_loser && raceLosers.includes(normalizeStr(p.w_race_loser))) score += 5;

        scores[p.user_name] = score;
        if (score < lowest) lowest = score;
    });

    const penalty = (lowest === Infinity ? 0 : lowest) - 5;
    const allDrivers = await db.execute("SELECT * FROM f1_drivers").then(r => r.rows);
    for (const d of allDrivers) {
        let fs = scores[d.name] !== undefined ? scores[d.name] : penalty;
        await db.execute({ sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?", args: [fs, d.name] });
    }

    await db.execute("DELETE FROM f1_predictions");
    await sendDiscordNotification(`🏁 **${raceData.raceName}** results finalized! Standings updated.`);
    return { success: true, message: `Round ${raceData.round} Finalized.` };
  } catch (e) {
    await sendDiscordNotification(`⚠️ Scoring Error: ${e.message}`);
    return { success: false, message: e.message };
  }
}

// --- ROUTES ---
app.post('/api/finalize', async (req, res) => {
    if (req.body.user_name !== 'admin' || req.body.password !== 'Open@0761') return res.status(403).json({ success: false });
    const result = await performFinalization();
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/register', async (req, res) => {
    try { await db.execute({ sql: "INSERT INTO f1_drivers (name, password) VALUES (?, ?)", args: [req.body.name, req.body.password] }); res.json({ success: true, message: "Registered!" }); } 
    catch (e) { res.status(400).json({ success: false, message: "User exists." }); }
});

app.post('/login', async (req, res) => {
    const r = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [req.body.name, req.body.password] });
    if (r.rows.length > 0) res.json({ success: true, driver: r.rows[0] });
    else res.status(401).json({ success: false });
});

app.post('/predict', async (req, res) => {
    const d = req.body;
    try {
        const auth = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [d.user_name, d.password] });
        if (auth.rows.length === 0) return res.status(401).send();
        
        await db.execute({
            sql: `INSERT INTO f1_predictions (user_name, p1, p2, p3, p11, p12, p19, p20, c1, c2, c5, c6, c10, w_race_loser) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_name) DO UPDATE SET p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p11=excluded.p11, p12=excluded.p12, p19=excluded.p19, p20=excluded.p20, c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c10=excluded.c10, w_race_loser=excluded.w_race_loser`,
            args: [d.user_name, d.p1, d.p2, d.p3, d.p11, d.p12, d.p19, d.p20, d.c1, d.c2, d.c5, d.c6, d.c10, d.w_race_loser]
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/predictions', async (req, res) => {
    const r = await db.execute("SELECT p.*, d.total_score FROM f1_predictions p JOIN f1_drivers d ON p.user_name = d.name");
    res.json(r.rows);
});

app.get('/api/season-leaderboard', async (req, res) => {
    const r = await db.execute("SELECT name, total_score FROM f1_drivers ORDER BY total_score DESC");
    res.json(r.rows);
});

app.get('/api/next-race', (req, res) => {
    res.json(f1Calendar2026.find(r => new Date(r.date) > new Date()) || f1Calendar2026[23]);
});

// --- ORGANIC WATCHER ---
const APP_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
setInterval(async () => {
    const now = new Date();
    const active = f1Calendar2026.find(r => { const d = new Date(r.date); return now > d && now - d < (48 * 60 * 60 * 1000); });
    if (active) await performFinalization();
    fetch(`${APP_URL}/api/next-race`).catch(() => {});
}, 15 * 60 * 1000);

app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`🏁 Server running on ${port}`));