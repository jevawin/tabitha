// Loading the real files the way a BROWSER loads them: core.js and background.js
// sharing one global scope.
//
// The other suites require() core.js, which gives each file its own module scope
// and so cannot catch a collision between them. That gap let a load-time
// SyntaxError ship: core.js declares `function isTrackableUrl`, a var-like global
// binding, while background.js declared `const { isTrackableUrl } = ...`, a
// lexical one. A lexical binding cannot coexist with a same-named global function
// binding, so the extension failed to start in both browsers, whichever order the
// files loaded in.
//
// Keep this suite behavioural: run the actual files, assert they load.

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

// Just enough surface for the top-level listener registrations and dlog().
function makeContext() {
  const evt = () => ({ addListener() {} });
  const api = {
    tabs: {
      onCreated: evt(),
      onRemoved: evt(),
      onMoved: evt(),
      onUpdated: evt(),
    },
    runtime: { onMessage: evt() },
    management: { getSelf: () => Promise.resolve({ installType: "normal" }) },
    storage: { local: {}, session: {} },
    windows: { getLastFocused: () => Promise.resolve({ id: 1 }) },
  };
  // No `require` in the context on purpose: that is what forces background.js
  // down its browser branch (globalThis.TabithaCore) rather than the Node one.
  return vm.createContext({
    chrome: api,
    browser: api,
    console: { log() {}, error() {} },
    setTimeout() {},
    clearTimeout() {},
  });
}

test("Firefox loads core.js then background.js in one global scope", () => {
  const ctx = makeContext();
  // Mirrors manifest background.scripts: ["core.js", "background.js"].
  assert.doesNotThrow(() => {
    vm.runInContext(read("shared", "core.js"), ctx, { filename: "core.js" });
    vm.runInContext(read("firefox", "background.js"), ctx, {
      filename: "background.js",
    });
  });
});

test("Chrome loads background.js which importScripts core.js", () => {
  const ctx = makeContext();
  const coreSrc = read("shared", "core.js");
  // The real service worker runs the imported file in the same global scope.
  ctx.importScripts = () =>
    vm.runInContext(coreSrc, ctx, { filename: "core.js" });
  assert.doesNotThrow(() => {
    vm.runInContext(read("chrome", "background.js"), ctx, {
      filename: "background.js",
    });
  });
});

test("core.js publishes its helpers without leaking global bindings", () => {
  const ctx = makeContext();
  vm.runInContext(read("shared", "core.js"), ctx, { filename: "core.js" });

  // The namespace is the contract background.js destructures from. Array.from
  // rehomes it: the vm returns an array from its own realm, whose prototype
  // fails deepStrictEqual against ours no matter what it contains.
  const names = Array.from(
    vm.runInContext("Object.keys(globalThis.TabithaCore)", ctx),
  );
  assert.deepStrictEqual(
    names.sort(),
    [
      "MAX_ICON_PATHS",
      "MAX_IMPORT_TABS",
      "MAX_IMPORT_WORKSPACES",
      "buildMovedState",
      "cleanName",
      "isTrackableUrl",
      "normalizeIcon",
      "parseBackup",
    ].sort(),
  );

  // Nothing else may reach the global scope, or background.js cannot safely
  // declare these names itself.
  for (const n of names) {
    assert.strictEqual(
      vm.runInContext(`typeof ${n} !== "undefined"`, ctx),
      false,
      `core.js leaked a global binding for "${n}"`,
    );
  }
});
