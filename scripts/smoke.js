const { spawn } = require('child_process');
const path = require('path');

const port = String(process.env.SMOKE_PORT || 3210);
const baseUrl = (process.env.SMOKE_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const cwd = path.resolve(__dirname, '..');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function waitForServer(child, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited before smoke checks completed (exit ${child.exitCode})`);
        }
        try {
            const response = await fetchWithTimeout(`${baseUrl}/`, {}, 2000);
            if (response.ok) return;
        } catch (_error) {
            // Retry until timeout.
        }
        await delay(500);
    }
    throw new Error('Timed out waiting for local server startup');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function request(pathname, {
    method = 'GET',
    headers = {},
    body,
    allowedStatuses = [200],
    timeoutMs = 5000
} = {}) {
    const response = await fetchWithTimeout(`${baseUrl}${pathname}`, {
        method,
        headers: {
            Accept: 'application/json,text/html',
            ...headers
        },
        body
    }, timeoutMs);

    const text = await response.text();
    if (!allowedStatuses.includes(response.status)) {
        throw new Error(`${pathname} returned ${response.status}. Body: ${text.slice(0, 240)}`);
    }

    let json = null;
    if ((response.headers.get('content-type') || '').includes('application/json')) {
        json = text ? JSON.parse(text) : null;
    }

    return { response, text, json };
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

async function checkRoute(label, pathname, options, validate) {
    const result = await request(pathname, options);
    await validate(result);
    console.log(`PASS ${label}`);
    return result;
}

async function runChecks() {
    const nextRace = await checkRoute('root html', '/', { allowedStatuses: [200] }, ({ text }) => {
        assert(/<!doctype html>|<html/i.test(text), 'Root route did not return HTML');
    });

    await checkRoute('spa fallback html', '/this-route-does-not-exist', { allowedStatuses: [200] }, ({ text }) => {
        assert(/<!doctype html>|<html/i.test(text), 'SPA fallback did not return HTML');
    });

    const nextRacePayload = await checkRoute('next race contract', '/api/next-race', { allowedStatuses: [200] }, ({ json }) => {
        assert(isObject(json), '/api/next-race did not return an object');
        assert(typeof json.lockTime === 'string', '/api/next-race missing lockTime');
        assert(typeof json.totalRounds === 'number', '/api/next-race missing totalRounds');
        assert(['open', 'locked'].includes(json.lockStatus), '/api/next-race missing valid lockStatus');
        assert(json.nextSession === null || isObject(json.nextSession), '/api/next-race nextSession must be null or object');
    });

    await checkRoute('calendar contract', '/api/calendar', { allowedStatuses: [200] }, ({ json }) => {
        assert(Array.isArray(json) && json.length > 0, '/api/calendar returned an empty calendar');
    });

    await checkRoute('driver stats contract', '/api/driver-stats/Max%20Verstappen', { allowedStatuses: [200] }, ({ json }) => {
        assert(json?.name === 'Max Verstappen', '/api/driver-stats returned unexpected driver payload');
        assert('wins' in json, '/api/driver-stats missing wins');
        assert('teamColour' in json, '/api/driver-stats missing teamColour');
    });

    await checkRoute('season leaderboard contract', '/api/season-leaderboard', { allowedStatuses: [200] }, ({ json }) => {
        assert(Array.isArray(json), '/api/season-leaderboard did not return an array');
    });

    await checkRoute('round scores contract', '/api/round-scores', { allowedStatuses: [200] }, ({ json }) => {
        assert(Array.isArray(json), '/api/round-scores did not return an array');
    });

    await checkRoute('weather contract', '/api/live/weather', { allowedStatuses: [200, 503] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(isObject(json), '/api/live/weather did not return JSON');
            assert(json.AirTemp != null || json.TrackTemp != null, '/api/live/weather missing temperatures');
            assert(typeof json.source === 'string', '/api/live/weather missing source');
        } else {
            assert(json?.error, '/api/live/weather should return error payload on failure');
        }
    });

    await checkRoute('live status contract', '/api/live/status', { allowedStatuses: [200, 502, 503] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(isObject(json), '/api/live/status should return JSON object');
        } else {
            assert(json?.error, '/api/live/status should return error payload on failure');
        }
    });

    await checkRoute('live widget contract', '/api/live-widget', { allowedStatuses: [200, 503] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(isObject(json), '/api/live-widget should return JSON object');
            assert(isObject(json.timing), '/api/live-widget missing timing');
            assert(Array.isArray(json.timing.drivers), '/api/live-widget missing timing.drivers');
        } else {
            assert(json?.error, '/api/live-widget should return error payload on failure');
        }
    });

    await checkRoute('team radio contract', '/api/live/team-radio', { allowedStatuses: [200, 401, 403, 502, 503] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(Array.isArray(json?.messages), '/api/live/team-radio missing messages array');
            assert(typeof json.total === 'number', '/api/live/team-radio missing total');
        } else {
            assert(json?.error, '/api/live/team-radio should return error payload on failure');
        }
    });

    await checkRoute('race control contract', '/api/live/race-control', { allowedStatuses: [200, 401, 403, 502, 503] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(Array.isArray(json), '/api/live/race-control should return an array');
        } else {
            assert(json?.error, '/api/live/race-control should return error payload on failure');
        }
    });

    await checkRoute('results list contract', '/api/live/results', { allowedStatuses: [200, 401, 403, 502, 503] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(Array.isArray(json), '/api/live/results should return an array');
        } else {
            assert(json?.error, '/api/live/results should return error payload on failure');
        }
    });

    await checkRoute('driver standings contract', '/api/standings/drivers', { allowedStatuses: [200, 401, 403, 502, 503] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(Array.isArray(json) || isObject(json), '/api/standings/drivers should return JSON data');
        } else {
            assert(json?.error, '/api/standings/drivers should return error payload on failure');
        }
    });

    await checkRoute('constructor standings contract', '/api/standings/constructors', { allowedStatuses: [200, 401, 403, 502, 503] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(Array.isArray(json) || isObject(json), '/api/standings/constructors should return JSON data');
        } else {
            assert(json?.error, '/api/standings/constructors should return error payload on failure');
        }
    });

    await checkRoute('paddock news contract', '/api/paddock-news', { allowedStatuses: [200, 502] }, ({ response, json }) => {
        if (response.status === 200) {
            assert(Array.isArray(json?.items), '/api/paddock-news missing items array');
        } else {
            assert(json?.error, '/api/paddock-news should return error payload on failure');
        }
    });

    const unauthorizedJson = async ({ response, json }, route) => {
        assert(response.status === 401, `${route} should reject unauthenticated access with 401`);
        assert(json?.error, `${route} should return an error payload when unauthenticated`);
    };

    await checkRoute('auth guard /api/me', '/api/me', { allowedStatuses: [401] }, (result) => unauthorizedJson(result, '/api/me'));
    await checkRoute('auth guard /api/season-picks', '/api/season-picks', { allowedStatuses: [401] }, (result) => unauthorizedJson(result, '/api/season-picks'));
    await checkRoute('auth guard /api/predictions', '/api/predictions', { allowedStatuses: [401] }, (result) => unauthorizedJson(result, '/api/predictions'));
    await checkRoute('auth guard /api/admin/users', '/api/admin/users', { allowedStatuses: [401] }, (result) => unauthorizedJson(result, '/api/admin/users'));
    await checkRoute('auth guard POST /predict', '/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        allowedStatuses: [401]
    }, (result) => unauthorizedJson(result, '/predict'));

    assert(isObject(nextRacePayload.json) || nextRace.text, 'Smoke run did not execute next-race check');
    console.log('Smoke checks passed');
}

async function main() {
    if (process.env.SMOKE_BASE_URL) {
        try {
            await runChecks();
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
        return;
    }

    let child;
    let stdout = '';
    let stderr = '';

    try {
        child = spawn(process.execPath, ['server.js'], {
            cwd,
            env: { ...process.env, PORT: port },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });

        await waitForServer(child);
        await runChecks();
    } catch (error) {
        console.error(error.message);
        if (stdout.trim()) console.error('\n[server stdout]\n' + stdout.trim());
        if (stderr.trim()) console.error('\n[server stderr]\n' + stderr.trim());
        process.exitCode = 1;
    } finally {
        if (child) {
            child.kill();
            await delay(300);
        }
    }
}

main();
