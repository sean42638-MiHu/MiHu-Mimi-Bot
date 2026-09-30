'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const baseline = require('./fixtures/permission-compatibility.json');
const { PERMISSION_ALIASES } = require('../config/permissionAliases');
const { PERMISSION_METADATA } = require('../config/permissions');
const { parsePermissionData, resolvePermissions, hasResolvedPermission, serializePermissionGrant } = require('../utils/permissionResolver');
const { validatePermissionGrant, canModifyRole } = require('../services/roleDelegationService');

test('every pre-refactor grant keeps exactly its original capability matrix after conversion', () => {
    assert.ok(Object.keys(PERMISSION_ALIASES).length >= new Set(Object.values(PERMISSION_ALIASES)).size);
    const isAllowedAdditiveCompatibilityPermission = key => /^view_cat_system_(settings|manage|info)$/.test(key);
    for (const [oldKey, expected] of Object.entries(baseline)) {
        const canonical = PERMISSION_ALIASES[oldKey];
        assert.match(canonical, /^(view|action)_/);
        assert.ok(PERMISSION_METADATA[canonical]);
        const resolved = new Set(resolvePermissions([oldKey]));
        const expectedResolved = new Set(expected.map(key => PERMISSION_ALIASES[key]));
        expectedResolved.forEach(key => assert.ok(resolved.has(key), `${oldKey} missing ${key}`));
        resolved.forEach(key => {
            if (!expectedResolved.has(key)) assert.ok(isAllowedAdditiveCompatibilityPermission(key), `${oldKey} unexpected additive permission: ${key}`);
        });
        for (const check of Object.keys(baseline)) {
            assert.equal(hasResolvedPermission([canonical], check), expected.includes(check), `${oldKey} -> ${check}`);
        }
        assert.deepEqual(resolvePermissions(JSON.stringify([oldKey])), resolvePermissions({ [oldKey]: true }));
    }
});

test('boolean maps fail closed for non-true values, malformed JSON and unknown wildcard variants', () => {
    for (const value of [false, 'false', 'true', 1, 0, null, {}, [], {enabled:true}]) {
        assert.equal(hasResolvedPermission({ '*': value }, 'view_manage_members'), false);
        assert.equal(hasResolvedPermission({ 'members.manage': value }, 'action_member_manage'), false);
    }
    for (const value of ['not-json', 'null', '42', '["members.view",true]', {'**':true}, {'查看會員':true}]) {
        assert.deepEqual(resolvePermissions(value), []);
    }
    assert.equal(hasResolvedPermission(['*'], 'unknown.permission'), false);
    assert.equal(hasResolvedPermission({ 'members.view': true }, 'view_member_ledger'), false);
    assert.equal(hasResolvedPermission({ 'staff.view': true }, 'view_staff_payroll'), false);
    assert.equal(hasResolvedPermission({ 'payroll.view': true }, 'action_staff_payroll'), false);
});

test('save canonical explicit grants while retaining unknown values without granting or accepting injection', () => {
    const original = '{"members.view":true,"future.flag":false,"custom": {"note":"保留"},"opaque":true}';
    const granted = validatePermissionGrant(resolvePermissions(['*']), ['members.view']);
    assert.deepEqual(granted, ['view_manage_members']);
    const saved = serializePermissionGrant(granted, original);
    assert.deepEqual(JSON.parse(saved), {'future.flag':false,custom:{note:'保留'},opaque:true,view_manage_members:true});
    assert.deepEqual(resolvePermissions(saved), ['view_manage_members']);
    assert.throws(() => validatePermissionGrant(['*'], ['future.injected']));
    assert.equal(canModifyRole({permissions:resolvePermissions(['*']),roleKey:'admin'}, {role_key:'custom',permissions:original}),true);
    assert.equal(canModifyRole({permissions:resolvePermissions(['roles.manage','members.view']),roleKey:'manager'}, {role_key:'custom',permissions:original}),false);
    assert.throws(() => serializePermissionGrant([], '{broken'));
    assert.equal(parsePermissionData('{broken').valid, false);
    assert.equal(canModifyRole({permissions:['*']}, {permissions:'{broken'}), false);
    const manage = validatePermissionGrant(resolvePermissions(['*']), ['system_settings.manage']);
    const reopened = parsePermissionData(serializePermissionGrant(manage, '[]')).keys;
    assert.deepEqual(reopened, ['action_system_config']);
    assert.ok(resolvePermissions(reopened).includes('view_system_settings'));
    assert.deepEqual(resolvePermissions([]), []);
    assert.deepEqual(validatePermissionGrant(['*'], ['*', 'members.view']), ['*', 'view_manage_members']);
});


test('unimplemented independent gates remain read-only and survive an otherwise empty save', () => {
    const old = '["home_banner","system"]';
    const saved = serializePermissionGrant([], old);
    assert.deepEqual(JSON.parse(saved), ['view_dashboard_banner']);
    for (const key of JSON.parse(saved)) assert.equal(PERMISSION_METADATA[key].implemented, false);
    assert.equal(PERMISSION_METADATA.view_system.implemented, true);
});
