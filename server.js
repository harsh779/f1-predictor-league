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

// --- SELF-HEALING CALENDAR ENDPOINT ---
app.get('/api/next-race', (req, res) => {
  const now = new Date(); // Back to Real-Time
  
  let nextRace = f1Calendar2026.find(race => new Date(race.date) > now);
  if (!nextRace) nextRace = f1Calendar2026[23]; 

  res.json({ 
    round: nextRace.round, 
    name: nextRace.name, 
    hasSprint: nextRace.hasSprint, 
    deadline: nextRace.date 
  });
});

// --- LIVE API: FETCH REAL F1 RESULTS ---
app.get('/api/season-results', async (req, res) => {
  try {
    const response = await fetch('http://api.jolpi.ca/ergast/f1/current/results/1.json');
    const data = await response.json();
    const races = data.MRData.RaceTable.Races;
    
    // If the season hasn't started yet or returned empty
    if (!races || races.length === 0) {
        return res.json([{ round: "-", name: "Awaiting Lights Out", winner: "-", team: "-" }]);
    }

    const formattedResults = races.map(race => ({
      round: race.round,
      name: race.raceName,
      winner: race.Results[0].Driver.familyName,
      team: race.Results[0].Constructor.name
    }));
    
    res.json(formattedResults);
  } catch (error) {
    console.error("API Fetch Error:", error);
    res.json([{ round: "ERR", name: "API Offline", winner: "-", team: "-" }]);
  }
});

app.post('/api/finalize', async (req, res) => {
  try {
    await db.execute("DELETE FROM f1_predictions");
    res.json({ success: true, message: "Race finalized. Grid reset." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Admin error" });
  }
});

// --- FRONTEND FALLBACK ---
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`🏁 Engine started on port ${port}`);
});