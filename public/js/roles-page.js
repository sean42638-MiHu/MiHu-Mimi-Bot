'use strict';
    let viewRoleModal, editRoleInfoModal;
    const delegatablePermissionKeys = new Set(window.rolePageConfig.delegatablePermissions);
    const legacyPermissionImplications = window.rolePageConfig.legacyPermissionImplications || {};
    const permissionLabelMap = window.rolePageConfig.permissionLabels || {};
    const canGrantWildcard = window.rolePageConfig.canGrantWildcard;

    function syncImpliedPermissions(scope = document.getElementById('editRolePermsModal')) {
        const checkboxes = [...scope.querySelectorAll('.perm-checkbox')];
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

        checkboxes.forEach(checkbox => {
            const source = impliedBy.get(checkbox.value);
            const canDelegate = (checkbox.value === '*' && canGrantWildcard)
                || delegatablePermissionKeys.has(checkbox.value);
            checkbox.checked = explicit.has(checkbox.value) || Boolean(source);
            checkbox.disabled = checkbox.dataset.inactive === 'true' || !canDelegate || Boolean(source && !explicit.has(checkbox.value));
            const sourceLabel = source ? (permissionLabelMap[source] || checkbox.dataset.permissionLabel || source) : '';
            checkbox.title = source ? `由「${sourceLabel}」推導啟用` : (!canDelegate ? '你沒有權限授予此項目' : '');

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
            syncImpliedPermissions(checkbox.closest('form'));
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

        modalEl.querySelectorAll('.perm-checkbox').forEach(cb => {
            cb.checked = false;
            cb.dataset.explicitChecked = 'false';
        });

        if (Array.isArray(currentPermsArray)) {
            currentPermsArray.forEach(perm => {
                const cb = modalEl.querySelector(`.perm-checkbox[value="${perm}"]`);
                if (cb) {
                    cb.checked = true;
                    cb.dataset.explicitChecked = 'true';
                }
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
            const color = row.getAttribute('data-color');
            const tier = row.getAttribute('data-tier');
            const desc = row.getAttribute('data-desc');

            let perms = [];
            try {
                const rawPerms = row.getAttribute('data-perms');
                perms = rawPerms ? JSON.parse(rawPerms) : [];
            } catch (e) {
                perms = [];
            }

            row.addEventListener('click', () => {
                const nameBadge = document.getElementById('viewRoleNameBadge');
                nameBadge.textContent = name;
                nameBadge.className = `role-pill-badge badge-style-${color}`;
        nameBadge.dataset.rolekey = row.dataset.rolekey || "";
                document.getElementById('viewRoleCategoryText').textContent = `[ ${category} · Lv.${tier} ]`;
                document.getElementById('viewRoleDesc').textContent = desc || '無特別說明';

                const displayBox = document.getElementById('viewRolePermTreeDisplay');
                if (displayBox) {
                    displayBox.innerHTML = '';
                    if (perms.length > 0) {
                        perms.forEach(p => {
                            const badge = document.createElement('span');
                            badge.className = 'badge bg-purple bg-opacity-25 text-purple border border-purple border-opacity-25 me-2 mb-2 p-2';
                            badge.textContent = p;
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
                editInfoBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
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
                editPermsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openEditRolePermsModal(roleKey, name, perms, JSON.parse(row.dataset.unknownPermissions || '{}'));
                });
            }
        });
    });
