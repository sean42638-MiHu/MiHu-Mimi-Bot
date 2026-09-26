const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const sourceDirectories = [
    path.join(__dirname, '..', 'commands'),
    path.join(__dirname, '..', 'handlers')
];
const directOrderMutation = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:main\.)?["`\[]?orders\b/i;

function collectJavaScriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectJavaScriptFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    });
}

test('Discord command and handler layers do not mutate orders directly', () => {
    const violations = sourceDirectories.flatMap(directory => collectJavaScriptFiles(directory))
        .flatMap(filePath => fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
            .map((line, index) => ({ filePath, line: index + 1, line }))
            .filter(entry => directOrderMutation.test(entry.line)));

    assert.deepEqual(violations, [], violations.map(item => `${path.relative(path.join(__dirname, '..'), item.filePath)}:${item.line}`).join('\n'));
});
