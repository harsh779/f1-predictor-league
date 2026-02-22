const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(express.json());
// Serves your frontend files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public'))); 

// --- CLOUD DATABASE CONNECTION (TURSO) ---
// This uses environment variables so your secrets stay off GitHub
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// --- DATABASE INITIALIZATION ---
// This runs once when the server boots to ensure your tables exist
async function setupDatabase() {
  try {
    // 1. Create Drivers Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS drivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        total_points INTEGER DEFAULT 0
      )
    `);
    
    // 2. Create Predictions Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id INTEGER,
        race_name TEXT,
        predicted_position INTEGER,
        actual_position INTEGER,
        FOREIGN KEY(driver_id) REFERENCES drivers(id)
      )
    `);
    console.log("✅ Turso Cloud Database connected and tables verified.");
  } catch (error) {
    console.error("❌ Database setup failed:", error);
  }
}
setupDatabase();

// --- API ROUTES ---

// 1. Register a new Driver
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({
      sql: "INSERT INTO drivers (username, password) VALUES (?, ?)",
      args: [username, password]
    });
    // result.lastInsertRowid gives us the new user's ID
    res.json({ success: true, message: "Driver registered successfully!", id: result.lastInsertRowid.toString() });
  } catch (error) {
    if (error.message.includes("UNIQUE")) {
      res.status(400).json({ success: false, message: "Username already taken. Please choose another." });
    } else {
      res.status(500).json({ success: false, message: "Server error during registration." });
    }
  }
});

// 2. Login a Driver
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({
      sql: "SELECT * FROM drivers WHERE username = ? AND password = ?",
      args: [username, password]
    });
    
    if (result.rows.length > 0) {
      res.json({ success: true, driver: result.rows[0] });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials." });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error during login." });
  }
});

// 3. Lock in a Prediction
app.post('/api/predict', async (req, res) => {
  const { driver_id, race_name, predicted_position } = req.body;
  try {
    await db.execute({
      sql: "INSERT INTO predictions (driver_id, race_name, predicted_position) VALUES (?, ?, ?)",
      args: [driver_id, race_name, predicted_position]
    });
    res.json({ success: true, message: "Prediction locked in!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to save prediction to cloud." });
  }
});

// 4. Fetch the Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await db.execute("SELECT username, total_points FROM drivers ORDER BY total_points DESC");
    res.json({ success: true, leaderboard: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch leaderboard." });
  }
});

// --- FRONTEND FALLBACK ---
// This ensures that if someone refreshes the page, it loads the HTML correctly
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- IGNITION ---
app.listen(port, () => {
  console.log(`🏁 Pit lane open! Server running on port ${port}`);
});