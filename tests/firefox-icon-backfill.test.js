// One-time backfill: workspaces saved before `icon.nodes` existed carry only
// { name, paths } and would otherwise render no icon at all in the palette
// (which renders exclusively from `nodes` — no innerHTML there, see
// shared/core.js normalizeIconNodes). These tests exercise backfillIconNodes
// directly rather than via onInstalled, since the fakes stub that listener as
// a no-op the way every other firefox-*.test.js stubs commands.onCommand.

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  commands: { onCommand: noopListener },
  runtime: { onMessage: noopListener, onInstalled: noopListener },
};

const { test } = require("node:test");
const assert = require("node:assert");
const { makeBrowser } = require("./fake-browser");
const { backfillIconNodes } = require("../firefox/background.js");

// Shaped like a real generated icon-data.json entry: only `name` and `nodes`
// matter to the backfill, so the fixture omits category/tags/paths.
const DATASET = [
  { name: "rocket", nodes: [["path", { d: "M1 1" }]] },
  { name: "gem", nodes: [["circle", { cx: "1", cy: "1", r: "1" }]] },
];

// Stubs the extension's own fetch("icon-data.json") for the duration of `fn`,
// recording every call so a test can assert the network path was (or was
// not) taken — the "skip when nothing needs it" and "don't refetch a
// workspace that's already backfilled" guarantees are otherwise invisible to
// a state-only assertion.
async function withFetch(fn) {
  const calls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => DATASET };
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = prevFetch;
  }
}

test("a workspace with {name, paths} and no nodes gains nodes from the dataset", async () => {
  const fake = makeBrowser({
    local: {
      workspaces: [{ id: "a", name: "A", tabs: [], icon: { name: "rocket", paths: "<path/>" } }],
      activeWorkspaceId: "a",
    },
  });
  globalThis.browser = fake;
  await withFetch(async (calls) => {
    await backfillIconNodes();
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0], /icon-data\.json$/);
  });
  assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, {
    name: "rocket",
    paths: "<path/>",
    nodes: [["path", { d: "M1 1" }]],
  });
});

test("a workspace whose icon name is absent from the dataset is left untouched", () =>
  withFetch(async () => {
    const fake = makeBrowser({
      local: {
        workspaces: [{ id: "a", name: "A", tabs: [], icon: { name: "renamed-icon", paths: "<path/>" } }],
        activeWorkspaceId: "a",
      },
    });
    globalThis.browser = fake;
    await backfillIconNodes();
    assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, { name: "renamed-icon", paths: "<path/>" });
  }));

test("a workspace that already has valid nodes is not rewritten, and no fetch fires for it", async () => {
  const existingNodes = [["circle", { cx: "9", cy: "9", r: "9" }]];
  const fake = makeBrowser({
    local: {
      workspaces: [{ id: "a", name: "A", tabs: [], icon: { name: "rocket", paths: "<path/>", nodes: existingNodes } }],
      activeWorkspaceId: "a",
    },
  });
  globalThis.browser = fake;
  await withFetch(async (calls) => {
    await backfillIconNodes();
    assert.strictEqual(calls.length, 0);
  });
  assert.deepStrictEqual(fake._peek.local().workspaces[0].icon.nodes, existingNodes);
});

test("the pass is skipped entirely (no fetch) when nothing needs it", async () => {
  const fake = makeBrowser({
    local: {
      workspaces: [
        { id: "a", name: "A", tabs: [] }, // no icon at all
        {
          id: "b",
          name: "B",
          tabs: [],
          icon: { name: "gem", paths: "<path/>", nodes: [["circle", { cx: "1", cy: "1", r: "1" }]] },
        },
      ],
      activeWorkspaceId: "a",
    },
  });
  globalThis.browser = fake;
  await withFetch(async (calls) => {
    await backfillIconNodes();
    assert.strictEqual(calls.length, 0);
  });
});

test("a mixed batch backfills only the workspace that needs it", async () => {
  const existingNodes = [["circle", { cx: "9", cy: "9", r: "9" }]];
  const fake = makeBrowser({
    local: {
      workspaces: [
        { id: "a", name: "A", tabs: [], icon: { name: "rocket", paths: "<path/>" } }, // needs it
        { id: "b", name: "B", tabs: [], icon: { name: "gem", paths: "<path/>", nodes: existingNodes } }, // already done
        { id: "c", name: "C", tabs: [] }, // no icon
      ],
      activeWorkspaceId: "a",
    },
  });
  globalThis.browser = fake;
  await withFetch((calls) => backfillIconNodes().then(() => assert.strictEqual(calls.length, 1)));
  const ws = fake._peek.local().workspaces;
  assert.deepStrictEqual(ws.find((w) => w.id === "a").icon.nodes, [["path", { d: "M1 1" }]]);
  assert.deepStrictEqual(ws.find((w) => w.id === "b").icon.nodes, existingNodes); // untouched, same reference-ish value
  assert.ok(!("icon" in ws.find((w) => w.id === "c")));
});

test("a non-ok fetch response is treated as a failure, not parsed as data", () =>
  withFetch(async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => { throw new Error("should not be called"); } });
    const fake = makeBrowser({
      local: {
        workspaces: [{ id: "a", name: "A", tabs: [], icon: { name: "rocket", paths: "<path/>" } }],
        activeWorkspaceId: "a",
      },
    });
    globalThis.browser = fake;
    await assert.doesNotReject(() => backfillIconNodes());
    assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, { name: "rocket", paths: "<path/>" });
  }));

test("a fetch failure (network unavailable) leaves state untouched, does not throw", () =>
  withFetch(async () => {
    globalThis.fetch = async () => { throw new Error("network unavailable"); };
    const fake = makeBrowser({
      local: {
        workspaces: [{ id: "a", name: "A", tabs: [], icon: { name: "rocket", paths: "<path/>" } }],
        activeWorkspaceId: "a",
      },
    });
    globalThis.browser = fake;
    await assert.doesNotReject(() => backfillIconNodes());
    assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, { name: "rocket", paths: "<path/>" });
  }));

// I2: a workspaces write that lands while the (large) dataset fetch is in
// flight must survive. setState({ workspaces }) replaces the whole key, so a
// backfill built from a state snapshot taken BEFORE the fetch — the original
// shape: getState(), await fetch, setState(workspaces-from-the-stale-read) —
// silently clobbers whatever wrote to `workspaces` during that await (auto-
// save firing, or a workspace created/switched at startup). The fake's fetch
// below writes directly to storage mid-flight to model exactly that landing.
// This test fails under the original read-before-fetch ordering (workspace
// "c" is missing afterwards) and only passes once the read that feeds the
// write happens AFTER the fetch, with nothing async in between.
test("a workspaces write landing while the dataset fetch is in flight survives the backfill", async () => {
  const fake = makeBrowser({
    local: {
      workspaces: [{ id: "a", name: "A", tabs: [], icon: { name: "rocket", paths: "<path/>" } }],
      activeWorkspaceId: "a",
    },
  });
  globalThis.browser = fake;

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // The concurrent write: something else finishes a storage.local write
    // for `workspaces` while this fetch is still pending.
    await fake.storage.local.set({
      workspaces: [
        { id: "a", name: "A", tabs: [], icon: { name: "rocket", paths: "<path/>" } },
        { id: "c", name: "C", tabs: [] },
      ],
    });
    return { ok: true, json: async () => DATASET };
  };
  try {
    await backfillIconNodes();
  } finally {
    globalThis.fetch = prevFetch;
  }

  const workspaces = fake._peek.local().workspaces;
  assert.ok(
    workspaces.some((w) => w.id === "c"),
    "workspace 'c', written mid-fetch, must survive the backfill's write"
  );
  assert.deepStrictEqual(
    workspaces.find((w) => w.id === "a").icon.nodes,
    [["path", { d: "M1 1" }]]
  );
});
