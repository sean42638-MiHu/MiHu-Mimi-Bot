const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { getEmployeePayoutOverview, requestWithdrawal } = require('../../services/payoutService');

function getAuthenticatedStudioId(req) {
    const studioId = Number(req.user && req.user.studio_id);
    return Number.isInteger(studioId) && studioId > 0 ? studioId : null;
}

router.get('/api/withdrawals', requireAuth, async (req, res) => {
    const studioId = getAuthenticatedStudioId(req);
    if (!studioId) return res.status(403).json({ success: false, message: '找不到已授權的工作室範圍' });
    try {
        const overview = await getEmployeePayoutOverview({ userId: req.user.id, studioId });
        return res.json({ success: true, overview });
    } catch (error) {
        return res.status(500).json({ success: false, message: '無法載入提款資訊' });
    }
});

router.post('/api/withdrawals/request', requireAuth, async (req, res) => {
    const studioId = getAuthenticatedStudioId(req);
    if (!studioId) return res.status(403).json({ success: false, message: '找不到已授權的工作室範圍' });
    try {
        const result = await requestWithdrawal({
            userId: req.user.id,
            amount: req.body.amount,
            operatorId: req.user.id
        });
        return res.status(201).json({ success: true, withdrawal: result });
    } catch (error) {
        const status = /提款|薪轉|會員|工作室|金額|申請期間|週期/.test(String(error.message)) ? 400 : 500;
        return res.status(status).json({ success: false, message: error.message || '提款申請失敗' });
    }
});

module.exports = router;
