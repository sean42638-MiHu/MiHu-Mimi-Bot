'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getDevelopmentDatabasePath, normalDataDirectory, normalDatabasePath } = require('./runtimePaths');

function inspectProductionDatabaseConfig(env = process.env, { requireExistingFile = true } = {}) {
    const errors = [];
    if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') errors.push('NODE_ENV must be production');
    if (String(env.APP_ENV || '').trim().toLowerCase() !== 'production') errors.push('APP_ENV must be production');
    if (env.PRODUCTION_IDENTITY_VERIFIED !== 'YES') errors.push('Production identity confirmation is missing');
    if (env.PRODUCTION_STORAGE_VERIFIED !== 'YES') errors.push('Persistent database storage confirmation is missing');

    const configuredPath = String(env.DATABASE_PATH || '').trim();
    let databasePath = null;
    if (!configuredPath) {
        errors.push('DATABASE_PATH is missing');
    } else if (!path.isAbsolute(configuredPath)) {
        errors.push('DATABASE_PATH must be an absolute path');
    } else {
        databasePath = path.resolve(configuredPath);
        if (databasePath === path.resolve(normalDatabasePath)) errors.push('Repository-local database.sqlite is not a Production database');
        if (databasePath === path.resolve(getDevelopmentDatabasePath())) errors.push('Development database cannot be used for Production');
        if (requireExistingFile) {
            try {
                if (!fs.statSync(databasePath).isFile()) errors.push('DATABASE_PATH does not identify a file');
            } catch {
                errors.push('Configured Production database file is unavailable');
            }
        }
    }

    const configuredDataDirectory = String(env.PRODUCTION_DATA_DIR || '').trim();
    if (!configuredDataDirectory) {
        errors.push('PRODUCTION_DATA_DIR is missing');
    } else if (!path.isAbsolute(configuredDataDirectory)) {
        errors.push('PRODUCTION_DATA_DIR must be absolute');
    } else {
        const dataDirectory = path.resolve(configuredDataDirectory);
        const relativeToRepo = path.relative(path.resolve(__dirname, '..'), dataDirectory);
        if (relativeToRepo === '' || (!relativeToRepo.startsWith(`..${path.sep}`) && relativeToRepo !== '..' && !path.isAbsolute(relativeToRepo))) {
            errors.push('Repository-local data directory is not Production storage');
        }
        if (dataDirectory === path.resolve(normalDataDirectory)) errors.push('Repository-local data directory is not Production storage');
        try {
            if (!fs.statSync(dataDirectory).isDirectory()) errors.push('PRODUCTION_DATA_DIR does not identify a directory');
        } catch {
            errors.push('Configured Production data directory is unavailable');
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        databasePath,
        safeIdentity: {
            environment: 'Production',
            provider: 'SQLite',
            database: databasePath ? 'configured absolute file path (redacted)' : 'MISSING',
            applicationData: configuredDataDirectory ? 'configured persistent directory (redacted)' : 'MISSING'
        }
    };
}

module.exports = { inspectProductionDatabaseConfig };
