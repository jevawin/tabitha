// The three dispositions. The third one — search into a workspace you are NOT
// in — is the reason this feature is Firefox-only, so it gets the most cover.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  commands: { onCommand: noopListener },
  runtime: { onMessage: noopListener, onInstalled: noopListener, onStartup: noopListener },
};

const { paletteSearch } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

const fixture = () =>
  makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "Work", tabs: [{ url: "https://a1/", pinned: false }] },
        { id: "B", name: "Play", tabs: [{ url: "https://b1/", pinned: false }] },
      ],
      activeWorkspaceId: "A",
    },
    session: { tabMap: { A: [1], B: [2] } },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://b1/", hidden: true },
    ],
  });

test("current tab: searches in the active tab by id", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "currentTab" });
  assert.deepStrictEqual(globalThis.browser._peek.searches(), [
    { query: "otters", tabId: 1, disposition: null },
  ]);
});

test("new tab: uses NEW_TAB so live tracking claims it normally", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "newTab" });
  assert.deepStrictEqual(globalThis.browser._peek.searches(), [
    { query: "otters", tabId: null, disposition: "NEW_TAB" },
  ]);
});

test("other workspace: the tab is created, hidden, searched, and stays hidden", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });

  const created = globalThis.browser._peek.tabs().find((t) => t.id === 3);
  assert.strictEqual(created.hidden, true, "the search tab must not appear on screen");
  assert.match(created.url, /otters/);

  // Searched by id, never by disposition — the two are mutually exclusive.
  assert.deepStrictEqual(globalThis.browser._peek.searches(), [
    { query: "otters", tabId: 3, disposition: null },
  ]);
});

test("other workspace: the new tab is owned by that workspace, not the active one", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });
  const map = globalThis.browser._peek.session().tabMap;
  assert.deepStrictEqual(map.B, [2, 3]);
  assert.deepStrictEqual(map.A, [1]);
});

test("other workspace: we never leave the workspace we are in", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });
  assert.strictEqual(globalThis.browser._peek.local().activeWorkspaceId, "A");
  assert.strictEqual(globalThis.browser._peek.tabs().find((t) => t.id === 1).active, true);
});

test("other workspace: the swapping guard is released even so", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });
  assert.strictEqual(globalThis.browser._peek.session().swapping, false);
});

// Deleting the setSwapping(true)/(false) pair from paletteSearch leaves every
// state-only assertion above green: swapping still reads false at the end,
// because it was never anything else. Only a call-time recording catches a
// guard that was never taken. Without it, tabs.create fires onCreated, and
// real auto-save would claim this tab for the ACTIVE workspace mid-search —
// invariant 1, the reason the guard exists at all.
test("other workspace: the swapping guard is HELD while the tab is created, hidden and searched", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });
  const relevant = globalThis.browser._peek
    .calls()
    .filter((c) => c.op === "create" || c.op === "hide" || c.op === "search");
  assert.strictEqual(relevant.length, 3, "expected exactly one create, hide and search call");
  for (const c of relevant) {
    assert.strictEqual(c.swapping, true, `${c.op} ran with swapping=${c.swapping}, expected true`);
  }
});

// Moving `search.search` above `hideTabs` (the code comment's named mistake:
// it would flash the result on screen before it could be hidden) leaves every
// other test green — none of them look at ordering, only end state. This is
// the one that would catch it.
test("other workspace: the tab is created, then hidden, then searched, in that order", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });
  const order = globalThis.browser._peek
    .calls()
    .filter((c) => c.op === "create" || c.op === "hide" || c.op === "search")
    .map((c) => c.op);
  assert.deepStrictEqual(order, ["create", "hide", "search"]);
});

test("targeting the active workspace is just a new tab", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "A" });
  assert.deepStrictEqual(globalThis.browser._peek.searches(), [
    { query: "otters", tabId: null, disposition: "NEW_TAB" },
  ]);
});

test("an empty query is rejected", async () => {
  globalThis.browser = fixture();
  await assert.rejects(() => paletteSearch("   ", { kind: "currentTab" }));
});

test("an unknown workspace is rejected without creating a stray tab", async () => {
  globalThis.browser = fixture();
  const before = globalThis.browser._peek.tabs().length;
  await assert.rejects(() => paletteSearch("otters", { kind: "workspace", id: "nope" }));
  assert.strictEqual(globalThis.browser._peek.tabs().length, before);
});
