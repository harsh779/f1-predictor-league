const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = 3000;

app.use(express.json()); 
app.use(express.static('public'));

app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

const db = new sqlite3.Database('./f1-league.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, 
      name TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      total_score INTEGER DEFAULT 0
  )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT UNIQUE NOT NULL,
      p1 TEXT, p2 TEXT, p3 TEXT, p10 TEXT, p11 TEXT, p19 TEXT, p20 TEXT,
      c1 TEXT, c2 TEXT, c5 TEXT, c6 TEXT, c10 TEXT,
      w_driver TEXT, w_constructor TEXT, w_race_loser TEXT, w_sprint_gainer TEXT, w_sprint_loser TEXT
    )
  `);
});

// --- DYNAMIC DEADLINE ENGINE ---
async function getDynamicDeadline() {
    try {
        const response = await fetch('http://api.jolpi.ca/ergast/f1/current/next.json');
        const data = await response.json();
        if (data.MRData.RaceTable.Races.length > 0) {
            const race = data.MRData.RaceTable.Races[0];
            // Uses FP1 time if it exists, otherwise defaults to midnight of race day
            const deadlineString = race.FirstPractice ? `${race.FirstPractice.date}T${race.FirstPractice.time}` : `${race.date}T00:00:00Z`;
            return new Date(deadlineString);
        }
    } catch (e) {
        // Safe fallback for pre-season testing (Australian GP 2026)
        return new Date("2026-03-06T01:30:00Z");
    }
    return new Date("2026-03-06T01:30:00Z");
}

app.get('/api/next-race', async (req, res) => {
    try {
        const response = await fetch('http://api.jolpi.ca/ergast/f1/current/next.json');
        const data = await response.json();
        if (data.MRData.RaceTable.Races.length > 0) {
            const race = data.MRData.RaceTable.Races[0];
            const deadline = race.FirstPractice ? `${race.FirstPractice.date}T${race.FirstPractice.time}` : `${race.date}T00:00:00Z`;
            res.json({ name: race.raceName, round: race.round, deadline: deadline });
        } else { throw new Error("No upcoming races found."); }
    } catch (e) {
        res.json({ name: "Australian Grand Prix (Pre-Season)", round: "1", deadline: "2026-03-06T01:30:00Z" });
    }
});

app.post('/register', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).send("Name and Password are required.");
  db.run(`INSERT INTO users (name, password) VALUES (?, ?)`, [name.trim(), password], function(err) {
    if (err) return res.status(400).send("Player is already registered!");
    res.send(`✅ ${name} registered successfully! You can now log in.`);
  });
});

app.post('/login', (req, res) => {
  const { name, password } = req.body;
  db.get(`SELECT name, total_score FROM users WHERE name = ? AND password = ?`, [name.trim(), password], (err, row) => {
      if (!row) return res.status(401).send("❌ Invalid name or password.");
      res.json({ message: `Welcome to the Paddock, ${row.name}`, user: row.name, total_score: row.total_score });
  });
});

app.post('/predict', async (req, res) => {
  // SECURE DYNAMIC LOCK: Verifies the real-world time against the API's FP1 time
  const currentDeadline = await getDynamicDeadline();
  if (new Date() > currentDeadline) {
      return res.status(403).send("❌ Grid is locked. Practice 1 has already started.");
  }

  const d = req.body;
  
  db.get("SELECT name FROM users WHERE name = ? AND password = ?", [d.user_name.trim(), d.password], (err, row) => {
    if (!row) return res.status(401).send(`❌ Unauthorized: Invalid credentials.`);

    // UPSERT LOGIC: This safely handles the "re-fill n times" rule
    const sql = `INSERT INTO predictions (user_name, p1, p2, p3, p10, p11, p19, p20, c1, c2, c5, c6, c10, w_driver, w_constructor, w_race_loser, w_sprint_gainer, w_sprint_loser) 
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(user_name) DO UPDATE SET p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p10=excluded.p10, p11=excluded.p11, p19=excluded.p19, p20=excluded.p20, c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c10=excluded.c10, w_driver=excluded.w_driver, w_constructor=excluded.w_constructor, w_race_loser=excluded.w_race_loser, w_sprint_gainer=excluded.w_sprint_gainer, w_sprint_loser=excluded.w_sprint_loser`;
                 
    db.run(sql, [d.user_name.trim(), d.p1, d.p2, d.p3, d.p10, d.p11, d.p19, d.p20, d.c1, d.c2, d.c5, d.c6, d.c10, d.w_driver, d.w_constructor, d.w_race_loser, d.w_sprint_gainer, d.w_sprint_loser], (err) => {
      if (err) return res.status(500).send("Database Error: " + err.message);
      res.send("✅ Strategy locked in successfully.");
    });
  });
});

app.post('/api/predictions/me', (req, res) => {
    const { user_name, password } = req.body;
    db.get("SELECT name FROM users WHERE name = ? AND password = ?", [user_name, password], (err, user) => {
        if (!user) return res.status(401).send("Unauthorized");
        
        db.get("SELECT * FROM predictions WHERE user_name = ?", [user_name], (err, row) => {
            if (err) return res.status(500).send("Database Error");
            if (!row) return res.status(404).send("No predictions found");
            res.json(row);
        });
    });
});

async function fetchLiveRaceData() {
    return {
        driverResults: { 
            "Max Verstappen": 1, "Charles Leclerc": 2, "Lando Norris": 3, "Oscar Piastri": 4, 
            "Carlos Sainz": 5, "George Russell": 6, "Lewis Hamilton": 7, "Fernando Alonso": 8, 
            "Pierre Gasly": 9, "Lance Stroll": 10, "Esteban Ocon": 11, "Alex Albon": 12, 
            "Nico Hulkenberg": 13, "Valtteri Bottas": 14, "Gabriel Bortoleto": 15, "Franco Colapinto": 16, 
            "Isack Hadjar": 17, "Kimi Antonelli": 18, "Liam Lawson": 19, "Arvid Lindblad": 20, 
            "Sergio Perez": 21, "Oliver Bearman": 22 
        },
        wildcards: { race_winner: "Max Verstappen", constructor_winner: "Red Bull", race_loser: "Valtteri Bottas", sprint_gainer: "Oscar Piastri", sprint_loser: "Sergio Perez" }
    };
}

const teamRosters = {
    "McLaren": ["Lando Norris", "Oscar Piastri"], "Red Bull": ["Max Verstappen", "Isack Hadjar"],
    "Ferrari": ["Charles Leclerc", "Lewis Hamilton"], "Mercedes": ["George Russell", "Kimi Antonelli"],
    "Aston Martin": ["Fernando Alonso", "Lance Stroll"], "Alpine": ["Pierre Gasly", "Franco Colapinto"],
    "Haas": ["Esteban Ocon", "Oliver Bearman"], "Racing Bulls": ["Liam Lawson", "Arvid Lindblad"],
    "Williams": ["Alex Albon", "Carlos Sainz"], "Audi": ["Nico Hulkenberg", "Gabriel Bortoleto"],
    "Cadillac": ["Sergio Perez", "Valtteri Bottas"]
};

function getConstructorRanks(driverData) {
    let sums = [];
    for (let team in teamRosters) {
        sums.push({ name: team, total: (driverData[teamRosters[team][0]] || 20) + (driverData[teamRosters[team][1]] || 20) });
    }
    sums.sort((a, b) => a.total - b.total);
    let ranks = {}; let currentRank = 1;
    for (let i = 0; i < sums.length; i++) {
        if (i > 0 && sums[i].total === sums[i-1].total) ranks[sums[i].name] = currentRank;
        else ranks[sums[i].name] = currentRank = i + 1;
    }
    return ranks;
}

app.get('/api/predictions', async (req, res) => {
  const liveData = await fetchLiveRaceData();
  const cRanks = getConstructorRanks(liveData.driverResults);

  db.all("SELECT * FROM predictions", [], (err, predictions) => {
    let results = predictions.map(u => {
      let score = 0;
      const calc = (name, target, data) => { let actual = data[name] || 20; if (target === actual) score += 2; else score -= Math.abs(target - actual); };
      [u.p1, u.p2, u.p3, u.p10, u.p11, u.p19, u.p20].forEach((n, i) => calc(n, [1,2,3,10,11,19,20][i], liveData.driverResults));
      [u.c1, u.c2, u.c5, u.c6, u.c10].forEach((n, i) => { let actual = cRanks[n] || 11; let target = [1,2,5,6,10][i]; if (target === actual) score += 2; else score -= Math.abs(target - actual); });
      
      if (u.w_driver === liveData.wildcards.race_winner) score += 50;
      if (u.w_constructor === liveData.wildcards.constructor_winner) score += 25;
      if (u.w_race_loser === liveData.wildcards.race_loser) score += 5;
      if (u.w_sprint_gainer === liveData.wildcards.sprint_gainer) score += 5;
      if (u.w_sprint_loser === liveData.wildcards.sprint_loser) score += 5;
      u.total_score = score; return u;
    });

    db.all("SELECT name FROM users", [], (err, allUsers) => {
      let submitted = results.map(r => r.user_name);
      let penaltyVal = results.length > 0 ? Math.min(...results.map(r => r.total_score)) - 5 : 0;
      allUsers.forEach(user => {
        if (!submitted.includes(user.name)) {
          results.push({ user_name: user.name, total_score: penaltyVal, p1: "MISSED", c1: "MISSED", w_driver: "MISSED" });
        }
      });
      res.json(results.sort((a,b) => b.total_score - a.total_score));
    });
  });
});

app.post('/api/finalize', async (req, res) => {
    const response = await fetch(`http://localhost:${port}/api/predictions`);
    const currentScores = await response.json();

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        currentScores.forEach(user => {
            db.run(`UPDATE users SET total_score = total_score + ? WHERE name = ?`, [user.total_score, user.user_name]);
        });
        db.run("DELETE FROM predictions"); 
        db.run("COMMIT", (err) => {
            if (err) return res.status(500).send("Failed to finalize.");
            res.send("✅ Race Finalized! Points committed to Season Leaderboard.");
        });
    });
});

app.get('/api/season-leaderboard', (req, res) => {
    db.all("SELECT name, total_score FROM users ORDER BY total_score DESC", [], (err, rows) => {
        res.json(rows);
    });
});

app.get('/api/season-results', async (req, res) => {
    try {
        const response = await fetch('http://api.jolpi.ca/ergast/f1/2025/results/1.json');
        const data = await response.json();
        const races = data.MRData.RaceTable.Races.map(r => ({
            round: r.round, name: r.raceName,
            winner: `${r.Results[0].Driver.givenName} ${r.Results[0].Driver.familyName}`,
            team: r.Results[0].Constructor.name
        }));
        res.json(races);
    } catch (e) {
        res.status(500).json({ error: "Could not load season results." });
    }
});

app.listen(port, () => console.log(`Server running on http://localhost:${port}`));