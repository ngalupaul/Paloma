const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('Mongo adapter preserves saved values, retries failures, and clears transaction cache after deletion', async () => {
  const collections = new Map();
  function collection(name) {
    if (!collections.has(name)) collections.set(name, {
      writes: [], data: new Map(), fail: false,
      async createIndex() {},
      async bulkWrite(ops) {
        if (this.fail) { this.fail = false; throw Error('temporary failure'); }
        this.writes.push(ops);
        for (const { updateOne: op } of ops) this.data.set(JSON.stringify(op.filter), op.update.$set);
      },
      async deleteMany() { this.data.clear(); },
    });
    return collections.get(name);
  }
  class MongoClient {
    topology = { isConnected: () => true };
    async connect() {}
    db() { return { collection }; }
    async close() {}
  }
  const context = {
    module: { exports: {} }, process: { env: { MONGODB_URI: 'mock://local-test' } },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'mongodb') return { MongoClient };
      if (name === 'dns') return { setServers() {} };
      return require(path.join('..', name));
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../mongodb.js'), 'utf8'), context);
  const db = context.module.exports;
  const users = new Map([['a', { id: 'a', username: 'A' }], ['b', { id: 'b', username: 'B' }]]);
  const wallets = new Map([['a', { balance: '100.00', depositCount: 1 }], ['b', { balance: '50.00', depositCount: 0 }]]);
  await db.saveState(users, wallets);
  await db.saveState(users, wallets);
  assert.equal(collection('users').writes.length, 1);
  wallets.get('a').balance = '125.00';
  collection('wallets').fail = true;
  assert.equal(await db.saveState(users, wallets), false);
  assert.equal(await db.saveState(users, wallets), true);
  assert.equal(collection('wallets').writes[1].length, 1);
  assert.equal(collection('wallets').data.get('{"userId":"a"}').balance, '125.00');
  const tx = [{ id: 'tx-a', amount: 25, status: 'pending' }];
  await db.saveTransactions(tx);
  tx[0].status = 'completed';
  await db.saveTransactions(tx);
  assert.equal(collection('transactions').data.get('{"id":"tx-a"}').status, 'completed');
  await db.deleteAllTransactions();
  await db.saveTransactions(tx);
  assert.equal(collection('transactions').writes.length, 3);
});
