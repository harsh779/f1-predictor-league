'use strict';

const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function requireInvariant(condition, message) {
    if (!condition) throw new Error(`Prediction safety check failed: ${message}`);
}

const predictionDeletes = source
    .split('\n')
    .filter(line => /DELETE FROM f1_predictions_v4/i.test(line));

requireInvariant(predictionDeletes.length > 0, 'no prediction cleanup statements were found');
requireInvariant(
    predictionDeletes.every(line => /\bWHERE\b/i.test(line)),
    'every prediction delete must include a WHERE clause'
);
requireInvariant(
    source.includes("archivePredictionRecord(tx, userName, d, predictionRound, 'player-submit')"),
    'player submissions must be archived in their write transaction'
);
requireInvariant(
    source.includes("archivePredictionRecord(tx, p.user_name, p, roundLabel, 'pre-finalization')"),
    'predictions must be archived again before finalization cleanup'
);
requireInvariant(
    source.includes("session.Type !== 'Race' || /sprint/i.test(sessionName)"),
    'Sprint sessions must never trigger Grand Prix finalization'
);
requireInvariant(
    source.includes('const preserveActivePredictions = suppliedPredictions !== null'),
    'manual finalization must preserve active prediction rows'
);
requireInvariant(
    source.includes('Unknown driver:') && source.includes('Unknown constructor:') && source.includes('Unknown wildcard driver:'),
    'all prediction values must be checked against the official roster'
);
requireInvariant(
    source.includes('validateFinalRaceResults(results)') && source.includes("SessionStatus !== 'Finalised'"),
    'scoring must require a complete, final race classification'
);
requireInvariant(
    source.includes('CREATE TABLE IF NOT EXISTS f1_round_finalization') && source.includes('acquireRoundFinalizationLock(roundCheck)'),
    'round finalization must use a database-backed lock'
);
requireInvariant(
    source.includes('validateRaceGrid(results)') && !source.includes('parseInt(r.grid) || gridMap[name]'),
    'race wildcard scoring must use the actual starting grid, not qualifying order'
);
requireInvariant(
    !source.includes('sprintGridMap[normalizeStr(d.name || \'\')] || gridMap'),
    'Sprint wildcard scoring must never fall back to Grand Prix qualifying'
);
requireInvariant(
    source.includes('await databaseReady;') && source.includes("'[FATAL] Application startup failed:'"),
    'the server must fail fast when database setup fails'
);
requireInvariant(
    source.includes('TURSO_BACKUP_DATABASE_URL') && source.includes('f1_backup_snapshots') && source.includes("scheduleIndependentBackup('prediction-submit')"),
    'submitted predictions must trigger an independent backup snapshot'
);
requireInvariant(
    !/<input[^>]+id="admin-import-clear"[^>]+checked/i.test(html),
    'destructive admin import replacement must be unchecked by default'
);
requireInvariant(
    source.includes('confirmClearExisting !== true'),
    'destructive admin import replacement must require explicit server-side confirmation'
);
requireInvariant(
    source.includes('if (await hasRoundBeenScored(round))'),
    'archive restore must not place scored-round picks back into the active table'
);

console.log('Prediction safety invariants passed.');
