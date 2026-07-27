const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { test } = require("node:test");
const assert = require("node:assert");
const { makeBrowser } = require("./fake-browser");
const { importWorkspaces } = require("../firefox/background.js");

test("importWorkspaces replaces every existing workspace", async () => {
  const fake = makeBrowser({
    local: { workspaces: [{ id: "old", name: "Old", tabs: [] }], activeWorkspaceId: "old" },
  });
  globalThis.browser = fake;
  const count = await importWorkspaces([{ id: "new", name: "New", tabs: [] }]);
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(fake._peek.local().workspaces.map((w) => w.name), ["New"]);
});

// Invariant 4: Default tracks nothing and closes nothing. An imported id would
// point at a workspace whose tabs are not open.
test("importWorkspaces always clears activeWorkspaceId", async () => {
  const fake = makeBrowser({
    local: { workspaces: [{ id: "old", name: "Old", tabs: [] }], activeWorkspaceId: "old" },
  });
  globalThis.browser = fake;
  await importWorkspaces([{ id: "a", name: "A", tabs: [] }]);
  assert.strictEqual(fake._peek.local().activeWorkspaceId, null);
});

test("importWorkspaces drops an icon that has no paths", async () => {
  const fake = makeBrowser({ local: {} });
  globalThis.browser = fake;
  await importWorkspaces([{ id: "a", name: "A", tabs: [], icon: { name: "gem" } }]);
  assert.ok(!("icon" in fake._peek.local().workspaces[0]));
});

test("importWorkspaces keeps a fully-formed icon", async () => {
  const fake = makeBrowser({ local: {} });
  globalThis.browser = fake;
  const icon = { name: "gem", paths: '<path d="M1 1"/>' };
  await importWorkspaces([{ id: "a", name: "A", tabs: [], icon }]);
  assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, icon);
});

test("importWorkspaces filters untrackable tabs", async () => {
  const fake = makeBrowser({ local: {} });
  globalThis.browser = fake;
  await importWorkspaces([
    { id: "a", name: "A", tabs: [{ url: "https://ok.com/" }, { url: "chrome://x" }] },
  ]);
  assert.deepStrictEqual(fake._peek.local().workspaces[0].tabs, [
    { url: "https://ok.com/", pinned: false },
  ]);
});

test("importing an empty list clears all workspaces", async () => {
  const fake = makeBrowser({ local: { workspaces: [{ id: "a", name: "A", tabs: [] }] } });
  globalThis.browser = fake;
  const count = await importWorkspaces([]);
  assert.strictEqual(count, 0);
  assert.deepStrictEqual(fake._peek.local().workspaces, []);
});

// ---------- Live tabs (Firefox only) ----------
// In Firefox every non-active workspace owns live, hidden tabs. Replacing the
// workspace records without closing them would strand them: no record would own
// them and only Firefox's hidden-tab menu could reach them. That is the same
// strand deleteWorkspace exists to prevent.

// A window holding both workspaces' live tabs, plus tabs nobody owns.
function loadedWindow({ pinned = false, loose = false } = {}) {
  const tabs = [
    { id: 1, windowId: 1, url: "https://a1.com/", active: true },
    { id: 2, windowId: 1, url: "https://a2.com/" },
    { id: 3, windowId: 1, url: "https://b1.com/", hidden: true },
    { id: 4, windowId: 1, url: "https://b2.com/", hidden: true },
  ];
  if (pinned) tabs.push({ id: 5, windowId: 1, url: "https://pin.com/", pinned: true });
  if (loose) tabs.push({ id: 6, windowId: 1, url: "https://loose.com/" });
  return {
    local: {
      workspaces: [
        { id: "a", name: "A", tabs: [{ url: "https://a1.com/", pinned: false }] },
        { id: "b", name: "B", tabs: [{ url: "https://b1.com/", pinned: false }] },
      ],
      activeWorkspaceId: "a",
    },
    session: { tabMap: { a: [1, 2], b: [3, 4] } },
    tabs,
  };
}

test("importWorkspaces closes the live tabs of every pre-import workspace", async () => {
  const fake = makeBrowser(loadedWindow({ pinned: true }));
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [{ url: "https://new.com/" }] }]);
  const left = fake._peek.tabs().map((t) => t.id);
  // 3 and 4 are the hidden ones — the tabs only Firefox's own menu could reach.
  for (const id of [1, 2, 3, 4]) assert.ok(!left.includes(id), `tab ${id} was left open`);
});

test("importWorkspaces clears the tab map", async () => {
  const fake = makeBrowser(loadedWindow({ pinned: true }));
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
  assert.deepStrictEqual(fake._peek.session().tabMap, {});
});

test("importWorkspaces never leaves the window with zero tabs", async () => {
  // Every tab in the window is owned, so closing them all would close the window.
  const fake = makeBrowser(loadedWindow());
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
  const left = fake._peek.tabs();
  assert.strictEqual(left.length, 1);
  assert.deepStrictEqual(left.map((t) => t.id), [5]); // a fresh blank tab
});

test("importWorkspaces leaves pinned tabs open and clears the loose ones", async () => {
  // Pinned tabs belong to nobody — Firefox refuses to hide them, so they stay
  // visible in every workspace and must survive. A loose visible tab is a
  // different story: it is ownable, so leaving it would let the first switch
  // into an imported workspace claim it into the backup.
  const fake = makeBrowser(loadedWindow({ pinned: true, loose: true }));
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
  assert.deepStrictEqual(fake._peek.tabs().map((t) => t.id).sort(), [5]);
});

// ---------- The post-restart path ----------
// storage.session is cleared on browser restart, so "restart Firefox, then
// restore a backup" reaches import with an EMPTY tabMap. Nothing is owned, the
// session-restored tabs are still on screen, and activeWorkspaceId is null after
// the import — so no switch would ever hide them. The first switch into an
// imported workspace would instead have syncNow/claimVisible write them into
// that workspace's saved record, mutating the backup the user just restored.

function restartedWindow(extra = []) {
  return {
    local: {
      workspaces: [{ id: "a", name: "A", tabs: [{ url: "https://a1.com/", pinned: false }] }],
      activeWorkspaceId: "a",
    },
    session: { tabMap: {} }, // wiped by the restart
    tabs: [
      { id: 1, windowId: 1, url: "https://a1.com/", active: true },
      { id: 2, windowId: 1, url: "https://a2.com/" },
      ...extra,
    ],
  };
}

test("importWorkspaces closes leftover visible tabs when the tab map is empty", async () => {
  const fake = makeBrowser(restartedWindow());
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [{ url: "https://new.com/" }] }]);
  const left = fake._peek.tabs().map((t) => t.id);
  for (const id of [1, 2]) assert.ok(!left.includes(id), `tab ${id} was left open`);
});

test("importWorkspaces never empties the window when every tab is a leftover", async () => {
  const fake = makeBrowser(restartedWindow());
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
  const left = fake._peek.tabs();
  assert.strictEqual(left.length, 1);
  assert.deepStrictEqual(left.map((t) => t.id), [3]); // a fresh blank tab
});

test("importWorkspaces keeps pinned tabs through the empty-tab-map path", async () => {
  const fake = makeBrowser(restartedWindow([
    { id: 5, windowId: 1, url: "https://pin.com/", pinned: true },
  ]));
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
  assert.deepStrictEqual(fake._peek.tabs().map((t) => t.id), [5]);
});

test("importWorkspaces leaves an untrackable tab alone", async () => {
  // about: pages can't be reopened, so no workspace can ever own one
  // (invariant 5). Closing it would destroy something we could not restore.
  const fake = makeBrowser(restartedWindow([
    { id: 5, windowId: 1, url: "about:config" },
  ]));
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
  assert.deepStrictEqual(fake._peek.tabs().map((t) => t.id), [5]);
});

// Invariant 1: the closes above must not feed back into auto-save.
test("importWorkspaces holds the swapping guard while it closes tabs", async () => {
  const fake = makeBrowser(loadedWindow({ pinned: true }));
  globalThis.browser = fake;
  // Assert the guard is UP at the moment of the close, not just down at the end:
  // the fake starts `swapping` false, so an end-state check alone passes even
  // with no guard at all.
  const seen = [];
  const remove = fake.tabs.remove;
  fake.tabs.remove = (ids) => {
    seen.push(fake._peek.session().swapping);
    return remove(ids);
  };
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
  assert.deepStrictEqual(seen, [true]);
  assert.strictEqual(fake._peek.session().swapping, false);
});

// ---------- Re-validation ----------

test("importWorkspaces skips a record with a blank name", async () => {
  const fake = makeBrowser({ local: {} });
  globalThis.browser = fake;
  const count = await importWorkspaces([
    { id: "a", name: "   ", tabs: [] },
    { id: "b", name: "B", tabs: [] },
  ]);
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(fake._peek.local().workspaces.map((w) => w.name), ["B"]);
});

test("importWorkspaces mints an id when one is missing", async () => {
  const fake = makeBrowser({ local: {} });
  globalThis.browser = fake;
  await importWorkspaces([{ name: "A", tabs: [] }, { id: 7, name: "B", tabs: [] }]);
  const ids = fake._peek.local().workspaces.map((w) => w.id);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
  assert.notStrictEqual(ids[0], ids[1]);
});

test("importWorkspaces trims a padded name", async () => {
  const fake = makeBrowser({ local: {} });
  globalThis.browser = fake;
  await importWorkspaces([{ id: "a", name: "  Work  ", tabs: [] }]);
  assert.strictEqual(fake._peek.local().workspaces[0].name, "Work");
});
