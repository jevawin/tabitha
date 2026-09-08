// Jumping must switch workspace first when the tab lives elsewhere, and must
// never close anything (invariant 11).
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  commands: { onCommand: noopListener },
  runtime: { onMessage: noopListener, onInstalled: noopListener, onStartup: noopListener },
};

const { jumpToTab, openWorkspace } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

const fixture = () =>
  makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "Work", tabs: [{ url: "https://a1/", pinned: false }] },
        { id: "B", name: "Play", lastActiveUrl: "https://b2/", tabs: [
          { url: "https://b1/", pinned: false },
          { url: "https://b2/", pinned: false },
        ] },
      ],
      activeWorkspaceId: "A",
    },
    session: { tabMap: { A: [1], B: [2, 3] } },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://b1/", hidden: true },
      { id: 3, windowId: 1, url: "https://b2/", hidden: true },
    ],
  });

test("jumping to a tab in another workspace switches, reveals and activates it", async () => {
  globalThis.browser = fixture();
  await jumpToTab(3);

  const tabs = globalThis.browser._peek.tabs();
  const target = tabs.find((t) => t.id === 3);
  assert.strictEqual(target.active, true);
  assert.strictEqual(target.hidden, false);
  assert.strictEqual(globalThis.browser._peek.local().activeWorkspaceId, "B");
  // The workspace we left is hidden, not closed.
  assert.strictEqual(tabs.find((t) => t.id === 1).hidden, true);
  assert.strictEqual(tabs.length, 3);
});

test("jumping within the active workspace does not switch", async () => {
  globalThis.browser = fixture();
  await jumpToTab(1);
  assert.strictEqual(globalThis.browser._peek.local().activeWorkspaceId, "A");
  assert.strictEqual(globalThis.browser._peek.tabs().find((t) => t.id === 1).active, true);
});

test("opening a workspace lands on its last-active url", async () => {
  globalThis.browser = fixture();
  await openWorkspace("B");
  const tabs = globalThis.browser._peek.tabs();
  assert.strictEqual(tabs.find((t) => t.url === "https://b2/").active, true);
});

test("opening a workspace with no last-active url still switches", async () => {
  globalThis.browser = fixture();
  await openWorkspace("A"); // already active, and has no lastActiveUrl
  assert.strictEqual(globalThis.browser._peek.local().activeWorkspaceId, "A");
});

test("jumping to an unknown tab rejects rather than throwing silently", async () => {
  globalThis.browser = fixture();
  await assert.rejects(() => jumpToTab(999));
});
