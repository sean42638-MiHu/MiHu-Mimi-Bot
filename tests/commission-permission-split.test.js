'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-commission-auth-')), 'test.sqlite');
const router = require('../routes/management/commission');
const { resolvePermissions } = require('../utils/permissionResolver');

function permissionOutcome(layer, perms) {
  const check = layer.route.stack[1].handle;
  let result = 'none';
  const res = {
    locals: { userPerms: resolvePermissions(perms) },
    status(code) { result = code; return this; },
    send() { return this; },
    redirect() { result = 'redirect'; return this; }
  };
  check({ user: { id: 'test-user' } }, res, () => { result = 'allowed'; });
  return result;
}

test('commission read access never authorizes a write route; legacy access remains compatible', () => {
  const layers = router.stack.filter(layer => layer.route);
  const read = layers.find(layer => layer.route.path === '/' && layer.route.methods.get);
  const writes = layers.filter(layer => layer.route.methods.post);
  assert.ok(read);
  assert.equal(writes.length, 4);
  assert.equal(permissionOutcome(read, ['commission.view']), 'allowed');
  assert.equal(permissionOutcome(read, ['commission.manage']), 'allowed');
  for (const layer of writes) {
    assert.equal(permissionOutcome(layer, ['commission.view']), 403, layer.route.path);
    assert.equal(permissionOutcome(layer, ['commission.manage']), 'allowed', layer.route.path);
    assert.equal(permissionOutcome(layer, ['sys_commission']), 'allowed', layer.route.path);
  }
  assert.equal(permissionOutcome(read, ['sys_commission']), 'allowed');
});

test('view-only commission list contains rates without edit controls', () => {
  const file = path.join(__dirname, '../views/partials/commission_category_list.ejs');
  const template = fs.readFileSync(file, 'utf8');
  const categories = [{ category: '測試類別', rate: .8 }];
  const view = ejs.render(template, { categories, hasPerm: key => key === 'commission.view' });
  const manage = ejs.render(template, { categories, hasPerm: key => key === 'commission.manage' });
  assert.match(view, /測試類別/);
  assert.doesNotMatch(view, /commission-manage-btn/);
  assert.match(manage, /commission-manage-btn/);
});
