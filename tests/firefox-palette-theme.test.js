// The stored theme becomes a data-theme attribute in a page's DOM, so it is
// validated on the way in as well as on the way out.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  // Every other firefox-*.test.js stubs this too: background.js registers
  // browser.commands.onCommand.addListener at module load, so omitting it
  // throws before any test body runs (module load failure, not the expected
  // "setPaletteTheme is not a function").
  commands: { onCommand: noopListener },
  runtime: { onMessage: noopListener, onInstalled: noopListener, onStartup: noopListener },
};

const { setPaletteTheme, getPaletteTheme } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

test("a valid theme is stored", async () => {
  globalThis.browser = makeBrowser();
  await setPaletteTheme("dark");
  assert.strictEqual(globalThis.browser._peek.local().paletteTheme, "dark");
  assert.strictEqual(await getPaletteTheme(), "dark");
});

test("system is storable, and is the default when nothing is stored", async () => {
  globalThis.browser = makeBrowser();
  assert.strictEqual(await getPaletteTheme(), "system");
  await setPaletteTheme("system");
  assert.strictEqual(await getPaletteTheme(), "system");
});

test("an invalid theme is rejected and nothing is written", async () => {
  globalThis.browser = makeBrowser({ local: { paletteTheme: "dark" } });
  await assert.rejects(() => setPaletteTheme("hot-pink"));
  assert.strictEqual(globalThis.browser._peek.local().paletteTheme, "dark");
});

test("setting the theme does not disturb workspaces", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [{ id: "A", name: "Work", tabs: [] }], activeWorkspaceId: "A" },
  });
  await setPaletteTheme("light");
  const local = globalThis.browser._peek.local();
  assert.strictEqual(local.workspaces.length, 1);
  assert.strictEqual(local.activeWorkspaceId, "A");
});
