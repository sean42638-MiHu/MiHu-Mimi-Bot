const path = require('node:path');
const os = require('node:os');

const projectRoot = path.resolve(__dirname, '..');
const normalDatabasePath = path.join(projectRoot, 'database.sqlite');
const developmentDatabasePath = path.join(projectRoot, 'data', 'development.sqlite');
const normalDataDirectory = path.join(projectRoot, 'data');
const developmentDataDirectory = path.join(normalDataDirectory, 'development');

function getDatabasePath(env = process.env) {
    if (env.NODE_ENV === 'test') {
        if (!env.TEST_DATABASE_PATH) throw new Error('NODE_ENV=test requires TEST_DATABASE_PATH');
        return path.resolve(env.TEST_DATABASE_PATH);
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
    if (String(env.APP_ENV || '').trim().toLowerCase() !== 'development') return normalDataDirectory;
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