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

// --- 1. DATABASE SETUP ---
async function setupDatabase() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, password TEXT, total_score INTEGER DEFAULT 0, has_participated INTEGER DEFAULT 0, is_vip INTEGER DEFAULT 0)`);
    
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN has_participated INTEGER DEFAULT 0`); } catch(e) {}
    try { await db.execute(`ALTER TABLE f1_drivers ADD COLUMN is_vip INTEGER DEFAULT 0`); } catch(e) {}

    // Bumped to v3 to handle the 22-car grid
    await db.execute(`CREATE TABLE IF NOT EXISTS f1_predictions_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_name TEXT UNIQUE, 
        p1 TEXT, p2 TEXT, p3 TEXT, 
        p11 TEXT, p12 TEXT, 
        p21 TEXT, p22 TEXT, 
        c1 TEXT, c2 TEXT, c5 TEXT, c6 TEXT, c10 TEXT, 
        w_race_loser TEXT, 
        w_sprint_gainer TEXT, w_sprint_loser TEXT
    )`);
    
    await db.execute({ sql: "INSERT INTO f1_drivers (name, password, has_participated, is_vip) VALUES ('admin', 'Open@0761', 0, 1) ON CONFLICT(name) DO NOTHING" });
    console.log("✅ Database Synced for 22-Car Grid.");
  } catch (e) { console.error("DB Error:", e); }
}
setupDatabase();

// --- 2. FULL 2026 CALENDAR (ENRICHED WITH CIRCUIT INTEL) ---
const f1Calendar2026 = [
  { round: 1, name: "Australian Grand Prix", hasSprint: false, date: "2026-03-06T07:00:00+05:30", circuit: "Albert Park Circuit", country: "Australia", trackDetails: { length: "5.278 km", laps: 58, corners: 14, firstGP: 1996, record: "1:19.813" }, sessions: { fp1: "2026-03-06T07:00:00+05:30", fp2: "2026-03-06T10:30:00+05:30", fp3: "2026-03-07T07:00:00+05:30", quali: "2026-03-07T10:30:00+05:30", race: "2026-03-08T09:30:00+05:30" } },
  { round: 2, name: "Chinese Grand Prix", hasSprint: true, date: "2026-03-13T09:00:00+05:30", circuit: "Shanghai International Circuit", country: "China", trackDetails: { length: "5.451 km", laps: 56, corners: 16, firstGP: 2004, record: "1:32.238" }, sessions: { fp1: "2026-03-13T09:00:00+05:30", sprintQuali: "2026-03-13T13:00:00+05:30", sprint: "2026-03-14T09:00:00+05:30", quali: "2026-03-14T13:00:00+05:30", race: "2026-03-15T12:30:00+05:30" } },
  { round: 3, name: "Japanese Grand Prix", hasSprint: false, date: "2026-03-27T08:00:00+05:30", circuit: "Suzuka International Racing Course", country: "Japan", trackDetails: { length: "5.807 km", laps: 53, corners: 18, firstGP: 1987, record: "1:30.983" }, sessions: { fp1: "2026-03-27T08:00:00+05:30", fp2: "2026-03-27T11:30:00+05:30", fp3: "2026-03-28T08:00:00+05:30", quali: "2026-03-28T11:30:00+05:30", race: "2026-03-29T10:30:00+05:30" } },
  { round: 4, name: "Bahrain Grand Prix", hasSprint: false, date: "2026-04-10T17:00:00+05:30", circuit: "Bahrain International Circuit", country: "Bahrain", trackDetails: { length: "5.412 km", laps: 57, corners: 15, firstGP: 2004, record: "1:31.447" }, sessions: { fp1: "2026-04-10T17:00:00+05:30", fp2: "2026-04-10T20:30:00+05:30", fp3: "2026-04-11T17:30:00+05:30", quali: "2026-04-11T21:30:00+05:30", race: "2026-04-12T20:30:00+05:30" } },
  { round: 5, name: "Saudi Arabian Grand Prix", hasSprint: false, date: "2026-04-17T19:00:00+05:30", circuit: "Jeddah Corniche Circuit", country: "Saudi Arabia", trackDetails: { length: "6.174 km", laps: 50, corners: 27, firstGP: 2021, record: "1:30.734" }, sessions: { fp1: "2026-04-17T19:00:00+05:30", fp2: "2026-04-17T22:30:00+05:30", fp3: "2026-04-18T19:00:00+05:30", quali: "2026-04-18T22:30:00+05:30", race: "2026-04-19T22:30:00+05:30" } },
  { round: 6, name: "Miami Grand Prix", hasSprint: true, date: "2026-05-01T22:00:00+05:30", circuit: "Miami International Autodrome", country: "United States", trackDetails: { length: "5.412 km", laps: 57, corners: 19, firstGP: 2022, record: "1:29.708" }, sessions: { fp1: "2026-05-01T22:00:00+05:30", sprintQuali: "2026-05-02T02:00:00+05:30", sprint: "2026-05-02T21:30:00+05:30", quali: "2026-05-03T01:30:00+05:30", race: "2026-05-04T01:30:00+05:30" } },
  { round: 7, name: "Canadian Grand Prix", hasSprint: true, date: "2026-05-22T23:00:00+05:30", circuit: "Circuit Gilles-Villeneuve", country: "Canada", trackDetails: { length: "4.361 km", laps: 70, corners: 14, firstGP: 1978, record: "1:13.078" }, sessions: { fp1: "2026-05-22T23:00:00+05:30", sprintQuali: "2026-05-23T03:00:00+05:30", sprint: "2026-05-23T21:30:00+05:30", quali: "2026-05-24T01:30:00+05:30", race: "2026-05-24T23:30:00+05:30" } },
  { round: 8, name: "Monaco Grand Prix", hasSprint: false, date: "2026-06-05T17:00:00+05:30", circuit: "Circuit de Monaco", country: "Monaco", trackDetails: { length: "3.337 km", laps: 78, corners: 19, firstGP: 1950, record: "1:12.909" }, sessions: { fp1: "2026-06-05T17:00:00+05:30", fp2: "2026-06-05T20:30:00+05:30", fp3: "2026-06-06T16:00:00+05:30", quali: "2026-06-06T19:30:00+05:30", race: "2026-06-07T18:30:00+05:30" } },
  { round: 9, name: "Spanish Grand Prix", hasSprint: false, date: "2026-06-12T17:00:00+05:30", circuit: "Circuit de Barcelona-Catalunya", country: "Spain", trackDetails: { length: "4.657 km", laps: 66, corners: 14, firstGP: 1991, record: "1:15.743" }, sessions: { fp1: "2026-06-12T17:00:00+05:30", fp2: "2026-06-12T20:30:00+05:30", fp3: "2026-06-13T16:00:00+05:30", quali: "2026-06-13T19:30:00+05:30", race: "2026-06-14T18:30:00+05:30" } },
  { round: 10, name: "Austrian Grand Prix", hasSprint: false, date: "2026-06-26T16:00:00+05:30", circuit: "Red Bull Ring", country: "Austria", trackDetails: { length: "4.318 km", laps: 71, corners: 10, firstGP: 1970, record: "1:05.619" }, sessions: { fp1: "2026-06-26T16:00:00+05:30", fp2: "2026-06-26T19:30:00+05:30", fp3: "2026-06-27T16:00:00+05:30", quali: "2026-06-27T19:30:00+05:30", race: "2026-06-28T18:30:00+05:30" } },
  { round: 11, name: "British Grand Prix", hasSprint: true, date: "2026-07-03T17:00:00+05:30", circuit: "Silverstone Circuit", country: "Great Britain", trackDetails: { length: "5.891 km", laps: 52, corners: 18, firstGP: 1950, record: "1:27.097" }, sessions: { fp1: "2026-07-03T17:00:00+05:30", sprintQuali: "2026-07-03T21:00:00+05:30", sprint: "2026-07-04T16:30:00+05:30", quali: "2026-07-04T20:30:00+05:30", race: "2026-07-05T19:30:00+05:30" } },
  { round: 12, name: "Belgian Grand Prix", hasSprint: false, date: "2026-07-17T17:00:00+05:30", circuit: "Circuit de Spa-Francorchamps", country: "Belgium", trackDetails: { length: "7.004 km", laps: 44, corners: 19, firstGP: 1950, record: "1:46.286" }, sessions: { fp1: "2026-07-17T17:00:00+05:30", fp2: "2026-07-17T20:30:00+05:30", fp3: "2026-07-18T16:00:00+05:30", quali: "2026-07-18T19:30:00+05:30", race: "2026-07-19T18:30:00+05:30" } },
  { round: 13, name: "Hungarian Grand Prix", hasSprint: false, date: "2026-07-24T17:00:00+05:30", circuit: "Hungaroring", country: "Hungary", trackDetails: { length: "4.381 km", laps: 70, corners: 14, firstGP: 1986, record: "1:16.627" }, sessions: { fp1: "2026-07-24T17:00:00+05:30", fp2: "2026-07-24T20:30:00+05:30", fp3: "2026-07-25T16:00:00+05:30", quali: "2026-07-25T19:30:00+05:30", race: "2026-07-26T18:30:00+05:30" } },
  { round: 14, name: "Dutch Grand Prix", hasSprint: true, date: "2026-08-21T16:00:00+05:30", circuit: "Circuit Zandvoort", country: "Netherlands", trackDetails: { length: "4.259 km", laps: 72, corners: 14, firstGP: 1952, record: "1:11.097" }, sessions: { fp1: "2026-08-21T16:00:00+05:30", sprintQuali: "2026-08-21T20:00:00+05:30", sprint: "2026-08-22T15:30:00+05:30", quali: "2026-08-22T19:30:00+05:30", race: "2026-08-23T18:30:00+05:30" } },
  { round: 15, name: "Italian Grand Prix", hasSprint: false, date: "2026-09-04T17:00:00+05:30", circuit: "Autodromo Nazionale Monza", country: "Italy", trackDetails: { length: "5.793 km", laps: 53, corners: 11, firstGP: 1950, record: "1:20.901" }, sessions: { fp1: "2026-09-04T17:00:00+05:30", fp2: "2026-09-04T20:30:00+05:30", fp3: "2026-09-05T16:00:00+05:30", quali: "2026-09-05T19:30:00+05:30", race: "2026-09-06T18:30:00+05:30" } },
  { round: 16, name: "Madrid Grand Prix", hasSprint: false, date: "2026-09-11T17:00:00+05:30", circuit: "IFEMA Madrid", country: "Spain", trackDetails: { length: "5.474 km", laps: 55, corners: 20, firstGP: 2026, record: "NEW CIRCUIT" }, sessions: { fp1: "2026-09-11T17:00:00+05:30", fp2: "2026-09-11T20:30:00+05:30", fp3: "2026-09-12T16:00:00+05:30", quali: "2026-09-12T19:30:00+05:30", race: "2026-09-13T18:30:00+05:30" } },
  { round: 17, name: "Azerbaijan Grand Prix", hasSprint: false, date: "2026-09-25T15:00:00+05:30", circuit: "Baku City Circuit", country: "Azerbaijan", trackDetails: { length: "6.003 km", laps: 51, corners: 20, firstGP: 2016, record: "1:43.009" }, sessions: { fp1: "2026-09-25T15:00:00+05:30", fp2: "2026-09-25T18:30:00+05:30", fp3: "2026-09-26T15:00:00+05:30", quali: "2026-09-26T18:30:00+05:30", race: "2026-09-27T16:30:00+05:30" } },
  { round: 18, name: "Singapore Grand Prix", hasSprint: true, date: "2026-10-09T15:00:00+05:30", circuit: "Marina Bay Street Circuit", country: "Singapore", trackDetails: { length: "4.940 km", laps: 62, corners: 19, firstGP: 2008, record: "1:34.486" }, sessions: { fp1: "2026-10-09T15:00:00+05:30", sprintQuali: "2026-10-09T19:00:00+05:30", sprint: "2026-10-10T15:00:00+05:30", quali: "2026-10-10T19:00:00+05:30", race: "2026-10-11T17:30:00+05:30" } },
  { round: 19, name: "United States Grand Prix", hasSprint: false, date: "2026-10-23T23:00:00+05:30", circuit: "Circuit of The Americas", country: "United States", trackDetails: { length: "5.513 km", laps: 56, corners: 20, firstGP: 2012, record: "1:36.169" }, sessions: { fp1: "2026-10-23T23:00:00+05:30", fp2: "2026-10-24T03:00:00+05:30", fp3: "2026-10-24T23:30:00+05:30", quali: "2026-10-25T03:30:00+05:30", race: "2026-10-26T00:30:00+05:30" } },
  { round: 20, name: "Mexico City Grand Prix", hasSprint: false, date: "2026-10-31T00:30:00+05:30", circuit: "Autódromo Hermanos Rodríguez", country: "Mexico", trackDetails: { length: "4.304 km", laps: 71, corners: 17, firstGP: 1963, record: "1:17.774" }, sessions: { fp1: "2026-10-31T00:30:00+05:30", fp2: "2026-10-31T04:00:00+05:30", fp3: "2026-10-31T23:00:00+05:30", quali: "2026-11-01T02:30:00+05:30", race: "2026-11-02T01:30:00+05:30" } },
  { round: 21, name: "São Paulo Grand Prix", hasSprint: false, date: "2026-11-06T20:00:00+05:30", circuit: "Autódromo José Carlos Pace", country: "Brazil", trackDetails: { length: "4.309 km", laps: 71, corners: 15, firstGP: 1973, record: "1:10.540" }, sessions: { fp1: "2026-11-06T20:00:00+05:30", fp2: "2026-11-06T23:30:00+05:30", fp3: "2026-11-07T19:00:00+05:30", quali: "2026-11-07T23:00:00+05:30", race: "2026-11-08T22:30:00+05:30" } },
  { round: 22, name: "Las Vegas Grand Prix", hasSprint: false, date: "2026-11-20T08:00:00+05:30", circuit: "Las Vegas Strip Circuit", country: "United States", trackDetails: { length: "6.201 km", laps: 50, corners: 17, firstGP: 2023, record: "1:35.490" }, sessions: { fp1: "2026-11-20T08:00:00+05:30", fp2: "2026-11-20T11:30:00+05:30", fp3: "2026-11-21T08:00:00+05:30", quali: "2026-11-21T11:30:00+05:30", race: "2026-11-22T11:30:00+05:30" } },
  { round: 23, name: "Qatar Grand Prix", hasSprint: false, date: "2026-11-27T19:00:00+05:30", circuit: "Lusail International Circuit", country: "Qatar", trackDetails: { length: "5.419 km", laps: 57, corners: 16, firstGP: 2021, record: "1:24.319" }, sessions: { fp1: "2026-11-27T19:00:00+05:30", fp2: "2026-11-27T22:30:00+05:30", fp3: "2026-11-28T18:30:00+05:30", quali: "2026-11-28T22:30:00+05:30", race: "2026-11-29T22:30:00+05:30" } },
  { round: 24, name: "Abu Dhabi Grand Prix", hasSprint: false, date: "2026-12-04T15:00:00+05:30", circuit: "Yas Marina Circuit", country: "United Arab Emirates", trackDetails: { length: "5.281 km", laps: 58, corners: 16, firstGP: 2009, record: "1:26.103" }, sessions: { fp1: "2026-12-04T15:00:00+05:30", fp2: "2026-12-04T18:30:00+05:30", fp3: "2026-12-05T16:00:00+05:30", quali: "2026-12-05T19:30:00+05:30", race: "2026-12-06T18:30:00+05:30" } }
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
  const url = "https://discord.com/api/webhooks/1476880265409335306/3N7tM1n8LUYucuCYCEWF3UzfDt9adgtzGKdqV433CG95J57SOwcyXOzSEbOgAiYK3MK3";
  try {
      await fetch(url, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ content: `🏎️ **F1 Steward:** ${msg}` }) 
      });
  } catch (e) { console.error("Discord Error:", e); }
}

// --- 4. SCORING ENGINE ---
async function performFinalization() {
  try {
    const raceRes = await fetch('https://api.jolpi.ca/ergast/f1/current/last/results.json').then(r => r.json());
    const races = raceRes.MRData.RaceTable.Races;
    if (!races || races.length === 0) return { success: false, message: "No data from F1 API." };
    
    const raceData = races[0];
    const results = raceData.Results;
    const check = await db.execute("SELECT count(*) as count FROM f1_predictions_v3");
    if (check.rows[0].count === 0) return { success: false, message: "No predictions found." };

    const actualDriverPositions = {};
    results.forEach(r => {
        const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
        let pos = parseInt(r.position);
        // DNF Rule changed to 22
        if (r.positionText === 'R' || r.positionText === 'D' || r.status.startsWith('Retired') || r.status.startsWith('Collision') || r.status.startsWith('Accident')) {
            pos = 22; 
        }
        actualDriverPositions[name] = pos;
    });

    const constructorSums = {};
    results.forEach(r => {
      const c = normalizeConstructor(r.Constructor.name);
      let pos = parseInt(r.position);
       // DNF Rule changed to 22
       if (r.positionText === 'R' || r.positionText === 'D') pos = 22; 
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
           // DNF Rule changed to 22
           if (r.positionText === 'R' || r.positionText === 'D') finish = 22;
           const drop = finish - parseInt(r.grid);
           const name = normalizeStr(`${r.Driver.givenName} ${r.Driver.familyName}`);
           if (drop > maxDrop) { maxDrop = drop; raceLosers = [name]; }
           else if (drop === maxDrop) raceLosers.push(name);
       }
    });

    const predictions = await db.execute("SELECT * FROM f1_predictions_v3").then(r => r.rows);
    let scores = {}; let lowest = Infinity;

    predictions.forEach(p => {
        let score = 0;
        const calc = (pred, actual) => {
            if (!actual) return 0;
            const diff = Math.abs(pred - actual);
            if (diff === 0) return 2;
            return -diff;
        };

        // Added P21 and P22 to scoring matrix
        const driversToScore = [
            { pred: p.p1, rank: 1 }, { pred: p.p2, rank: 2 }, { pred: p.p3, rank: 3 },
            { pred: p.p11, rank: 11 }, { pred: p.p12, rank: 12 },
            { pred: p.p21, rank: 21 }, { pred: p.p22, rank: 22 }
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

    await db.execute("DELETE FROM f1_predictions_v3");
    
    return { success: true, message: "Round Finalized." };
  } catch (e) { return { success: false, message: e.message }; }
}

// --- 5. CORE ROUTES ---
app.get('/api/next-race', (req, res) => {
  const now = new Date();
  const next = f1Calendar2026.find(r => {
      const raceEndBuffer = new Date(r.sessions.race);
      raceEndBuffer.setHours(raceEndBuffer.getHours() + 4);
      return raceEndBuffer > now;
  }) || f1Calendar2026[f1Calendar2026.length-1];
  
  const payload = { ...next, lockTime: next.sessions.quali };
  res.json(payload);
});

app.get('/api/calendar', (req, res) => { res.json(f1Calendar2026); });

app.post('/predict', async (req, res) => {
  const d = req.body;
  const auth = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [d.user_name, d.password] });
  if (auth.rows.length === 0) return res.status(401).json({ success: false, message: "Login failed" });

  const now = new Date();
  const currentRace = f1Calendar2026.find(r => {
      const raceEndBuffer = new Date(r.sessions.race);
      raceEndBuffer.setHours(raceEndBuffer.getHours() + 4);
      return raceEndBuffer > now;
  }); 
  if (!currentRace) return res.status(403).json({ success: false, message: "Season Over" });

  const lockTime = new Date(currentRace.sessions.quali);
  if (now > lockTime) {
      return res.status(403).json({ success: false, message: "Parc Fermé: Predictions are officially locked for this session!" });
  }

  try {
      await db.execute({
          sql: `INSERT INTO f1_predictions_v3 (user_name, p1, p2, p3, p11, p12, p21, p22, c1, c2, c5, c6, c10, w_race_loser, w_sprint_gainer, w_sprint_loser) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                ON CONFLICT(user_name) DO UPDATE SET 
                p1=excluded.p1, p2=excluded.p2, p3=excluded.p3, p11=excluded.p11, p12=excluded.p12, p21=excluded.p21, p22=excluded.p22, 
                c1=excluded.c1, c2=excluded.c2, c5=excluded.c5, c6=excluded.c6, c10=excluded.c10, 
                w_race_loser=excluded.w_race_loser, w_sprint_gainer=excluded.w_sprint_gainer, w_sprint_loser=excluded.w_sprint_loser`,
          args: [d.user_name, d.p1, d.p2, d.p3, d.p11, d.p12, d.p21, d.p22, d.c1, d.c2, d.c5, d.c6, d.c10, d.w_race_loser, d.w_sprint_gainer, d.w_sprint_loser]
      });
      
      await db.execute({ sql: `UPDATE f1_drivers SET has_participated = 1 WHERE name = ?`, args: [d.user_name] });
      res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/finalize', async (req, res) => {
  if (req.body.user_name !== 'admin' || req.body.password !== 'Open@0761') return res.status(403).json({ success: false });
  const result = await performFinalization();
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/register', async (req, res) => {
  try { 
      await db.execute({ sql: "INSERT INTO f1_drivers (name, password, has_participated, is_vip) VALUES (?, ?, 0, 0)", args: [req.body.name, req.body.password] }); 
      res.json({ success: true, message: "Registered!" }); 
  } catch (e) { res.status(400).json({ success: false, message: "Username Taken" }); }
});

app.post('/login', async (req, res) => {
  const r = await db.execute({ sql: "SELECT * FROM f1_drivers WHERE name = ? AND password = ?", args: [req.body.name, req.body.password] });
  if (r.rows.length > 0) res.json({ success: true, driver: r.rows[0] });
  else res.status(401).json({ success: false });
});

app.get('/api/predictions', async (req, res) => {
  const r = await db.execute("SELECT p.*, d.total_score FROM f1_predictions_v3 p JOIN f1_drivers d ON p.user_name = d.name");
  res.json(r.rows);
});

app.get('/api/season-leaderboard', async (req, res) => {
  const r = await db.execute("SELECT name, total_score, is_vip FROM f1_drivers WHERE name != 'admin' AND has_participated = 1 ORDER BY total_score DESC");
  res.json(r.rows);
});

// --- 6. ADMIN ROUTES ---
app.get('/api/admin/users', async (req, res) => {
const { user, pass } = req.query;
if (user !== 'admin' || pass !== 'Open@0761') return res.status(403).send("Unauthorized");
try {
    const r = await db.execute("SELECT id, name, total_score, has_participated, is_vip FROM f1_drivers WHERE name != 'admin' ORDER BY name ASC");
    res.json(r.rows);
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/toggle-vip', async (req, res) => {
const { adminUser, adminPass, targetUser, vipStatus } = req.body;
if (adminUser !== 'admin' || adminPass !== 'Open@0761') return res.status(403).send("Unauthorized");
try {
    await db.execute({ sql: "UPDATE f1_drivers SET is_vip = ? WHERE name = ?", args: [vipStatus ? 1 : 0, targetUser] });
    res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reset-user', async (req, res) => {
const { adminUser, adminPass, targetUser } = req.body;
if (adminUser !== 'admin' || adminPass !== 'Open@0761') return res.status(403).send("Unauthorized");
try {
    await db.execute({ sql: "UPDATE f1_drivers SET total_score = 0, has_participated = 0 WHERE name = ?", args: [targetUser] });
    res.json({ success: true });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 7. AUTOMATED CRON JOB ---
const APP_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
setInterval(async () => {
  const now = new Date();
  const active = f1Calendar2026.find(r => { 
      const raceTime = new Date(r.sessions.race); 
      return now > raceTime && now - raceTime < (24 * 60 * 60 * 1000); 
  });
  if (active) await performFinalization();
  fetch(`${APP_URL}/api/next-race`).catch(() => {});
}, 15 * 60 * 1000);

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`🏁 Server 3000`));