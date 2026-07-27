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
