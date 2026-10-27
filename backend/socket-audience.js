const PRESENCE_ONLY = 'presence-only';
const MODERN_TICKS = 'modern-room-ticks';

function configureSocketAudience(socket) {
  socket.presenceOnly = socket.handshake?.auth?.presenceOnly === true;
  if (socket.presenceOnly) socket.join(PRESENCE_ONLY);
  if (socket.handshake?.auth?.roomTicksOnly === true) socket.join(MODERN_TICKS);
}

function gameAudience(io) { return io.except(PRESENCE_ONLY); }
function legacyTickAudience(io) { return io.except([PRESENCE_ONLY, MODERN_TICKS]); }

module.exports = { configureSocketAudience, gameAudience, legacyTickAudience };
