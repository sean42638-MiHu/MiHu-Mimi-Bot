const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('Recharge keeps bonus separate and VIP counts deposits once', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-wallet-vip-'));
  process.env.NODE_ENV = 'test';
  process.env.APP_ENV = 'development';
  process.env.TEST_DATABASE_PATH = path.join(temp, 'test.sqlite');
  process.env.DEVELOPMENT_DATA_DIR = path.join(temp, 'data');
  fs.mkdirSync(process.env.DEVELOPMENT_DATA_DIR);

  const db = require('../database');
  const { adjustUserWallet, getUserWallet } = require('../utils/walletHelper');
  const { getUserVipInfo } = require('../utils/discountHelper');
  const { handleTopupModal } = require('../handlers/topupModalHandler');
  const run = (sql, args = []) => new Promise((resolve, reject) =>
    db.run(sql, args, error => error ? reject(error) : resolve())
  );
  const get = (sql, args = []) => new Promise((resolve, reject) =>
    db.get(sql, args, (error, row) => error ? reject(error) : resolve(row))
  );

  try {
    await run(`CREATE TABLE users (
      id TEXT PRIMARY KEY, studio_id INTEGER, balance REAL DEFAULT 0,
      bonus_balance REAL DEFAULT 0, manual_spent REAL DEFAULT 0,
      manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0
    )`);
    await run(`CREATE TABLE user_wallets (
      user_id TEXT PRIMARY KEY, balance REAL, bonus_balance REAL,
      manual_spent REAL, manual_deposited REAL, updated_at TEXT
    )`);
    await run(`CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY, user_id TEXT, type TEXT, amount REAL,
      balance_before REAL, balance_after REAL, reference_type TEXT,
      reference_id TEXT, description TEXT, operator_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(`CREATE TABLE topups (
      id INTEGER PRIMARY KEY, user_id TEXT, amount REAL, bonus REAL,
      channel_type TEXT, note TEXT, operator_id TEXT, created_at TEXT
    )`);
    await run(`CREATE TABLE orders (
      id INTEGER PRIMARY KEY, boss_id TEXT, total_amount REAL, status TEXT
    )`);
    await run(`CREATE TABLE vip_tiers (
      level INTEGER PRIMARY KEY, name TEXT, spent_threshold REAL,
      deposit_threshold REAL, rewards TEXT, color TEXT
    )`);
    await run(`CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY, operator_id TEXT, studio_id INTEGER,
      action TEXT, target_type TEXT, target_id TEXT, before_data TEXT,
      after_data TEXT, metadata TEXT, ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await run("INSERT INTO users (id,studio_id) VALUES ('boss',1),('operator',1)");
    await run("INSERT INTO user_wallets VALUES ('boss',0,0,0,0,CURRENT_TIMESTAMP)");
    for (const [level, spent, deposited] of [
      [1, 3000, 2500], [3, 13333, 10000], [4, 25000, 20000]
    ]) {
      await run("INSERT INTO vip_tiers VALUES (?,?,?,?, '[]','#A855F7')",
        [level, `VIP ${level}`, spent, deposited]);
    }

    const recharge = (amount, bonus = 0) => adjustUserWallet({
      userId: 'boss', addAmount: amount, bonusChange: bonus,
      reason: 'isolated regression test', operatorId: 'operator'
    });

    const first = await recharge(10000, 5000);
    assert.equal(first.newBalance, 10000);
    assert.equal(first.newBonus, 5000);
    assert.equal(first.newTotalBalance, 15000);
    assert.equal(first.newDeposited, 10000);

    let vip = await getUserVipInfo('boss');
    assert.equal(vip.totalDeposited, 10000);
    assert.equal(vip.vip_level, 3);
    assert.equal(vip.discountRate, 1);

    await recharge(10000);
    vip = await getUserVipInfo('boss');
    assert.equal(vip.totalDeposited, 20000);
    assert.equal(vip.vip_level, 4);

    const wallet = await getUserWallet('boss');
    assert.equal(wallet.balance, 20000);
    assert.equal(wallet.bonus_balance, 5000);
    assert.equal(wallet.total_balance, 25000);
    const history = await get('SELECT SUM(amount) AS total FROM topups');
    assert.equal(history.total, 20000);

    // 手動累積值為 0 時仍優先，不能又把歷史充值加回來。
    await adjustUserWallet({
      userId: 'boss', overrideDeposited: 0,
      reason: 'test explicit zero', operatorId: 'operator'
    });
    vip = await getUserVipInfo('boss');
    assert.equal(vip.totalDeposited, 0);
    assert.equal(vip.vip_level, 0);

    let reply;
    await handleTopupModal({
      deferred: true, replied: false,
      customId: 'topup_modal_operator_boss',
      user: {
        id: 'operator', tag: 'test-operator',
        displayAvatarURL: () => 'https://example.com/avatar.png'
      },
      fields: {
        getTextInputValue: key => ({
          real_amount: '10', bonus_amount: '250', note: 'test reply'
        })[key]
      },
      client: { users: { fetch: async () => null } },
      editReply: async value => { reply = value; }
    });

    const fields = reply.embeds[0].toJSON().fields;
    const total = fields.find(field => field.name.includes('最新可用總餘額'));
    assert.equal(total.value, '$25,260 NTD');
    vip = await getUserVipInfo('boss');
    assert.equal(vip.totalDeposited, 10);
    assert.equal(vip.vip_level, 0);
    assert.equal((await getUserWallet('boss')).bonus_balance, 5250);

    const mirror = await get("SELECT * FROM users WHERE id='boss'");
    const final = await getUserWallet('boss');
    assert.equal(mirror.balance, final.balance);
    assert.equal(mirror.bonus_balance, final.bonus_balance);
    assert.equal(mirror.manual_deposited, final.manual_deposited);
  } finally {
    await new Promise((resolve, reject) =>
      db.close(error => error ? reject(error) : resolve())
    );
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
