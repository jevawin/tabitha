const { test } = require("node:test");
const assert = require("node:assert");
const data = require("../shared/icon-data.json");

const EXCLUDED = ["square-pen", "trash-2", "save", "folder-plus", "list-end", "check", "folder", "ellipsis"];

test("icon-data.json is a large array", () => {
  assert.ok(Array.isArray(data));
  assert.ok(data.length > 1000, `expected many icons, got ${data.length}`);
});

test("every entry has name/category/tags/paths of the right shape", () => {
  for (const e of data) {
    assert.strictEqual(typeof e.name, "string");
    assert.strictEqual(typeof e.category, "string");
    assert.ok(Array.isArray(e.tags));
    assert.strictEqual(typeof e.paths, "string");
    assert.ok(e.paths.includes("<"), `paths should be SVG markup for ${e.name}`);
    assert.ok(!e.paths.includes("<svg"), `${e.name} paths must be inner markup only`);
  }
});

test("excluded icons are absent from the pickable set", () => {
  const names = new Set(data.map((e) => e.name));
  for (const n of EXCLUDED) assert.ok(!names.has(n), `${n} must be excluded`);
});

test("categories are varied (sourcing actually worked)", () => {
  const cats = new Set(data.map((e) => e.category));
  assert.ok(cats.size >= 5, `expected >=5 distinct categories, got ${cats.size}`);
  const other = data.filter((e) => e.category === "Other").length;
  const otherShare = other / data.length;
  assert.ok(
    otherShare < 0.2,
    `too many uncategorised: ${other}/${data.length} (${(otherShare * 100).toFixed(1)}%) are "Other"`
  );
});
