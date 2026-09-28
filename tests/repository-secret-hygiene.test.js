'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const insideGit = git(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
const SECRET_PATH = /(^|\/)\.ssh(\/|$)|(^|\/)(id_(rsa|ecdsa|ed25519)[^/]*|authorized_keys|known_hosts)$|\.(pem|key)$/;

test('SSH and private key material is ignored and never tracked', { skip: !insideGit && 'not a git work tree' }, () => {
    for (const candidate of ['.ssh/id_ed25519', '.ssh/config', 'deploy/.ssh/authorized_keys', 'id_rsa', 'id_ed25519.pub', 'known_hosts', 'tls/privkey.pem', 'server.key']) {
        const result = git(['check-ignore', '--no-index', '-q', candidate]);
        assert.equal(result.status, 0, `${candidate} must be ignored`);
    }
    const tracked = git(['ls-files', '-z']).stdout.split('\0').filter(Boolean);
    assert.deepEqual(tracked.filter(file => SECRET_PATH.test(file)), []);
});
