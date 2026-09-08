// isCollectableOrphanTab — the pure predicate behind firefox/background.js's
// startup garbage collection (see collectOrphanTabs). Kept here, not only
// exercised indirectly, because the properties that make this safe — "owned
// tabs are never touched", "pinned tabs can never match", and "only a URL we
// ourselves saved can ever match" — are exactly the ones a future edit could
// silently break. The last of those is the B1 fix: `tabs.hide` is a shared
// permission (Sidebery, Simple Tab Groups, Panorama all use it too), so
// "hidden" alone never meant "ours" — see the function's own comment in
// shared/core.js for the full reasoning.
const { test } = require("node:test");
const assert = require("node:assert");
const { isCollectableOrphanTab } = require("../shared/core.js");

const base = { id: 1, hidden: true, pinned: false, url: "https://example.com/" };
const noneOwned = new Set();
const savedUrl = new Set(["https://example.com/"]);

test("a hidden, unpinned, trackable, unowned tab whose URL we saved is collectable", () => {
  assert.strictEqual(isCollectableOrphanTab(base, noneOwned, savedUrl), true);
});

test("a visible tab is never collectable", () => {
  assert.strictEqual(isCollectableOrphanTab({ ...base, hidden: false }, noneOwned, savedUrl), false);
});

test("a pinned tab is never collectable, even hidden", () => {
  assert.strictEqual(isCollectableOrphanTab({ ...base, pinned: true }, noneOwned, savedUrl), false);
});

test("a non-http(s) tab is never collectable", () => {
  assert.strictEqual(isCollectableOrphanTab({ ...base, url: "about:blank" }, noneOwned, savedUrl), false);
  assert.strictEqual(isCollectableOrphanTab({ ...base, url: "" }, noneOwned, savedUrl), false);
  assert.strictEqual(isCollectableOrphanTab({ ...base, url: undefined }, noneOwned, savedUrl), false);
});

test("a tab owned by any workspace is never collectable, even hidden", () => {
  const owned = new Set([1]);
  assert.strictEqual(isCollectableOrphanTab(base, owned, savedUrl), false);
});

test("ownership is by id, not by any other field", () => {
  const owned = new Set([2, 3]);
  assert.strictEqual(isCollectableOrphanTab(base, owned, savedUrl), true);
});

// B1: a hidden, unpinned, unowned, http(s) tab is STILL not collectable if its
// URL is not one we saved ourselves. This is the case that matters most: a
// tab another extension (Sidebery, Simple Tab Groups, Panorama — all share
// the tabs.hide permission) hid on purpose must never be treated as our
// garbage just because it happens to be hidden.
test("a hidden orphan whose URL was never saved by us is never collectable", () => {
  assert.strictEqual(isCollectableOrphanTab(base, noneOwned, new Set()), false);
  assert.strictEqual(
    isCollectableOrphanTab(base, noneOwned, new Set(["https://someone-elses-tab/"])),
    false,
  );
});

// The match is exact string equality, not a normalised/stripped comparison —
// a fragment (or query) difference must NOT be treated as the same tab.
test("URL matching is exact — a fragment difference is a different tab", () => {
  const withFragment = { ...base, url: "https://example.com/#section" };
  assert.strictEqual(isCollectableOrphanTab(withFragment, noneOwned, savedUrl), false);
});
