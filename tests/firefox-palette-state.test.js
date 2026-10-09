// paletteState is the overlay's only source of truth. It must see hidden tabs in
// other workspaces (that is the whole point of the Firefox target) and fall back
// to saved records for workspaces that have not been opened this session.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  commands: { onCommand: noopListener },
  runtime: { onMessage: noopListener, onInstalled: noopListener, onStartup: noopListener },
};

const { buildPaletteState } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

const fixture = () =>
  makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "Work", tabs: [{ url: "https://a1/", pinned: false, title: "A one" }] },
        { id: "B", name: "Play", tabs: [{ url: "https://b1/", pinned: false, title: "B one" }] },
        { id: "C", name: "Cold", lastActiveUrl: "https://c2/", tabs: [
          { url: "https://c1/", pinned: false, title: "C one" },
          { url: "https://c2/", pinned: false, title: "C two" },
        ] },
      ],
      activeWorkspaceId: "A",
    },
    session: { tabMap: { A: [1], B: [2] } },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", title: "A one", active: true },
      { id: 2, windowId: 1, url: "https://b1/", title: "B one", hidden: true },
      { id: 3, windowId: 1, url: "about:config", title: "Config" },
    ],
  });

test("a live tab item carries `active`, matching the browser's own active tab", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  const a = state.items.find((i) => i.kind === "tab" && i.tabId === 1);
  const b = state.items.find((i) => i.kind === "tab" && i.tabId === 2);
  assert.strictEqual(a.active, true); // fixture tab 1 is the active tab
  assert.strictEqual(b.active, false);
});

test("live tabs are listed with their owning workspace, hidden ones included", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();

  const a = state.items.find((i) => i.kind === "tab" && i.tabId === 1);
  assert.deepStrictEqual(
    { workspaceId: a.workspaceId, hidden: a.hidden, title: a.title },
    { workspaceId: "A", hidden: false, title: "A one" }
  );

  const b = state.items.find((i) => i.kind === "tab" && i.tabId === 2);
  assert.deepStrictEqual(
    { workspaceId: b.workspaceId, hidden: b.hidden, title: b.title },
    { workspaceId: "B", hidden: true, title: "B one" }
  );
});

test("live tab items carry favIconUrl; saved records carry none", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();

  const a = state.items.find((i) => i.kind === "tab" && i.tabId === 1);
  assert.strictEqual(a.favIconUrl, ""); // fixture tab 1 sets no favIconUrl
  const saved = state.items.find((i) => i.kind === "saved");
  assert.strictEqual(saved.favIconUrl, undefined);
});

test("a tab's real favIconUrl passes through unchanged", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [{ id: "A", name: "Work", tabs: [] }], activeWorkspaceId: "A" },
    session: { tabMap: { A: [1] } },
    tabs: [{ id: 1, windowId: 1, url: "https://a1/", title: "A one", active: true, favIconUrl: "https://a.example/favicon.ico" }],
  });
  const state = await buildPaletteState();
  const a = state.items.find((i) => i.kind === "tab" && i.tabId === 1);
  assert.strictEqual(a.favIconUrl, "https://a.example/favicon.ico");
});

test("untrackable tabs are never offered", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  assert.strictEqual(state.items.some((i) => i.url === "about:config"), false);
});

test("a workspace with no live tabs falls back to its saved records", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  const saved = state.items.filter((i) => i.kind === "saved" && i.workspaceId === "C");
  assert.deepStrictEqual(saved.map((i) => i.title), ["C one", "C two"]);
  assert.strictEqual(saved.every((i) => i.tabId === null && i.hidden === true), true);
});

test("a saved record is not duplicated when the same url is already live", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  const a1 = state.items.filter((i) => i.url === "https://a1/");
  assert.strictEqual(a1.length, 1);
  assert.strictEqual(a1[0].kind, "tab");
});

test("the palette theme defaults to system and is passed through", async () => {
  globalThis.browser = fixture();
  assert.strictEqual((await buildPaletteState()).theme, "system");

  globalThis.browser = makeBrowser({ local: { paletteTheme: "light" } });
  assert.strictEqual((await buildPaletteState()).theme, "light");
});

test("a junk stored theme falls back to system rather than reaching the DOM", async () => {
  globalThis.browser = makeBrowser({ local: { paletteTheme: "'; drop--" } });
  assert.strictEqual((await buildPaletteState()).theme, "system");
});

test("every workspace is offered as its own item", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  const ws = state.items.filter((i) => i.kind === "workspace");
  assert.deepStrictEqual(ws.map((i) => i.title), ["Work", "Play", "Cold"]);
  assert.strictEqual(ws.find((i) => i.workspaceId === "C").url, "https://c2/");
});
