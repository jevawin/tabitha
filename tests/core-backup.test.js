const { test } = require("node:test");
const assert = require("node:assert");
const { parseBackup, MAX_IMPORT_WORKSPACES, MAX_IMPORT_TABS } = require("../shared/core.js");

const wrap = (workspaces) =>
  JSON.stringify({ format: "tabitha-workspaces", version: 1, workspaces });

test("a valid backup round-trips", () => {
  const res = parseBackup(
    wrap([{ id: "a", name: "Work", tabs: [{ url: "https://a.com/", pinned: false }] }])
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.workspaces.length, 1);
  assert.deepStrictEqual(res.workspaces[0].tabs, [{ url: "https://a.com/", pinned: false }]);
});

test("malformed JSON is reported, not thrown", () => {
  const res = parseBackup("{not json");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /JSON/);
});

test("a file without the format tag is rejected", () => {
  const res = parseBackup(JSON.stringify({ version: 1, workspaces: [] }));
  assert.strictEqual(res.ok, false);
});

test("an unknown version is rejected", () => {
  const res = parseBackup(
    JSON.stringify({ format: "tabitha-workspaces", version: 99, workspaces: [] })
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /version/i);
});

// The security case: icon.paths reaches innerHTML in popup.js, so an imported
// file must never be able to supply it.
test("hostile icon.paths is discarded, not sanitised", () => {
  const res = parseBackup(
    wrap([
      {
        id: "a",
        name: "Evil",
        tabs: [],
        icon: { name: "rocket", paths: "<script>alert(1)</script>" },
      },
    ])
  );
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.workspaces[0].icon, { name: "rocket" });
  assert.ok(!("paths" in res.workspaces[0].icon));
});

test("an icon always survives as name-only, whatever the input", () => {
  const res = parseBackup(
    wrap([{ id: "a", name: "W", tabs: [], icon: { name: "gem", paths: "<path/>" } }])
  );
  assert.deepStrictEqual(res.workspaces[0].icon, { name: "gem" });
});

test("non-http tabs are filtered out", () => {
  const res = parseBackup(
    wrap([
      {
        id: "a",
        name: "W",
        tabs: [
          { url: "https://ok.com/", pinned: false },
          { url: "chrome://settings", pinned: false },
          { url: "javascript:alert(1)", pinned: false },
        ],
      },
    ])
  );
  assert.deepStrictEqual(res.workspaces[0].tabs, [{ url: "https://ok.com/", pinned: false }]);
});

test("duplicate and missing ids are regenerated", () => {
  const res = parseBackup(
    wrap([
      { id: "same", name: "A", tabs: [] },
      { id: "same", name: "B", tabs: [] },
      { name: "C", tabs: [] },
    ])
  );
  const ids = res.workspaces.map((w) => w.id);
  assert.strictEqual(new Set(ids).size, 3);
  assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
});

test("a workspace with a blank name is dropped", () => {
  const res = parseBackup(wrap([{ id: "a", name: "   ", tabs: [] }, { id: "b", name: "Keep", tabs: [] }]));
  assert.deepStrictEqual(res.workspaces.map((w) => w.name), ["Keep"]);
});

test("an empty workspaces array is valid", () => {
  const res = parseBackup(wrap([]));
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.workspaces, []);
});

// Rejected, not truncated: a file this size is a mistake or an attack, and
// silently dropping half of it is worse than refusing it.
test("too many workspaces is rejected, not truncated", () => {
  const many = Array.from({ length: MAX_IMPORT_WORKSPACES + 1 }, (_, i) => ({
    id: String(i), name: `W${i}`, tabs: [],
  }));
  const res = parseBackup(wrap(many));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /too many workspaces/i);
});

test("too many tabs in one workspace is rejected", () => {
  const tabs = Array.from({ length: MAX_IMPORT_TABS + 1 }, () => ({
    url: "https://a.com/", pinned: false,
  }));
  const res = parseBackup(wrap([{ id: "a", name: "Big", tabs }]));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /too many tabs/i);
});
