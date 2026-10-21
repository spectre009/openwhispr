const test = require("node:test");
const assert = require("node:assert/strict");

const MainWindowPlacementCoordinator = require("../../src/helpers/mainWindowPlacementCoordinator");
const { deferred } = require("./harness/deferred");

test("a stale display lookup cannot apply after a newer request", async () => {
  const coordinator = new MainWindowPlacementCoordinator();
  const firstDisplay = deferred();
  const applied = [];

  const first = coordinator.request(
    () => firstDisplay.promise,
    async (display) => {
      applied.push(display);
      return { applied: true };
    }
  );
  const second = coordinator.request(
    async () => "display-b",
    async (display) => {
      applied.push(display);
      return { applied: true };
    }
  );

  await second;
  firstDisplay.resolve("display-a");

  assert.deepEqual(await first, { applied: false, reason: "superseded" });
  assert.deepEqual(applied, ["display-b"]);
});

test("cancelling a start lookup prevents a stop press from being followed by a move", async () => {
  const coordinator = new MainWindowPlacementCoordinator();
  const display = deferred();
  let applied = false;

  const request = coordinator.request(
    () => display.promise,
    async () => {
      applied = true;
      return { applied: true };
    }
  );
  coordinator.cancelPending();
  display.resolve("display-a");

  assert.deepEqual(await request, { applied: false, reason: "superseded" });
  assert.equal(applied, false);
});

test("a user drag cancels pending placement and blocks later automatic moves", async () => {
  const coordinator = new MainWindowPlacementCoordinator();
  const display = deferred();
  let applyCount = 0;

  const pending = coordinator.request(
    () => display.promise,
    async () => {
      applyCount += 1;
      return { applied: true };
    }
  );
  coordinator.markManuallyPositioned();
  display.resolve("display-a");

  assert.deepEqual(await pending, { applied: false, reason: "superseded" });
  assert.deepEqual(
    await coordinator.request(
      async () => "display-b",
      async () => {
        applyCount += 1;
        return { applied: true };
      }
    ),
    { applied: false, reason: "manual-position" }
  );
  assert.equal(applyCount, 0);
});

test("changing the configured position restores automatic placement", async () => {
  const coordinator = new MainWindowPlacementCoordinator();
  coordinator.markManuallyPositioned();
  coordinator.resetManualPosition();

  const result = await coordinator.request(
    async () => "display-a",
    async (display) => ({ applied: true, display })
  );

  assert.deepEqual(result, { applied: true, display: "display-a" });
});

test("a deferring request lets the placement judge a drag, which it may release", async () => {
  const coordinator = new MainWindowPlacementCoordinator();
  coordinator.markManuallyPositioned();

  const result = await coordinator.request(
    async () => "locked-display",
    async (display, isCurrent) => {
      assert.equal(coordinator.hasManualPosition(), true);
      coordinator.releaseManualPosition();
      return { applied: true, display, current: isCurrent() };
    },
    { deferManual: true }
  );

  assert.deepEqual(result, { applied: true, display: "locked-display", current: true });
  assert.equal(coordinator.hasManualPosition(), false);
});

test("a new drag still supersedes a deferring request", async () => {
  const coordinator = new MainWindowPlacementCoordinator();
  const display = deferred();
  let applied = false;

  const pending = coordinator.request(
    () => display.promise,
    async () => {
      applied = true;
      return { applied: true };
    },
    { deferManual: true }
  );
  coordinator.markManuallyPositioned();
  display.resolve("locked-display");

  assert.deepEqual(await pending, { applied: false, reason: "superseded" });
  assert.equal(applied, false);
});
