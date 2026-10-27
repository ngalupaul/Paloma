const test = require('node:test');
const assert = require('node:assert/strict');
const { createChangedRecordWriter } = require('../changed-records');

test('only changed wallets are written; timestamp churn does not rewrite the whole collection', async () => {
  const writer = createChangedRecordWriter('userId');
  const records = Array.from({ length: 5000 }, (_, i) => ({ userId: i, balance: '100.00' }));
  const batches = [];
  const write = async data => { batches.push(data); return true; };
  await writer.save(records, write);
  await writer.save(records.map(x => ({ ...x, updatedAt: new Date() })), write);
  records[42].balance = '125.00';
  await writer.save(records, write);
  assert.deepEqual(batches.map(x => x.length), [5000, 1]);
  assert.equal(batches[1][0].balance, '125.00');
});

test('failed and partially failed writes retry without marking records as saved', async () => {
  const writer = createChangedRecordWriter('id');
  const records = [{ id: 'tx-1', status: 'pending' }];
  await assert.rejects(writer.save(records, async () => { throw Error('offline'); }));
  assert.equal(await writer.save(records, async () => false), false);
  let count = 0;
  await writer.save(records, async data => { count += data.length; });
  await writer.save(records, async () => { throw Error('should skip'); });
  assert.equal(count, 1);
  records[0].status = 'completed';
  await writer.save(records, async data => { assert.equal(data[0].status, 'completed'); });
});

test('clearing and eviction permit restores; no database deletion is performed', async () => {
  const writer = createChangedRecordWriter('id');
  let count = 0;
  const write = async data => { count += data.length; };
  await writer.save([{ id: 1 }], write);
  await writer.save([], write);
  await writer.save([{ id: 1 }], write);
  writer.clear();
  await writer.save([{ id: 1 }], write);
  assert.equal(count, 3);
});
