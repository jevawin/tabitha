// The switch, against the in-memory `browser` fake.
//
// The point of this extension is that switching HIDES tabs instead of closing
// them. These tests pin that down: tab ids must survive a round trip, tabs must
// never be removed by a switch, and Firefox's constraints (the active tab and
// pinned tabs cannot be hidden) must be respected.

const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const {
  switchWorkspace,
  createWorkspace,
  createEmptyWorkspace,
  deleteWorkspace,
} = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

const twoWorkspaces = () => ({
  workspaces: [
    { id: "A", name: "A", tabs: [{ url: "https://a1/", pinned: false }, { url: "https://a2/", pinned: false }] },
    { id: "B", name: "B", tabs: [{ url: "https://b1/", pinned: false }] },
  ],
  activeWorkspaceId: "A",
});

// A window already showing workspace A's tabs (the state Firefox restores into
// at the start of a browser session, before any workspace is live).
const aTabsOpen = () => [
  { id: 1, windowId: 1, url: "https://a1/", active: true, pinned: false },
  { id: 2, windowId: 1, url: "https://a2/", active: false, pinned: false },
];

const urlsOf = (tabs) => tabs.map((t) => t.url).sort();

test("switching hides the old workspace instead of closing it", async () => {
  const fake = makeBrowser({ local: twoWorkspaces(), tabs: aTabsOpen() });
  globalThis.browser = fake;

  await switchWorkspace("B");

  assert.strictEqual(fake._peek.local().activeWorkspaceId, "B");
  assert.deepStrictEqual(urlsOf(fake._peek.visible()), ["https://b1/"], "only B is showing");
  assert.ok(
    fake._peek.tabs().some((t) => t.id === 1) && fake._peek.tabs().some((t) => t.id === 2),
    "A's tabs are still open, just hidden"
  );
  assert.ok(fake._peek.tabs().filter((t) => t.id === 1 || t.id === 2).every((t) => t.hidden), "and really hidden");
  assert.strictEqual(fake._peek.session().swapping, false, "guard released");
});

test("switching back reveals the same tabs — nothing is reopened", async () => {
  const fake = makeBrowser({ local: twoWorkspaces(), tabs: aTabsOpen() });
  globalThis.browser = fake;

  await switchWorkspace("B");
  const afterFirst = fake._peek.tabs().map((t) => t.id).sort();

  await switchWorkspace("A");
  const afterSecond = fake._peek.tabs().map((t) => t.id).sort();

  assert.deepStrictEqual(afterSecond, afterFirst, "no new tabs: they were shown, not rebuilt");
  assert.deepStrictEqual(urlsOf(fake._peek.visible()), ["https://a1/", "https://a2/"], "A is showing again");
  assert.ok(afterSecond.includes(1) && afterSecond.includes(2), "A's original tab ids survived the round trip");

  await switchWorkspace("B");
  assert.deepStrictEqual(fake._peek.tabs().map((t) => t.id).sort(), afterFirst, "a third switch opens nothing");
});

test("no outgoing tab is left visible — the active tab moves first", async () => {
  const fake = makeBrowser({ local: twoWorkspaces(), tabs: aTabsOpen() });
  globalThis.browser = fake;

  // Tab 1 is active and belongs to A. Firefox refuses to hide the active tab,
  // so unless the switch activates one of B's tabs first, tab 1 stays on screen.
  await switchWorkspace("B");

  assert.deepStrictEqual(urlsOf(fake._peek.visible()), ["https://b1/"], "A's active tab was hidden too");
  assert.ok(fake._peek.visible()[0].active, "and B's tab took over as active");
});

test("first activation materializes a workspace from its saved urls, once", async () => {
  const fake = makeBrowser({ local: twoWorkspaces(), tabs: aTabsOpen() });
  globalThis.browser = fake;

  await switchWorkspace("B");
  assert.strictEqual(fake._peek.tabs().filter((t) => t.url === "https://b1/").length, 1, "opened once");

  await switchWorkspace("A");
  await switchWorkspace("B");
  assert.strictEqual(
    fake._peek.tabs().filter((t) => t.url === "https://b1/").length,
    1,
    "later switches do not open it again"
  );
});

test("an empty workspace materializes as one blank tab", async () => {
  const fake = makeBrowser({
    local: { workspaces: [{ id: "A", name: "A", tabs: [] }], activeWorkspaceId: "A" },
    tabs: aTabsOpen(),
  });
  globalThis.browser = fake;

  await createEmptyWorkspace("Empty");

  assert.strictEqual(fake._peek.visible().length, 1, "exactly one tab visible");
  assert.strictEqual(fake._peek.visible()[0].url, "", "and it is blank");
  assert.strictEqual(fake._peek.tabs().length, 3, "A's two tabs are still open behind it");
});

test("pinned tabs stay visible in every workspace and belong to none", async () => {
  const fake = makeBrowser({
    local: twoWorkspaces(),
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true, pinned: false },
      { id: 7, windowId: 1, url: "https://pinned/", active: false, pinned: true },
    ],
  });
  globalThis.browser = fake;

  await switchWorkspace("B");

  assert.ok(urlsOf(fake._peek.visible()).includes("https://pinned/"), "pinned tab still visible in B");
  assert.strictEqual(fake._peek.tabs().find((t) => t.id === 7).hidden, false, "Firefox would refuse; we never ask");
  const a = fake._peek.local().workspaces.find((w) => w.id === "A");
  assert.deepStrictEqual(a.tabs, [{ url: "https://a1/", pinned: false }], "and it is not saved into a workspace");
});

test("a tab that refuses to hide is left visible, not lost", async () => {
  const fake = makeBrowser({
    local: twoWorkspaces(),
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true, pinned: false },
      // Stands in for a tab sharing screen, mic or camera.
      { id: 2, windowId: 1, url: "https://meet/", active: false, pinned: false, unhideable: true },
    ],
  });
  globalThis.browser = fake;

  await switchWorkspace("B");

  assert.ok(urlsOf(fake._peek.visible()).includes("https://meet/"), "the call tab stayed on screen");
  assert.ok(urlsOf(fake._peek.visible()).includes("https://b1/"), "B still opened alongside it");
  const a = fake._peek.local().workspaces.find((w) => w.id === "A");
  assert.ok(a.tabs.some((t) => t.url === "https://meet/"), "and it is still saved under A");
});

test("a tab the user un-hides is not swallowed by the active workspace", async () => {
  const fake = makeBrowser({ local: twoWorkspaces(), tabs: aTabsOpen() });
  globalThis.browser = fake;

  await switchWorkspace("B");
  // The user reaches into Firefox's hidden-tab menu and un-hides one of A's.
  fake._peek.tabs().find((t) => t.id === 1).hidden = false;

  await switchWorkspace("A");
  await switchWorkspace("B");

  const a = fake._peek.local().workspaces.find((w) => w.id === "A");
  const b = fake._peek.local().workspaces.find((w) => w.id === "B");
  assert.ok(a.tabs.some((t) => t.url === "https://a1/"), "the tab still belongs to A");
  assert.ok(!b.tabs.some((t) => t.url === "https://a1/"), "and B never claimed it");
});

test("Save current tabs forks the window into a new workspace", async () => {
  const fake = makeBrowser({
    local: { workspaces: [], activeWorkspaceId: null },
    tabs: aTabsOpen(),
  });
  globalThis.browser = fake;

  const ws = await createWorkspace("First");

  assert.deepStrictEqual(
    ws.tabs,
    [{ url: "https://a1/", pinned: false }, { url: "https://a2/", pinned: false }],
    "claimed the visible tabs"
  );
  assert.strictEqual(fake._peek.local().activeWorkspaceId, ws.id, "and dropped us into it");
  assert.strictEqual(fake._peek.tabs().length, 2, "nothing opened, closed or hidden");
  assert.strictEqual(fake._peek.visible().length, 2, "everything still on screen");
});

test("Save current tabs takes ownership from the workspace that held them", async () => {
  const fake = makeBrowser({
    local: { workspaces: [{ id: "A", name: "A", tabs: [] }], activeWorkspaceId: "A" },
    session: { tabMap: { A: [1, 2] } },
    tabs: aTabsOpen(),
  });
  globalThis.browser = fake;

  const ws = await createWorkspace("Fork");

  assert.deepStrictEqual(fake._peek.session().tabMap[ws.id], [1, 2], "the new workspace owns the tabs");
  assert.deepStrictEqual(fake._peek.session().tabMap.A, [], "the old one lost them");
});

test("deleting a workspace closes its tabs and never empties the window", async () => {
  const fake = makeBrowser({ local: twoWorkspaces(), tabs: aTabsOpen() });
  globalThis.browser = fake;

  await switchWorkspace("B"); // A hidden, B showing
  await deleteWorkspace("A");

  assert.ok(!fake._peek.local().workspaces.some((w) => w.id === "A"), "workspace gone");
  assert.deepStrictEqual(urlsOf(fake._peek.tabs()), ["https://b1/"], "A's hidden tabs closed with it");
  assert.strictEqual(fake._peek.local().activeWorkspaceId, "B", "B is untouched");

  await deleteWorkspace("B");
  assert.ok(fake._peek.tabs().length >= 1, "window still has a tab");
  assert.strictEqual(fake._peek.local().activeWorkspaceId, null, "back to Default state");
});
