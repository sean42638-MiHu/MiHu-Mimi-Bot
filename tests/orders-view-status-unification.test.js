const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

function read(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('my orders and management orders use shared status filters and badge partial', () => {
    const myOrders = read('views/my_orders.ejs');
    const managementOrders = read('views/orders.ejs');
    const ordersTable = read('views/partials/orders_table.ejs');

    assert.match(myOrders, /const filterOptions = orderStatusFilters \|\| \[\]/);
    assert.match(managementOrders, /const filterOptions = orderStatusFilters \|\| \[\]/);
    assert.match(myOrders, /\/css\/order-status-badge\.css/);
    assert.match(managementOrders, /\/css\/order-status-badge\.css/);
    assert.match(myOrders, /\/js\/order-status-dom\.js/);
    assert.match(managementOrders, /\/js\/order-status-dom\.js/);

    assert.match(myOrders, /include\('partials\/order_status_badge'/);
    assert.match(ordersTable, /include\('\.\/order_status_badge'/);

    assert.doesNotMatch(managementOrders, /data-filter="refunded"/);
    assert.doesNotMatch(managementOrders, /data-filter="rejected"/);
    assert.doesNotMatch(myOrders, /data-filter="active"/);
    assert.doesNotMatch(ordersTable, /status-badge-pending/);
});
