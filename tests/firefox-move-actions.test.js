// Integration tests for the move ACTIONS against the in-memory `browser` fake.
// The pure-helper tests (move.test.js) can't cover the browser.* control flow
// (show/hide, follow-the-tab, source save), so these do — deterministically,
// without a real browser.
//
// A move never closes, hides or reloads the tab being moved: only ownership
// changes. These tests assert exactly that, so a regression fails here.

const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { moveActiveTab, moveActiveTabToNew } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

const winTabs = () => [
  { id: 1, windowId: 1, url: "https://a.com/", active: false, pinned: false },
  { id: 2, windowId: 1, url: "https://b.com/", active: true, pinned: false }, // the active/moved tab
  { id: 3, windowId: 1, url: "https://c.com/", active: false, pinned: false },
];

const urlsOf = (tabs) => tabs.map((t) => t.url).sort();

test("moveActiveTabToNew follows the tab: new workspace active, source loses the tab, nothing closes", async () => {
  const fake = makeBrowser({
    local: { workspaces: [{ id: "src", name: "Src", tabs: [] }], activeWorkspaceId: "src" },
    tabs: winTabs(),
  });
  globalThis.browser = fake;

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

  assert.deepStrictEqual(fake._peek.tabs().map((t) => t.id).sort(), [1, 2, 3], "every tab still open");
  assert.deepStrictEqual(urlsOf(fake._peek.visible()), ["https://b.com/"], "only the moved tab is visible");
  assert.strictEqual(fake._peek.session().swapping, false, "swapping guard released");
});

test("moveActiveTabToNew in Default state (no active source) still creates and follows", async () => {
  const fake = makeBrowser({ local: { workspaces: [], activeWorkspaceId: null }, tabs: winTabs() });
  globalThis.browser = fake;

  await moveActiveTabToNew("Fresh");

  const local = fake._peek.local();
  const created = local.workspaces.find((w) => w.name === "Fresh");
  assert.ok(created);
  assert.strictEqual(local.activeWorkspaceId, created.id);
  assert.deepStrictEqual(created.tabs, [{ url: "https://b.com/", pinned: false }]);
  assert.deepStrictEqual(fake._peek.tabs().map((t) => t.id).sort(), [1, 2, 3], "nothing closed");
  // With no source workspace the leftovers are owned by nobody, but they are
  // still hidden — Default state has no tabs it needs to keep on screen.
  assert.deepStrictEqual(urlsOf(fake._peek.visible()), ["https://b.com/"], "leftovers hidden anyway");
});

test("moveActiveTab (existing) follows into the target and never reloads the tab", async () => {
  const fake = makeBrowser({
    local: {
      workspaces: [
        { id: "src", name: "Src", tabs: [] },
        { id: "dst", name: "Dst", tabs: [{ url: "https://x.com/", pinned: false }] },
      ],
      activeWorkspaceId: "src",
    },
    tabs: winTabs(),
  });
  globalThis.browser = fake;

  await moveActiveTab("dst");

  const local = fake._peek.local();
  assert.strictEqual(local.activeWorkspaceId, "dst", "followed: target is active");

  const dst = local.workspaces.find((w) => w.id === "dst");
  assert.deepStrictEqual(
    urlsOf(dst.tabs),
    ["https://b.com/", "https://x.com/"],
    "target holds its own tab plus the moved one"
  );

  const src = local.workspaces.find((w) => w.id === "src");
  assert.deepStrictEqual(
    src.tabs,
    [{ url: "https://a.com/", pinned: false }, { url: "https://c.com/", pinned: false }],
    "source saved WITHOUT the moved tab"
  );

  assert.deepStrictEqual(
    urlsOf(fake._peek.visible()),
    ["https://b.com/", "https://x.com/"],
    "window shows the target's tabs; the moved tab is among them"
  );
  assert.ok(fake._peek.tabs().some((t) => t.url === "https://a.com/"), "the source's tabs are hidden, not closed");

  // Same id, never hidden: the page was not reloaded and did not even blink.
  const moved = fake._peek.tabs().find((t) => t.url === "https://b.com/");
  assert.strictEqual(moved.id, 2, "same tab id — ownership changed, the tab did not");
  assert.strictEqual(moved.hidden, false, "and it was never hidden on the way");
});

test("moveActiveTab rejects a non-http(s) active tab", async () => {
  const fake = makeBrowser({
    local: { workspaces: [{ id: "dst", name: "Dst", tabs: [] }], activeWorkspaceId: null },
    tabs: [{ id: 1, windowId: 1, url: "about:config", active: true, pinned: false }],
  });
  globalThis.browser = fake;
  await assert.rejects(() => moveActiveTab("dst"), /can't be moved/i);
});

test("moveActiveTab rejects the workspace you are already in", async () => {
  const fake = makeBrowser({
    local: { workspaces: [{ id: "src", name: "Src", tabs: [] }], activeWorkspaceId: "src" },
    tabs: winTabs(),
  });
  globalThis.browser = fake;
  await assert.rejects(() => moveActiveTab("src"), /already in this workspace/i);
});
