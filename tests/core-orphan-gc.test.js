// isCollectableOrphanTab — the pure predicate behind firefox/background.js's
// startup garbage collection (see collectOrphanTabs). Kept here, not only
// exercised indirectly, because the two properties that make this safe —
// "owned tabs are never touched" and "pinned tabs can never match" — are
// exactly the ones a future edit could silently break.
const { test } = require("node:test");
const assert = require("node:assert");
const { isCollectableOrphanTab } = require("../shared/core.js");

const base = { id: 1, hidden: true, pinned: false, url: "https://example.com/" };
const noneOwned = new Set();

test("a hidden, unpinned, trackable, unowned tab is collectable", () => {
  assert.strictEqual(isCollectableOrphanTab(base, noneOwned), true);
});

test("a visible tab is never collectable", () => {
  assert.strictEqual(isCollectableOrphanTab({ ...base, hidden: false }, noneOwned), false);
});

test("a pinned tab is never collectable, even hidden", () => {
  assert.strictEqual(isCollectableOrphanTab({ ...base, pinned: true }, noneOwned), false);
});

test("a non-http(s) tab is never collectable", () => {
  assert.strictEqual(isCollectableOrphanTab({ ...base, url: "about:blank" }, noneOwned), false);
  assert.strictEqual(isCollectableOrphanTab({ ...base, url: "" }, noneOwned), false);
  assert.strictEqual(isCollectableOrphanTab({ ...base, url: undefined }, noneOwned), false);
});

test("a tab owned by any workspace is never collectable, even hidden", () => {
  const owned = new Set([1]);
  assert.strictEqual(isCollectableOrphanTab(base, owned), false);
});

test("ownership is by id, not by any other field", () => {
  const owned = new Set([2, 3]);
  assert.strictEqual(isCollectableOrphanTab(base, owned), true);
});
