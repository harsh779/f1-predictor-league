const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    // Compile inline scripts without executing browser-only code.
    new Function(match[1]);
}

const port = 31000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-profile-access-'));
const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
        ...process.env,
        PORT: String(port),
        APP_URL: `http://localhost:${port}`,
        NODE_ENV: 'development',
        ENABLE_LOCAL_AUTH: '1',
        TURSO_DATABASE_URL: `file:${path.join(tempDir, 'test.db')}`,
        DISCORD_WEBHOOK: '',
        TURSO_BACKUP_DATABASE_URL: '',
        TURSO_BACKUP_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

async function request(pathname, options = {}) {
    const response = await fetch(base + pathname, options);
    return {
        status: response.status,
        body: await response.json().catch(() => null),
        cookie: response.headers.get('set-cookie')
    };
}

async function waitForServer() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const response = await fetch(`${base}/api/session`);
            if (response.ok) return;
        } catch (_) { }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Local test server did not start.\n${output}`);
}

async function login(persona) {
    const response = await fetch(`${base}/auth/local-dev?persona=${persona}`, { redirect: 'manual' });
    assert.equal(response.status, 302, `${persona} login should redirect`);
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie, `${persona} login should set a session cookie`);
    return setCookie.split(';')[0];
}

(async () => {
    try {
        await waitForServer();

        const guest = await request('/api/session');
        assert.equal(guest.status, 200);
        assert.equal(guest.body.authenticated, false);
        assert.equal(guest.body.entitlements.compete, false);

        // Seed the local-only preview league without attaching its cookie to guest requests.
        await login('player');

        const leagues = await request('/api/leagues');
        assert.equal(leagues.status, 200);
        assert.equal(leagues.body.length, 1);
        assert.equal(leagues.body[0].slug, 'f1-2026-main');

        const leaderboard = await request('/api/season-leaderboard');
        assert.equal(leaderboard.status, 200);
        assert.ok(leaderboard.body.length >= 6);
        const publicProfile = await request(`/api/players/${leaderboard.body[0].id}/profile`);
        assert.equal(publicProfile.status, 200);
        assert.ok(publicProfile.body.performance.rank);

        const nonmemberCookie = await login('nonmember');
        const nonmemberSession = await request('/api/session', { headers: { cookie: nonmemberCookie } });
        assert.equal(nonmemberSession.body.authenticated, true);
        assert.equal(nonmemberSession.body.entitlements.compete, false);
        const blockedScores = await request('/api/round-scores', { headers: { cookie: nonmemberCookie } });
        assert.equal(blockedScores.status, 403);
        assert.equal(blockedScores.body.code, 'LEAGUE_MEMBERSHIP_REQUIRED');
        const profileEdit = await request('/api/profile', {
            method: 'PATCH',
            headers: { cookie: nonmemberCookie, 'content-type': 'application/json' },
            body: JSON.stringify({ bio: 'Test strategist', location: 'Bengaluru', favorite_driver: 'Lewis Hamilton', favorite_constructor: 'Ferrari', avatar_url: '' })
        });
        assert.equal(profileEdit.status, 200);

        const playerCookie = await login('player');
        const playerSession = await request('/api/session', { headers: { cookie: playerCookie } });
        assert.equal(playerSession.body.entitlements.compete, true);
        assert.equal((await request('/api/round-scores', { headers: { cookie: playerCookie } })).status, 200);

        const adminCookie = await login('admin');
        const adminSession = await request('/api/session', { headers: { cookie: adminCookie } });
        assert.equal(adminSession.body.entitlements.admin, true);
        assert.equal(adminSession.body.entitlements.compete, true);

        const secondLeague = await request('/api/admin/leagues', {
            method: 'POST',
            headers: { cookie: adminCookie, 'content-type': 'application/json' },
            body: JSON.stringify({ slug: 'local-second-league', name: 'Local Second League', season: 2026, status: 'active', visibility: 'public' })
        });
        assert.equal(secondLeague.status, 201);
        const addMembership = await request(`/api/admin/leagues/${secondLeague.body.id}/memberships/${nonmemberSession.body.user.id}`, {
            method: 'PUT',
            headers: { cookie: adminCookie, 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'player', status: 'active' })
        });
        assert.equal(addMembership.status, 200);
        const promotedSession = await request('/api/session', { headers: { cookie: nonmemberCookie } });
        assert.equal(promotedSession.body.entitlements.compete, true);
        assert.equal(promotedSession.body.memberships.length, 1);

        const backup = await request('/api/admin/export', { headers: { cookie: adminCookie } });
        assert.equal(backup.status, 200);
        assert.equal(backup.body.schema_version, 3);
        assert.ok(Array.isArray(backup.body.leagues) && backup.body.leagues.length === 2);
        assert.ok(Array.isArray(backup.body.memberships));
        assert.ok(Array.isArray(backup.body.profiles));

        console.log('Profile and league access checks passed.');
    } finally {
        child.kill('SIGTERM');
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
