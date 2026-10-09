// paletteRowVerbs is the single source of truth for "which verbs apply to
// this row" — shared/palette.js's onKeydown gates ⌥⏎ (move tab here) and
// ⇧⏎ (rename) on it before acting, and the footer hints are built from the
// same table, so the two surfaces can never disagree with each other about
// what a row supports. Neither the renderer nor onKeydown has a DOM harness,
// so this table is the only part of "which verbs apply" that is actually
// unit-tested — see the palette-actions brief's "Approach" section.
const { test } = require("node:test");
const assert = require("node:assert");
const { paletteRowVerbs } = require("../shared/core.js");

const NONE = { activate: false, moveHere: false, rename: false, delete: false, expand: false, collapse: false };

test("a non-selectable row (or no row at all) supports nothing", () => {
  assert.deepStrictEqual(paletteRowVerbs(null), NONE);
  assert.deepStrictEqual(paletteRowVerbs(undefined), NONE);
  assert.deepStrictEqual(paletteRowVerbs({ kind: "header", workspaceId: "A", selectable: false }), NONE);
});

test("a tab row: activate (jump) and collapse (← folds its parent) only", () => {
  const row = { kind: "tab", workspaceId: "A", selectable: true };
  const verbs = paletteRowVerbs(row);
  assert.strictEqual(verbs.activate, true);
  assert.strictEqual(verbs.collapse, true);
  assert.strictEqual(verbs.moveHere, false);
  assert.strictEqual(verbs.rename, false);
  assert.strictEqual(verbs.delete, false);
  assert.strictEqual(verbs.expand, false); // a tab row cannot expand anything itself
});

test("a real workspace header: every verb applies", () => {
  const row = { kind: "header", workspaceId: "A", selectable: true };
  const verbs = paletteRowVerbs(row);
  assert.deepStrictEqual(verbs, {
    activate: true, moveHere: true, rename: true, delete: true, expand: true, collapse: true,
  });
});

test("the synthetic Unfiled header (workspaceId: null): can toggle, nothing else — there is no workspace to move to, rename or delete", () => {
  const row = { kind: "header", workspaceId: null, selectable: true };
  const verbs = paletteRowVerbs(row);
  assert.strictEqual(verbs.activate, false); // opening it is a no-op (item is null) — see palette.js activate()
  assert.strictEqual(verbs.moveHere, false);
  assert.strictEqual(verbs.rename, false);
  assert.strictEqual(verbs.delete, false);
  assert.strictEqual(verbs.expand, true);
  assert.strictEqual(verbs.collapse, true);
});

test("a 'more' row: expand only", () => {
  const row = { kind: "more", workspaceId: "A", selectable: true };
  const verbs = paletteRowVerbs(row);
  assert.strictEqual(verbs.expand, true);
  assert.strictEqual(verbs.collapse, false);
  assert.strictEqual(verbs.activate, false);
  assert.strictEqual(verbs.moveHere, false);
  assert.strictEqual(verbs.rename, false);
  assert.strictEqual(verbs.delete, false);
});

test("create and createEmpty rows: activate only", () => {
  for (const kind of ["create", "createEmpty"]) {
    const row = { kind, workspaceId: null, selectable: true };
    const verbs = paletteRowVerbs(row);
    assert.strictEqual(verbs.activate, true, kind);
    assert.strictEqual(verbs.moveHere, false, kind);
    assert.strictEqual(verbs.rename, false, kind);
    assert.strictEqual(verbs.delete, false, kind);
    assert.strictEqual(verbs.expand, false, kind);
    assert.strictEqual(verbs.collapse, false, kind);
  }
});

test("a search row (palette-round3 #3): activate only, same shape as create rows — nothing to move/rename/delete/expand/collapse", () => {
  const row = { kind: "search", workspaceId: null, selectable: true, where: { kind: "currentTab" } };
  const verbs = paletteRowVerbs(row);
  assert.deepStrictEqual(verbs, {
    activate: true, moveHere: false, rename: false, delete: false, expand: false, collapse: false,
  });
});

test("a group label row: never selectable, so it supports nothing (the early return, same as any non-selectable row)", () => {
  const row = { kind: "label", workspaceId: null, selectable: false, text: "WEB" };
  assert.deepStrictEqual(paletteRowVerbs(row), NONE);
});
