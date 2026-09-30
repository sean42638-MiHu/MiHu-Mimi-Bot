const express = require('express');
const router = express.Router();
const { requireAuth: ensureAuth, requirePerm: checkPerm } = require('../../middleware/auth');
const { writeAuditLog } = require('../../utils/auditService');
const { withTransactionGate } = require('../../utils/transactionGate');
const db = require('../../database');
const { normalizeTalentShareRate } = require('../../utils/commissionHelper');
const { syncCommissionJsonFromDb } = require('../../utils/dataSync');

const DEFAULT_CATEGORIES = [
	{ category: '陪玩單', rate: 0.80 },
	{ category: '禮物單', rate: 0.85 },
	{ category: '有獎單', rate: 0.90 },
	{ category: '冠名單', rate: 0.85 },
	{ category: '其他單', rate: 0.80 },
	{ category: '獎金單', rate: 1.00 }
];

const CATEGORY_ORDER = DEFAULT_CATEGORIES.map(item => item.category);
const CATEGORY_ALIASES = { '有獎': '有獎單', '冠名': '冠名單', '獎金': '獎金單', '其他': '其他單', '活動單': '其他單' };
const CATEGORY_STORAGE_ALIASES = {
	'有獎單': ['有獎單', '有獎'],
	'冠名單': ['冠名單', '冠名'],
	'獎金單': ['獎金單', '獎金'],
	'其他單': ['其他單', '其他', '活動單']
};

function canonicalCategory(category) {
	return CATEGORY_ALIASES[category] || category;
}

function categoryStorageKeys(category) {
	return CATEGORY_STORAGE_ALIASES[category] || [category];
}

function all(sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
	});
}

function run(sql, params = []) {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (err) {
			if (err) return reject(err);
			resolve({ changes: this.changes, lastID: this.lastID });
		});
	});
}

function syncCommissionJson() {
	return new Promise((resolve, reject) => {
		syncCommissionJsonFromDb(err => err ? reject(err) : resolve());
	});
}

router.get('/', ensureAuth, checkPerm('view_commission'), async (req, res) => {
	try {
		const rows = await all('SELECT category, rate FROM commission_settings ORDER BY category COLLATE NOCASE');
		const categoriesByName = new Map();
		rows.forEach(row => {
			const category = canonicalCategory(row.category);
			if (categoriesByName.has(category) && row.category !== category) return;
			categoriesByName.set(category, { category, rate: normalizeTalentShareRate(row.rate) });
		});
		const categories = Array.from(categoriesByName.values());
		categories.sort((left, right) => {
			const leftRank = CATEGORY_ORDER.indexOf(left.category);
			const rightRank = CATEGORY_ORDER.indexOf(right.category);
			if (leftRank !== -1 || rightRank !== -1) {
				return (leftRank === -1 ? CATEGORY_ORDER.length : leftRank) - (rightRank === -1 ? CATEGORY_ORDER.length : rightRank);
			}
			return left.category.localeCompare(right.category, 'zh-Hant');
		});

		res.render('commission', {
			user: req.user,
			activePage: 'commission',
			categories,
			success: req.query.saved === '1',
			error: req.query.error || null
		});
	} catch (err) {
		console.error('載入抽佣類別失敗:', err);
		res.status(500).send('載入抽佣類別失敗');
	}
});

router.post('/update-single', ensureAuth, checkPerm('action_commission_config'), async (req, res) => {
	const submittedCategory = req.body.category_name ?? req.body.category;
	const categoryValue = Array.isArray(submittedCategory) ? submittedCategory[0] : submittedCategory;
	const category = canonicalCategory(String(categoryValue || '').trim());
	const rawRate = req.body.rate;

	try {
		if (!category || rawRate === undefined || rawRate === null || String(rawRate).trim() === '') {
			throw new Error('類別與比例不可為空');
		}
		const rate = normalizeTalentShareRate(rawRate);
		if (rate === null) throw new Error('比例必須介於 0% 至 100%');

		const storedCategories = categoryStorageKeys(category);
		const placeholders = storedCategories.map(() => '?').join(',');
		const existing = await all(`SELECT category, rate FROM commission_settings WHERE category IN (${placeholders})`, storedCategories);
		if (existing.length === 0) throw new Error(`找不到類別「${category}」`);

		await withTransactionGate(async () => {
			await run('BEGIN IMMEDIATE');
			try {
			await run(
				`UPDATE commission_settings SET rate = ?, updated_at = CURRENT_TIMESTAMP WHERE category IN (${placeholders})`,
				[rate, ...storedCategories]
			);
			await writeAuditLog({
				operatorId: req.user.id,
				action: 'commission_rate_update',
				targetType: 'commission_category',
				targetId: category,
				before: existing,
				after: { category, rate },
				metadata: { source: 'management-commission-route' }
			});
			await run('COMMIT');
			} catch (err) {
				await run('ROLLBACK').catch(() => {});
				throw err;
			}
		});

		await syncCommissionJson();
		res.redirect(303, '/management/commission?saved=1');
	} catch (err) {
		res.redirect(303, '/management/commission?error=' + encodeURIComponent(err.message || '更新類別比例失敗'));
	}
});

router.post('/update-rates', ensureAuth, checkPerm('action_commission_config'), async (req, res) => {
	const submittedCategories = Array.isArray(req.body.categories) ? req.body.categories : [req.body.categories].filter(Boolean);
	const submittedRates = Array.isArray(req.body.rates) ? req.body.rates : [req.body.rates].filter(value => value !== undefined);
	const updates = [];

	try {
		if (submittedCategories.length !== submittedRates.length) throw new Error('類別與比例資料數量不一致');
		for (let index = 0; index < submittedCategories.length; index++) {
			const submittedCategory = String(submittedCategories[index] || '').trim();
			const rawRate = submittedRates[index];
			const category = canonicalCategory(submittedCategory);
			const rate = normalizeTalentShareRate(rawRate);
			if (!category || rate === null) throw new Error(`類別「${submittedCategory}」的比例無效`);
			updates.push([category, rate]);
		}
		if (updates.length === 0) throw new Error('沒有收到可更新的類別比例');

		await withTransactionGate(async () => {
			await run('BEGIN IMMEDIATE');
			try {
			for (const [category, rate] of updates) {
				const storedCategories = categoryStorageKeys(category);
				const placeholders = storedCategories.map(() => '?').join(',');
				const before = await all(`SELECT category, rate FROM commission_settings WHERE category IN (${placeholders})`, storedCategories);
				const result = await run(
					`UPDATE commission_settings SET rate = ?, updated_at = CURRENT_TIMESTAMP WHERE category IN (${placeholders})`,
					[rate, ...storedCategories]
				);
				if (result.changes < 1) throw new Error(`找不到類別「${category}」`);
				await writeAuditLog({
					operatorId: req.user.id,
					action: 'commission_rate_update',
					targetType: 'commission_category',
					targetId: category,
					before,
					after: { category, rate },
					metadata: { source: 'management-commission-batch' }
				});
			}
			await run('COMMIT');
			} catch (err) {
				await run('ROLLBACK').catch(() => {});
				throw err;
			}
		});

		await syncCommissionJson();
		res.redirect(303, '/management/commission?saved=1');
	} catch (err) {
		res.redirect(303, '/management/commission?error=' + encodeURIComponent(err.message || '更新比例失敗'));
	}
});

router.post('/add-category', ensureAuth, checkPerm('action_commission_config'), async (req, res) => {
	const category = canonicalCategory(String(req.body.category || '').trim());
	const rate = normalizeTalentShareRate(req.body.rate);

	if (!category || category.length > 60 || rate === null) {
		return res.redirect(303, '/management/commission?error=' + encodeURIComponent('請輸入有效類別名稱與 0–100% 實拿比例'));
	}

	try {
		const aliases = categoryStorageKeys(category);
		const placeholders = aliases.map(() => '?').join(',');
		const existing = await all(`SELECT category FROM commission_settings WHERE category IN (${placeholders})`, aliases);
		if (existing.length > 0) throw new Error(`類別「${category}」已存在`);
		await withTransactionGate(async () => {
			await run('BEGIN IMMEDIATE');
			try {
			await run('INSERT INTO commission_settings (category, rate) VALUES (?, ?)', [category, rate]);
			await writeAuditLog({
				operatorId: req.user.id,
				action: 'commission_category_add',
				targetType: 'commission_category',
				targetId: category,
				before: null,
				after: { category, rate },
				metadata: { source: 'management-commission-route' }
			});
			await run('COMMIT');
			} catch (error) {
				await run('ROLLBACK').catch(() => {});
				throw error;
			}
		});
		await syncCommissionJson();
		res.redirect(303, '/management/commission?saved=1');
	} catch (err) {
		const message = String(err.message || '').includes('UNIQUE')
			? `類別「${category}」已存在`
			: (err.message || '新增類別失敗');
		res.redirect(303, '/management/commission?error=' + encodeURIComponent(message));
	}
});

router.post('/delete-category', ensureAuth, checkPerm('action_commission_config'), async (req, res) => {
	const submittedCategory = req.body.category_name ?? req.body.category;
	const categoryValue = Array.isArray(submittedCategory) ? submittedCategory[0] : submittedCategory;
	const category = canonicalCategory(String(categoryValue || '').trim());
	if (!category) return res.redirect(303, '/management/commission?error=' + encodeURIComponent('缺少要刪除的類別'));

	try {
		const storedCategories = categoryStorageKeys(category);
		const placeholders = storedCategories.map(() => '?').join(',');
		const before = await all(`SELECT category, rate FROM commission_settings WHERE category IN (${placeholders})`, storedCategories);
		const pendingSnapshotRows = await all(
			`SELECT COUNT(*) AS count FROM orders WHERE category IN (${placeholders}) AND commission_rate_snapshot IS NULL`,
			storedCategories
		);
		if (Number(pendingSnapshotRows[0] && pendingSnapshotRows[0].count) > 0) {
			throw new Error(`類別「${category}」仍有未建立抽佣快照的歷史訂單，暫不可刪除`);
		}

		await withTransactionGate(async () => {
			await run('BEGIN IMMEDIATE');
			try {
			const result = await run(`DELETE FROM commission_settings WHERE category IN (${placeholders})`, storedCategories);
			if (result.changes < 1) throw new Error(`找不到類別「${category}」`);
			await writeAuditLog({
				operatorId: req.user.id,
				action: 'commission_category_delete',
				targetType: 'commission_category',
				targetId: category,
				before,
				after: null,
				metadata: { source: 'management-commission-route' }
			});
			await run('COMMIT');
			} catch (error) {
				await run('ROLLBACK').catch(() => {});
				throw error;
			}
		});
		await syncCommissionJson();
		res.redirect(303, '/management/commission?saved=1');
	} catch (err) {
		res.redirect(303, '/management/commission?error=' + encodeURIComponent(err.message || '刪除類別失敗'));
	}
});

module.exports = router;