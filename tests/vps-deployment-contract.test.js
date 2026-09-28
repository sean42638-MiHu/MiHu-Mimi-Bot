'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('VPS systemd templates run distinct non-root runtimes with no migration or command deployment', () => {
    const web = read('deploy/systemd/mihu-web.service');
    const bot = read('deploy/systemd/mihu-bot.service');
    assert.match(web, /User=mihu/);
    assert.match(web, /Group=mihu/);
    assert.match(web, /WorkingDirectory=\/opt\/mihu\/app/);
    assert.match(web, /EnvironmentFile=\/etc\/mihu\/mihu\.env/);
    assert.match(web, /EnvironmentFile=\/etc\/mihu\/mihu-web\.env/);
    assert.match(web, /ExecStart=\/usr\/bin\/npm start/);
    assert.doesNotMatch(web, /db:migrate|registerDiscordCommands|botRunner/);
    assert.match(bot, /User=mihu/);
    assert.match(bot, /Group=mihu/);
    assert.match(bot, /EnvironmentFile=\/etc\/mihu\/mihu\.env/);
    assert.match(bot, /EnvironmentFile=\/etc\/mihu\/mihu-bot\.env/);
    assert.match(bot, /WorkingDirectory=\/opt\/mihu\/app/);
    assert.match(bot, /ExecStart=\/usr\/bin\/node botRunner\.js/);
    assert.ok(fs.existsSync(path.join(root, 'botRunner.js')), 'bot ExecStart must resolve inside WorkingDirectory');
    assert.doesNotMatch(bot, /index\.js|db:migrate|registerDiscordCommands/);
    assert.match(web, /NoNewPrivileges=true/);
    assert.match(bot, /NoNewPrivileges=true/);
    assert.match(web, /ReadOnlyPaths=\/opt\/mihu\/app/);
    assert.match(bot, /ReadOnlyPaths=\/opt\/mihu\/app/);
});

test('VPS templates isolate app, DB, mirror, env and backup paths without real secrets/domain', () => {
    const sharedEnv = read('deploy/env/mihu.production.env.example');
    const webEnv = read('deploy/env/mihu-web.env.example');
    const botEnv = read('deploy/env/mihu-bot.env.example');
    const nginx = read('deploy/nginx/mihu.conf.example');
    assert.match(sharedEnv, /DATABASE_PATH=\/var\/lib\/mihu\/database\.sqlite/);
    assert.match(sharedEnv, /PRODUCTION_DATA_DIR=\/var\/lib\/mihu\/data/);
    assert.match(sharedEnv, /DATABASE_BACKUP_DIR=\/var\/backups\/mihu/);
    assert.doesNotMatch(sharedEnv, /MIHU_RUNTIME_ROLE=/);
    assert.match(webEnv, /MIHU_RUNTIME_ROLE=web/);
    assert.match(botEnv, /MIHU_RUNTIME_ROLE=bot/);
    assert.match(sharedEnv, /SESSION_SECRET=<SECRET/);
    assert.match(sharedEnv, /DISCORD_CLIENT_SECRET=<SECRET/);
    assert.match(sharedEnv, /DISCORD_BOT_TOKEN=<SECRET/);
    assert.match(sharedEnv, /PUBLIC_BASE_URL=https:\/\/<APPROVED_DOMAIN>/);
    assert.doesNotMatch(sharedEnv, /(?:ghp_|sk_live_|eyJ[a-zA-Z0-9_-]{12,})/);
    assert.match(nginx, /listen 80/);
    assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3000/);
    assert.match(nginx, /proxy_set_header Host/);
    assert.match(nginx, /proxy_set_header X-Real-IP/);
    assert.match(nginx, /proxy_set_header X-Forwarded-For/);
    assert.match(nginx, /proxy_set_header X-Forwarded-Proto/);
    assert.doesNotMatch(nginx, /botRunner|discord/i);
    assert.match(nginx, /server_name _/);
});

test('Node and Express contracts bind production Web to loopback and Node 24', () => {
    const appPackage = JSON.parse(read('package.json'));
    const packageJson = JSON.parse(read('package-lock.json'));
    const web = read('index.js');
    const runtime = read('utils/productionRuntimeConfig.js');
    assert.equal(appPackage.engines.node, '>=24.0.0 <25');
    assert.equal(packageJson.packages[''].engines.node, '>=24.0.0 <25');
    assert.match(web, /app\.listen\(PORT, HOST/);
    assert.match(runtime, /WEB_LISTEN_HOST must be 127\.0\.0\.1/);
});
