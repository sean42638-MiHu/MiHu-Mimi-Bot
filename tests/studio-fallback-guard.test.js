const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const runtimeDirectories = ['routes', 'commands', 'handlers', 'utils'];
const fallbackPatterns = [
    /studio_id\s*=\s*1\b/i,
    /studioId\s*=\s*1\b/i,
    /\b(?:studioId|studio_id|studio)\s*(?:\|\||\?\?)\s*1\b/i,
    /Number\([^\n]*studio_id[^\n]*\)\s*\|\|\s*1\b/i
];

function collectJavaScriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectJavaScriptFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    });
}

test('runtime studio-scoped modules do not fall back to Studio 1', () => {
    const root = path.join(__dirname, '..');
    const files = runtimeDirectories.flatMap(directory => collectJavaScriptFiles(path.join(root, directory)));
    const violations = files.flatMap(fullPath => fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)
        .map((line, index) => ({ file: path.relative(root, fullPath), line: index + 1, text: line }))
        .filter(entry => fallbackPatterns.some(pattern => pattern.test(entry.text))));
    assert.deepEqual(violations, [], violations.map(entry => `${entry.file}:${entry.line}`).join('\n'));
});
