class MainWindowPlacementCoordinator {
  constructor() {
    this._requestId = 0;
    this._hasManualPosition = false;
  }

  cancelPending() {
    this._requestId += 1;
  }

  markManuallyPositioned() {
    this._hasManualPosition = true;
    this.cancelPending();
  }

  resetManualPosition() {
    this._hasManualPosition = false;
    this.cancelPending();
  }

  hasManualPosition() {
    return this._hasManualPosition;
  }

  // Drops the user's drag from inside a placement that has just decided it no
  // longer applies (it left the locked display). Unlike resetManualPosition it
  // keeps that placement current.
  releaseManualPosition() {
    this._hasManualPosition = false;
  }

  /**
   * By default a manual position wins outright: a dragged pill stays put.
   * `deferManual` lets the placement itself decide whether a drag still applies
   * (a locked display keeps a drag only while it stays on that display); a new
   * drag still supersedes the request.
   */
  async request(resolvePlacement, applyPlacement, { deferManual = false } = {}) {
    if (this._hasManualPosition && !deferManual) {
      return { applied: false, reason: "manual-position" };
    }

    const requestId = ++this._requestId;
    const isCurrent = () =>
      requestId === this._requestId && (deferManual || !this._hasManualPosition);
    const placement = await resolvePlacement();

    if (!isCurrent()) {
      return { applied: false, reason: "superseded" };
    }

    return applyPlacement(placement, isCurrent);
  }
}

module.exports = MainWindowPlacementCoordinator;
