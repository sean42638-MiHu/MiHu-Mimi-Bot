'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');

const execFileAsync = promisify(execFile);

const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'deploy/nginx/mihu-rbac-initialization.conf.example'), 'utf8');
const nginxAvailable = spawnSync('nginx', ['-v']).status === 0 && spawnSync('openssl', ['version']).status === 0;

const SIMULATED_EDGE = '127.0.0.2';
const NAMED_OPERATOR_IP = '198.51.100.7';
const NAMED_OPERATOR_IPV6 = '2001:db8:1234:5678::abcd';

function freePort() {
    return new Promise(resolve => {
        const server = http.createServer().listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function curl(port, { method = 'GET', route = '/login', from = '127.0.0.1', headers = {} } = {}) {
    const args = ['-sk', '-o', '-', '-w', '\n%{http_code}', '--interface', from, '-X', method,
        '--resolve', `example.invalid:${port}:127.0.0.1`];
    for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`);
    args.push(`https://example.invalid:${port}${route}`);
    const { stdout: output } = await execFileAsync('curl', ['--max-time', '10', ...args], { encoding: 'utf8' });
    const index = output.lastIndexOf('\n');
    return { status: Number(output.slice(index + 1)), body: output.slice(0, index) };
}

test('initialization Nginx template trusts CF-Connecting-IP only from trusted edges and allowlists routes', { skip: !nginxAvailable && 'nginx/openssl not installed' }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-nginx-init-'));
    const backend = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ path: req.url, method: req.method, xff: req.headers['x-forwarded-for'] || null }));
    });
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    const backendPort = backend.address().port;
    const nginxPort = await freePort();
    const redirectPort = await freePort();
    const snippets = path.join(directory, 'snippets');
    fs.mkdirSync(snippets);
    for (const name of ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) fs.mkdirSync(path.join(directory, name));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=example.invalid',
        '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')], { stdio: 'ignore' });

    const proxySnippet = template.split('\n').filter(line => line.startsWith('#| ')).map(line => line.slice(3)).join('\n');
    fs.writeFileSync(path.join(snippets, 'mihu-init-proxy.conf'), `${proxySnippet}\n`);
    const site = template
        .replace('listen 80;', `listen 127.0.0.1:${redirectPort};`)
        .replace('listen [::]:80;', '')
        .replace('listen 443 ssl;', `listen 127.0.0.1:${nginxPort} ssl;`)
        .replace('listen [::]:443 ssl;', '')
        .replace('/etc/nginx/tls/mihu/fullchain.pem', path.join(directory, 'cert.pem'))
        .replace('/etc/nginx/tls/mihu/privkey.pem', path.join(directory, 'key.pem'))
        .replaceAll('/etc/nginx/snippets/', `${snippets}/`)
        .replaceAll('http://127.0.0.1:3000', `http://127.0.0.1:${backendPort}`);
    fs.writeFileSync(path.join(directory, 'site.conf'), site);
    fs.writeFileSync(path.join(directory, 'nginx.conf'), `
        pid ${directory}/nginx.pid;
        error_log ${directory}/error.log;
        events {}
        http {
            access_log off;
            client_body_temp_path ${directory}/client_body;
            proxy_temp_path ${directory}/proxy;
            fastcgi_temp_path ${directory}/fastcgi;
            uwsgi_temp_path ${directory}/uwsgi;
            scgi_temp_path ${directory}/scgi;
            set_real_ip_from ${SIMULATED_EDGE};
            real_ip_header CF-Connecting-IP;
            real_ip_recursive on;
            include ${directory}/site.conf;
        }
    `);
    const nginx = args => spawnSync('nginx', ['-p', directory, '-e', path.join(directory, 'error.log'), '-c', path.join(directory, 'nginx.conf'), ...args], { encoding: 'utf8' });
    const setAccess = rules => {
        fs.writeFileSync(path.join(snippets, 'mihu-init-access.conf'), rules);
        const reload = nginx(['-s', 'reload']);
        assert.equal(reload.status, 0, reload.stderr);
        spawnSync('sleep', ['0.5']);
    };

    try {
        fs.writeFileSync(path.join(snippets, 'mihu-init-access.conf'), `allow ${NAMED_OPERATOR_IP};\nallow ${NAMED_OPERATOR_IPV6};\ndeny all;\n`);
        const syntax = nginx(['-t']);
        assert.equal(syntax.status, 0, syntax.stderr);
        const start = nginx([]);
        assert.equal(start.status, 0, start.stderr);
        spawnSync('sleep', ['0.5']);

        // Mode B: named egress through a trusted edge.
        const viaEdge = (route, method = 'GET', ip = NAMED_OPERATOR_IP, extra = {}) => curl(nginxPort, { route, method, from: SIMULATED_EDGE, headers: { 'CF-Connecting-IP': ip, ...extra } });
        const allowedLogin = await viaEdge('/login', 'GET', NAMED_OPERATOR_IP, { 'X-Forwarded-For': '1.2.3.4' });
        assert.equal(allowedLogin.status, 200);
        assert.equal(JSON.parse(allowedLogin.body).xff, NAMED_OPERATOR_IP);
        assert.equal((await viaEdge('/login', 'GET', '203.0.113.9')).status, 403);
        const ipv6Login = await viaEdge('/login', 'GET', NAMED_OPERATOR_IPV6);
        assert.equal(ipv6Login.status, 200);
        assert.equal(JSON.parse(ipv6Login.body).xff, NAMED_OPERATOR_IPV6);
        // A rotated temporary address in the same /64 must be refused, not silently admitted.
        assert.equal((await viaEdge('/login', 'GET', '2001:db8:1234:5678::abce')).status, 403);
        assert.equal((await viaEdge('/login', 'GET', '2001:db8:1234:9999::1')).status, 403);
        const { stdout: redirectHeaders } = await execFileAsync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}',
            '--resolve', `example.invalid:${redirectPort}:127.0.0.1`, `http://example.invalid:${redirectPort}/login`], { encoding: 'utf8' });
        assert.match(redirectHeaders, /^301 https:\/\/example\.invalid\/login$/);
        assert.equal((await curl(nginxPort, { route: '/login', from: '127.0.0.1', headers: { 'CF-Connecting-IP': NAMED_OPERATOR_IP } })).status, 403);

        for (const route of ['/login', '/logout', '/auth/discord', '/auth/discord/callback?code=x&state=y', '/auth/login-transition', '/management/members', '/css/admin-layout.css']) {
            assert.equal((await viaEdge(route)).status, 200, route);
        }
        assert.equal((await viaEdge('/management/members/update-vip/abc', 'POST')).status, 200);
        assert.equal((await viaEdge('/management/members/update-vip/abc', 'GET')).status, 403);
        assert.equal((await viaEdge('/login', 'POST')).status, 403);
        for (const route of ['/', '/dashboard', '/management/staff', '/management/members/transactions', '/management/members/update-balance/abc', '/system/roles', '/api/withdrawals', '/healthz']) {
            assert.equal((await viaEdge(route)).status, 503, route);
        }

        // Mode A: SSH tunnel terminates on VPS loopback; edge traffic is refused even for the named address.
        setAccess('if ($realip_remote_addr !~ "^(127\\.0\\.0\\.1|::1)$") { return 403; }\n');
        assert.equal((await curl(nginxPort, { route: '/login', from: '127.0.0.1' })).status, 200);
        assert.equal((await curl(nginxPort, { route: '/dashboard', from: '127.0.0.1' })).status, 503);
        assert.equal((await viaEdge('/login')).status, 403);
        assert.equal((await viaEdge('/login', 'GET', '127.0.0.1')).status, 403);
    } finally {
        nginx(['-s', 'stop']);
        await new Promise(resolve => backend.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
