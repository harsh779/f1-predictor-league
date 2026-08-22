'use strict';

const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

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

console.log('Prediction safety invariants passed.');
