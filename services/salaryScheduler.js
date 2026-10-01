const { dbAll, dbRun } = require('../utils/dbHelper');
const { distributeMonthlyFixedSalary } = require('./salaryService');

const JOB_KEY = 'salary-fixed-monthly-auto';
const TAIPEI_TIMEZONE = 'Asia/Taipei';

function getTaipeiParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: TAIPEI_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    });
    const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return {
        month: `${values.year}-${values.month}`,
        day: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute),
        daysInMonth: new Date(Date.UTC(Number(values.year), Number(values.month), 0)).getUTCDate()
    };
}

function isRuleDue(rule, parts, env = process.env) {
    const payoutDay = Number(rule.payout_day || 1);
    if (!Number.isInteger(payoutDay) || payoutDay < 1 || payoutDay > 31) {
        throw new Error(`Invalid payout_day for salary rule ${rule.id}`);
    }
    const dueDay = Math.min(payoutDay, parts.daysInMonth);
    const dueHour = Number(env.SALARY_SCHEDULER_HOUR || 0);
    const dueMinute = Number(env.SALARY_SCHEDULER_MINUTE || 0);
    if (!Number.isInteger(dueHour) || dueHour < 0 || dueHour > 23
        || !Number.isInteger(dueMinute) || dueMinute < 0 || dueMinute > 59) {
        throw new Error('SALARY_SCHEDULER_HOUR/MINUTE is invalid');
    }
    return parts.day > dueDay
        || (parts.day === dueDay && (parts.hour > dueHour || (parts.hour === dueHour && parts.minute >= dueMinute)));
}

function isSchedulerEnabled(env = process.env) {
    const enabled = String(env.SALARY_SCHEDULER_ENABLED || '').trim().toLowerCase() === 'true';
    const role = String(env.MIHU_RUNTIME_ROLE || '').trim().toLowerCase();
    return enabled && role === 'web';
}

async function logRun({ studioId = null, month, status, message = '' }) {
    await dbRun(`
        INSERT INTO salary_scheduler_runs (
            job_key, target_month, studio_id, status, message, completed_at
        ) VALUES (?, ?, ?, ?, ?, DATETIME('now', 'localtime'))
    `, [JOB_KEY, month, studioId, status, String(message || '').slice(0, 400)]);
}

async function runSchedulerTick(env = process.env, now = new Date()) {
    const parts = getTaipeiParts(now);
    const rules = await dbAll(`
        SELECT current_rule.id, current_rule.studio_id, current_rule.payout_day
        FROM salary_rules current_rule
        WHERE current_rule.is_active = 1 AND current_rule.effective_month <= ?
            AND current_rule.id = (
                SELECT candidate.id FROM salary_rules candidate
                WHERE candidate.studio_id = current_rule.studio_id
                    AND candidate.is_active = 1 AND candidate.effective_month <= ?
                    AND ((current_rule.role_key IS NOT NULL
                            AND candidate.role_key = current_rule.role_key
                            AND candidate.item_name = current_rule.item_name)
                        OR (current_rule.role_key IS NULL AND candidate.role_key IS NULL
                            AND candidate.user_id = current_rule.user_id))
                ORDER BY candidate.effective_month DESC, candidate.id DESC LIMIT 1
            )
        ORDER BY studio_id ASC, id ASC
    `, [parts.month, parts.month]);
    const dueRules = rules.filter(rule => isRuleDue(rule, parts, env));
    if (!dueRules.length) {
        if (!rules.length) return { ran: false, reason: 'no-active-rules', month: parts.month };
        return { ran: false, reason: 'before-rule-due-time', month: parts.month };
    }

    let processed = 0;
    let skipped = 0;
    for (const rule of dueRules) {
        const studioId = Number(rule.studio_id);
        try {
            await distributeMonthlyFixedSalary({
                studioId,
                operatorId: null,
                month: parts.month,
                ruleId: rule.id,
                source: 'scheduler',
                note: `Scheduler auto distribute (${TAIPEI_TIMEZONE})`
            });
            await logRun({ studioId, month: parts.month, status: 'success', message: `rule ${rule.id} committed` });
            processed += 1;
        } catch (error) {
            const message = String(error && error.message || 'unknown');
            if (message.includes('已完成派發') || message.includes('沒有符合身分組')) {
                await logRun({ studioId, month: parts.month, status: 'skipped', message: `rule ${rule.id}: ${message}` });
                skipped += 1;
                continue;
            }
            await logRun({ studioId, month: parts.month, status: 'failed', message: `rule ${rule.id}: ${message}` });
            console.error(`[salary-scheduler] studio=${studioId} rule=${rule.id} month=${parts.month} failed: ${message}`);
        }
    }

    return { ran: true, month: parts.month, due: dueRules.length, processed, skipped };
}

function startSalaryScheduler(env = process.env) {
    if (!isSchedulerEnabled(env)) {
        return { started: false, reason: 'disabled-or-non-web-role' };
    }

    const pollMs = Math.max(15000, Number(env.SALARY_SCHEDULER_POLL_MS || 60000));
    let running = false;
    const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            await runSchedulerTick(env);
        } catch (error) {
            console.error('[salary-scheduler] tick failed:', String(error && error.message || error));
        } finally {
            running = false;
        }
    }, pollMs);
    timer.unref();

    runSchedulerTick(env).catch(error => {
        console.error('[salary-scheduler] startup tick failed:', String(error && error.message || error));
    });

    return {
        started: true,
        stop() {
            clearInterval(timer);
        }
    };
}

module.exports = {
    JOB_KEY,
    TAIPEI_TIMEZONE,
    getTaipeiParts,
    isRuleDue,
    isSchedulerEnabled,
    runSchedulerTick,
    startSalaryScheduler
};
