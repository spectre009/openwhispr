// "Review last dictation" (the review hotkey and the tray item): opens the
// History view on the current owner's last dictation, a 👎 review drafted,
// so the user can say what went wrong while it's fresh.
//
// - It never touches a dictation still being made: while one is prepared,
//   recorded, processed or still being pasted and saved (the dictation
//   window reports that part, dictation-delivery-state), the pill says to
//   finish it first and nothing else happens.
// - The target is resolved in main after that: the newest listed row with
//   this owner's steps whose trace wasn't the assistant's (database.js,
//   getLastReviewableDictation). None found opens History with a notice.
// - The request waits in the window manager until the control panel's
//   renderer asks for it (get-pending-review-request), as a Settings section
//   does, so a panel that is still loading gets it once it mounts.

function createDictationReview({ windowManager, db, getOwner, logger }) {
  let requests = 0;

  const log = (message, meta) => {
    try {
      logger?.debug?.(message, meta, "history");
    } catch {
      // Logging must never cost the action.
    }
  };

  const currentOwner = () => {
    try {
      const owner = getOwner();
      return typeof owner === "string" && owner ? owner : null;
    } catch {
      return null;
    }
  };

  /** The id of the dictation the action opens, or null. */
  function resolveTarget() {
    const owner = currentOwner();
    if (!owner) return null;
    try {
      return db.getLastReviewableDictation(owner);
    } catch (error) {
      log("Last dictation not found", { error: error.message });
      return null;
    }
  }

  return {
    resolveTarget,

    /** Refused while a dictation is busy; otherwise queues the request and opens the panel. */
    async run() {
      if (windowManager.isDictationBusy()) {
        log("Review refused", { reason: "busy" });
        windowManager.notifyReviewBusy();
        return { opened: false, reason: "busy" };
      }
      const id = resolveTarget();
      requests += 1;
      log("Review opened", { found: id !== null });
      await windowManager.queueReviewRequest({ requestId: requests, id });
      return { opened: true, id };
    },
  };
}

module.exports = { createDictationReview };
