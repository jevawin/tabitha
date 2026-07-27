const noopListener = { addListener() {} };
globalThis.chrome = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { test } = require("node:test");
const assert = require("node:assert");
const { makeChrome } = require("./fake-chrome");
const { importWorkspaces } = require("../chrome/background.js");

test("importWorkspaces replaces every existing workspace", async () => {
  const fake = makeChrome({
    local: { workspaces: [{ id: "old", name: "Old", tabs: [] }], activeWorkspaceId: "old" },
  });
  globalThis.chrome = fake;
  const count = await importWorkspaces([{ id: "new", name: "New", tabs: [] }]);
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(fake._peek.local().workspaces.map((w) => w.name), ["New"]);
});

// Invariant 4: Default tracks nothing and closes nothing. An imported id would
// point at a workspace whose tabs are not open.
test("importWorkspaces always clears activeWorkspaceId", async () => {
  const fake = makeChrome({
    local: { workspaces: [{ id: "old", name: "Old", tabs: [] }], activeWorkspaceId: "old" },
  });
  globalThis.chrome = fake;
  await importWorkspaces([{ id: "a", name: "A", tabs: [] }]);
  assert.strictEqual(fake._peek.local().activeWorkspaceId, null);
});

test("importWorkspaces drops an icon that has no paths", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  await importWorkspaces([{ id: "a", name: "A", tabs: [], icon: { name: "gem" } }]);
  assert.ok(!("icon" in fake._peek.local().workspaces[0]));
});

test("importWorkspaces keeps a fully-formed icon", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  const icon = { name: "gem", paths: '<path d="M1 1"/>' };
  await importWorkspaces([{ id: "a", name: "A", tabs: [], icon }]);
  assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, icon);
});

test("importWorkspaces filters untrackable tabs", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  await importWorkspaces([
    { id: "a", name: "A", tabs: [{ url: "https://ok.com/" }, { url: "chrome://x" }] },
  ]);
  assert.deepStrictEqual(fake._peek.local().workspaces[0].tabs, [
    { url: "https://ok.com/", pinned: false },
  ]);
});

test("importWorkspaces skips a record with a blank name", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  const count = await importWorkspaces([
    { id: "a", name: "   ", tabs: [] },
    { id: "b", name: "B", tabs: [] },
  ]);
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(fake._peek.local().workspaces.map((w) => w.name), ["B"]);
});

test("importWorkspaces mints an id when one is missing", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  await importWorkspaces([{ name: "A", tabs: [] }, { id: 7, name: "B", tabs: [] }]);
  const ids = fake._peek.local().workspaces.map((w) => w.id);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
  assert.notStrictEqual(ids[0], ids[1]);
});

test("importWorkspaces trims a padded name", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  await importWorkspaces([{ id: "a", name: "  Work  ", tabs: [] }]);
  assert.strictEqual(fake._peek.local().workspaces[0].name, "Work");
});

test("importing an empty list clears all workspaces", async () => {
  const fake = makeChrome({ local: { workspaces: [{ id: "a", name: "A", tabs: [] }] } });
  globalThis.chrome = fake;
  const count = await importWorkspaces([]);
  assert.strictEqual(count, 0);
  assert.deepStrictEqual(fake._peek.local().workspaces, []);
});
