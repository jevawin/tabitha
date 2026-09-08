// Shared core helpers. Pure — no browser API, so no stubs needed.
const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeIcon, normalizeIconNodes, ICON_NODE_TAGS, ICON_NODE_ATTRS } = require("../shared/core.js");

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

// A realistic multi-element Lucide entry: [[tag, {attr: value}], ...], the
// exact shape icon-nodes.json uses. Values here are illustrative, not
// literally lucide's rocket icon.
const REAL_NODES = [
  ["path", { d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" }],
  ["path", { d: "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" }],
  ["circle", { cx: "12", cy: "12", r: "3" }],
];

test("normalizeIconNodes accepts a real Lucide-shaped entry unchanged", () => {
  assert.deepStrictEqual(normalizeIconNodes(REAL_NODES), REAL_NODES);
});

test("normalizeIconNodes rejects a non-array", () => {
  assert.strictEqual(normalizeIconNodes(null), null);
  assert.strictEqual(normalizeIconNodes(undefined), null);
  assert.strictEqual(normalizeIconNodes("not an array"), null);
  assert.strictEqual(normalizeIconNodes({ 0: ["path", {}] }), null);
});

test("normalizeIconNodes drops a node with a disallowed tag", () => {
  const nodes = [["path", { d: "M1 1" }], ["script", { d: "M1 1" }], ["foreignObject", {}], ["image", {}]];
  assert.deepStrictEqual(normalizeIconNodes(nodes), [["path", { d: "M1 1" }]]);
});

test("normalizeIconNodes drops disallowed attributes but keeps allowed ones on the same node", () => {
  const nodes = [["circle", { cx: "1", cy: "2", r: "3", onload: "alert(1)", href: "javascript:alert(1)", style: "color:red" }]];
  assert.deepStrictEqual(normalizeIconNodes(nodes), [["circle", { cx: "1", cy: "2", r: "3" }]]);
});

test("normalizeIconNodes drops a non-two-element entry", () => {
  const nodes = [["path", { d: "M1 1" }], ["path"], ["path", {}, "extra"], "not-a-pair", 42];
  assert.deepStrictEqual(normalizeIconNodes(nodes), [["path", { d: "M1 1" }]]);
});

test("normalizeIconNodes rejects a non-string attribute value without coercing it", () => {
  const nodes = [["circle", { cx: "1", cy: 2, r: null, fill: ["x"], d: { toString: () => "M1 1" } }]];
  assert.deepStrictEqual(normalizeIconNodes(nodes), [["circle", { cx: "1" }]]);
});

test("normalizeIconNodes caps the node count at 32", () => {
  const nodes = Array.from({ length: 40 }, () => ["circle", { cx: "1", cy: "1", r: "1" }]);
  const out = normalizeIconNodes(nodes);
  assert.strictEqual(out.length, 32);
});

test("normalizeIconNodes caps each attribute value's length", () => {
  const nodes = [["path", { d: "a".repeat(1024) }], ["path", { d: "a".repeat(1025) }]];
  assert.deepStrictEqual(normalizeIconNodes(nodes), [["path", { d: "a".repeat(1024) }], ["path", {}]]);
});

test("ICON_NODE_TAGS and ICON_NODE_ATTRS match the measured Lucide surface", () => {
  assert.deepStrictEqual(
    [...ICON_NODE_TAGS].sort(),
    ["circle", "ellipse", "line", "path", "polygon", "polyline", "rect"]
  );
  assert.deepStrictEqual(
    [...ICON_NODE_ATTRS].sort(),
    ["cx", "cy", "d", "fill", "height", "points", "r", "rx", "ry", "width", "x", "x1", "x2", "y", "y1", "y2"]
  );
});

// ---------- normalizeIcon + nodes ----------

test("normalizeIcon keeps valid nodes alongside name/paths", () => {
  const out = normalizeIcon({ name: "rocket", paths: "<path d=\"M1 1\"/>", nodes: REAL_NODES });
  assert.deepStrictEqual(out, { name: "rocket", paths: "<path d=\"M1 1\"/>", nodes: REAL_NODES });
});

test("normalizeIcon drops only `nodes` when nodes are junk, keeping name/paths", () => {
  const out = normalizeIcon({ name: "rocket", paths: "<path d=\"M1 1\"/>", nodes: "not-an-array" });
  assert.deepStrictEqual(out, { name: "rocket", paths: "<path d=\"M1 1\"/>" });
  assert.ok(!("nodes" in out));
});

test("normalizeIcon is unchanged for an icon with no nodes field at all", () => {
  const out = normalizeIcon({ name: "rocket", paths: "<path d=\"M1 1\"/>" });
  assert.deepStrictEqual(out, { name: "rocket", paths: "<path d=\"M1 1\"/>" });
});
