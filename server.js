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

// --- CLOUD DATABASE ARCHITECTURE ---
async function setupDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS f1_drivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        password TEXT,
        total_score INTEGER DEFAULT 0
      )
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS f1_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_name TEXT UNIQUE,
        p1 TEXT, p2 TEXT, p3 TEXT, p10 TEXT, p11 TEXT, p19 TEXT, p20 TEXT,
        c1 TEXT, c2 TEXT, c5 TEXT, c6 TEXT, c10 TEXT,
        w_race_loser TEXT, w_sprint_gainer TEXT, w_sprint_loser TEXT
      )
    `);
    console.log("✅ Custom F1 Tables verified and aligned with frontend.");
  } catch (error) {
    console.error("❌ Database setup failed:", error);
  }
}
setupDatabase();

// --- 2026 CALENDAR MEMORY ---
const f1Calendar2026 = [
  { round: 1, name: "Australian Grand Prix", hasSprint: false, date: "2026-03-08T00:00:00Z" },
  { round: 2, name: "Chinese Grand Prix", hasSprint: true, date: "2026-03-15T00:00:00Z" },
  { round: 3, name: "Japanese Grand Prix", hasSprint: false, date: "2026-03-29T00:00:00Z" },
  { round: 4, name: "Bahrain Grand Prix", hasSprint: false, date: "2026-04-12T00:00:00Z" },
  { round: 5, name: "Saudi Arabian Grand Prix", hasSprint: false, date: "2026-04-19T00:00:00Z" },
  { round: 6, name: "Miami Grand Prix", hasSprint: true, date: "2026-05-03T00:00:00Z" },
  { round: 7, name: "Canadian Grand Prix", hasSprint: true, date: "2026-05-24T00:00:00Z" },
  { round: 8, name: "Monaco Grand Prix", hasSprint: false, date: "2026-06-07T00:00:00Z" },
  { round: 9, name: "Spanish Grand Prix (Barcelona)", hasSprint: false, date: "2026-06-14T00:00:00Z" },
  { round: 10, name: "Austrian Grand Prix", hasSprint: false, date: "2026-06-28T00:00:00Z" },
  { round: 11, name: "British Grand Prix", hasSprint: true, date: "2026-07-05T00:00:00Z" },
  { round: 12, name: "Belgian Grand Prix", hasSprint: false, date: "2026-07-19T00:00:00Z" },
  { round: 13, name: "Hungarian Grand Prix", hasSprint: false, date: "2026-07-26T00:00:00Z" },
  { round: 14, name: "Dutch Grand Prix", hasSprint: true, date: "2026-08-23T00:00:00Z" },
  { round: 15, name: "Italian Grand Prix", hasSprint: false, date: "2026-09-06T00:00:00Z" },
  { round: 16, name: "Spanish Grand Prix (Madrid)", hasSprint: false, date: "2026-09-13T00:00:00Z" },
  { round: 17, name: "Azerbaijan Grand Prix", hasSprint: false, date: "2026-09-26T00:00:00Z" },
  { round: 18, name: "Singapore Grand Prix", hasSprint: true, date: "2026-10-11T00:00:00Z" },
  { round: 19, name: "United States Grand Prix (Austin)", hasSprint: false, date: "2026-10-25T00:00:00Z" },
  { round: 20, name: "Mexico City Grand Prix", hasSprint: false, date: "2026-11-01T00:00:00Z" },
  { round: 21, name: "São Paulo Grand Prix", hasSprint: false, date: "2026-11-08T00:00:00Z" },
  { round: 22, name: "Las Vegas Grand Prix", hasSprint: false, date: "2026-11-21T00:00:00Z" },
  { round: 23, name: "Qatar Grand Prix", hasSprint: false, date: "2026-11-29T00:00:00Z" },
  { round: 24, name: "Abu Dhabi Grand Prix", hasSprint: false, date: "2026-12-06T00:00:00Z" }
];

// --- TEXT NORMALIZATION HELPERS ---
function normalizeStr(str) {
    if (!str) return "";
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function normalizeConstructor(c) {
    if (!c) return "";
    const lower = normalizeStr(c);
    if (lower.includes("mclaren")) return "mclaren";
    if (lower.includes("red bull") || lower.includes("redbull")) return "red bull";
    if (lower.includes("ferrari")) return "ferrari";
    if (lower.includes("mercedes")) return "mercedes";
    if (lower.includes("aston")) return "aston martin";
    if (lower.includes("alpine")) return "alpine";
    if (lower.includes("haas")) return "haas";
    if (lower.includes("rb") || lower.includes("racing bulls")) return "racing bulls";
    if (lower.includes("williams")) return "williams";
    if (lower.includes("sauber") || lower.includes("audi") || lower.includes("alfa romeo")) return "audi";
    if (lower.includes("cadillac") || lower.includes("andretti")) return "cadillac";
    return lower;
}

// --- MASTER SCORING LOGIC (The Core Engine) ---
async function performFinalization() {
  try {
    // 1. Fetch live classification
    const raceRes = await fetch('https://api.jolpi.ca/ergast/f1/current/last/results.json').then(r => r.json());
    const races = raceRes.MRData.RaceTable.Races;
    if (!races || races.length === 0) return { success: false, message: "No data." };
    
    const raceData = races[0];
    const results = raceData.Results;

    // Check if we actually have predictions to score
    const activePredictions = await db.execute("SELECT count(*) as count FROM f1_predictions");
    if (activePredictions.rows[0].count === 0) {
        return { success: false, message: "No active predictions to process." };
    }

    // 2. Parse Actual Driver Positions
    const actualDriverPositions = {};
    results.forEach(r => {
      const driverName = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
      actualDriverPositions[driverName] = parseInt(r.position);
    });

    // 3. Calculate Constructor Ranks
    const constructorSums = {};
    results.forEach(r => {
      const cName = normalizeConstructor(r.Constructor.name);
      if (!constructorSums[cName]) constructorSums[cName] = 0;
      constructorSums[cName] += parseInt(r.position);
    });

    const sortedConstructors = Object.keys(constructorSums).sort((a, b) => constructorSums[a] - constructorSums[b]);
    const actualConstructorRanks = {};
    for (let i = 0; i < sortedConstructors.length; i++) {
        if (i > 0 && constructorSums[sortedConstructors[i]] === constructorSums[sortedConstructors[i-1]]) {
            actualConstructorRanks[sortedConstructors[i]] = actualConstructorRanks[sortedConstructors[i-1]];
        } else {
            actualConstructorRanks[sortedConstructors[i]] = i + 1;
        }
    }

    // 4. Wildcards (Race Loser)
    let maxDrop = -999;
    let raceLosers = [];
    results.forEach(r => {
       const grid = parseInt(r.grid);
       const pos = parseInt(r.position);
       if (grid > 0) { 
           const drop = pos - grid; 
           const normDriver = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
           if (drop > maxDrop) { maxDrop = drop; raceLosers = [normDriver]; } 
           else if (drop === maxDrop) { raceLosers.push(normDriver); }
       }
    });

    // 5. Evaluate Predictions
    const predictions = await db.execute("SELECT * FROM f1_predictions").then(r => r.rows);
    let scores = {};
    let lowestActiveScore = Infinity;

    predictions.forEach(p => {
        let score = 0;
        const evalPos = (pred, target) => {
            const actual = actualDriverPositions[normalizeStr(pred)];
            if (!actual) return;
            const diff = Math.abs(target - actual);
            score -= diff;
            if (diff === 0) score += 2;
        };
        const evalCon = (pred, target) => {
            const actual = actualConstructorRanks[normalizeConstructor(pred)];
            if (!actual) return;
            const diff = Math.abs(target - actual);
            score -= diff;
            if (diff === 0) score += 2;
        };

        evalPos(p.p1, 1); evalPos(p.p2, 2); evalPos(p.p3, 3);
        evalPos(p.p10, 10); evalPos(p.p11, 11); evalPos(p.p19, 19); evalPos(p.p20, 20);
        evalCon(p.c1, 1); evalCon(p.c2, 2); evalCon(p.c5, 5); evalCon(p.c6, 6); evalCon(p.c10, 10);
        
        if (p.w_race_loser && raceLosers.includes(normalizeStr(p.w_race_loser))) score += 5;

        scores[p.user_name] = score;
        if (score < lowestActiveScore) lowestActiveScore = score;
    });

    // 6. Update Leaderboard & Reset
    if (lowestActiveScore === Infinity) lowestActiveScore = 0;
    const penalty = lowestActiveScore - 5;
    const allDrivers = await db.execute("SELECT * FROM f1_drivers").then(r => r.rows);
    
    for (const driver of allDrivers) {
        let finalScore = scores[driver.name] !== undefined ? scores[driver.name] : penalty;
        await db.execute({
            sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?",
            args: [finalScore, driver.name]
        });
    }

    await db.execute("DELETE FROM f1_predictions");
    return { success: true, message: `Finalized Round ${raceData.round}` };

  } catch (error) {
    console.error("Scoring failure:", error);
    return { success: false, message: error.message };
  }
}

// --- 1. AUTH & PREDICTION ROUTES ---
app.post('/register', async (req, res) => {
  const { name, password } = req.body;
  try {
    await db.execute({ sql: "INSERT INTO f1_drivers (name, password) VALUES (?, ?)", args: [name, password] });
    res.json({ success: true, message: "Contract signed!" });
  } catch (e) { res.status(400).json({ success: false, message: "Registration failed." }); }
});

app.post('/login', async (req, res) => {
  const { name, password } = req.body;
  const result = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [name, password] });
  if (result.rows.length > 0) res.json({ success: true, driver: result.rows[0] });
  else res.status(401).json({ success: false, message: "Invalid credentials." });
});

app.post('/predict', async (req, res) => {
  const data = req.body;
  try {
    const auth = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [data.user_name, data.password] });
    if (auth.rows.length === 0) return res.status(401).json({success: false});

    await db.execute({
      sql: `INSERT INTO f1_predictions (user_name, p1, p2, p3, p10, p11, p19, p20, c1, c2, c5, c6, c10, w_race_loser) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_name) DO UPDATE SET p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p10=excluded.p10, p11=excluded.p11, p19=excluded.p19, p20=excluded.p20, c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c10=excluded.c10, w_race_loser=excluded.w_race_loser`,
      args: [data.user_name, data.p1, data.p2, data.p3, data.p10, data.p11, data.p19, data.p20, data.c1, data.c2, data.c5, data.c6, data.c10, data.w_race_loser]
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

// --- 2. DASHBOARD ROUTES ---
app.get('/api/predictions', async (req, res) => {
    const r = await db.execute("SELECT p.*, d.total_score FROM f1_predictions p JOIN f1_drivers d ON p.user_name = d.name");
    res.json(r.rows);
});

app.get('/api/season-leaderboard', async (req, res) => {
    const r = await db.execute("SELECT name, total_score FROM f1_drivers ORDER BY total_score DESC");
    res.json(r.rows);
});

app.get('/api/next-race', (req, res) => {
  const next = f1Calendar2026.find(r => new Date(r.date) > new Date()) || f1Calendar2026[23];
  res.json(next);
});

// --- 3. THE ORGANIC WATCHER & BACKUP BUTTON ---
app.post('/api/finalize', async (req, res) => {
    const result = await performFinalization();
    res.status(result.success ? 200 : 400).json(result);
});

// Watcher: Runs every 15 minutes to check for finished races
const APP_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
setInterval(async () => {
    const now = new Date();
    // Check if we are within 48 hours of a scheduled race start
    const activeRound = f1Calendar2026.find(r => {
        const d = new Date(r.date);
        return now > d && now - d < (48 * 60 * 60 * 1000);
    });

    if (activeRound) {
        console.log(`🧐 Organic Watcher: Results check for ${activeRound.name}...`);
        await performFinalization();
    }
    // Keep engine warm
    fetch(`${APP_URL}/api/next-race`).catch(() => {});
}, 15 * 60 * 1000);

app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`🏁 Engine hot on port ${port}`));