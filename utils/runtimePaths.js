const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const projectRoot = path.resolve(__dirname, '..');
const normalDatabasePath = path.join(projectRoot, 'database.sqlite');
const developmentDatabasePath = path.join(projectRoot, 'data', 'development.sqlite');
const normalDataDirectory = path.join(projectRoot, 'data');
const developmentDataDirectory = path.join(normalDataDirectory, 'development');

function getDatabasePath(env = process.env) {
    const nodeEnvironment = String(env.NODE_ENV || '').trim().toLowerCase();
    const appEnvironment = String(env.APP_ENV || '').trim().toLowerCase();
    if (env.NODE_ENV === 'test') {
        if (!env.TEST_DATABASE_PATH) throw new Error('NODE_ENV=test requires TEST_DATABASE_PATH');
        return path.resolve(env.TEST_DATABASE_PATH);
    }

    if (appEnvironment === 'development' && nodeEnvironment === 'production') {
        throw new Error('APP_ENV=development cannot use NODE_ENV=production');
    }

    if (nodeEnvironment === 'production' || appEnvironment === 'production') {
        const configuredPath = String(env.DATABASE_PATH || '').trim();
        if (!configuredPath) throw new Error('Production runtime requires an explicit DATABASE_PATH');
        if (!path.isAbsolute(configuredPath)) throw new Error('Production DATABASE_PATH must be absolute');
        const selectedPath = path.resolve(configuredPath);
        const samePath = (left, right) => {
            const resolvedLeft = path.resolve(left);
            const resolvedRight = path.resolve(right);
            if (resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()) return true;
            try {
                return fs.existsSync(resolvedLeft) && fs.existsSync(resolvedRight)
                    && fs.realpathSync(resolvedLeft).toLowerCase() === fs.realpathSync(resolvedRight).toLowerCase();
            } catch {
                return false;
            }
        };
        if (samePath(selectedPath, normalDatabasePath)) {
            throw new Error('Production runtime cannot use the repository-local database.sqlite fallback');
        }
        if (samePath(selectedPath, developmentDatabasePath)) {
            throw new Error('Production runtime cannot use the isolated Development database');
        }
        return selectedPath;
    }

    if (String(env.APP_ENV || '').trim().toLowerCase() === 'development') {
        if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
            throw new Error('APP_ENV=development cannot use NODE_ENV=production');
        }
        const selectedPath = path.resolve(env.DATABASE_PATH || developmentDatabasePath);
        if (selectedPath !== path.resolve(developmentDatabasePath)) {
            throw new Error('APP_ENV=development requires the isolated data/development.sqlite database');
        }
        return selectedPath;
    }

    const selectedPath = path.resolve(env.DATABASE_PATH || normalDatabasePath);
    if (selectedPath === path.resolve(developmentDatabasePath)) {
        throw new Error('Normal runtime cannot use the isolated Development database');
    }
    return selectedPath;
}

function getRuntimeDataDirectory(env = process.env) {
    const appEnvironment = String(env.APP_ENV || '').trim().toLowerCase();
    const nodeEnvironment = String(env.NODE_ENV || '').trim().toLowerCase();
    if (appEnvironment === 'production' || nodeEnvironment === 'production') {
        const configuredDirectory = String(env.PRODUCTION_DATA_DIR || '').trim();
        if (!configuredDirectory) throw new Error('Production runtime requires an explicit PRODUCTION_DATA_DIR');
        if (!path.isAbsolute(configuredDirectory)) throw new Error('Production PRODUCTION_DATA_DIR must be absolute');
        const selectedDirectory = path.resolve(configuredDirectory);
        const relativeToProject = path.relative(projectRoot, selectedDirectory);
        if (relativeToProject === '' || (!relativeToProject.startsWith(`..${path.sep}`) && relativeToProject !== '..' && !path.isAbsolute(relativeToProject))) {
            throw new Error('Production data directory cannot be inside the repository');
        }
        let stats;
        try { stats = fs.statSync(selectedDirectory); }
        catch { throw new Error('Production PRODUCTION_DATA_DIR must be an existing persistent directory'); }
        if (!stats.isDirectory()) throw new Error('Production PRODUCTION_DATA_DIR must be a directory');
        return selectedDirectory;
    }
    if (appEnvironment !== 'development') return normalDataDirectory;
    const selectedDirectory = path.resolve(env.DEVELOPMENT_DATA_DIR || developmentDataDirectory);
    if (env.NODE_ENV === 'test') {
        const tempRoot = path.resolve(os.tmpdir());
        const relativeDirectory = path.relative(tempRoot, selectedDirectory);
        if (relativeDirectory === '..' || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
            throw new Error('Development test data directory must be under the operating system temporary directory');
        }
        return selectedDirectory;
    }
    if (selectedDirectory !== path.resolve(developmentDataDirectory)) {
        throw new Error('Development runtime requires the isolated data/development directory');
    }
    return selectedDirectory;
}

function getDevelopmentDatabasePath() {
    return developmentDatabasePath;
}

function isDevelopmentDatabasePath(candidatePath) {
    return Boolean(candidatePath) && path.resolve(candidatePath) === path.resolve(developmentDatabasePath);
}

module.exports = {
    getDatabasePath,
    getDevelopmentDatabasePath,
    getRuntimeDataDirectory,
    isDevelopmentDatabasePath,
    normalDatabasePath,
    normalDataDirectory
};