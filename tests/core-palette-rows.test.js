// buildPaletteRows turns the palette's flat `items` + `workspaces` into the
// grouped row list the overlay renders: a header row per workspace followed
// by its tabs, now collapsible. Pure, so it is tested here rather than only
// by eyeballing the overlay (there is no browser-test harness for
// shared/palette.js).
//
// Collapse state lives in ONE Set (`expanded`), passed in by the caller
// (palette.js owns and mutates it across a palette session). A workspace id
// present in the set means "open, capped at PALETTE_COLLAPSED_TABS"; that id
// plus PALETTE_FULL_SUFFIX means "open, showing everything" — the brief
// explicitly asks for one concept, not two overlapping sets, so "expanded"
// and "fully expanded" are two states of the SAME key rather than membership
// in two different sets. The unfiled section's synthetic key is `null`
// (Set.has(null)/.add(null) both work fine), matching the `workspaceId: null`
// already used for its rows.
//
// nextSelectableIndex is the arrow-key stepping logic factored out so it can
// be tested without a DOM: skip non-selectable rows, clamp at the ends,
// never get stuck or loop forever.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  buildPaletteRows,
  nextSelectableIndex,
  paletteArrowTargetsTree,
  MAX_PALETTE_RESULTS,
  PALETTE_COLLAPSED_TABS,
  PALETTE_FULL_SUFFIX,
  PALETTE_COLLAPSED_SUFFIX,
} = require("../shared/core.js");

const fullKey = (id) => `${id}${PALETTE_FULL_SUFFIX}`;
const collapsedKey = (id) => `${id}${PALETTE_COLLAPSED_SUFFIX}`;

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

// ---------- collapse / expand ----------

test("empty query: the active workspace is expanded, its header comes first, defaultSel is row 0", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "C", "");
  assert.strictEqual(rows[0].kind, "header");
  assert.strictEqual(rows[0].workspaceId, "C");
  assert.strictEqual(rows[0].expanded, true);
  assert.strictEqual(defaultSel, 0);
  // stored order after the active one: A, then B
  const headerOrder = rows.filter((r) => r.kind === "header").map((r) => r.workspaceId);
  assert.deepStrictEqual(headerOrder, ["C", "A", "B"]);
  // C's own tab shows underneath — it is the expanded section.
  assert.deepStrictEqual(
    rows.filter((r) => r.kind === "tab" && r.workspaceId === "C").map((r) => r.item.title),
    ["Cold storage", "Random funky title"]
  );
});

test("empty query: a non-active workspace is collapsed — header only, no tab rows, but its header still carries the true count", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "C", "");
  const bHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "B");
  assert.strictEqual(bHeader.expanded, false);
  assert.strictEqual(bHeader.count, 2); // "Funky beats" + "Old bookmark", even though neither is rendered
  assert.strictEqual(rows.some((r) => r.kind === "tab" && r.workspaceId === "B"), false);
  assert.strictEqual(rows.some((r) => r.kind === "more" && r.workspaceId === "B"), false);
});

test("empty query: a workspace id present in `expanded` is shown open even though it is not active", () => {
  const expanded = new Set(["B"]);
  const { rows } = buildPaletteRows(items(), workspaces(), "C", "", expanded);
  const bHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "B");
  assert.strictEqual(bHeader.expanded, true);
  assert.deepStrictEqual(
    rows.filter((r) => r.kind === "tab" && r.workspaceId === "B").map((r) => r.item.title).sort(),
    ["Funky beats", "Old bookmark"].sort()
  );
});

// Finding 2: the active workspace used to be an unconditional "capped" —
// `isActive` short-circuited before the expanded Set was ever consulted, so
// there was no way to close it. PALETTE_COLLAPSED_SUFFIX is the explicit
// override collapseSection (palette.js) now sets; these tests pin the fix at
// the buildPaletteRows level, independent of the (untestable) renderer.
test("the active workspace collapses when its id carries the explicit PALETTE_COLLAPSED_SUFFIX marker", () => {
  const expanded = new Set([collapsedKey("C")]);
  const { rows } = buildPaletteRows(items(), workspaces(), "C", "", expanded);
  const cHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "C");
  assert.strictEqual(cHeader.expanded, false);
  assert.strictEqual(cHeader.count, 2); // true count still shown, same as any other collapsed header
  assert.strictEqual(rows.some((r) => r.kind === "tab" && r.workspaceId === "C"), false);
});

test("a collapsed active workspace's header stays selectable, and defaultSel still lands on it", () => {
  const expanded = new Set([collapsedKey("C")]);
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "C", "", expanded);
  const cHeaderIdx = rows.findIndex((r) => r.kind === "header" && r.workspaceId === "C");
  assert.strictEqual(rows[cHeaderIdx].selectable, true);
  assert.strictEqual(defaultSel, 0);
  assert.strictEqual(cHeaderIdx, 0); // active workspace still sorts first, collapsed or not
});

test("re-expanding the active workspace (plain id back in the set) clears the collapse override", () => {
  // Simulates palette.js's expandCapped, which deletes the collapsed marker
  // before adding the plain id — both keys present is the real sequence a
  // collapse-then-reopen produces, not a state buildPaletteRows should have
  // to special-case away.
  const expanded = new Set([collapsedKey("C"), "C"]);
  const { rows } = buildPaletteRows(items(), workspaces(), "C", "", expanded);
  const cHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "C");
  assert.strictEqual(cHeader.expanded, true);
});

test("without the marker, the active workspace still defaults open — the override is opt-in, not a new default", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "C", "");
  const cHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "C");
  assert.strictEqual(cHeader.expanded, true);
});

test("an expanded section past PALETTE_COLLAPSED_TABS items shows the cap plus a 'more' row carrying the remaining count", () => {
  const bigWs = [{ id: "Z", name: "Huge" }];
  const bigItems = Array.from({ length: PALETTE_COLLAPSED_TABS + 3 }, (_, n) => ({
    kind: "tab", tabId: n, title: `tab ${n}`, url: "https://x/", workspaceId: "Z", hidden: false,
  }));
  const { rows } = buildPaletteRows(bigItems, bigWs, "Z", "");
  const shownTabs = rows.filter((r) => r.kind === "tab" && r.workspaceId === "Z");
  const more = rows.find((r) => r.kind === "more" && r.workspaceId === "Z");
  assert.strictEqual(shownTabs.length, PALETTE_COLLAPSED_TABS);
  // The cap keeps a prefix of the section's own order, not an arbitrary subset.
  assert.deepStrictEqual(shownTabs.map((r) => r.item.title), bigItems.slice(0, PALETTE_COLLAPSED_TABS).map((i) => i.title));
  assert.ok(more, "a 'more' row must appear once the cap is exceeded");
  assert.strictEqual(more.count, 3);
  assert.strictEqual(more.selectable, true);
});

test("an expanded section at or under the cap gets no 'more' row", () => {
  const ws = [{ id: "Z", name: "Small" }];
  const smallItems = Array.from({ length: PALETTE_COLLAPSED_TABS }, (_, n) => ({
    kind: "tab", tabId: n, title: `tab ${n}`, url: "https://x/", workspaceId: "Z", hidden: false,
  }));
  const { rows } = buildPaletteRows(smallItems, ws, "Z", "");
  assert.strictEqual(rows.filter((r) => r.kind === "tab").length, PALETTE_COLLAPSED_TABS);
  assert.strictEqual(rows.some((r) => r.kind === "more"), false);
});

test("marking a workspace 'fully expanded' (id + PALETTE_FULL_SUFFIX) shows everything, no cap, no 'more' row", () => {
  const bigWs = [{ id: "Z", name: "Huge" }];
  const bigItems = Array.from({ length: PALETTE_COLLAPSED_TABS + 20 }, (_, n) => ({
    kind: "tab", tabId: n, title: `tab ${n}`, url: "https://x/", workspaceId: "Z", hidden: false,
  }));
  const expanded = new Set([fullKey("Z")]);
  const { rows } = buildPaletteRows(bigItems, bigWs, "Z", "", expanded);
  assert.strictEqual(rows.filter((r) => r.kind === "tab").length, PALETTE_COLLAPSED_TABS + 20);
  assert.strictEqual(rows.some((r) => r.kind === "more"), false);
});

test("with a query, the PALETTE_COLLAPSED_TABS cap does not apply even to a large matching section", () => {
  const ws = [{ id: "Z", name: "Zoo" }];
  const manyItems = Array.from({ length: PALETTE_COLLAPSED_TABS + 10 }, (_, n) => ({
    kind: "tab", tabId: n, title: `zebra ${n}`, url: "https://x/", workspaceId: "Z", hidden: false,
  }));
  const { rows } = buildPaletteRows(manyItems, ws, null, "zebra");
  assert.strictEqual(rows.filter((r) => r.kind === "tab").length, PALETTE_COLLAPSED_TABS + 10);
  assert.strictEqual(rows.some((r) => r.kind === "more"), false);
});

test("the unfiled section is collapsed by default, selectable, and carries its true count", () => {
  const withOrphans = [
    ...items(),
    { kind: "tab", tabId: 9, title: "Orphan one", url: "https://x/1", workspaceId: null, hidden: false },
    { kind: "tab", tabId: 10, title: "Orphan two", url: "https://x/2", workspaceId: null, hidden: false },
  ];
  const { rows } = buildPaletteRows(withOrphans, workspaces(), "A", "");
  const header = rows.find((r) => r.kind === "header" && r.workspaceId === null);
  assert.strictEqual(header.selectable, true);
  assert.strictEqual(header.item, null);
  assert.strictEqual(header.expanded, false);
  assert.strictEqual(header.count, 2);
  assert.strictEqual(rows.some((r) => r.kind === "tab" && r.workspaceId === null), false);
});

test("expanding the unfiled section (null in `expanded`) reveals its tabs", () => {
  const withOrphans = [...items(), { kind: "tab", tabId: 9, title: "Orphan tab", url: "https://x/", workspaceId: null, hidden: false }];
  const expanded = new Set([null]);
  const { rows } = buildPaletteRows(withOrphans, workspaces(), "A", "", expanded);
  const header = rows.find((r) => r.kind === "header" && r.workspaceId === null);
  assert.strictEqual(header.expanded, true);
  assert.deepStrictEqual(
    rows.filter((r) => r.kind === "tab" && r.workspaceId === null).map((r) => r.item.title),
    ["Orphan tab"]
  );
});

// ---------- numbering ----------

test("num runs 1-based over selectable rows in visible order, and is null past 9", () => {
  // 12 workspaces, all collapsed (none active/expanded): 12 header rows, only
  // the first 9 are numbered.
  const manyWs = Array.from({ length: 12 }, (_, n) => ({ id: `w${n}`, name: `Workspace ${n}` }));
  const { rows } = buildPaletteRows([], manyWs, null, "");
  assert.deepStrictEqual(rows.map((r) => r.num), [1, 2, 3, 4, 5, 6, 7, 8, 9, null, null, null]);
});

test("num counts headers, tabs and 'more' rows alike, in the order they appear", () => {
  const { rows } = buildPaletteRows(items(), workspaces(), "C", "");
  // C (active, expanded: header + 2 tabs) = num 1,2,3; then A collapsed = 4; then B collapsed = 5.
  assert.deepStrictEqual(rows.map((r) => r.num), [1, 2, 3, 4, 5]);
});

test("a non-selectable row (there are none today, but the contract holds) would get num null — pinned via the empty/no-rows case", () => {
  assert.deepStrictEqual(buildPaletteRows([], [], null, ""), { rows: [], defaultSel: -1 });
});

// ---------- existing behaviour that must not regress ----------

test("a workspace-name match brings ALL of that workspace's items, unfiltered, header selected, uncapped", () => {
  const { rows, defaultSel } = buildPaletteRows(items(), workspaces(), "A", "funky");
  assert.strictEqual(rows[0].kind, "header");
  assert.strictEqual(rows[0].workspaceId, "B");
  assert.strictEqual(rows[0].expanded, true);
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

test("unowned tabs land in a selectable Unfiled section, last, item: null, expanded when queried", () => {
  const withOrphan = [...items(), { kind: "tab", tabId: 9, title: "Orphan tab", url: "https://x/", workspaceId: null, hidden: false }];
  const { rows } = buildPaletteRows(withOrphan, workspaces(), "A", "orphan");
  const last = rows[rows.length - 1];
  assert.strictEqual(last.kind, "tab");
  assert.strictEqual(last.item.title, "Orphan tab");
  const unfiledHeaderIdx = rows.findIndex((r) => r.kind === "header" && r.workspaceId === null);
  assert.strictEqual(unfiledHeaderIdx, rows.length - 2);
  // Selectable now (the wireframe gives it a chevron and a num badge like
  // every other section) — the old non-selectable behaviour was dropped
  // deliberately, not regressed.
  assert.strictEqual(rows[unfiledHeaderIdx].selectable, true);
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
// Finding 2 (pre-collapse): a flat rows.slice(0, MAX_PALETTE_RESULTS) could
// truncate mid section and drop a later, small section's header entirely — a
// whole workspace vanishing from a palette whose job is to show workspace
// structure. These tests pin the section-aware replacement.
//
// Collapse-by-default already keeps ordinary no-query browsing well under
// the cap (most sections show zero tabs), so the scenario that actually
// exercises the budget pass today is a QUERY matching many large workspaces
// by name — every matched section is forced "fully expanded, uncapped" (see
// the "does not apply under a query" test above), which is exactly the
// old flat-list failure mode reproduced under the new API.

test("a big section does not evict a small one under a query: both headers survive and the small section keeps its one tab", () => {
  const bigSmallWs = [
    { id: "BIG", name: "Sixty zebra" },
    { id: "SMALL", name: "One zebra" },
  ];
  const bigTabs = Array.from({ length: 60 }, (_, n) => ({
    kind: "tab", tabId: n, title: `tab ${n}`, url: "https://x/", workspaceId: "BIG", hidden: false,
  }));
  const smallTabs = [{ kind: "tab", tabId: 999, title: "the one tab", url: "https://y/", workspaceId: "SMALL", hidden: false }];
  // "zebra" name-matches both workspaces, forcing both sections "fully
  // expanded, uncapped" — the scenario that reproduces the old flat-list bug.
  const { rows } = buildPaletteRows([...bigTabs, ...smallTabs], bigSmallWs, "BIG", "zebra");

  assert.ok(rows.length <= MAX_PALETTE_RESULTS);
  const bigHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "BIG");
  const smallHeader = rows.find((r) => r.kind === "header" && r.workspaceId === "SMALL");
  assert.ok(bigHeader, "BIG's header must survive the cap");
  assert.ok(smallHeader, "SMALL's header must survive the cap — this is the bug the fix closes");
  const smallTabRows = rows.filter((r) => r.kind === "tab" && r.workspaceId === "SMALL");
  assert.deepStrictEqual(smallTabRows.map((r) => r.item.title), ["the one tab"]);
});

test("every qualifying section keeps its header under a query even when tabs must be trimmed to fit", () => {
  const manyWs = Array.from({ length: 5 }, (_, n) => ({ id: `w${n}`, name: `Workspace ${n} zebra` }));
  // Each workspace has more items than an even 1/5 share of the cap, so the
  // round-robin must trim every section's tabs, never drop a whole section.
  // Query "zebra" name-matches every workspace, forcing full/uncapped
  // sections — the scenario where the budget pass still has work to do.
  const manyItems = manyWs.flatMap((ws) =>
    Array.from({ length: 20 }, (_, n) => ({
      kind: "tab", tabId: `${ws.id}-${n}`, title: `${ws.name} tab ${n}`, url: "https://x/", workspaceId: ws.id, hidden: false,
    }))
  );
  const { rows } = buildPaletteRows(manyItems, manyWs, "w0", "zebra");
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

test("round-robin distribution under a query changes only which items survive, never section or item order", () => {
  const threeWs = [
    { id: "X", name: "X zebra" },
    { id: "Y", name: "Y zebra" },
    { id: "Z", name: "Z zebra" },
  ];
  // Sized so the round-robin must trim: 3 headers + up to MAX-3 tabs shared
  // across three sections that between them hold far more than that.
  const bigSection = (id) =>
    Array.from({ length: 30 }, (_, n) => ({
      kind: "tab", tabId: `${id}-${n}`, title: `${id} tab ${n}`, url: "https://x/", workspaceId: id, hidden: false,
    }));
  const allItems = [...bigSection("X"), ...bigSection("Y"), ...bigSection("Z")];
  const { rows } = buildPaletteRows(allItems, threeWs, "X", "zebra");

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

// ---------- paletteArrowTargetsTree (Finding 1) ----------
// Focus lives in the query input for the palette's whole lifetime, so a bare
// ArrowLeft/ArrowRight can only safely drive the collapse tree when there is
// nothing to type over — an empty query and no modifier. Otherwise the keys
// must reach the input as ordinary caret keys (move, option-word-jump,
// shift-select), or a user who has typed anything can never fix a typo.

test("an empty query with no modifier targets the tree", () => {
  assert.strictEqual(paletteArrowTargetsTree("", {}), true);
});

test("a whitespace-only query targets the tree, consistent with buildPaletteRows treating it as no query", () => {
  assert.strictEqual(paletteArrowTargetsTree("   ", {}), true);
});

test("missing modifiers argument defaults to 'no modifier held'", () => {
  assert.strictEqual(paletteArrowTargetsTree("", undefined), true);
});

test("any non-empty query is left to the caret, regardless of modifiers", () => {
  assert.strictEqual(paletteArrowTargetsTree("abc", {}), false);
});

test("each modifier alone defeats tree-targeting even on an empty query", () => {
  assert.strictEqual(paletteArrowTargetsTree("", { shiftKey: true }), false);
  assert.strictEqual(paletteArrowTargetsTree("", { altKey: true }), false);
  assert.strictEqual(paletteArrowTargetsTree("", { metaKey: true }), false);
  assert.strictEqual(paletteArrowTargetsTree("", { ctrlKey: true }), false);
});

test("a modifier held with non-empty text still defeats tree-targeting (not just redundant with the query check)", () => {
  assert.strictEqual(paletteArrowTargetsTree("abc", { altKey: true }), false);
});
