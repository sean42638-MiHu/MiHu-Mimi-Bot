'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth: ensureAuth, requirePerm: checkPerm } = require('../../middleware/auth');
const { getBusinessAnalytics } = require('../../services/businessAnalyticsService');

router.get('/', ensureAuth, checkPerm('action_view_analytics'), async (req, res) => {
    try {
        const analytics = await getBusinessAnalytics({ studioId: req.user.studio_id, query: req.query });
        return res.render('business_analytics', { activePage: 'analytics', analytics, error: null });
    } catch (error) {
        console.error('載入公司營運統計失敗:', error.message);
        return res.status(503).render('business_analytics', { activePage: 'analytics', analytics: null, error: '營運統計目前無法載入，請稍後再試。' });
    }
});

module.exports = router;
