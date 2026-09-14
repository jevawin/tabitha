// Loads the palette's injected scripts the way Firefox's executeScript does:
// core.js, then palette.css.js, then palette.js, into ONE shared global.
//
// Nothing else in the suite evaluates these two files — every other test
// require()s core.js or a background script. That gap let a real bug ship in
// signed builds 0.3.2 and 0.3.3: a CSS comment containing backticks closed
// palette.css.js's template literal early, the remainder ran as JavaScript and
// threw "Cannot read properties of undefined (reading 'title')", and the
// Cmd+Shift+, palette silently stopped opening. `node --check` passed, because
// the broken fragment is still valid syntax — it only fails when run.
const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// The minimum DOM the scripts touch at load time. Deliberately inert: this
// test proves the files evaluate without throwing, not that they render.
function fakeElement() {
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, appendChild() {}, append() {}, addEventListener() {},
    attachShadow() { return fakeElement(); }, querySelector() { return fakeElement(); },
    remove() {}, focus() {}, select() {}, replaceChild() {},
  };
}

function load(files) {
  const win = { addEventListener() {}, removeEventListener() {} };
  const sandbox = {
    console,
    window: win,
    document: { createElement: fakeElement, createElementNS: fakeElement, documentElement: fakeElement() },
    CSSStyleSheet: function () { this.replaceSync = () => {}; },
    browser: { runtime: { sendMessage: async () => ({ ok: false }) } },
  };
  sandbox.globalThis = sandbox;
  win.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(read(f), sandbox, { filename: f });
  return sandbox;
}

test("palette.css.js evaluates without throwing", () => {
  assert.doesNotThrow(() => load(["shared/core.js", "shared/palette.css.js"]));
});

test("palette.css.js defines the stylesheet as one non-empty string", () => {
  const g = load(["shared/core.js", "shared/palette.css.js"]);
  assert.strictEqual(typeof g.TABITHA_PALETTE_CSS, "string");
  // A template literal closed early leaves a truncated string behind even in
  // the cases where it doesn't throw — so check real rules survived to the end.
  assert.ok(g.TABITHA_PALETTE_CSS.includes(".current-dot"), "stylesheet was cut short");
  assert.ok(g.TABITHA_PALETTE_CSS.includes(".row .sub.with-marker"), "stylesheet was cut short");
});

test("palette.css.js contains exactly the two backticks that open and close its template literal", () => {
  // Any other backtick — including one inside a CSS comment — ends the
  // literal early. This is the precise failure that shipped.
  const count = (read("shared/palette.css.js").match(/`/g) || []).length;
  assert.strictEqual(count, 2, `found ${count} backticks; a stray one closes the template literal`);
});

test("palette.js evaluates after core.js and palette.css.js without throwing", () => {
  assert.doesNotThrow(() => load(["shared/core.js", "shared/palette.css.js", "shared/palette.js"]));
});
