'use strict';
let viewRoleModal, editRoleInfoModal;
const rolePageConfig = window.rolePageConfig || {};
const delegatablePermissionKeys = new Set(rolePageConfig.delegatablePermissions || []);
const legacyPermissionImplications = rolePageConfig.legacyPermissionImplications || {};
const permissionLabelMap = rolePageConfig.permissionLabels || {};
const roleBadgeClassMap = rolePageConfig.roleBadgeClassMap || {};
const canGrantWildcard = Boolean(rolePageConfig.canGrantWildcard);

function canDelegatePermissionKey(permissionKey) {
    return (permissionKey === '*' && canGrantWildcard) || delegatablePermissionKeys.has(permissionKey);
}

function resolveRoleBadgeClass(roleKey) {
    const key = String(roleKey || '').trim().toLowerCase();
    return roleBadgeClassMap[key] || 'role-badge role-badge-default';
}

function notifyPermissionHint(message) {
    if (!message) return;
    if (window.MiHuFeedback && typeof window.MiHuFeedback.warning === 'function') {
        window.MiHuFeedback.warning('權限關聯提醒', message);
        return;
    }
    window.alert(message);
}

function getPermissionHierarchy(scope) {
    const checkboxes = [...scope.querySelectorAll('.perm-checkbox')];
    const byKey = new Map(checkboxes.map(checkbox => [checkbox.value, checkbox]));
    const childrenByParent = new Map();

    checkboxes.forEach(checkbox => {
        const parentKey = checkbox.dataset.permissionParentKey;
        if (!parentKey) return;
        if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
        childrenByParent.get(parentKey).push(checkbox);
    });

    return { checkboxes, byKey, childrenByParent };
}

function collectCheckedDescendants(parentKey, hierarchy, visited = new Set()) {
    if (visited.has(parentKey)) return [];
    visited.add(parentKey);
    const directChildren = hierarchy.childrenByParent.get(parentKey) || [];
    const descendants = [];
    directChildren.forEach(child => {
        if (child.checked) descendants.push(child);
        descendants.push(...collectCheckedDescendants(child.value, hierarchy, visited));
    });
    return descendants;
}

function enableParentChain(checkbox, hierarchy) {
    let parentKey = checkbox.dataset.permissionParentKey;
    while (parentKey) {
        const parent = hierarchy.byKey.get(parentKey);
        if (!parent) break;
        if (parent.disabled) {
            const parentLabel = parent.dataset.permissionLabel || permissionLabelMap[parent.value] || parent.value;
            notifyPermissionHint(`「${parentLabel}」不可委派，無法單獨開啟子項。`);
            return false;
        }
        parent.checked = true;
        parent.dataset.explicitChecked = 'true';
        parentKey = parent.dataset.permissionParentKey;
    }
    return true;
}

function applyHierarchyToggleRules(changedCheckbox, scope) {
    if (!changedCheckbox || !scope) return;
    const hierarchy = getPermissionHierarchy(scope);

    if (changedCheckbox.checked && changedCheckbox.dataset.permissionChild === 'true') {
        if (!enableParentChain(changedCheckbox, hierarchy)) {
            changedCheckbox.checked = false;
            changedCheckbox.dataset.explicitChecked = 'false';
            return;
        }
    }

    if (changedCheckbox.dataset.permissionParent === 'true' && !changedCheckbox.checked) {
        const activeDescendants = collectCheckedDescendants(changedCheckbox.value, hierarchy)
            .filter((checkbox, index, list) => list.indexOf(checkbox) === index);
        if (!activeDescendants.length) return;

        const blocked = activeDescendants.filter(checkbox => checkbox.disabled);
        if (blocked.length) {
            changedCheckbox.checked = true;
            changedCheckbox.dataset.explicitChecked = 'true';
            const blockedNames = blocked
                .map(checkbox => checkbox.dataset.permissionLabel || permissionLabelMap[checkbox.value] || checkbox.value)
                .join('、');
            notifyPermissionHint(`仍有不可編輯子項啟用中：${blockedNames}`);
            return;
        }

        activeDescendants.forEach(checkbox => {
            checkbox.checked = false;
            checkbox.dataset.explicitChecked = 'false';
        });
    }
}

function syncImpliedPermissions(scope = document.getElementById('editRolePermsModal')) {
    const hierarchy = getPermissionHierarchy(scope);
    const checkboxes = hierarchy.checkboxes;
    const explicit = new Set(checkboxes
        .filter(checkbox => checkbox.dataset.explicitChecked === 'true')
        .map(checkbox => checkbox.value));
    const checked = new Set(explicit);
    const impliedBy = new Map();
    const pending = [...checked];

    while (pending.length) {
        const source = pending.pop();
        for (const implied of legacyPermissionImplications[source] || []) {
            if (!impliedBy.has(implied)) impliedBy.set(implied, source);
            if (!checked.has(implied)) {
                checked.add(implied);
                pending.push(implied);
            }
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        hierarchy.childrenByParent.forEach((children, parentKey) => {
            if (!children.some(child => checked.has(child.value))) return;
            if (!checked.has(parentKey)) {
                checked.add(parentKey);
                changed = true;
            }
            if (!explicit.has(parentKey) && !impliedBy.has(parentKey)) {
                const sourceChild = children.find(child => checked.has(child.value));
                if (sourceChild) impliedBy.set(parentKey, sourceChild.value);
            }
        });
    }

    checkboxes.forEach(checkbox => {
        const source = impliedBy.get(checkbox.value);
        const canDelegate = canDelegatePermissionKey(checkbox.value);
        const parentKey = checkbox.dataset.permissionParentKey;
        const parentCheckbox = parentKey ? hierarchy.byKey.get(parentKey) : null;
        const blockedByParent = Boolean(parentCheckbox && !canDelegatePermissionKey(parentCheckbox.value));

        checkbox.checked = explicit.has(checkbox.value) || Boolean(source);
        checkbox.disabled = checkbox.dataset.inactive === 'true'
            || !canDelegate
            || Boolean(source && !explicit.has(checkbox.value))
            || blockedByParent;

        const sourceLabel = source ? (permissionLabelMap[source] || checkbox.dataset.permissionLabel || source) : '';
        checkbox.title = source
            ? `由「${sourceLabel}」推導啟用`
            : (!canDelegate
                ? '你沒有權限授予此項目'
                : (blockedByParent ? '父分類未授權，無法單獨委派子項' : ''));

        const label = checkbox.closest('label') || document.querySelector(`label[for="${checkbox.id}"]`);
        if (!label) return;
        let lock = label.querySelector('.permission-lock-indicator');
        let hint = label.querySelector('.permission-implied-hint');

        if (checkbox.disabled && !lock) {
            lock = document.createElement('i');
            lock.className = 'fa-solid fa-lock text-secondary permission-lock-indicator';
            label.append(lock);
        }
        if (lock) {
            if (!checkbox.disabled) lock.remove();
            else {
                lock.title = checkbox.title;
                lock.setAttribute('aria-label', checkbox.title);
            }
        }
        if (source && !hint) {
            hint = document.createElement('small');
            hint.className = 'permission-implied-hint d-block text-secondary';
            const nameNode = label.querySelector('.admin-permission-name');
            if (nameNode) nameNode.append(hint);
        }
        if (!source && hint) hint.remove();
        if (source && hint) hint.textContent = `由「${sourceLabel}」推導啟用`;
    });
}

document.querySelectorAll('.perm-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
        checkbox.dataset.explicitChecked = String(checkbox.checked);
        const scope = checkbox.closest('form');
        applyHierarchyToggleRules(checkbox, scope);
        syncImpliedPermissions(scope);
    });
});

document.querySelectorAll('form').forEach(form => {
    if (form.querySelector('.perm-checkbox')) syncImpliedPermissions(form);
});

function openEditRolePermsModal(roleKey, roleName, currentPermsArray, unknownPermissions = {}) {
    const modalEl = document.getElementById('editRolePermsModal');
    if (!modalEl) return;
    document.getElementById('targetRoleKey').value = roleKey;
    document.getElementById('targetRoleName').textContent = `${roleName} (${roleKey})`;

    modalEl.querySelectorAll('.perm-checkbox').forEach(checkbox => {
        checkbox.checked = false;
        checkbox.dataset.explicitChecked = 'false';
    });

    if (Array.isArray(currentPermsArray)) {
        currentPermsArray.forEach(permission => {
            const checkbox = modalEl.querySelector(`.perm-checkbox[value="${permission}"]`);
            if (!checkbox) return;
            checkbox.checked = true;
            checkbox.dataset.explicitChecked = 'true';
        });
    }

    const unknownSection = document.getElementById('roleUnknownPermissions');
    const unknownList = document.getElementById('roleUnknownPermissionList');
    unknownList.replaceChildren();
    Object.entries(unknownPermissions).forEach(([key, value]) => {
        const line = document.createElement('div');
        line.textContent = `${key}: ${JSON.stringify(value)}`;
        unknownList.append(line);
    });
    unknownSection.hidden = Object.keys(unknownPermissions).length === 0;

    syncImpliedPermissions(modalEl);
    const visibilityTabTrigger = modalEl.querySelector('#rolePermissionTabVisibilityTrigger');
    if (visibilityTabTrigger) {
        if (typeof bootstrap !== 'undefined' && bootstrap && bootstrap.Tab && typeof bootstrap.Tab.getOrCreateInstance === 'function') {
            bootstrap.Tab.getOrCreateInstance(visibilityTabTrigger).show();
        } else if (typeof visibilityTabTrigger.setAttribute === 'function') {
            visibilityTabTrigger.setAttribute('aria-selected', 'true');
        }
    }

    const modalInstance = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
    modalInstance.show();
}

document.addEventListener('DOMContentLoaded', () => {
    viewRoleModal = new bootstrap.Modal(document.getElementById('viewRoleModal'));
    const editRoleInfoModalElement = document.getElementById('editRoleInfoModal');
    editRoleInfoModal = editRoleInfoModalElement ? new bootstrap.Modal(editRoleInfoModalElement) : null;

    document.querySelectorAll('.role-row').forEach(row => {
        const id = row.getAttribute('data-id');
        const roleKey = row.getAttribute('data-rolekey') || 'role_' + id;
        const name = row.getAttribute('data-name');
        const category = row.getAttribute('data-category');
        const tier = row.getAttribute('data-tier');
        const desc = row.getAttribute('data-desc');

        let perms = [];
        try {
            const rawPerms = row.getAttribute('data-perms');
            perms = rawPerms ? JSON.parse(rawPerms) : [];
        } catch {
            perms = [];
        }

        row.addEventListener('click', () => {
            const nameBadge = document.getElementById('viewRoleNameBadge');
            nameBadge.textContent = name;
            nameBadge.className = `role-pill-badge ${resolveRoleBadgeClass(roleKey)}`;
            nameBadge.dataset.rolekey = roleKey;
            document.getElementById('viewRoleCategoryText').textContent = `[ ${category} · Lv.${tier} ]`;
            document.getElementById('viewRoleDesc').textContent = desc || '無特別說明';

            const displayBox = document.getElementById('viewRolePermTreeDisplay');
            if (displayBox) {
                displayBox.innerHTML = '';
                if (perms.length > 0) {
                    perms.forEach(permission => {
                        const badge = document.createElement('span');
                        badge.className = 'admin-badge admin-badge-purple me-2 mb-2 p-2';
                        badge.textContent = permission;
                        displayBox.append(badge);
                    });
                } else {
                    displayBox.innerHTML = '<div class="text-secondary small text-center py-3">尚未開啟任何權限項目</div>';
                }
            }
            viewRoleModal.show();
        });

        const editInfoBtn = row.querySelector('.btn-edit-info');
        if (editInfoBtn) {
            editInfoBtn.addEventListener('click', event => {
                event.stopPropagation();
                document.getElementById('editRoleInfoForm').action = `/system/roles/update-info/${id}`;
                document.getElementById('editRoleInfoTitle').textContent = `編輯「${name}」基本資料`;
                document.getElementById('editInfoName').value = name;
                document.getElementById('editInfoCategory').value = category;
                document.getElementById('editInfoTier').value = tier;
                document.getElementById('editInfoDesc').value = desc;
                editRoleInfoModal.show();
            });
        }

        const editPermsBtn = row.querySelector('.btn-edit-perms');
        if (editPermsBtn) {
            editPermsBtn.addEventListener('click', event => {
                event.stopPropagation();
                openEditRolePermsModal(roleKey, name, perms, JSON.parse(row.dataset.unknownPermissions || '{}'));
            });
        }
    });
});
