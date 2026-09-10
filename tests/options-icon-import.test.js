// options.js's resolveIcons re-resolves an imported backup's name-only icons
// against the committed icon-data.json. It must resolve BOTH `paths` and
// `nodes` (I1): resolving only `paths` — the original shape — left every
// icon picked or imported after install rendering the palette's default
// sentinel until the next backfill, since the palette renders exclusively
// from `nodes`.
//
// options.js has no module scope of its own (no IIFE) and touches `document`
// at load time, so a minimal DOM stub goes up before requiring it — same
// spirit as the `globalThis.browser` stubs every firefox-*.test.js installs
// before requiring firefox/background.js.

const { test } = require("node:test");
const assert = require("node:assert");

function stubEl() {
  return { addEventListener() {}, click() {}, appendChild() {}, textContent: "", hidden: false, value: "", className: "" };
}
globalThis.document = { getElementById: () => stubEl(), createElement: () => stubEl() };
globalThis.browser = {
  management: { getSelf: async () => ({ installType: "development" }) },
  runtime: { sendMessage: async () => ({}) },
};

require("../shared/core.js"); // sets globalThis.TabithaCore, which options.js reads at load time
const { resolveIcons } = require("../shared/options.js");

const DATASET = [
  { name: "rocket", paths: "<path d=\"M1 1\"/>", nodes: [["path", { d: "M1 1" }]] },
  { name: "gem", paths: "<path d=\"M2 2\"/>", nodes: [["circle", { cx: "1", cy: "1", r: "1" }]] },
];

async function withFetch(fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => DATASET });
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

test("resolveIcons resolves both paths and nodes for a name-only imported icon", () =>
  withFetch(async () => {
    const workspaces = [{ id: "a", name: "A", tabs: [], icon: { name: "rocket" } }];
    const out = await resolveIcons(workspaces);
    assert.deepStrictEqual(out[0].icon, {
      name: "rocket",
      paths: "<path d=\"M1 1\"/>",
      nodes: [["path", { d: "M1 1" }]],
    });
  }));

test("resolveIcons drops the icon entirely when its name is absent from the dataset", () =>
  withFetch(async () => {
    const workspaces = [{ id: "a", name: "A", tabs: [], icon: { name: "not-a-real-icon" } }];
    const out = await resolveIcons(workspaces);
    assert.ok(!("icon" in out[0]));
  }));

test("resolveIcons leaves iconless workspaces untouched and never fetches", async () => {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { calls.push(1); return { json: async () => DATASET }; };
  try {
    const workspaces = [{ id: "a", name: "A", tabs: [] }];
    const out = await resolveIcons(workspaces);
    assert.deepStrictEqual(out, workspaces);
    assert.strictEqual(calls.length, 0);
  } finally {
    globalThis.fetch = prev;
  }
});
