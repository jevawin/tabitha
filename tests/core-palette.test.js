// Palette ranking — pure, so it is tested once and never per-target.
const { test } = require("node:test");
const assert = require("node:assert");
const { rankPaletteItems, MAX_PALETTE_RESULTS } = require("../shared/core.js");

const items = [
  { kind: "tab", title: "GitHub — jevawin/tabitha", url: "https://github.com/jevawin/tabitha" },
  { kind: "tab", title: "Mozilla Developer Network", url: "https://developer.mozilla.org/" },
  { kind: "saved", title: "Tabitha docs", url: "https://example.com/tabitha-docs" },
  { kind: "workspace", title: "Work", url: "" },
];

test("an empty query returns everything, in the order given", () => {
  const out = rankPaletteItems(items, "");
  assert.deepStrictEqual(out.map((i) => i.title), items.map((i) => i.title));
});

test("a title prefix outranks a mid-title match", () => {
  const out = rankPaletteItems(items, "tabitha");
  assert.strictEqual(out[0].title, "Tabitha docs");
});

test("a URL-only match is still returned, ranked below title matches", () => {
  const out = rankPaletteItems(items, "developer");
  // Both the MDN title and the MDN url match; the saved doc matches neither.
  assert.ok(out.some((i) => i.title === "Mozilla Developer Network"));
  assert.ok(!out.some((i) => i.title === "Tabitha docs"));
});

test("non-matches are dropped", () => {
  assert.deepStrictEqual(rankPaletteItems(items, "zzzzz"), []);
});

test("matching is case-insensitive and trims the query", () => {
  const out = rankPaletteItems(items, "  GITHUB  ");
  assert.strictEqual(out[0].title, "GitHub — jevawin/tabitha");
});

test("ties keep their original relative order", () => {
  const tied = [
    { title: "alpha one", url: "https://a/" },
    { title: "alpha two", url: "https://b/" },
  ];
  assert.deepStrictEqual(
    rankPaletteItems(tied, "alpha").map((i) => i.title),
    ["alpha one", "alpha two"]
  );
});

test("results are capped", () => {
  const many = Array.from({ length: 200 }, (_, n) => ({ title: `match ${n}`, url: "https://x/" }));
  assert.strictEqual(rankPaletteItems(many, "match").length, MAX_PALETTE_RESULTS);
});

test("missing title or url does not throw", () => {
  assert.doesNotThrow(() => rankPaletteItems([{ kind: "tab" }], "x"));
  assert.deepStrictEqual(rankPaletteItems(null, "x"), []);
});
