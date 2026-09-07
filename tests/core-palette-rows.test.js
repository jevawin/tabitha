// buildPaletteRows turns the palette's flat `items` + `workspaces` into the
// grouped row list the overlay renders: a header row per workspace followed
// by its tabs. Pure, so it is tested here rather than only by eyeballing the
// overlay (there is no browser-test harness for shared/palette.js).
//
// nextSelectableIndex is the arrow-key stepping logic factored out so it can
// be tested without a DOM: skip non-selectable rows, clamp at the ends,
// never get stuck or loop forever.
const { test } = require("node:test");
const assert = require("node:assert");
const { buildPaletteRows, nextSelectableIndex, MAX_PALETTE_RESULTS } = require("../shared/core.js");

const workspaces = () => [
  { id: "A", name: "Work" },
  { id: "B", name: "Funky" },
  { id: "C", name: "Cold" },
];

// B ("Funky") holds one item that does NOT textually match "funky" at all —
// neither its title nor its url — this is the item that proves a name match
// pulls in ALL of a workspace's items unfiltered, not just the ones that also
// happen to match. (Regression: this url used to be "https://funky/2", which
// itself scored on rankPaletteItems' url tier — a test that filtered this
// section through rankPaletteItems by mistake still passed, because the item
// survived the filter on its own. Verified by mutation; see the fix report.)
const items = () => [
  { kind: "tab", tabId: 1, title: "Work dashboard", url: "https://work/", workspaceId: "A", hidden: false },
  { kind: "tab", tabId: 2, title: "Funky beats", url: "https://funky/1", workspaceId: "B", hidden: false },
  { kind: "saved", tabId: null, title: "Old bookmark", url: "https://example.com/2", workspaceId: "B", hidden: true },
  { kind: "tab", tabId: 3, title: "Cold storage", url: "https://cold/", workspaceId: "C", hidden: false },
  { kind: "tab", tabId: 4, title: "Random funky title", url: "https://cold/funky", workspaceId: "C", hidden: false },
];

test("empty query: the active workspace's header comes first, defaultSel is row 0", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "C", "");
  assert.strictEqual(rows[0].kind, "header");
  assert.strictEqual(rows[0].workspaceId, "C");
  assert.strictEqual(defaultSel, 0);
  // stored order after the active one: A, then B
  const headerOrder = rows.filter((r) => r.kind === "header").map((r) => r.workspaceId);
  assert.deepStrictEqual(headerOrder, ["C", "A", "B"]);
});

test("empty query: each header is followed by all of that workspace's items", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "");
  const bIndex = rows.findIndex((r) => r.kind === "header" && r.workspaceId === "B");
  assert.strictEqual(rows[bIndex + 1].item.title, "Funky beats");
  assert.strictEqual(rows[bIndex + 2].item.title, "Old bookmark");
  assert.strictEqual(rows[bIndex + 1].depth, 1);
  assert.strictEqual(rows[bIndex].depth, 0);
});

test("a workspace-name match brings ALL of that workspace's items, unfiltered, header selected", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "A", "funky");
  assert.strictEqual(rows[0].kind, "header");
  assert.strictEqual(rows[0].workspaceId, "B");
  assert.strictEqual(defaultSel, 0);
  // Both of B's items present, including the one that does not textually
  // match "funky" at all.
  const bTitles = rows
    .filter((r) => r.kind === "tab" && r.workspaceId === "B")
    .map((r) => r.item.title);
  assert.deepStrictEqual(bTitles.sort(), ["Funky beats", "Old bookmark"].sort());
});

test("a tab-only match selects the first matching tab, not a header", () => {
  // "cold storage" matches no workspace name, only C's "Cold storage" tab.
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "A", "cold storage");
  assert.strictEqual(rows[defaultSel].kind, "tab");
  assert.strictEqual(rows[defaultSel].item.title, "Cold storage");
});

test("when both a name and other workspaces' items match, the named workspace leads with its header selected, other matches still appear below", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "A", "funky");
  assert.strictEqual(rows[defaultSel].kind, "header");
  assert.strictEqual(rows[defaultSel].workspaceId, "B");
  // C's "Random funky title" matches by content only (no name match) and
  // must still show up, after B's section.
  const cHeaderIdx = rows.findIndex((r) => r.kind === "header" && r.workspaceId === "C");
  assert.ok(cHeaderIdx > 0, "C's section should be present");
  const cTitles = rows
    .filter((r) => r.kind === "tab" && r.workspaceId === "C")
    .map((r) => r.item.title);
  assert.deepStrictEqual(cTitles, ["Random funky title"]); // only the matching one, not "Cold storage"
});

test("workspaces matching neither the name nor any item are omitted entirely", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "funky");
  assert.strictEqual(rows.some((r) => r.workspaceId === "A"), false);
});

test("a query matching nothing anywhere returns no rows and defaultSel -1", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "A", "zzz-nomatch-zzz");
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(defaultSel, -1);
});

test("unowned tabs land in a non-selectable Unfiled section, last, item: null", () => {
  const withOrphan = [...items(), { kind: "tab", tabId: 9, title: "Orphan tab", url: "https://x/", workspaceId: null, hidden: false }];
  const { rows } = buildPaletteRows(withOrphan, workspaces(), "A", "");
  const last = rows[rows.length - 1];
  assert.strictEqual(last.kind, "tab");
  assert.strictEqual(last.item.title, "Orphan tab");
  const unfiledHeaderIdx = rows.findIndex((r) => r.kind === "header" && r.workspaceId === null);
  assert.strictEqual(unfiledHeaderIdx, rows.length - 2);
  assert.strictEqual(rows[unfiledHeaderIdx].selectable, false);
  assert.strictEqual(rows[unfiledHeaderIdx].item, null);
});

test("the Unfiled section is absent when there are no unowned tabs", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "A", "");
  assert.strictEqual(rows.some((r) => r.workspaceId === null), false);
});

test("defaultSel never points at a non-selectable row, even when only unfiled tabs match", () => {
  const withOrphan = [...items(), { kind: "tab", tabId: 9, title: "Orphan tab", url: "https://x/", workspaceId: null, hidden: false }];
  const { rows, defaultSel } = buildPaletteRows(withOrphan, workspaces(), "A", "orphan");
  assert.notStrictEqual(defaultSel, -1);
  assert.strictEqual(rows[defaultSel].selectable, true);
  assert.strictEqual(rows[defaultSel].item.title, "Orphan tab");
});

test("the total row cap holds even when one workspace has many items", () => {
  const bigWs = [{ id: "Z", name: "Huge" }];
  const bigItems = Array.from({ length: MAX_PALETTE_RESULTS + 10 }, (_, n) => ({
    kind: "tab",
    tabId: n,
    title: `tab ${n}`,
    url: "https://x/",
    workspaceId: "Z",
    hidden: false,
  }));
  const { rows, defaultSel } = buildPaletteRows(bigItems, bigWs, "Z", "");
  assert.ok(rows.length <= MAX_PALETTE_RESULTS);
  assert.strictEqual(defaultSel, 0);
  assert.strictEqual(rows[0].kind, "header");
});

// ---------- row-cap budget: sections, not a flat row slice ----------
// Finding 2: a flat rows.slice(0, MAX_PALETTE_RESULTS) could truncate mid
// section and drop a later, small section's header entirely — a whole
// workspace vanishing from a palette whose job is to show workspace
// structure. These tests pin the section-aware replacement.

test("a big section does not evict a small one: both headers survive and the small section keeps its one tab", () => {
  const bigSmallWs = [
    { id: "BIG", name: "Sixty" },
    { id: "SMALL", name: "One" },
  ];
  const bigTabs = Array.from({ length: 60 }, (_, n) => ({
    kind: "tab", tabId: n, title: `tab ${n}`, url: "https://x/", workspaceId: "BIG", hidden: false,
  }));
  const smallTabs = [{ kind: "tab", tabId: 999, title: "the one tab", url: "https://y/", workspaceId: "SMALL", hidden: false }];
  const { rows } = buildPaletteRows([...bigTabs, ...smallTabs], bigSmallWs, "BIG", "");

  assert.ok(rows.length <= MAX_PALETTE_RESULTS);
  const bigHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "BIG");
  const smallHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "SMALL");
  assert.ok(bigHeader, "BIG's header must survive the cap");
  assert.ok(smallHeader, "SMALL's header must survive the cap — this is the bug the fix closes");
  const smallTabRows = rows.filter((r) => r.kind === "tab" && r.workspaceId === "SMALL");
  assert.deepStrictEqual(smallTabRows.map((r) => r.item.title), ["the one tab"]);
});

test("every qualifying section keeps its header even when tabs must be trimmed to fit", () => {
  const manyWs = Array.from({ length: 5 }, (_, n) => ({ id: `w${n}`, name: `Workspace ${n}` }));
  // Each workspace has more items than an even 1/5 share of the cap, so the
  // round-robin must trim every section's tabs, never drop a whole section.
  const manyItems = manyWs.flatMap((ws) =>
    Array.from({ length: 20 }, (_, n) => ({
      kind: "tab", tabId: `${ws.id}-${n}`, title: `${ws.name} tab ${n}`, url: "https://x/", workspaceId: ws.id, hidden: false,
    }))
  );
  const { rows } = buildPaletteRows(manyItems, manyWs, "w0", "");
  assert.ok(rows.length <= MAX_PALETTE_RESULTS);
  const headerIds = rows.filter((r) => r.kind === "header").map((r) => r.workspaceId);
  assert.deepStrictEqual(headerIds.sort(), manyWs.map((w) => w.id).sort());
});

test("when header count alone would exceed the cap, whole sections are dropped by rank rather than emitting headerless tabs", () => {
  const tooManyWs = Array.from({ length: MAX_PALETTE_RESULTS + 10 }, (_, n) => ({ id: `w${n}`, name: `Workspace ${n}` }));
  const oneItemEach = tooManyWs.map((ws) => ({
    kind: "tab", tabId: ws.id, title: `${ws.name} tab`, url: "https://x/", workspaceId: ws.id, hidden: false,
  }));
  const { rows } = buildPaletteRows(oneItemEach, tooManyWs, null, "");
  assert.strictEqual(rows.length, MAX_PALETTE_RESULTS);
  // No tab row exists without its header sitting above it in the output —
  // every row here is a header, budget for tabs is zero.
  assert.ok(rows.every((r) => r.kind === "header"));
  // The kept sections are the leading ones, by existing rank order (stored
  // order here, since the query is empty), not an arbitrary subset.
  assert.deepStrictEqual(rows.map((r) => r.workspaceId), tooManyWs.slice(0, MAX_PALETTE_RESULTS).map((w) => w.id));
});

test("round-robin distribution changes only which items survive, never section or item order", () => {
  const threeWs = [
    { id: "X", name: "X" },
    { id: "Y", name: "Y" },
    { id: "Z", name: "Z" },
  ];
  // Sized so the round-robin must trim: 3 headers + up to MAX-3 tabs shared
  // across three sections that between them hold far more than that.
  const bigSection = (id) =>
    Array.from({ length: 30 }, (_, n) => ({
      kind: "tab", tabId: `${id}-${n}`, title: `${id} tab ${n}`, url: "https://x/", workspaceId: id, hidden: false,
    }));
  const allItems = [...bigSection("X"), ...bigSection("Y"), ...bigSection("Z")];
  const { rows } = buildPaletteRows(allItems, threeWs, "X", "");

  assert.deepStrictEqual(rows.filter((r) => r.kind === "header").map((r) => r.workspaceId), ["X", "Y", "Z"]);
  // Within each section, surviving tabs are a prefix of that section's
  // original order (tab 0, tab 1, ... — never a gap or a reorder).
  for (const id of ["X", "Y", "Z"]) {
    const kept = rows.filter((r) => r.kind === "tab" && r.workspaceId === id).map((r) => r.item.title);
    const original = allItems.filter((it) => it.workspaceId === id).map((it) => it.title);
    assert.deepStrictEqual(kept, original.slice(0, kept.length));
  }
});

test("empty items/workspaces produce no rows and defaultSel -1", () => {
  assert.deepStrictEqual(buildPaletteRows([], [], null, ""), { rows: [], defaultSel: -1 });
  assert.deepStrictEqual(buildPaletteRows([], [], null, "x"), { rows: [], defaultSel: -1 });
});

test("kind:'workspace' entries in items are not treated as extra tab rows", () => {
  const withWsEntry = [...items(), { kind: "workspace", workspaceId: "A", title: "Work", url: "" }];
  const { rows } = buildPaletteRows(withWsEntry, workspaces(), "A", "");
  // Exactly one header per workspace, never a duplicate from the items entry.
  const aHeaders = rows.filter((r) => r.kind === "header" && r.workspaceId === "A");
  assert.strictEqual(aHeaders.length, 1);
});

// ---------- nextSelectableIndex ----------

const rowsFrom = (flags) => flags.map((selectable) => ({ selectable }));

test("nextSelectableIndex skips non-selectable rows moving down", () => {
  const rows = rowsFrom([true, false, false, true]);
  assert.strictEqual(nextSelectableIndex(rows, 0, 1), 3);
});

test("nextSelectableIndex skips non-selectable rows moving up", () => {
  const rows = rowsFrom([true, false, false, true]);
  assert.strictEqual(nextSelectableIndex(rows, 3, -1), 0);
});

test("nextSelectableIndex clamps at the bottom rather than getting stuck or wrapping", () => {
  const rows = rowsFrom([true, false, true]);
  assert.strictEqual(nextSelectableIndex(rows, 2, 1), 2);
});

test("nextSelectableIndex clamps at the top rather than getting stuck or wrapping", () => {
  const rows = rowsFrom([true, false, true]);
  assert.strictEqual(nextSelectableIndex(rows, 0, -1), 0);
});

test("nextSelectableIndex returns -1, not an infinite loop, when nothing is selectable", () => {
  const rows = rowsFrom([false, false, false]);
  assert.strictEqual(nextSelectableIndex(rows, 0, 1), -1);
  assert.strictEqual(nextSelectableIndex(rows, 0, -1), -1);
  assert.strictEqual(nextSelectableIndex(rows, -1, 1), -1);
});

test("nextSelectableIndex recovers from a stale/invalid starting index", () => {
  const rows = rowsFrom([false, true, false]);
  assert.strictEqual(nextSelectableIndex(rows, -1, 1), 1);
});

test("nextSelectableIndex on an empty list returns -1", () => {
  assert.strictEqual(nextSelectableIndex([], 0, 1), -1);
});
