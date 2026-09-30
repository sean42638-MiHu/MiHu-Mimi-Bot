'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

async function createSchema(db) {
    await run(db, `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        studio_id INTEGER,
        balance REAL DEFAULT 0,
        bonus_balance REAL DEFAULT 0,
        manual_spent REAL DEFAULT 0,
        manual_deposited REAL DEFAULT 0
    )`);
    await run(db, `CREATE TABLE user_wallets (
        user_id TEXT PRIMARY KEY,
        balance REAL DEFAULT 0,
        bonus_balance REAL DEFAULT 0,
        manual_spent REAL DEFAULT 0,
        manual_deposited REAL DEFAULT 0,
        updated_at TEXT
    )`);
}

function loadHandlersWithDatabase(db) {
    const modulePaths = {
        database: require.resolve('../database'),
        commissionHelper: require.resolve('../utils/commissionHelper'),
        walletService: require.resolve('../utils/walletService'),
        orderService: require.resolve('../utils/orderService'),
        dispatchModalHandler: require.resolve('../handlers/dispatchModalHandler'),
        assignModalHandler: require.resolve('../handlers/assignModalHandler'),
        createOrderModalHandler: require.resolve('../handlers/createOrderModalHandler')
    };
    const previous = Object.fromEntries(
        Object.entries(modulePaths).map(([key, value]) => [key, require.cache[value]])
    );

    require.cache[modulePaths.database] = {
        id: modulePaths.database,
        filename: modulePaths.database,
        loaded: true,
        exports: db
    };

    for (const key of Object.keys(modulePaths)) {
        if (key === 'database') continue;
        delete require.cache[modulePaths[key]];
    }

    return {
        handleDispatchModal: require('../handlers/dispatchModalHandler'),
        handleAssignModal: require('../handlers/assignModalHandler').handleAssignModal,
        handleCreateOrderModal: require('../handlers/createOrderModalHandler').handleCreateOrderModal,
        restore() {
            for (const [key, modulePath] of Object.entries(modulePaths)) {
                if (previous[key]) require.cache[modulePath] = previous[key];
                else delete require.cache[modulePath];
            }
        }
    };
}

async function withFixture(runCase) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-dispatch-wallet-'));
    const db = new sqlite3.Database(path.join(directory, 'fixture.sqlite'));
    const handlers = loadHandlersWithDatabase(db);

    try {
        await createSchema(db);
        await run(db, `INSERT INTO users (id, studio_id, balance, bonus_balance)
            VALUES ('operator-a', 1, 0, 0), ('boss-a', 1, 9999, 888), ('boss-b', 2, 9999, 0), ('talent-a', 1, 0, 0)`);
        await run(db, `INSERT INTO user_wallets (user_id, balance, bonus_balance, updated_at)
            VALUES ('boss-a', 20, 500, CURRENT_TIMESTAMP), ('boss-b', 500, 0, CURRENT_TIMESTAMP)`);
        return await runCase({ db, ...handlers });
    } finally {
        handlers.restore();
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function createBaseInteraction(customId) {
    const responses = [];
    return {
        deferred: false,
        replied: false,
        customId,
        user: { id: 'operator-a', username: 'operator-a', globalName: 'Operator A', tag: 'operator-a#0001' },
        member: { nickname: 'Operator A' },
        guild: { channels: { fetch: async () => ({ send: async () => {} }) } },
        client: { channels: { fetch: async () => null } },
        fields: {
            getTextInputValue: key => ({
                dispatch_game: 'LoL',
                dispatch_content: '一般場',
                dispatch_extra: '',
                dispatch_note: '',
                order_game: 'LoL',
                order_content: '一般場',
                order_extra: '',
                order_note: ''
            })[key] || ''
        },
        async deferReply() {
            this.deferred = true;
        },
        async editReply(payload) {
            this.replied = true;
            responses.push(payload);
            return payload;
        },
        _responses: responses
    };
}

test('/dispatch precheck uses canonical user_wallets balance instead of users.balance mirror', async () => {
    await withFixture(async ({ handleDispatchModal }) => {
        global.dispatchSessions = new Map([[
            's1',
            {
                cId: 'channel-1',
                bId: 'boss-a',
                cat: '陪玩單',
                tag: '123',
                dur: 1,
                unit: '小時',
                pri: 100,
                disc: 0,
                csId: 'operator-a',
                commandInitiatorId: 'operator-a'
            }
        ]]);

        const interaction = createBaseInteraction('modal_dispatch_s1');
        await handleDispatchModal(interaction);
        const message = String(interaction._responses[0] && interaction._responses[0].content || '');
        assert.match(message, /錢包餘額不足/);
        assert.match(message, /可用主餘額：`\$20` NTD/);
        assert.doesNotMatch(message, /\$9,999/);
    });
});

test('/指定陪玩 returns wallet-not-found message instead of generic insufficient balance', async () => {
    await withFixture(async ({ handleAssignModal }) => {
        global.assignSessions = new Map([[
            's2',
            {
                cId: 'channel-1',
                bId: 'missing-boss',
                tId: 'talent-a',
                cat: '陪玩單',
                dur: 1,
                unit: '小時',
                pri: 50,
                disc: 0,
                commandInitiatorId: 'operator-a'
            }
        ]]);

        const interaction = createBaseInteraction('modal_assign_s2');
        await handleAssignModal(interaction);
        const message = String(interaction._responses[0] && interaction._responses[0].content || '');
        assert.match(message, /尚未在系統中註冊會員錢包/);
        assert.doesNotMatch(message, /餘額不足/);
    });
});

test('/建立訂單 detects studio mismatch in precheck path', async () => {
    await withFixture(async ({ handleCreateOrderModal }) => {
        global.createOrderSessions = new Map([[
            's3',
            {
                bId: 'boss-b',
                tId: 'talent-a',
                cat: '陪玩單',
                dur: 1,
                unit: '小時',
                pri: 50,
                disc: 0,
                commandInitiatorId: 'operator-a'
            }
        ]]);

        const interaction = createBaseInteraction('modal_create_order_s3');
        await handleCreateOrderModal(interaction);
        const message = String(interaction._responses[0] && interaction._responses[0].content || '');
        assert.match(message, /不屬於目前工作室|不屬於同一工作室/);
    });
});

test('/dispatch reports database read failures without masquerading as insufficient balance', async () => {
    await withFixture(async ({ db, handleDispatchModal }) => {
        await run(db, 'DROP TABLE user_wallets');
        global.dispatchSessions = new Map([[
            's4',
            {
                cId: 'channel-1',
                bId: 'boss-a',
                cat: '陪玩單',
                tag: '123',
                dur: 1,
                unit: '小時',
                pri: 50,
                disc: 0,
                csId: 'operator-a',
                commandInitiatorId: 'operator-a'
            }
        ]]);

        const interaction = createBaseInteraction('modal_dispatch_s4');
        await handleDispatchModal(interaction);
        const message = String(interaction._responses[0] && interaction._responses[0].content || '');
        assert.match(message, /讀取錢包資料失敗/);
        assert.doesNotMatch(message, /餘額不足/);
    });
});
