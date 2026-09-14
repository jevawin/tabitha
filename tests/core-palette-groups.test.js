// Tail grouping (palette-round3 brief #3): once the query is non-empty, the
// remainder of the row list splits into two labelled, non-selectable-header
// groups — WORKSPACE (the two create rows, unchanged behaviour) and WEB (two
// web-search rows, new). Dedicated coverage beyond what
// core-palette-rows.test.js already pins incidentally while testing create
// rows and defaultSel.
const { test } = require("node:test");
const assert = require("node:assert");
const { buildPaletteRows } = require("../shared/core.js");

const workspaces = () => [{ id: "A", name: "Work" }];
const items = () => [
  { kind: "tab", tabId: 1, title: "Work dashboard", url: "https://work/", workspaceId: "A", hidden: false },
];

// ---------- presence ----------

test("WEB group (label + 2 search rows) appears for any non-empty query, even one matching a workspace by name", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "work");
  const webLabel = rows.find((r) => r.kind === "label" && r.text === "WEB");
  assert.ok(webLabel, "WEB label must be present");
  const searchRows = rows.filter((r) => r.kind === "search");
  assert.strictEqual(searchRows.length, 2);
  assert.strictEqual(searchRows[0].where.kind, "currentTab");
  assert.strictEqual(searchRows[1].where.kind, "newTab");
});

test("WORKSPACE group is absent (no label, no create rows) only when the query is an exact workspace-name match", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "  work  ");
  assert.strictEqual(rows.some((r) => r.kind === "label" && r.text === "WORKSPACE"), false);
  assert.strictEqual(rows.some((r) => r.kind === "create" || r.kind === "createEmpty"), false);
});

test("WORKSPACE group (label + 2 create rows) appears when the query matches no workspace exactly", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "brand new");
  const wsLabel = rows.find((r) => r.kind === "label" && r.text === "WORKSPACE");
  assert.ok(wsLabel);
  assert.strictEqual(rows.filter((r) => r.kind === "create" || r.kind === "createEmpty").length, 2);
});

test("no groups at all on an empty query", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "");
  assert.strictEqual(rows.some((r) => r.kind === "label" || r.kind === "search"), false);
});

// ---------- label rows ----------

test("label rows are never selectable and carry no num", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "brand new");
  const labels = rows.filter((r) => r.kind === "label");
  assert.strictEqual(labels.length, 2); // WORKSPACE + WEB
  for (const label of labels) {
    assert.strictEqual(label.selectable, false);
    assert.strictEqual(label.num, null);
  }
});

test("group labels appear in order: WORKSPACE before WEB", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "brand new");
  const labelTexts = rows.filter((r) => r.kind === "label").map((r) => r.text);
  assert.deepStrictEqual(labelTexts, ["WORKSPACE", "WEB"]);
});

// ---------- search rows ----------

test("search rows are selectable, carry the trimmed query as `name`, and no num", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "  brand new  ");
  const searchRows = rows.filter((r) => r.kind === "search");
  for (const row of searchRows) {
    assert.strictEqual(row.selectable, true);
    assert.strictEqual(row.name, "brand new");
    assert.strictEqual(row.num, null);
  }
});

test("search rows carry the shortcut hint that replaces their (absent) num badge", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "x");
  const [currentTab, newTab] = rows.filter((r) => r.kind === "search");
  assert.strictEqual(currentTab.hint, "⏎");
  assert.strictEqual(newTab.hint, "⌘⏎");
});

// ---------- numbering: search rows must not shift or consume numbers ----------

test("numbering of headers/tabs/create rows is unaffected by the presence of search rows", () => {
  // "work" name-matches the one workspace, so its header + tab both show,
  // followed by the (absent, exact match) WORKSPACE group and the WEB group.
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "work");
  const header = rows.find((r) => r.kind === "header");
  const tab = rows.find((r) => r.kind === "tab");
  assert.strictEqual(header.num, 1);
  assert.strictEqual(tab.num, 2);
  // Both search rows sit after the tab but consume no number of their own.
  const searchNums = rows.filter((r) => r.kind === "search").map((r) => r.num);
  assert.deepStrictEqual(searchNums, [null, null]);
});

test("a create row appended after several numbered rows still gets the next number, unaffected by the trailing search rows", () => {
  const manyWs = Array.from({ length: 3 }, (_, n) => ({ id: `w${n}`, name: `zebra ${n}` }));
  const { rows } = buildPaletteRows([], manyWs, null, "zebra"); // name-matches all 3, none exactly
  // 3 headers (num 1-3), then label(null), create(4), createEmpty(5), label(null), search(null), search(null).
  assert.deepStrictEqual(rows.map((r) => r.num), [1, 2, 3, null, 4, 5, null, null, null]);
});

// ---------- defaultSel ----------

test("defaultSel lands on the current-tab search row only when nothing else (no workspace, no tab/saved item) matched", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "A", "totally-unmatched-xyz");
  assert.strictEqual(rows[defaultSel].kind, "search");
  assert.strictEqual(rows[defaultSel].where.kind, "currentTab");
});

test("defaultSel does NOT move to the search row when a workspace or tab matched", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "A", "work");
  assert.notStrictEqual(rows[defaultSel].kind, "search");
});

test("defaultSel is unaffected by search rows on an empty query", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "A", "");
  assert.strictEqual(rows[defaultSel].kind, "header");
});

test("create rows are never defaultSel even when they are the only other selectable rows besides the search rows", () => {
  const { rows, defaultSel } = buildPaletteRows([], [], null, "totally-unmatched-xyz");
  assert.notStrictEqual(rows[defaultSel].kind, "create");
  assert.notStrictEqual(rows[defaultSel].kind, "createEmpty");
  assert.strictEqual(rows[defaultSel].kind, "search");
});
