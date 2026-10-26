// Dedicated connection pools: Electron session partitions for requests whose
// connections may need to be reset (closeAllConnections) without touching
// anyone else's. Proxy and certificate handling are Chromium's, as in the
// default session. In memory only (no "persist:" prefix).

const pools = new Map();

/**
 * The partition's session, created once. `configure` runs on creation only
 * (webRequest hooks are per session, so a new partition starts with none).
 */
function getConnectionPool(partition, { configure } = {}) {
  let pool = pools.get(partition);
  if (!pool) {
    const { session } = require("electron");
    pool = session.fromPartition(partition);
    configure?.(pool);
    pools.set(partition, pool);
  }
  return pool;
}

module.exports = { getConnectionPool };
