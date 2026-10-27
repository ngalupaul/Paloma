const test = require('node:test');
const assert = require('node:assert/strict');
const { configureSocketAudience, gameAudience, legacyTickAudience } = require('../socket-audience');

function socket(auth) {
  const s = { handshake: { auth }, rooms: new Set(), join(room) { this.rooms.add(room); } };
  configureSocketAudience(s);
  return s;
}

test('presence opts out of game traffic while old clients keep their protocol', () => {
  const clients = [socket({ presenceOnly: true }), socket({ roomTicksOnly: true }), socket({})];
  const packets = [];
  const io = { except(rooms) {
    const excluded = [].concat(rooms);
    return { emit(event, payload) {
      clients.forEach((s, index) => {
        if (!excluded.some(r => s.rooms.has(r))) packets.push({ index, event, payload });
      });
    } };
  } };
  const payload = { roomId: 1, multiplier: 2.25 };
  gameAudience(io).emit('game:room:tick', payload);
  legacyTickAudience(io).emit('game:tick', { multiplier: 2.25 });
  assert.deepEqual(packets.map(x => [x.index, x.event]), [
    [1, 'game:room:tick'], [2, 'game:room:tick'], [2, 'game:tick'],
  ]);
  assert.equal(packets[0].payload, payload);
  assert.equal(clients[2].presenceOnly, false);
  // Account rooms are independent of game filtering.
  clients[0].join('user-1');
  assert.ok(clients[0].rooms.has('user-1'));
});
