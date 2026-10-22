const WebSocket = require("ws");
const { assertCloudAllowed } = require("./openWhisprCloudGate");

// Node `ws` sockets are invisible to the session blocker: every streaming
// client dials through this subclass, which refuses OpenWhispr's hosts while
// the account & Cloud switch is off (a base URL the user typed included).
class GuardedWebSocket extends WebSocket {
  constructor(address, ...rest) {
    assertCloudAllowed(String(address), "streaming connection");
    super(address, ...rest);
  }
}

module.exports = GuardedWebSocket;
