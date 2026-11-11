const debugLogger = require("./debugLogger");

// A GPU pack that can't be used is logged as a warning (#2554). This fork's
// logger keeps warnings in the log file at its default level (Problems only),
// so they need no file of their own, and with logging Off nothing is written.
function warnGpuFallback(message, meta) {
  debugLogger.warn(message, meta);
}

module.exports = { warnGpuFallback };
