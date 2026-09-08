// collectOrphanTabs — startup garbage collection for the tabs stranded by a
// browser restart. tabMap lives in storage.session, which Firefox clears on
// restart, while Firefox's own session restore brings every previously-hidden
// tab back as hidden. Nothing else in the codebase can ever adopt one of
// those (the only ownership path, readOwnableTabs, only looks at *visible*
// tabs), so on the next startup they are pure garbage. This suite is the
// safety net: prove the two properties that matter most before anything gets
// closed — owned tabs are untouchable, and a no-op really is a no-op — then
// prove the guard is genuinely held the way firefox-palette-search.test.js
// does for paletteSearch.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  commands: { onCommand: noopListener },
  runtime: { onMessage: noopListener, onInstalled: noopListener, onStartup: noopListener },
};

const { collectOrphanTabs } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

test("a hidden tab owned by no workspace is closed", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://orphan/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const ids = globalThis.browser._peek.tabs().map((t) => t.id);
  assert.deepStrictEqual(ids, [1]);
});

test("a hidden tab a workspace still owns in tabMap is never closed", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: { A: [2] } },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://owned/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const ids = globalThis.browser._peek.tabs().map((t) => t.id).sort();
  assert.deepStrictEqual(ids, [1, 2]);
});

test("visible, pinned, and non-http(s) tabs are never touched", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://visible/", hidden: false },
      // Pinned + hidden cannot happen via the real hide() path (Firefox
      // refuses to hide a pinned tab), but the exclusion must hold on its
      // own regardless of how the fixture got here.
      { id: 3, windowId: 1, url: "https://pinned/", hidden: true, pinned: true },
      { id: 4, windowId: 1, url: "about:blank", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const ids = globalThis.browser._peek.tabs().map((t) => t.id).sort();
  assert.deepStrictEqual(ids, [1, 2, 3, 4]);
});

test("collection runs across every window, not just one", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://orphan-1/", hidden: true },
      { id: 3, windowId: 2, url: "https://a2/", active: true },
      { id: 4, windowId: 2, url: "https://orphan-2/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const ids = globalThis.browser._peek.tabs().map((t) => t.id).sort();
  assert.deepStrictEqual(ids, [1, 3]);
});

test("a window left with nothing but orphans gets a blank tab before they close", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://orphan-a/", hidden: true },
      { id: 2, windowId: 1, url: "https://orphan-b/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const remaining = globalThis.browser._peek.tabs();
  assert.strictEqual(remaining.length, 1, "the window must never reach zero tabs");
  assert.strictEqual(remaining[0].url, "", "the survivor is the freshly created blank tab");
});

test("nothing to collect is a true no-op: no guard taken, no tab calls beyond the query", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: {} },
    tabs: [{ id: 1, windowId: 1, url: "https://a1/", active: true }],
  });
  await collectOrphanTabs();
  assert.deepStrictEqual(globalThis.browser._peek.calls(), []);
  assert.strictEqual(globalThis.browser._peek.session().swapping, false);
});

test("the swapping guard is released even when tabs are closed", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://orphan/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  assert.strictEqual(globalThis.browser._peek.session().swapping, false);
});

// Deleting the setSwapping(true)/(false) pair leaves every state-only
// assertion above green: swapping still reads false at the end, because it
// was never anything else. Only a call-time recording catches a guard that
// was never taken. Without it, tabs.remove fires onRemoved, and real
// auto-save would run claimVisible mid-collection — invariant 1, the exact
// bug the guard exists to prevent.
test("the swapping guard is HELD while the orphan is removed", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://orphan/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const removes = globalThis.browser._peek.calls().filter((c) => c.op === "remove");
  assert.strictEqual(removes.length, 1, "expected exactly one remove call");
  assert.strictEqual(removes[0].swapping, true, "remove ran with the guard released");
});

test("the swapping guard is HELD while the replacement blank tab is created", async () => {
  globalThis.browser = makeBrowser({
    session: { tabMap: {} },
    tabs: [{ id: 1, windowId: 1, url: "https://orphan/", hidden: true }],
  });
  await collectOrphanTabs();
  const creates = globalThis.browser._peek.calls().filter((c) => c.op === "create");
  assert.strictEqual(creates.length, 1, "expected exactly one create call");
  assert.strictEqual(creates[0].swapping, true, "create ran with the guard released");
});
