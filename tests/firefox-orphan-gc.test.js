// collectOrphanTabs — startup garbage collection for the tabs stranded by a
// browser restart. tabMap lives in storage.session, which Firefox clears on
// restart, while Firefox's own session restore brings every previously-hidden
// tab back as hidden. Nothing else in the codebase can ever adopt one of
// those (the only ownership path, readOwnableTabs, only looks at *visible*
// tabs), so on the next startup they are pure garbage — PROVIDED it is
// actually our garbage. `tabs.hide` is a shared permission (Sidebery, Simple
// Tab Groups and Panorama all use it too), so every fixture below saves the
// orphan's URL into a workspace's tabs[] before expecting it to be collected
// — that saved-URL match (B1) is what tells "our superseded materialize()
// duplicate" apart from "some other extension's hidden tab".
//
// This suite proves, in order: ownership (tabMap) is respected, the B1
// saved-URL gate is respected (both directions), a no-op really is a no-op,
// the per-window never-zero-tabs invariant holds even when a global count
// would look fine (B3), and the swapping guard is genuinely HELD (not just
// released) the way firefox-palette-search.test.js proves it for
// paletteSearch. It also proves the B2 fix: a successful collection is
// recorded to storage.local, capped, and count-preserving; a no-op never
// writes anything.
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

// A workspace whose saved tabs[] contains exactly the given URLs — the B1
// prerequisite for those URLs to ever be collectable.
const savedIn = (id, urls) => ({ id, name: id, tabs: urls.map((url) => ({ url, pinned: false })) });

test("a hidden tab owned by no workspace, whose URL we saved, is closed", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [savedIn("A", ["https://orphan/"])] },
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

test("a hidden tab a workspace still owns in tabMap is never closed, even if its URL is saved", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [savedIn("A", ["https://owned/"])] },
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

// B1: the actual blocker case. A hidden, unpinned, http(s), tabMap-unowned
// tab that we did NOT save anywhere must survive — that shape is exactly what
// another extension's own stashed tab looks like from the outside.
test("a hidden orphan whose URL was never saved by us is left alone (another extension's tab)", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [savedIn("A", ["https://something-else/"])] },
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      // Hidden, unpinned, http(s), unowned by tabMap — every old-predicate box
      // ticked — but its URL is not in any workspace's saved tabs[].
      { id: 2, windowId: 1, url: "https://sidebery-stash/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const ids = globalThis.browser._peek.tabs().map((t) => t.id).sort();
  assert.deepStrictEqual(ids, [1, 2], "the un-saved hidden tab must survive");
});

test("visible, pinned, and non-http(s) tabs are never touched, even when their URL is saved", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [savedIn("A", ["https://visible/", "https://pinned/"])] },
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
    local: { workspaces: [savedIn("A", ["https://orphan-1/", "https://orphan-2/"])] },
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
    local: { workspaces: [savedIn("A", ["https://orphan-a/", "https://orphan-b/"])] },
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

// B3: the reviewer proved a global tab-count check ("total tabs <= total
// doomed, create ONE replacement somewhere") passes every test above just as
// well as the real per-window check, because every fixture above uses a
// single window. This is the case that only a genuinely per-window check
// survives: window 1 has a real survivor (so the GLOBAL count stays above the
// global doomed count), but window 2 is nothing but orphans and would still
// be emptied unless its OWN window is checked.
test("a window consisting entirely of orphans still gets a replacement, even when another window has survivors", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [savedIn("A", ["https://orphan-1/", "https://orphan-2/"])] },
    session: { tabMap: {} },
    tabs: [
      // Window 1: a real, kept tab plus one orphan. 2 tabs total, 1 doomed —
      // survives either way.
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://orphan-1/", hidden: true },
      // Window 2: nothing but one orphan. Globally: 3 tabs, 2 doomed (2 and
      // 3) — global count says "fine, plenty of tabs left" while window 2
      // alone is about to go to zero.
      { id: 3, windowId: 2, url: "https://orphan-2/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const remaining = globalThis.browser._peek.tabs();
  const win2 = remaining.filter((t) => t.windowId === 2);
  assert.strictEqual(win2.length, 1, "window 2 must never reach zero tabs");
  assert.strictEqual(win2[0].url, "", "window 2's survivor is the freshly created blank tab");

  // The replacement must exist before the removal that would otherwise empty
  // the window, not just "eventually" — order, not only end state.
  const calls = globalThis.browser._peek.calls();
  const createIdx = calls.findIndex((c) => c.op === "create");
  const removeIdx = calls.findIndex((c) => c.op === "remove");
  assert.ok(createIdx >= 0, "expected a replacement create call");
  assert.ok(removeIdx >= 0, "expected a remove call");
  assert.ok(createIdx < removeIdx, "the replacement must be created before the removal");
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

// B1 is also a no-op source in its own right: a hidden tab that ticks every
// other box but has no saved URL must take the same true-no-op path, not a
// guard-then-skip path.
test("a hidden, unsaved orphan alone is also a true no-op", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [] },
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://not-ours/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  assert.deepStrictEqual(globalThis.browser._peek.calls(), []);
  assert.strictEqual(globalThis.browser._peek.local().lastOrphanCollection ?? null, null);
});

test("the swapping guard is released even when tabs are closed", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [savedIn("A", ["https://orphan/"])] },
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
    local: { workspaces: [savedIn("A", ["https://orphan/"])] },
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
    local: { workspaces: [savedIn("A", ["https://orphan/"])] },
    session: { tabMap: {} },
    tabs: [{ id: 1, windowId: 1, url: "https://orphan/", hidden: true }],
  });
  await collectOrphanTabs();
  const creates = globalThis.browser._peek.calls().filter((c) => c.op === "create");
  assert.strictEqual(creates.length, 1, "expected exactly one create call");
  assert.strictEqual(creates[0].swapping, true, "create ran with the guard released");
});

// B2: a successful collection must leave a visible, size-bounded trail in
// storage.local, since dlog (the codebase's usual logging) is silent in a
// packaged/signed build — exactly the build that will run this for real.
test("a successful collection records lastOrphanCollection with an ISO timestamp, count and URLs", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [savedIn("A", ["https://orphan-1/", "https://orphan-2/"])] },
    session: { tabMap: {} },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://orphan-1/", hidden: true },
      { id: 3, windowId: 1, url: "https://orphan-2/", hidden: true },
    ],
  });
  await collectOrphanTabs();
  const rec = globalThis.browser._peek.local().lastOrphanCollection;
  assert.ok(rec, "expected a lastOrphanCollection record");
  assert.strictEqual(rec.count, 2);
  assert.deepStrictEqual(rec.urls.sort(), ["https://orphan-1/", "https://orphan-2/"]);
  assert.ok(!Number.isNaN(Date.parse(rec.at)), "at must be a parseable timestamp");
});

// The cap: count stays the true total even when the URL list is truncated —
// losing the count on top of the URL list would understate what was closed.
test("the stored URL list is capped at 200 even when more tabs were closed, but count is not", async () => {
  const n = 205;
  const urls = Array.from({ length: n }, (_, i) => `https://orphan-${i}/`);
  const tabs = [{ id: 1, windowId: 1, url: "https://a1/", active: true }];
  urls.forEach((url, i) => tabs.push({ id: i + 2, windowId: 1, url, hidden: true }));

  globalThis.browser = makeBrowser({
    local: { workspaces: [savedIn("A", urls)] },
    session: { tabMap: {} },
    tabs,
  });
  await collectOrphanTabs();
  const rec = globalThis.browser._peek.local().lastOrphanCollection;
  assert.strictEqual(rec.count, n, "the true count must not be truncated");
  assert.strictEqual(rec.urls.length, 200, "the stored URL list must be capped at 200");
});
