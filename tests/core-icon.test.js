// Shared core helpers. Pure — no browser API, so no stubs needed.
const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeIcon } = require("../shared/core.js");

test("normalizeIcon returns a clean {name, paths} for valid input", () => {
  const out = normalizeIcon({ name: "rocket", paths: "<path d=\"M1 1\"/>", extra: "ignored" });
  assert.deepStrictEqual(out, { name: "rocket", paths: "<path d=\"M1 1\"/>" });
});

test("normalizeIcon rejects missing or non-string fields", () => {
  assert.strictEqual(normalizeIcon({ name: "rocket" }), null);
  assert.strictEqual(normalizeIcon({ paths: "<path/>" }), null);
  assert.strictEqual(normalizeIcon({ name: 1, paths: "<path/>" }), null);
  assert.strictEqual(normalizeIcon({ name: "x", paths: 2 }), null);
});

test("normalizeIcon rejects blank fields", () => {
  assert.strictEqual(normalizeIcon({ name: "   ", paths: "<path/>" }), null);
  assert.strictEqual(normalizeIcon({ name: "x", paths: "   " }), null);
});

test("normalizeIcon rejects oversized paths", () => {
  assert.strictEqual(normalizeIcon({ name: "x", paths: "<path/>".repeat(1000) }), null); // ~7000 chars, well above 4096 cap
});

test("normalizeIcon accepts paths at exactly the 4096 limit", () => {
  assert.ok(normalizeIcon({ name: "x", paths: "a".repeat(4096) }));
});
test("normalizeIcon rejects paths one char over the 4096 limit", () => {
  assert.strictEqual(normalizeIcon({ name: "x", paths: "a".repeat(4097) }), null);
});

test("normalizeIcon returns null for null/undefined/non-object", () => {
  assert.strictEqual(normalizeIcon(null), null);
  assert.strictEqual(normalizeIcon(undefined), null);
  assert.strictEqual(normalizeIcon("rocket"), null);
});
