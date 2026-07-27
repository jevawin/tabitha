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

test("importWorkspaces leaves tabs no workspace owns alone", async () => {
  // A pinned tab (Firefox refuses to hide those, so they belong to nobody) and a
  // visible tab no workspace has claimed.
  const fake = makeBrowser(loadedWindow({ pinned: true, loose: true }));
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
  assert.deepStrictEqual(fake._peek.tabs().map((t) => t.id).sort(), [5, 6]);
});

// Invariant 1: the closes above must not feed back into auto-save.
test("importWorkspaces releases the swapping guard", async () => {
  const fake = makeBrowser(loadedWindow({ pinned: true }));
  globalThis.browser = fake;
  await importWorkspaces([{ id: "n", name: "N", tabs: [] }]);
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
