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
    // Creating fresh tables with the exact columns your frontend expects
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
        w_driver TEXT, w_constructor TEXT, w_race_loser TEXT, w_sprint_gainer TEXT, w_sprint_loser TEXT
      )
    `);
    console.log("✅ Custom F1 Tables verified and aligned with frontend.");
  } catch (error) {
    console.error("❌ Database setup failed:", error);
  }
}
setupDatabase();

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
  const { user_name, password, p1, p2, p3, p10, p11, p19, p20, c1, c2, c5, c6, c10, w_driver, w_constructor, w_race_loser, w_sprint_gainer, w_sprint_loser } = req.body;
  
  try {
    // Security check: Make sure user actually exists before accepting picks
    const auth = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [user_name, password] });
    if (auth.rows.length === 0) return res.status(401).json({success: false, message: "Unauthorized"});

    // Upsert: Insert new picks, or update them if the user already predicted
    await db.execute({
      sql: `INSERT INTO f1_predictions (user_name, p1, p2, p3, p10, p11, p19, p20, c1, c2, c5, c6, c10, w_driver, w_constructor, w_race_loser, w_sprint_gainer, w_sprint_loser) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_name) DO UPDATE SET 
            p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p10=excluded.p10, p11=excluded.p11, p19=excluded.p19, p20=excluded.p20,
            c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c10=excluded.c10,
            w_driver=excluded.w_driver, w_constructor=excluded.w_constructor, w_race_loser=excluded.w_race_loser, 
            w_sprint_gainer=excluded.w_sprint_gainer, w_sprint_loser=excluded.w_sprint_loser`,
      args: [user_name, p1, p2, p3, p10, p11, p19, p20, c1, c2, c5, c6, c10, w_driver, w_constructor, w_race_loser, w_sprint_gainer, w_sprint_loser]
    });
    res.json({ success: true, message: "Strategy locked in!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to save prediction." });
  }
});

// Fetches the logged-in user's previous picks to repopulate dropdowns
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

// Live Tower
app.get('/api/predictions', async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT p.user_name, d.total_score, p.p1, p.p2, p.c1, p.c2, p.w_driver, p.w_race_loser 
      FROM f1_predictions p JOIN f1_drivers d ON p.user_name = d.name
    `);
    res.json(result.rows);
  } catch (error) {
    res.json([]);
  }
});

// Standings
app.get('/api/season-leaderboard', async (req, res) => {
  try {
    const result = await db.execute("SELECT name, total_score FROM f1_drivers ORDER BY total_score DESC");
    res.json(result.rows);
  } catch (error) {
    res.json([]);
  }
});

// Temporary Fallback APIs until we wire up Jolpica Live Data
app.get('/api/next-race', (req, res) => {
  res.json({ round: 1, name: "Australian Grand Prix", deadline: new Date(Date.now() + 86400000 * 5).toISOString() });
});

app.get('/api/season-results', (req, res) => {
  res.json([{ round: "-", name: "Awaiting Lights Out", winner: "-", team: "-" }]);
});

// Admin override to clear grid for next race
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