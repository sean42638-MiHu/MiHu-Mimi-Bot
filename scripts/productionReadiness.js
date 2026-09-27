'use strict';

const { inspectProductionDatabaseConfig } = require('../utils/productionDatabaseConfig');
const { inspectBotProductionConfig, inspectWebProductionConfig, isSupportedProductionNode } = require('../utils/productionRuntimeConfig');

const SECRET_ENV_KEYS = Object.freeze([
    'SESSION_SECRET',
    'PAYROLL_DATA_ENCRYPTION_KEY',
    'PLATFORM_SUPERUSER_ID',
    'DISCORD_CLIENT_ID',
    'DISCORD_BOT_TOKEN',
    'DISCORD_CLIENT_SECRET',
    'SMTP_PASS'
]);

function evaluateProductionReadiness(env = process.env) {
    const database = inspectProductionDatabaseConfig(env);
    const web = inspectWebProductionConfig(env);
    const bot = inspectBotProductionConfig(env);
    const secrets = Object.fromEntries(SECRET_ENV_KEYS.map(key => [key, env[key] ? 'CONFIGURED' : 'MISSING']));
    if (secrets.DISCORD_BOT_TOKEN === 'MISSING' && env.DISCORD_TOKEN) secrets.DISCORD_BOT_TOKEN = 'CONFIGURED';
    const runtimeRole = String(env.MIHU_RUNTIME_ROLE || '').trim().toLowerCase();
    const requiredSecretKeys = runtimeRole === 'bot'
        ? ['PAYROLL_DATA_ENCRYPTION_KEY', 'PLATFORM_SUPERUSER_ID', 'DISCORD_BOT_TOKEN']
        : ['SESSION_SECRET', 'PAYROLL_DATA_ENCRYPTION_KEY', 'PLATFORM_SUPERUSER_ID', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'];
    const missingRequiredSecrets = requiredSecretKeys.filter(key => secrets[key] !== 'CONFIGURED');
    const runtime = runtimeRole === 'bot' ? bot : web;
    const runtimeRoleValid = runtimeRole === 'web' || runtimeRole === 'bot';
    const ready = database.ok && runtime.ok && runtimeRoleValid && missingRequiredSecrets.length === 0;

    return {
        readiness: ready ? 'PASS' : 'FAIL',
        environment: String(env.NODE_ENV || 'MISSING').toUpperCase(),
        database: database.safeIdentity,
        checks: {
            productionIdentity: env.PRODUCTION_IDENTITY_VERIFIED === 'YES' ? 'CONFIRMED' : 'MISSING',
            persistentStorage: env.PRODUCTION_STORAGE_VERIFIED === 'YES' ? 'CONFIRMED' : 'MISSING',
            databasePath: database.ok ? 'CONFIGURED' : 'INVALID_OR_MISSING',
            webEnvironment: web.ok ? 'CONFIGURED' : 'INVALID_OR_MISSING',
            botEnvironment: bot.ok ? 'CONFIGURED' : 'INVALID_OR_MISSING',
            runtimeRole: runtimeRoleValid ? runtimeRole.toUpperCase() : 'INVALID',
            nodeVersion: isSupportedProductionNode(env.NODE_VERSION || process.versions.node) ? 'SUPPORTED_NODE_24' : 'UNSUPPORTED',
            requiredSecrets: missingRequiredSecrets.length === 0 ? 'CONFIGURED' : 'MISSING'
        },
        secrets,
        databaseIssues: database.errors,
        webConfigurationIssues: web.errors,
        productionDeploymentVerified: false,
        productionRbacVerified: false
    };
}

if (require.main === module) {
    const report = evaluateProductionReadiness();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.readiness !== 'PASS') process.exitCode = 1;
}

module.exports = { SECRET_ENV_KEYS, evaluateProductionReadiness };
