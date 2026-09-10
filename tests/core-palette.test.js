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

// Pins the 80-vs-60 boundary. Previously only tier 80 or tier 60 was checked
// in isolation, so collapsing them into one tier kept the suite green.
test("a title word-boundary match outranks a mid-word title match", () => {
  const out = rankPaletteItems(
    [
      { title: "alphabetazone", url: "https://y/" }, // "beta" mid-word -> 60
      { title: "release beta notes", url: "https://x/" }, // " beta" word boundary -> 80
    ],
    "beta"
  );
  assert.deepStrictEqual(
    out.map((i) => i.title),
    ["release beta notes", "alphabetazone"]
  );
});

// Pins the 60-vs-30 boundary. Previously the only url-match test ("developer")
// also matched the title at a higher tier, so the url-only `return 30` branch
// never executed and could be deleted without failing anything.
test("a title substring match outranks a url-only match, and both are kept", () => {
  const out = rankPaletteItems(
    [
      { title: "Nothing relevant", url: "https://example.com/" }, // url only -> 30
      { title: "unexampled", url: "https://y/" }, // "example" mid-word title -> 60
    ],
    "example"
  );
  assert.deepStrictEqual(
    out.map((i) => i.title),
    ["unexampled", "Nothing relevant"]
  );
});

test("missing title or url does not throw", () => {
  assert.doesNotThrow(() => rankPaletteItems([{ kind: "tab" }], "x"));
  assert.deepStrictEqual(rankPaletteItems(null, "x"), []);
});
