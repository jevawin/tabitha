// Shared core helpers. Pure — no browser API, so no stubs needed.

const { test } = require("node:test");
const assert = require("node:assert");
const { buildMovedState } = require("../shared/core.js");

const tab = { url: "https://example.com/", pinned: false };

test("buildMovedState appends tab to the target workspace", () => {
  const state = {
    workspaces: [
      { id: "a", name: "A", tabs: [{ url: "https://a.com/", pinned: false }] },
      { id: "b", name: "B", tabs: [] }
    ],
    activeWorkspaceId: "a"
  };
  const next = buildMovedState(state, "b", tab);
  assert.deepStrictEqual(next.workspaces[1].tabs, [tab]);
  // source untouched by this helper (closing the live tab handles source re-sync)
  assert.strictEqual(next.workspaces[0].tabs.length, 1);
  // input not mutated
  assert.strictEqual(state.workspaces[1].tabs.length, 0);
});

test("buildMovedState throws when target is missing", () => {
  const state = { workspaces: [], activeWorkspaceId: null };
  assert.throws(() => buildMovedState(state, "nope", tab), /target not found/);
});
