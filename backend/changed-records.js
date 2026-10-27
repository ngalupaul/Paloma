const { createHash } = require('node:crypto');

// Cache only fingerprints of successfully written records, never financial data.
// A failed/partial batch stays dirty and is retried on the next save.
function createChangedRecordWriter(key) {
  const saved = new Map();
  return {
    clear() { saved.clear(); },
    async save(records, write) {
      const current = new Set();
      const pending = [];
      for (const record of records) {
        const { _id, updatedAt, ...data } = record;
        const id = data[key];
        current.add(id);
        const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        if (saved.get(id) !== hash) pending.push({ id, hash, data });
      }
      if (pending.length) {
        const ok = await write(pending.map(({ data }) => data));
        if (ok === false) return false;
        for (const { id, hash } of pending) saved.set(id, hash);
      }
      // Eviction affects only this cache. It never deletes database records.
      for (const id of saved.keys()) if (!current.has(id)) saved.delete(id);
      return true;
    },
  };
}

module.exports = { createChangedRecordWriter };
