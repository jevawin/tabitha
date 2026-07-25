// Integration tests for the move ACTIONS against an in-memory chrome fake.
// The pure-helper tests (move.test.js) can't cover the chrome.* control flow
// (window reshaping, follow-the-tab, source save), so these do — deterministically,
// without a real browser.

const { test } = require("node:test");
const assert = require("node:assert");

// background.js registers listeners at load; give it stubs so require() succeeds.
const noopListener = { addListener() {} };
globalThis.chrome = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { moveActiveTab, moveActiveTabToNew } = require("../chrome/background.js");
const { makeChrome } = require("./fake-chrome");

const winTabs = () => [
  { id: 1, windowId: 1, url: "https://a.com/", active: false, pinned: false },
  { id: 2, windowId: 1, url: "https://b.com/", active: true, pinned: false }, // the active/moved tab
  { id: 3, windowId: 1, url: "https://c.com/", active: false, pinned: false },
];

test("moveActiveTabToNew follows the tab: new workspace active, source loses the tab, only the moved tab stays open", async () => {
  const fake = makeChrome({
    local: { workspaces: [{ id: "src", name: "Src", tabs: [] }], activeWorkspaceId: "src" },
    tabs: winTabs(),
  });
  globalThis.chrome = fake;

  await moveActiveTabToNew("New");

  const local = fake._peek.local();
  const created = local.workspaces.find((w) => w.name === "New");

  assert.ok(created, "a workspace named New exists");
  assert.strictEqual(local.activeWorkspaceId, created.id, "followed: new workspace is active");
  assert.deepStrictEqual(created.tabs, [{ url: "https://b.com/", pinned: false }], "new workspace holds the moved tab");

  const src = local.workspaces.find((w) => w.id === "src");
  assert.deepStrictEqual(
    src.tabs,
    [{ url: "https://a.com/", pinned: false }, { url: "https://c.com/", pinned: false }],
    "source saved WITHOUT the moved tab"
  );

  const remaining = fake._peek.tabs();
  assert.deepStrictEqual(remaining.map((t) => t.id), [2], "only the moved tab stays open (others closed, window not empty)");
  assert.strictEqual(fake._peek.session().swapping, false, "swapping guard released");
});

test("moveActiveTabToNew in Default state (no active source) still creates and follows", async () => {
  const fake = makeChrome({
    local: { workspaces: [], activeWorkspaceId: null },
    tabs: winTabs(),
  });
  globalThis.chrome = fake;

  await moveActiveTabToNew("Fresh");

  const local = fake._peek.local();
  const created = local.workspaces.find((w) => w.name === "Fresh");
  assert.ok(created);
  assert.strictEqual(local.activeWorkspaceId, created.id);
  assert.deepStrictEqual(created.tabs, [{ url: "https://b.com/", pinned: false }]);
  assert.deepStrictEqual(fake._peek.tabs().map((t) => t.id), [2], "others closed, moved tab stays");
});

test("moveActiveTab (existing) follows into the target: target active, source loses the tab, window shows the target's tabs", async () => {
  const fake = makeChrome({
    local: {
      workspaces: [{ id: "src", name: "Src", tabs: [] }, { id: "dst", name: "Dst", tabs: [{ url: "https://x.com/", pinned: false }] }],
      activeWorkspaceId: "src",
    },
    tabs: winTabs(),
  });
  globalThis.chrome = fake;

  await moveActiveTab("dst");

  const local = fake._peek.local();
  assert.strictEqual(local.activeWorkspaceId, "dst", "followed: target is active");

  const dst = local.workspaces.find((w) => w.id === "dst");
  assert.deepStrictEqual(
    dst.tabs,
    [{ url: "https://x.com/", pinned: false }, { url: "https://b.com/", pinned: false }],
    "moved tab appended to the target's saved tabs"
  );

  const src = local.workspaces.find((w) => w.id === "src");
  assert.deepStrictEqual(
    src.tabs,
    [{ url: "https://a.com/", pinned: false }, { url: "https://c.com/", pinned: false }],
    "source saved WITHOUT the moved tab"
  );

  assert.deepStrictEqual(
    fake._peek.tabs().map((t) => t.url),
    ["https://x.com/", "https://b.com/"],
    "window now shows the target workspace's tabs (the moved tab reopened among them)"
  );
});

test("moveActiveTab rejects a non-http(s) active tab", async () => {
  const fake = makeChrome({
    local: { workspaces: [{ id: "dst", name: "Dst", tabs: [] }], activeWorkspaceId: null },
    tabs: [{ id: 1, windowId: 1, url: "chrome://extensions", active: true, pinned: false }],
  });
  globalThis.chrome = fake;
  await assert.rejects(() => moveActiveTab("dst"), /can't be moved/i);
});
