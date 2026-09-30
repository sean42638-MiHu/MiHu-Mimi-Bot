const express = require('express');
const router = express.Router();
const { ensureAuth, checkPerm } = require('../../middleware/auth');
const { generateReconciliationReport } = require('../../utils/reconciliationService');
const { generateWalletMirrorReport } = require('../../utils/walletMirrorMonitor');

router.get('/', ensureAuth, checkPerm('action_staff_payroll_details'), async (req, res) => {
    try {
        const report = await generateReconciliationReport();
        return res.json({ success: true, readOnly: true, report });
    } catch (error) {
        console.error('Reconciliation report failed:', error);
        return res.status(500).json({ success: false, error: 'Unable to generate reconciliation report' });
    }
});

router.get('/wallet-mirror', ensureAuth, checkPerm('action_staff_payroll_details'), async (req, res) => {
    try {
        const report = await generateWalletMirrorReport();
        return res.json({ success: true, readOnly: true, repairsPerformed: 0, report });
    } catch (error) {
        console.error('Wallet mirror report failed:', error && error.code ? error.code : 'read-only query failure');
        return res.status(500).json({ success: false, error: 'Unable to generate wallet mirror report' });
    }
});

module.exports = router;
