// deleteConfirmLabel — palette-round3 brief #1. The delete confirm must warn
// about what a delete actually LOSES (every saved tab, live or not — the
// workspace record itself is destroyed), not what Firefox happens to close
// live right now. A workspace that has not been opened this session can
// have saved tabs with zero live ones, which is exactly the bug: a 5-tab
// workspace's confirm read "close its 0 tabs?".
const { test } = require("node:test");
const assert = require("node:assert");
const { deleteConfirmLabel } = require("../shared/core.js");

test("plural count", () => {
  assert.strictEqual(deleteConfirmLabel("Research", 5), 'Delete "Research" and its 5 tabs?');
});

test("singular count reads '1 tab', not '1 tabs'", () => {
  assert.strictEqual(deleteConfirmLabel("Research", 1), 'Delete "Research" and its 1 tab?');
});

test("zero reads as plural ('0 tabs'), same English rule as everywhere else in the app", () => {
  assert.strictEqual(deleteConfirmLabel("Empty", 0), 'Delete "Empty" and its 0 tabs?');
});

test("the name is interpolated verbatim, quoted", () => {
  assert.strictEqual(deleteConfirmLabel("Q4 Planning", 3), 'Delete "Q4 Planning" and its 3 tabs?');
});
