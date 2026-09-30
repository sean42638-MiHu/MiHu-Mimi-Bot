'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { PERMISSION_METADATA } = require('../config/permissions');
const { PERMISSION_IMPLICATIONS } = require('../utils/permissionResolver');

test('actual editor script separates forms and clears derived state while retaining explicit grants', () => {
    const createScope = () => {
        const scope = { checkboxes: [], querySelectorAll: () => scope.checkboxes,
            querySelector: selector => scope.checkboxes.find(cb => selector.includes(`value="${cb.value}"`)) || scope.checkboxes[0] };
        scope.checkboxes = ['action_system_config','view_system_settings'].map(value => ({
            value, checked:false, disabled:false, dataset:{}, title:'', listeners:{},
            addEventListener(type, handler) { this.listeners[type]=handler; },
            closest(selector) { return selector === 'form' ? scope : null; }
        }));
        return scope;
    };
    const edit=createScope(), add=createScope();
    const elements={editRolePermsModal:edit,targetRoleKey:{},targetRoleName:{},
        roleUnknownPermissions:{}, roleUnknownPermissionList:{children:[],replaceChildren(){this.children=[];},append(line){this.children.push(line);}}};
    const document = { querySelectorAll: selector => selector === 'form' ? [edit,add] : [...edit.checkboxes,...add.checkboxes],
        getElementById: id => elements[id], querySelector:()=>null, addEventListener(){}, createElement:()=>({textContent:''}) };
    const context = { document, window:{rolePageConfig:{delegatablePermissions:Object.keys(PERMISSION_METADATA),
        legacyPermissionImplications:PERMISSION_IMPLICATIONS,canGrantWildcard:true}}, bootstrap:{Modal:class {static getInstance(){return null;} show(){}}} };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve('../public/js/roles-page.js'),'utf8'),context);
    add.checkboxes[0].checked=true;add.checkboxes[0].listeners.change();
    assert.equal(add.checkboxes[1].checked,true);
    context.openEditRolePermsModal('custom','名稱',['action_system_config'],{opaque:'<script>inert</script>'});
    assert.equal(edit.checkboxes[1].checked,true);
    assert.equal(edit.checkboxes[1].disabled,true);
    assert.equal(add.checkboxes[0].dataset.explicitChecked,'true');
    edit.checkboxes[0].checked=false;edit.checkboxes[0].listeners.change();
    assert.equal(edit.checkboxes[1].checked,false);
    assert.equal(edit.checkboxes[1].disabled,false);
    assert.equal(add.checkboxes[1].checked,true);
    context.openEditRolePermsModal('custom','名稱',['action_system_config','view_system_settings']);
    edit.checkboxes[0].checked=false;edit.checkboxes[0].listeners.change();
    assert.equal(edit.checkboxes[1].checked,true);
    assert.equal(edit.checkboxes[1].dataset.explicitChecked,'true');
    assert.equal(elements.roleUnknownPermissions.hidden,true);
});
