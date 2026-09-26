const express = require('express');
const router = express.Router();
const db = require('../database');

// 🚀 載入拆分模組 (含新建立的獨立抽傭路由)
const membersRouter = require('./management/members');
const staffRouter = require('./management/staff');
const payrollRouter = require('./management/payroll');
const ordersRouter = require('./management/orders');
const commissionRouter = require('./management/commission'); // 👈 新增獨立抽傭模組
const reconciliationRouter = require('./management/reconciliation');

// 🚀 正確掛載管理子路由（指定專屬路徑前綴）
router.use('/members', membersRouter);
router.use('/staff', staffRouter);
router.use('/payroll', payrollRouter);
router.use('/orders', ordersRouter);
router.use('/commission', commissionRouter); // 👈 正確掛載 /management/commission
router.use('/reconciliation', reconciliationRouter);

module.exports = router;