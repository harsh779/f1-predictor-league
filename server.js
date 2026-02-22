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

// --- 1. AUTHENTICATION ROUTES ---
app.post('/register', async (req, res) => {
  const { name, password } = req.body;
  try {
    await db.execute({
      sql: "INSERT INTO f1_drivers (name, password) VALUES (?, ?)",
      args: [name || null, password || null] 
    });
    res.json({ success: true, message: "Contract signed! You can now enter the paddock." });
  } catch (error) {
    if (error.message && error.message.includes("UNIQUE")) {
      res.status(400).json({ success: false, message: "Driver Name already taken." });
    } else {
      res.status(500).json({ success: false, message: "Registration failed." });
    }
  }
});

app.post('/login', async (req, res) => {
  const { name, password } = req.body;
  try {
    const result = await db.execute({
      sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?",
      args: [name || null, password || null]
    });
    if (result.rows.length > 0) {
      res.json({ success: true, driver: result.rows[0] });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials." });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "Login failed." });
  }
});

// --- 2. PREDICTION LOGIC ---
app.post('/predict', async (req, res) => {
  const { user_name, password, p1, p2, p3, p10, p11, p19, p20, c1, c2, c5, c6, c10, w_race_loser, w_sprint_gainer, w_sprint_loser } = req.body;
  try {
    const auth = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [user_name, password] });
    if (auth.rows.length === 0) return res.status(401).json({success: false, message: "Unauthorized"});

    await db.execute({
      sql: `INSERT INTO f1_predictions (user_name, p1, p2, p3, p10, p11, p19, p20, c1, c2, c5, c6, c10, w_race_loser, w_sprint_gainer, w_sprint_loser) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_name) DO UPDATE SET 
            p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p10=excluded.p10, p11=excluded.p11, p19=excluded.p19, p20=excluded.p20,
            c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c10=excluded.c10,
            w_race_loser=excluded.w_race_loser, w_sprint_gainer=excluded.w_sprint_gainer, w_sprint_loser=excluded.w_sprint_loser`,
      args: [user_name, p1, p2, p3, p10, p11, p19, p20, c1, c2, c5, c6, c10, w_race_loser, w_sprint_gainer, w_sprint_loser]
    });
    res.json({ success: true, message: "Strategy locked in!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to save prediction." });
  }
});

app.post('/api/predictions/me', async (req, res) => {
  const { user_name, password } = req.body;
  try {
    const result = await db.execute({ sql: "SELECT * FROM f1_predictions WHERE user_name = ?", args: [user_name] });
    if (result.rows.length > 0) res.json(result.rows[0]);
    else res.status(404).json({ message: "No predictions found" });
  } catch (error) {
    res.status(500).json({ message: "Error fetching history" });
  }
});

// --- 3. DASHBOARD FEEDS ---
app.get('/api/predictions', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT p.user_name, d.total_score, p.p1, p.p2, p.c1, p.c2, p.w_race_loser, p.w_sprint_gainer, p.w_sprint_loser 
      FROM f1_predictions p JOIN f1_drivers d ON p.user_name = d.name
    `);
    res.json(result.rows);
  } catch (error) {
    res.json([]);
  }
});

app.get('/api/season-leaderboard', async (req, res) => {
  try {
    const result = await db.execute("SELECT name, total_score FROM f1_drivers ORDER BY total_score DESC");
    res.json(result.rows);
  } catch (error) {
    res.json([]);
  }
});

app.get('/api/next-race', (req, res) => {
  const now = new Date(); 
  let nextRace = f1Calendar2026.find(race => new Date(race.date) > now);
  if (!nextRace) nextRace = f1Calendar2026[23]; 

  res.json({ round: nextRace.round, name: nextRace.name, hasSprint: nextRace.hasSprint, deadline: nextRace.date });
});

// --- LIVE API: FETCH REAL F1 RESULTS ---
app.get('/api/season-results', async (req, res) => {
  try {
    const response = await fetch('https://api.jolpi.ca/ergast/f1/2025/results/1.json');
    const data = await response.json();
    const races = data.MRData.RaceTable.Races;
    if (!races || races.length === 0) return res.json([{ round: "-", name: "Awaiting Lights Out", winner: "-", team: "-" }]);
    
    const formattedResults = races.map(race => ({
      round: race.round,
      name: race.raceName,
      winner: race.Results[0].Driver.familyName,
      team: race.Results[0].Constructor.name
    }));
    res.json(formattedResults);
  } catch (error) {
    res.json([{ round: "ERR", name: "API Offline", winner: "-", team: "-" }]);
  }
});

// --- THE MASTER SCORING ALGORITHM ---
app.post('/api/finalize', async (req, res) => {
  try {
    // 1. Fetch live classification from Jolpica
    // CHANGED 'current' TO '2025' FOR TESTING
    const raceRes = await fetch('https://api.jolpi.ca/ergast/f1/2025/last/results.json').then(r => r.json());
    const races = raceRes.MRData.RaceTable.Races;
    if (!races || races.length === 0) return res.status(400).json({ success: false, message: "No official race data available yet." });
    
    const raceData = races[0];
    const results = raceData.Results;

    // 2. Parse Actual Driver Positions
    const actualDriverPositions = {};
    results.forEach(r => {
      const driverName = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
      actualDriverPositions[driverName] = parseInt(r.position);
    });

    // 3. Parse and Calculate Constructor Ranks (Sum of drivers, ties skip next rank)
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

    // 4. Determine Biggest Race Loser Wildcard
    let maxDrop = -999;
    let raceLosers = [];
    results.forEach(r => {
       const grid = parseInt(r.grid);
       const pos = parseInt(r.position);
       if (grid > 0) { 
           const drop = pos - grid; 
           const normDriver = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
           if (drop > maxDrop) {
               maxDrop = drop;
               raceLosers = [normDriver];
           } else if (drop === maxDrop) {
               raceLosers.push(normDriver);
           }
       }
    });

    // 5. Determine Sprint Wildcards (if applicable)
    let sprintGainers = [];
    let sprintLosers = [];
    try {
        // CHANGED 'current' TO '2025' FOR TESTING
        const sprintRes = await fetch('https://api.jolpi.ca/ergast/f1/2025/last/sprint.json').then(r => r.json());
        const sprintRaces = sprintRes.MRData.RaceTable.Races;
        if (sprintRaces && sprintRaces.length > 0 && sprintRaces[0].round === raceData.round) {
            const sprintResults = sprintRaces[0].SprintResults;
            let maxSprintDrop = -999; 
            let maxSprintGain = -999; 
            
            sprintResults.forEach(r => {
               const grid = parseInt(r.grid);
               const pos = parseInt(r.position);
               const normDriver = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
               if (grid > 0) {
                   const drop = pos - grid;
                   const gain = grid - pos;
                   
                   if (drop > maxSprintDrop) { maxSprintDrop = drop; sprintLosers = [normDriver]; } 
                   else if (drop === maxSprintDrop) { sprintLosers.push(normDriver); }

                   if (gain > maxSprintGain) { maxSprintGain = gain; sprintGainers = [normDriver]; } 
                   else if (gain === maxSprintGain) { sprintGainers.push(normDriver); }
               }
            });
        }
    } catch(e) { console.log("No sprint data for this round."); }

    // 6. Evaluate all predictions
    const predictions = await db.execute("SELECT * FROM f1_predictions").then(r => r.rows);
    let scores = {};
    let lowestActiveScore = Infinity;

    predictions.forEach(p => {
        let score = 0;

        // Differential Driver Scoring
        const evalPos = (predictedName, targetPos) => {
            if (!predictedName) return;
            const normName = normalizeStr(predictedName);
            const actualPos = actualDriverPositions[normName];
            if (!actualPos) return; 
            const diff = Math.abs(targetPos - actualPos);
            score -= diff;
            if (diff === 0) score += 2;
        };

        evalPos(p.p1, 1); evalPos(p.p2, 2); evalPos(p.p3, 3);
        evalPos(p.p10, 10); evalPos(p.p11, 11); evalPos(p.p19, 19); evalPos(p.p20, 20);

        // Differential Constructor Scoring
        const evalCon = (predictedName, targetRank) => {
            if (!predictedName) return;
            const normC = normalizeConstructor(predictedName);
            const actualRank = actualConstructorRanks[normC];
            if (!actualRank) return;
            const diff = Math.abs(targetRank - actualRank);
            score -= diff;
            if (diff === 0) score += 2;
        };

        evalCon(p.c1, 1); evalCon(p.c2, 2); evalCon(p.c5, 5); evalCon(p.c6, 6); evalCon(p.c10, 10);

        // Apply Wildcards
        if (p.w_race_loser && raceLosers.includes(normalizeStr(p.w_race_loser))) score += 5;
        if (p.w_sprint_gainer && sprintGainers.includes(normalizeStr(p.w_sprint_gainer))) score += 5;
        if (p.w_sprint_loser && sprintLosers.includes(normalizeStr(p.w_sprint_loser))) score += 5;

        scores[p.user_name] = score;
        if (score < lowestActiveScore) lowestActiveScore = score;
    });

    // 7. Apply Missed Lock Penalty
    if (lowestActiveScore === Infinity) lowestActiveScore = 0;
    const penaltyScore = lowestActiveScore - 5;

    const allDrivers = await db.execute("SELECT * FROM f1_drivers").then(r => r.rows);
    for (const driver of allDrivers) {
        let finalScore = penaltyScore;
        if (scores[driver.name] !== undefined) {
            finalScore = scores[driver.name];
        }
        await db.execute({
            sql: "UPDATE f1_drivers SET total_score = total_score + ? WHERE name = ?",
            args: [finalScore, driver.name]
        });
    }

    // 8. Wipe predictions for the next race
    await db.execute("DELETE FROM f1_predictions");

    res.json({ success: true, message: "Scores calculated and Grid reset successfully!" });

  } catch (error) {
    console.error("❌ ADMIN FINALIZE ERROR:", error);
    res.status(500).json({ success: false, message: "Admin calculation failed." });
  }
});

// --- FRONTEND FALLBACK ---
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`🏁 Engine started on port ${port}`);
});

// --- SELF-PING / ANTI-SLEEP HEARTBEAT ---
const APP_URL = process.env.RENDER_EXTERNAL_URL || 'https://f1-predictor-league.onrender.com';
const PING_INTERVAL = 14 * 60 * 1000; 

setInterval(async () => {
  try {
    const response = await fetch(`${APP_URL}/api/next-race`);
    if (response.ok) {
      console.log(`🔥 Heartbeat successful: Engine kept warm at ${new Date().toLocaleTimeString()}`);
    }
  } catch (error) {
    console.error(`⚠️ Heartbeat failed: Could not ping self.`, error.message);
  }
}, PING_INTERVAL);