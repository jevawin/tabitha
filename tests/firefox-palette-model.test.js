// Titles and last-active URL must survive a claim, because a workspace that has
// not been opened this session has no live tab to read either from.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  commands: { onCommand: noopListener },
  runtime: { onMessage: noopListener, onInstalled: noopListener },
};

const { switchWorkspace } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

test("claiming stores each tab's title and the active tab's url", async () => {
  globalThis.browser = makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "A", tabs: [] },
        { id: "B", name: "B", tabs: [{ url: "https://b1/", pinned: false }] },
      ],
      activeWorkspaceId: "A",
    },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", title: "First", active: false },
      { id: 2, windowId: 1, url: "https://a2/", title: "Second", active: true },
    ],
  });

  // Switching away from A claims A while its tabs are still visible.
  await switchWorkspace("B");

  const a = globalThis.browser._peek.local().workspaces.find((w) => w.id === "A");
  assert.deepStrictEqual(a.tabs, [
    { url: "https://a1/", pinned: false, title: "First" },
    { url: "https://a2/", pinned: false, title: "Second" },
  ]);
  assert.strictEqual(a.lastActiveUrl, "https://a2/");
});

test("a tab with no title stores no title field rather than an empty one", async () => {
  globalThis.browser = makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "A", tabs: [] },
        { id: "B", name: "B", tabs: [{ url: "https://b1/", pinned: false }] },
      ],
      activeWorkspaceId: "A",
    },
    tabs: [{ id: 1, windowId: 1, url: "https://a1/", active: true }],
  });

  await switchWorkspace("B");

  const a = globalThis.browser._peek.local().workspaces.find((w) => w.id === "A");
  assert.deepStrictEqual(a.tabs, [{ url: "https://a1/", pinned: false }]);
});
