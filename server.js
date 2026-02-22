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
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// --- DATABASE INITIALIZATION ---
async function setupDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS drivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        total_points INTEGER DEFAULT 0
      )
    `);
    
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
app.post('/register', async (req, res) => {
  console.log("📥 Incoming Register Request:", req.body);
  const { username, password } = req.body;
  
  try {
    const result = await db.execute({
      sql: "INSERT INTO drivers (username, password) VALUES (?, ?)",
      args: [username || null, password || null] 
    });
    res.json({ success: true, message: "Driver registered successfully!", id: result.lastInsertRowid.toString() });
  } catch (error) {
    console.error("❌ REGISTER ERROR:", error);
    if (error.message && error.message.includes("UNIQUE")) {
      res.status(400).json({ success: false, message: "Username already taken. Please choose another." });
    } else {
      res.status(500).json({ success: false, message: "Server error during registration." });
    }
  }
});

// 2. Login a Driver
app.post('/login', async (req, res) => {
  console.log("📥 Incoming Login Request:", req.body);
  const { username, password } = req.body;
  
  try {
    const result = await db.execute({
      sql: "SELECT * FROM drivers WHERE username = ? AND password = ?",
      args: [username || null, password || null]
    });
    
    if (result.rows.length > 0) {
      res.json({ success: true, driver: result.rows[0] });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials." });
    }
  } catch (error) {
    console.error("❌ LOGIN ERROR:", error);
    res.status(500).json({ success: false, message: "Server error during login." });
  }
});

// 3. Lock in a Prediction
app.post('/predict', async (req, res) => {
  console.log("📥 Incoming Predict Request:", req.body);
  const { driver_id, race_name, predicted_position } = req.body;
  try {
    await db.execute({
      sql: "INSERT INTO predictions (driver_id, race_name, predicted_position) VALUES (?, ?, ?)",
      args: [driver_id || null, race_name || null, predicted_position || null]
    });
    res.json({ success: true, message: "Prediction locked in!" });
  } catch (error) {
    console.error("❌ PREDICT ERROR:", error);
    res.status(500).json({ success: false, message: "Failed to save prediction to cloud." });
  }
});

// 4. Fetch the Leaderboard
app.get('/leaderboard', async (req, res) => {
  try {
    const result = await db.execute("SELECT username, total_points FROM drivers ORDER BY total_points DESC");
    res.json({ success: true, leaderboard: result.rows });
  } catch (error) {
    console.error("❌ LEADERBOARD ERROR:", error);
    res.status(500).json({ success: false, message: "Failed to fetch leaderboard." });
  }
});

// --- FRONTEND FALLBACK ---
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- IGNITION ---
app.listen(port, () => {
  console.log(`🏁 Pit lane open! Server running on port ${port}`);
});