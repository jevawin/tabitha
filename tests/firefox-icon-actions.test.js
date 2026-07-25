const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { test } = require("node:test");
const assert = require("node:assert");
const { makeBrowser } = require("./fake-browser");
const { createWorkspace, createEmptyWorkspace, setWorkspaceIcon, moveActiveTabToNew } = require("../firefox/background.js");

const ICON = { name: "rocket", paths: "<path d=\"M1 1\"/>" };
const oneWindow = () => [
  { id: 1, windowId: 1, url: "https://a.com/", active: true, pinned: false },
  { id: 2, windowId: 1, url: "https://b.com/", active: false, pinned: false },
];

test("createWorkspace stores a valid icon on the new record", async () => {
  const fake = makeBrowser({ tabs: oneWindow() });
  globalThis.browser = fake;
  const ws = await createWorkspace("A", ICON);
  const stored = fake._peek.local().workspaces.find((w) => w.id === ws.id);
  assert.deepStrictEqual(stored.icon, ICON);
});

test("createWorkspace omits icon when none/invalid is passed", async () => {
  const fake = makeBrowser({ tabs: oneWindow() });
  globalThis.browser = fake;
  const ws1 = await createWorkspace("NoIcon");
  const ws2 = await createWorkspace("BadIcon", { name: "x" });
  const stored = fake._peek.local().workspaces;
  assert.ok(!("icon" in stored.find((w) => w.id === ws1.id)));
  assert.ok(!("icon" in stored.find((w) => w.id === ws2.id)));
});

test("setWorkspaceIcon sets then clears a record's icon", async () => {
  const fake = makeBrowser({ local: { workspaces: [{ id: "a", name: "A", tabs: [] }], activeWorkspaceId: "a" } });
  globalThis.browser = fake;
  await setWorkspaceIcon("a", ICON);
  assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, ICON);
  await setWorkspaceIcon("a", { name: "bad" }); // invalid -> clears
  assert.ok(!("icon" in fake._peek.local().workspaces[0]));
});

test("setWorkspaceIcon is a no-op for an unknown id", async () => {
  // Seed with an icon so the assertion is meaningful — we verify it is untouched.
  const fake = makeBrowser({ local: { workspaces: [{ id: "a", name: "A", tabs: [], icon: ICON }], activeWorkspaceId: "a" } });
  globalThis.browser = fake;
  await setWorkspaceIcon("nope", ICON);
  assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, ICON);
});

test("createEmptyWorkspace stores a valid icon on the new record", async () => {
  const fake = makeBrowser({ tabs: oneWindow() });
  globalThis.browser = fake;
  const ws = await createEmptyWorkspace("Empty", ICON);
  const stored = fake._peek.local().workspaces.find((w) => w.id === ws.id);
  assert.deepStrictEqual(stored.icon, ICON);
});

test("moveActiveTabToNew seeds the new workspace with an icon", async () => {
  const fake = makeBrowser({ local: { workspaces: [{ id: "src", name: "Src", tabs: [] }], activeWorkspaceId: "src" }, tabs: oneWindow() });
  globalThis.browser = fake;
  const ws = await moveActiveTabToNew("New", ICON);
  const created = fake._peek.local().workspaces.find((w) => w.id === ws.id);
  assert.deepStrictEqual(created.icon, ICON);
});
