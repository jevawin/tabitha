# Firefox Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cmd+Shift+K frosted-glass overlay to Tabitha's Firefox target that searches tabs and workspaces, and can fire a search into a background workspace without leaving the current one.

**Architecture:** All decisions stay in `firefox/background.js`, which gains four message types. Pure ranking lives in `shared/core.js` and is tested once. The overlay is a closed shadow root injected into the active page by a content script, not an iframe — `backdrop-filter` cannot blur across an iframe boundary and the frosted glass is the design.

**Tech Stack:** Plain JS, no build, no dependencies. `node --test` against `tests/fake-browser.js`. WebExtensions MV3 (`commands`, `scripting`, `search`, `tabHide`).

**Spec:** `docs/2026-09-06-command-palette-spec.md`

## Global Constraints

- **Firefox only.** `chrome/background.js` must reject every new message type. Do not port.
- **Never edit a synced copy.** Change `shared/`, then `node tools/sync.mjs`. `chrome/popup.js` and `firefox/core.js` are gitignored build output.
- **`shared/core.js` touches no browser API**, and everything in it stays inside the existing IIFE. A bare top-level `function foo(){}` there collides with background.js's `const { foo } = ...` and the extension will not start. Add new names to the `TabithaCore` export object at the bottom.
- **No new dependencies.** `npx` only, never added to the repo.
- Tests run as `node --test tests/*.test.js` (the glob matters — `node --test tests/` fails on Node 24).
- Existing invariants in `CLAUDE.md` all still apply. Live hazards: mute live tracking during any tab creation (invariant 1), never close a tab on a switch path (invariant 11), never let the window reach zero tabs (invariant 3).
- Backup format `version` stays `1`. New fields are additive and optional on read.
- Dev logging uses `dlog()` / `derror()`, never raw `console.log`.
- The overlay follows `prefers-color-scheme` by default. No colour may have its only definition inside a media query — define the complete light palette on bare `:host`, then redefine tokens for dark twice (system preference, and explicit override) so a pinned choice wins in both directions.
- Firefox `strict_min_version` is `115.0`.

---

### Task 1: Pure palette ranking in core.js

**Files:**
- Modify: `shared/core.js` (inside the IIFE; add to the `TabithaCore` export at the bottom)
- Test: `tests/core-palette.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `rankPaletteItems(items, query) -> Array<item>` and `MAX_PALETTE_RESULTS = 50`. An item is `{ kind, title, url, ... }`; ranking reads only `title` and `url` and returns the same objects, filtered and sorted. Tasks 3 and 7 rely on both names.

- [ ] **Step 1: Write the failing test**

Create `tests/core-palette.test.js`:

```js
// Palette ranking — pure, so it is tested once and never per-target.
const { test } = require("node:test");
const assert = require("node:assert");
const { rankPaletteItems, MAX_PALETTE_RESULTS } = require("../shared/core.js");

const items = [
  { kind: "tab", title: "GitHub — jevawin/tabitha", url: "https://github.com/jevawin/tabitha" },
  { kind: "tab", title: "Mozilla Developer Network", url: "https://developer.mozilla.org/" },
  { kind: "saved", title: "Tabitha docs", url: "https://example.com/tabitha-docs" },
  { kind: "workspace", title: "Work", url: "" },
];

test("an empty query returns everything, in the order given", () => {
  const out = rankPaletteItems(items, "");
  assert.deepStrictEqual(out.map((i) => i.title), items.map((i) => i.title));
});

test("a title prefix outranks a mid-title match", () => {
  const out = rankPaletteItems(items, "tabitha");
  assert.strictEqual(out[0].title, "Tabitha docs");
});

test("a URL-only match is still returned, ranked below title matches", () => {
  const out = rankPaletteItems(items, "developer");
  // Both the MDN title and the MDN url match; the saved doc matches neither.
  assert.ok(out.some((i) => i.title === "Mozilla Developer Network"));
  assert.ok(!out.some((i) => i.title === "Tabitha docs"));
});

test("non-matches are dropped", () => {
  assert.deepStrictEqual(rankPaletteItems(items, "zzzzz"), []);
});

test("matching is case-insensitive and trims the query", () => {
  const out = rankPaletteItems(items, "  GITHUB  ");
  assert.strictEqual(out[0].title, "GitHub — jevawin/tabitha");
});

test("ties keep their original relative order", () => {
  const tied = [
    { title: "alpha one", url: "https://a/" },
    { title: "alpha two", url: "https://b/" },
  ];
  assert.deepStrictEqual(
    rankPaletteItems(tied, "alpha").map((i) => i.title),
    ["alpha one", "alpha two"]
  );
});

test("results are capped", () => {
  const many = Array.from({ length: 200 }, (_, n) => ({ title: `match ${n}`, url: "https://x/" }));
  assert.strictEqual(rankPaletteItems(many, "match").length, MAX_PALETTE_RESULTS);
});

test("missing title or url does not throw", () => {
  assert.doesNotThrow(() => rankPaletteItems([{ kind: "tab" }], "x"));
  assert.deepStrictEqual(rankPaletteItems(null, "x"), []);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/core-palette.test.js`
Expected: FAIL — `rankPaletteItems is not a function`.

- [ ] **Step 3: Implement it**

In `shared/core.js`, inside the IIFE, above the `// ---------- Exports ----------` block:

```js
  // Palette ranking. Substring scoring only — deliberately not fuzzy. A fuzzy
  // matcher surfaces confident nonsense for short queries, and the palette is
  // driven by muscle memory where a wrong first row is worse than no row.
  const MAX_PALETTE_RESULTS = 50;

  function scorePaletteItem(item, needle) {
    const title = ((item && item.title) || "").toLowerCase();
    const url = ((item && item.url) || "").toLowerCase();
    if (title.startsWith(needle)) return 100;
    if (title.includes(" " + needle)) return 80; // word boundary
    if (title.includes(needle)) return 60;
    if (url.includes(needle)) return 30;
    return 0;
  }

  // Returns the same item objects, filtered and sorted. Never mutates the input.
  function rankPaletteItems(items, query) {
    const list = Array.isArray(items) ? items : [];
    const needle = (query || "").trim().toLowerCase();
    if (!needle) return list.slice(0, MAX_PALETTE_RESULTS);
    return list
      .map((item, i) => ({ item, i, score: scorePaletteItem(item, needle) }))
      .filter((r) => r.score > 0)
      // Index breaks ties, so equal scores keep the caller's order. Array.sort
      // is stable in modern engines, but relying on that silently is how a
      // result order becomes accidentally load-bearing.
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, MAX_PALETTE_RESULTS)
      .map((r) => r.item);
  }
```

Then extend the export object at the bottom of the file — add the two new names to the existing `const TabithaCore = { ... }` literal:

```js
  const TabithaCore = { isTrackableUrl, cleanName, MAX_ICON_PATHS, normalizeIcon, buildMovedState, parseBackup, MAX_IMPORT_WORKSPACES, MAX_IMPORT_TABS, rankPaletteItems, MAX_PALETTE_RESULTS };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/core-palette.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole suite, including the load test**

Run: `node --test tests/*.test.js`
Expected: all PASS. `browser-load.test.js` matters here — it loads `core.js` and `background.js` into one shared global the way a browser does, and it is the only test that would catch a name collision introduced by this task.

- [ ] **Step 6: Commit**

```bash
git add shared/core.js tests/core-palette.test.js
git commit -m "feat: add pure palette ranking to core"
```

---

### Task 2: Store tab titles and each workspace's last-active URL

**Files:**
- Modify: `firefox/background.js` — `claimVisible()`
- Modify: `shared/core.js` — `parseBackup()`
- Modify: `firefox/background.js` — `importWorkspaces()`
- Test: `tests/firefox-palette-model.test.js` (create)
- Test: `tests/core-backup.test.js` (extend)

**Interfaces:**
- Consumes: Task 1 nothing.
- Produces: workspace records gain optional `lastActiveUrl: string` and their `tabs[]` entries gain optional `title: string`. Task 3 reads both. Both are optional on read — old records and old backups have neither.

- [ ] **Step 1: Write the failing test**

Create `tests/firefox-palette-model.test.js`:

```js
// Titles and last-active URL must survive a claim, because a workspace that has
// not been opened this session has no live tab to read either from.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { switchWorkspace } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

test("claiming stores each tab's title and the active tab's url", async () => {
  globalThis.browser = makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "A", tabs: [] },
        { id: "B", name: "B", tabs: [{ url: "https://b1/", pinned: false }] },
      ],
      activeWorkspaceId: "A",
    },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", title: "First", active: false },
      { id: 2, windowId: 1, url: "https://a2/", title: "Second", active: true },
    ],
  });

  // Switching away from A claims A while its tabs are still visible.
  await switchWorkspace("B");

  const a = globalThis.browser._peek.local().workspaces.find((w) => w.id === "A");
  assert.deepStrictEqual(a.tabs, [
    { url: "https://a1/", pinned: false, title: "First" },
    { url: "https://a2/", pinned: false, title: "Second" },
  ]);
  assert.strictEqual(a.lastActiveUrl, "https://a2/");
});

test("a tab with no title stores no title field rather than an empty one", async () => {
  globalThis.browser = makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "A", tabs: [] },
        { id: "B", name: "B", tabs: [{ url: "https://b1/", pinned: false }] },
      ],
      activeWorkspaceId: "A",
    },
    tabs: [{ id: 1, windowId: 1, url: "https://a1/", active: true }],
  });

  await switchWorkspace("B");

  const a = globalThis.browser._peek.local().workspaces.find((w) => w.id === "A");
  assert.deepStrictEqual(a.tabs, [{ url: "https://a1/", pinned: false }]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/firefox-palette-model.test.js`
Expected: FAIL — the claimed tabs have no `title`, and `lastActiveUrl` is `undefined`.

- [ ] **Step 3: Implement the claim change**

In `firefox/background.js`, in `claimVisible()`, replace the block that currently reads:

```js
  const { workspaces } = await getState();
  const ws = workspaces.find((w) => w.id === wsId);
  if (ws) {
    ws.tabs = tabs.map((t) => ({ url: t.url, pinned: false }));
    await setState({ workspaces });
  }
  return ids;
```

with:

```js
  const { workspaces } = await getState();
  const ws = workspaces.find((w) => w.id === wsId);
  if (ws) {
    // Title is stored so a workspace that has not been opened this session is
    // still searchable by something a human recognises. Omitted rather than
    // stored empty, so the record shape stays honest about what is known.
    ws.tabs = tabs.map((t) => ({
      url: t.url,
      pinned: false,
      ...(t.title ? { title: t.title } : {}),
    }));
    // Where "open this workspace" should land. A URL, not a tab id: ids die with
    // the browser session and this has to survive a restart.
    const active = tabs.find((t) => t.active);
    if (active && active.url) ws.lastActiveUrl = active.url;
    await setState({ workspaces });
  }
  return ids;
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test tests/firefox-palette-model.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing backup round-trip test**

Append to `tests/core-backup.test.js`:

```js
test("parseBackup carries tab titles and lastActiveUrl through", () => {
  const file = JSON.stringify({
    format: "tabitha-workspaces",
    version: 1,
    workspaces: [
      {
        id: "A",
        name: "Work",
        lastActiveUrl: "https://a2/",
        tabs: [
          { url: "https://a1/", pinned: false, title: "First" },
          { url: "https://a2/", pinned: false },
        ],
      },
    ],
  });
  const res = parseBackup(file);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.workspaces[0].lastActiveUrl, "https://a2/");
  assert.deepStrictEqual(res.workspaces[0].tabs, [
    { url: "https://a1/", pinned: false, title: "First" },
    { url: "https://a2/", pinned: false },
  ]);
});

test("parseBackup drops a non-string title and an untrackable lastActiveUrl", () => {
  const file = JSON.stringify({
    format: "tabitha-workspaces",
    version: 1,
    workspaces: [
      {
        id: "A",
        name: "Work",
        lastActiveUrl: "javascript:alert(1)",
        tabs: [{ url: "https://a1/", pinned: false, title: { evil: true } }],
      },
    ],
  });
  const res = parseBackup(file);
  assert.strictEqual(res.ok, true);
  assert.strictEqual("lastActiveUrl" in res.workspaces[0], false);
  assert.deepStrictEqual(res.workspaces[0].tabs, [{ url: "https://a1/", pinned: false }]);
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `node --test tests/core-backup.test.js`
Expected: FAIL — `parseBackup` strips both new fields today.

- [ ] **Step 7: Implement the parseBackup change**

In `shared/core.js`, in `parseBackup()`, replace:

```js
      const tabs = rawTabs
        .filter((t) => t && isTrackableUrl(t.url))
        .map((t) => ({ url: t.url, pinned: t.pinned === true }));
```

with:

```js
      // TRUST BOUNDARY: `title` comes from a user-chosen file. It is carried as
      // text only and MUST be rendered with textContent, never innerHTML — see
      // the palette row renderer. A non-string is dropped rather than coerced,
      // so an object or array can never reach the DOM.
      const tabs = rawTabs
        .filter((t) => t && isTrackableUrl(t.url))
        .map((t) => ({
          url: t.url,
          pinned: t.pinned === true,
          ...(typeof t.title === "string" && t.title.trim() ? { title: t.title } : {}),
        }));
```

and, in the same loop, replace:

```js
      const ws = { id, name, tabs };
```

with:

```js
      const ws = { id, name, tabs };
      // Only an http/s URL is a valid landing target, same rule as tabs.
      if (isTrackableUrl(raw.lastActiveUrl)) ws.lastActiveUrl = raw.lastActiveUrl;
```

- [ ] **Step 8: Implement the matching importWorkspaces change**

`importWorkspaces()` in `firefox/background.js` re-validates independently of `parseBackup`, so it needs the same two changes. Replace:

```js
    const tabs = (Array.isArray(w.tabs) ? w.tabs : [])
      .filter((t) => t && isTrackableUrl(t.url))
      .map((t) => ({ url: t.url, pinned: t.pinned === true }));
    const id = typeof w.id === "string" && w.id ? w.id : crypto.randomUUID();
    workspaces.push({ id, name, tabs, ...(icon ? { icon } : {}) });
```

with:

```js
    const tabs = (Array.isArray(w.tabs) ? w.tabs : [])
      .filter((t) => t && isTrackableUrl(t.url))
      .map((t) => ({
        url: t.url,
        pinned: t.pinned === true,
        ...(typeof t.title === "string" && t.title.trim() ? { title: t.title } : {}),
      }));
    const id = typeof w.id === "string" && w.id ? w.id : crypto.randomUUID();
    workspaces.push({
      id,
      name,
      tabs,
      ...(icon ? { icon } : {}),
      ...(isTrackableUrl(w.lastActiveUrl) ? { lastActiveUrl: w.lastActiveUrl } : {}),
    });
```

- [ ] **Step 9: Run the whole suite**

Run: `node --test tests/*.test.js`
Expected: all PASS. The existing backup and import tests must still pass unchanged — old records carry neither field and must keep working.

- [ ] **Step 10: Commit**

```bash
git add shared/core.js firefox/background.js tests/firefox-palette-model.test.js tests/core-backup.test.js
git commit -m "feat: store tab titles and last-active url per workspace"
```

---

### Task 3: Teach the fake about get/title/search, and build paletteState

**Files:**
- Modify: `tests/fake-browser.js`
- Modify: `firefox/background.js` — add `buildPaletteState()` and the `paletteState` message case
- Test: `tests/firefox-palette-state.test.js` (create)

**Interfaces:**
- Consumes: `rankPaletteItems` is *not* used here — the background returns everything and the overlay ranks. Consumes Task 2's `title` / `lastActiveUrl`.
- Produces: message `paletteState` returning `{ ok: true, items, workspaces, activeWorkspaceId, theme }`, where `theme` is `"system" | "light" | "dark"` and defaults to `"system"`. An item is one of:
  - `{ kind: "tab", tabId: number, url, title, workspaceId: string|null, hidden: boolean }`
  - `{ kind: "saved", tabId: null, url, title, workspaceId: string, hidden: true }`
  - `{ kind: "workspace", workspaceId: string, title, url, icon: object|null }`
  Tasks 4, 5 and 7 all depend on these exact shapes.
- Produces: `tests/fake-browser.js` gains `tabs.get(id)`, `title` support, and a `search` namespace recording calls at `_peek.searches()`. Task 5 depends on the search fake.

- [ ] **Step 1: Extend the fake**

The fake models Firefox's biting behaviour, and a fake that lies is worse than no test — so add to it rather than working around it.

In `tests/fake-browser.js`, add `title` to the `create` return (after the `url` line):

```js
          url: props.url || "",
          title: props.title || "",
```

Add `tabs.get`, next to `query`:

```js
      get: (id) => {
        const t = tabStore.find((x) => x.id === id);
        return t
          ? Promise.resolve(structuredClone(t))
          : Promise.reject(new Error("No tab with id: " + id));
      },
```

Add a `search` namespace as a sibling of `tabs`. It models the one behaviour that
matters: a search navigates the target tab and does **not** reveal it, which is
what was measured on Firefox 156.

```js
    // Measured on Firefox 156.0b3: search.search({query, tabId}) navigates a
    // HIDDEN tab and leaves it hidden. Modelled here so the palette's
    // "search into a background workspace" path is covered by tests and not
    // only by a manual check.
    search: {
      search: ({ query, tabId, disposition }) => {
        if (tabId != null && disposition != null) {
          return Promise.reject(new Error("tabId and disposition are mutually exclusive"));
        }
        searches.push({ query, tabId: tabId ?? null, disposition: disposition ?? null });
        const url = "https://example-engine/?q=" + encodeURIComponent(query);
        if (tabId != null) {
          const t = tabStore.find((x) => x.id === tabId);
          if (!t) return Promise.reject(new Error("No tab with id: " + tabId));
          t.url = url;
          t.title = query + " — Search";
          return Promise.resolve(); // note: `hidden` is deliberately untouched
        }
        const t = {
          id: nextId++,
          windowId: tabStore.length ? tabStore[0].windowId : 1,
          url,
          title: query + " — Search",
          active: false,
          pinned: false,
          hidden: false,
        };
        tabStore.push(t);
        return Promise.resolve();
      },
    },
```

Declare the recorder near `let nextId = ...`:

```js
  const searches = [];
```

and expose it in `_peek`:

```js
      searches: () => structuredClone(searches),
```

- [ ] **Step 2: Write the failing test**

Create `tests/firefox-palette-state.test.js`:

```js
// paletteState is the overlay's only source of truth. It must see hidden tabs in
// other workspaces (that is the whole point of the Firefox target) and fall back
// to saved records for workspaces that have not been opened this session.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { buildPaletteState } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

const fixture = () =>
  makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "Work", tabs: [{ url: "https://a1/", pinned: false, title: "A one" }] },
        { id: "B", name: "Play", tabs: [{ url: "https://b1/", pinned: false, title: "B one" }] },
        { id: "C", name: "Cold", lastActiveUrl: "https://c2/", tabs: [
          { url: "https://c1/", pinned: false, title: "C one" },
          { url: "https://c2/", pinned: false, title: "C two" },
        ] },
      ],
      activeWorkspaceId: "A",
    },
    session: { tabMap: { A: [1], B: [2] } },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", title: "A one", active: true },
      { id: 2, windowId: 1, url: "https://b1/", title: "B one", hidden: true },
      { id: 3, windowId: 1, url: "about:config", title: "Config" },
    ],
  });

test("live tabs are listed with their owning workspace, hidden ones included", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();

  const a = state.items.find((i) => i.kind === "tab" && i.tabId === 1);
  assert.deepStrictEqual(
    { workspaceId: a.workspaceId, hidden: a.hidden, title: a.title },
    { workspaceId: "A", hidden: false, title: "A one" }
  );

  const b = state.items.find((i) => i.kind === "tab" && i.tabId === 2);
  assert.deepStrictEqual(
    { workspaceId: b.workspaceId, hidden: b.hidden, title: b.title },
    { workspaceId: "B", hidden: true, title: "B one" }
  );
});

test("untrackable tabs are never offered", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  assert.strictEqual(state.items.some((i) => i.url === "about:config"), false);
});

test("a workspace with no live tabs falls back to its saved records", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  const saved = state.items.filter((i) => i.kind === "saved" && i.workspaceId === "C");
  assert.deepStrictEqual(saved.map((i) => i.title), ["C one", "C two"]);
  assert.strictEqual(saved.every((i) => i.tabId === null && i.hidden === true), true);
});

test("a saved record is not duplicated when the same url is already live", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  const a1 = state.items.filter((i) => i.url === "https://a1/");
  assert.strictEqual(a1.length, 1);
  assert.strictEqual(a1[0].kind, "tab");
});

test("the palette theme defaults to system and is passed through", async () => {
  globalThis.browser = fixture();
  assert.strictEqual((await buildPaletteState()).theme, "system");

  globalThis.browser = makeBrowser({ local: { paletteTheme: "light" } });
  assert.strictEqual((await buildPaletteState()).theme, "light");
});

test("a junk stored theme falls back to system rather than reaching the DOM", async () => {
  globalThis.browser = makeBrowser({ local: { paletteTheme: "'; drop--" } });
  assert.strictEqual((await buildPaletteState()).theme, "system");
});

test("every workspace is offered as its own item", async () => {
  globalThis.browser = fixture();
  const state = await buildPaletteState();
  const ws = state.items.filter((i) => i.kind === "workspace");
  assert.deepStrictEqual(ws.map((i) => i.title), ["Work", "Play", "Cold"]);
  assert.strictEqual(ws.find((i) => i.workspaceId === "C").url, "https://c2/");
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --test tests/firefox-palette-state.test.js`
Expected: FAIL — `buildPaletteState is not a function`.

- [ ] **Step 4: Implement it**

In `firefox/background.js`, add above the `// ---------- Message router` block:

```js
// ---------- Palette ----------

// Everything the overlay needs, in one message. The overlay does no assembly of
// its own: it renders and sends, exactly like the popup (keep it that way).
//
// Three sources, in priority order. A live tab always wins over a saved record
// for the same URL, because only the live one can be jumped to.
async function buildPaletteState() {
  const winId = await getCurrentWindowId();
  const { workspaces, activeWorkspaceId } = await getState();
  const map = await getTabMap();
  const theme = await getPaletteTheme();

  const ownerOf = new Map();
  for (const [wsId, ids] of Object.entries(map)) {
    for (const id of ids || []) ownerOf.set(id, wsId);
  }

  const items = [];
  const liveKeys = new Set();

  const all = winId == null ? [] : await browser.tabs.query({ windowId: winId });
  for (const t of all) {
    // Same rule as everywhere else: only http/s can be reopened or reasoned
    // about, so about: and extension pages are never offered.
    if (!isTrackableUrl(t.url)) continue;
    const workspaceId = ownerOf.get(t.id) || null;
    liveKeys.add(`${workspaceId}|${t.url}`);
    items.push({
      kind: "tab",
      tabId: t.id,
      url: t.url,
      title: t.title || t.url,
      workspaceId,
      hidden: !!t.hidden,
    });
  }

  for (const ws of workspaces) {
    for (const t of ws.tabs || []) {
      if (!isTrackableUrl(t.url)) continue;
      if (liveKeys.has(`${ws.id}|${t.url}`)) continue;
      items.push({
        kind: "saved",
        tabId: null,
        url: t.url,
        title: t.title || t.url,
        workspaceId: ws.id,
        hidden: true,
      });
    }
  }

  for (const ws of workspaces) {
    items.push({
      kind: "workspace",
      workspaceId: ws.id,
      title: ws.name,
      url: ws.lastActiveUrl || "",
      icon: ws.icon || null,
    });
  }

  return { workspaces, activeWorkspaceId, items, theme };
}
```

Add the theme reader above it. It is a separate `storage.local` key rather than
part of the workspaces blob, so writing it can never race a workspace write:

```js
// Palette theme: "system" (default), "light" or "dark". Validated on read, not
// only on write — the value ends up as a data-theme attribute in a page's DOM,
// and storage is not a trust boundary we control alone.
const PALETTE_THEMES = ["system", "light", "dark"];

async function getPaletteTheme() {
  const { paletteTheme } = await browser.storage.local.get({ paletteTheme: "system" });
  return PALETTE_THEMES.includes(paletteTheme) ? paletteTheme : "system";
}
```

Add the message case to the router's `switch`, next to `getState`:

```js
      case "paletteState":
        return { ok: true, ...(await buildPaletteState()) };
```

Add `buildPaletteState` and `getPaletteTheme` to the `module.exports` object at
the bottom of the file.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `node --test tests/firefox-palette-state.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the whole suite**

Run: `node --test tests/*.test.js`
Expected: all PASS. The fake changed, so every existing suite is exercising it too.

- [ ] **Step 7: Commit**

```bash
git add tests/fake-browser.js firefox/background.js tests/firefox-palette-state.test.js
git commit -m "feat: assemble palette state from live tabs, saved records and workspaces"
```

---

### Task 4: Jump to a tab, and open a workspace at its last tab

**Files:**
- Modify: `firefox/background.js` — add `jumpToTab()` and `openWorkspace()`, plus two message cases
- Test: `tests/firefox-palette-jump.test.js` (create)

**Interfaces:**
- Consumes: Task 3's item shapes (`tabId`, `workspaceId`), Task 2's `lastActiveUrl`.
- Produces: messages `jumpToTab { tabId }` and `openWorkspace { id }`, both returning `{ ok: true }`. Task 7 sends both.

- [ ] **Step 1: Write the failing test**

Create `tests/firefox-palette-jump.test.js`:

```js
// Jumping must switch workspace first when the tab lives elsewhere, and must
// never close anything (invariant 11).
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { jumpToTab, openWorkspace } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

const fixture = () =>
  makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "Work", tabs: [{ url: "https://a1/", pinned: false }] },
        { id: "B", name: "Play", lastActiveUrl: "https://b2/", tabs: [
          { url: "https://b1/", pinned: false },
          { url: "https://b2/", pinned: false },
        ] },
      ],
      activeWorkspaceId: "A",
    },
    session: { tabMap: { A: [1], B: [2, 3] } },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://b1/", hidden: true },
      { id: 3, windowId: 1, url: "https://b2/", hidden: true },
    ],
  });

test("jumping to a tab in another workspace switches, reveals and activates it", async () => {
  globalThis.browser = fixture();
  await jumpToTab(3);

  const tabs = globalThis.browser._peek.tabs();
  const target = tabs.find((t) => t.id === 3);
  assert.strictEqual(target.active, true);
  assert.strictEqual(target.hidden, false);
  assert.strictEqual(globalThis.browser._peek.local().activeWorkspaceId, "B");
  // The workspace we left is hidden, not closed.
  assert.strictEqual(tabs.find((t) => t.id === 1).hidden, true);
  assert.strictEqual(tabs.length, 3);
});

test("jumping within the active workspace does not switch", async () => {
  globalThis.browser = fixture();
  await jumpToTab(1);
  assert.strictEqual(globalThis.browser._peek.local().activeWorkspaceId, "A");
  assert.strictEqual(globalThis.browser._peek.tabs().find((t) => t.id === 1).active, true);
});

test("opening a workspace lands on its last-active url", async () => {
  globalThis.browser = fixture();
  await openWorkspace("B");
  const tabs = globalThis.browser._peek.tabs();
  assert.strictEqual(tabs.find((t) => t.url === "https://b2/").active, true);
});

test("opening a workspace with no last-active url still switches", async () => {
  globalThis.browser = fixture();
  await openWorkspace("A"); // already active, and has no lastActiveUrl
  assert.strictEqual(globalThis.browser._peek.local().activeWorkspaceId, "A");
});

test("jumping to an unknown tab rejects rather than throwing silently", async () => {
  globalThis.browser = fixture();
  await assert.rejects(() => jumpToTab(999));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/firefox-palette-jump.test.js`
Expected: FAIL — `jumpToTab is not a function`.

- [ ] **Step 3: Implement both**

In `firefox/background.js`, below `buildPaletteState()`:

```js
// Jump to one tab, wherever it lives. If it belongs to another workspace we
// switch there first — which hides the current set and shows the target's — then
// activate the specific tab. Nothing is ever closed here.
async function jumpToTab(tabId) {
  const winId = await getCurrentWindowId();
  if (winId == null) throw new Error("No working window");
  // Fail loudly on a stale id rather than switching to nowhere. The palette can
  // hold an id for a tab the user closed a moment ago.
  await browser.tabs.get(tabId);

  const map = await getTabMap();
  let owner = null;
  for (const [wsId, ids] of Object.entries(map)) {
    if ((ids || []).includes(tabId)) owner = wsId;
  }

  const { activeWorkspaceId } = await getState();
  if (owner && owner !== activeWorkspaceId) await switchWorkspace(owner);

  // After the switch the target is visible; activating also reveals it if the
  // switch left it hidden for any reason.
  await browser.tabs.update(tabId, { active: true });
}

// Open a workspace and land where the user left it. Falls back to whatever the
// switch chose when lastActiveUrl is absent or its tab is gone.
async function openWorkspace(id) {
  const state = await getState();
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error("workspace not found");

  if (state.activeWorkspaceId !== id) await switchWorkspace(id);
  if (!ws.lastActiveUrl) return;

  const winId = await getCurrentWindowId();
  if (winId == null) return;
  const ids = await liveIds(id, winId);
  const tabs = (await browser.tabs.query({ windowId: winId })).filter((t) => ids.includes(t.id));
  const target = tabs.find((t) => t.url === ws.lastActiveUrl);
  if (target) await browser.tabs.update(target.id, { active: true });
}
```

Add both message cases to the router's `switch`:

```js
      case "jumpToTab":
        await jumpToTab(msg.tabId);
        return { ok: true };
      case "openWorkspace":
        await openWorkspace(msg.id);
        return { ok: true };
```

Add `jumpToTab` and `openWorkspace` to `module.exports`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test tests/firefox-palette-jump.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the whole suite and commit**

```bash
node --test tests/*.test.js
git add firefox/background.js tests/firefox-palette-jump.test.js
git commit -m "feat: jump to any tab and open a workspace at its last tab"
```

---

### Task 5: Search from the palette, including into a background workspace

**Files:**
- Modify: `firefox/manifest.json` — add the `search` permission
- Modify: `firefox/background.js` — add `paletteSearch()` and its message case
- Test: `tests/firefox-palette-search.test.js` (create)

**Interfaces:**
- Consumes: Task 3's fake `search` namespace and `_peek.searches()`.
- Produces: message `paletteSearch { query, where }` returning `{ ok: true }`, where `where` is `{kind:"currentTab"}` | `{kind:"newTab"}` | `{kind:"workspace", id}`. Task 7 sends all three.

- [ ] **Step 1: Write the failing test**

Create `tests/firefox-palette-search.test.js`:

```js
// The three dispositions. The third one — search into a workspace you are NOT
// in — is the reason this feature is Firefox-only, so it gets the most cover.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { paletteSearch } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

const fixture = () =>
  makeBrowser({
    local: {
      workspaces: [
        { id: "A", name: "Work", tabs: [{ url: "https://a1/", pinned: false }] },
        { id: "B", name: "Play", tabs: [{ url: "https://b1/", pinned: false }] },
      ],
      activeWorkspaceId: "A",
    },
    session: { tabMap: { A: [1], B: [2] } },
    tabs: [
      { id: 1, windowId: 1, url: "https://a1/", active: true },
      { id: 2, windowId: 1, url: "https://b1/", hidden: true },
    ],
  });

test("current tab: searches in the active tab by id", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "currentTab" });
  assert.deepStrictEqual(globalThis.browser._peek.searches(), [
    { query: "otters", tabId: 1, disposition: null },
  ]);
});

test("new tab: uses NEW_TAB so live tracking claims it normally", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "newTab" });
  assert.deepStrictEqual(globalThis.browser._peek.searches(), [
    { query: "otters", tabId: null, disposition: "NEW_TAB" },
  ]);
});

test("other workspace: the tab is created, hidden, searched, and stays hidden", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });

  const created = globalThis.browser._peek.tabs().find((t) => t.id === 3);
  assert.strictEqual(created.hidden, true, "the search tab must not appear on screen");
  assert.match(created.url, /otters/);

  // Searched by id, never by disposition — the two are mutually exclusive.
  assert.deepStrictEqual(globalThis.browser._peek.searches(), [
    { query: "otters", tabId: 3, disposition: null },
  ]);
});

test("other workspace: the new tab is owned by that workspace, not the active one", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });
  const map = globalThis.browser._peek.session().tabMap;
  assert.deepStrictEqual(map.B, [2, 3]);
  assert.deepStrictEqual(map.A, [1]);
});

test("other workspace: we never leave the workspace we are in", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });
  assert.strictEqual(globalThis.browser._peek.local().activeWorkspaceId, "A");
  assert.strictEqual(globalThis.browser._peek.tabs().find((t) => t.id === 1).active, true);
});

test("other workspace: the swapping guard is released even so", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "B" });
  assert.strictEqual(globalThis.browser._peek.session().swapping, false);
});

test("targeting the active workspace is just a new tab", async () => {
  globalThis.browser = fixture();
  await paletteSearch("otters", { kind: "workspace", id: "A" });
  assert.deepStrictEqual(globalThis.browser._peek.searches(), [
    { query: "otters", tabId: null, disposition: "NEW_TAB" },
  ]);
});

test("an empty query is rejected", async () => {
  globalThis.browser = fixture();
  await assert.rejects(() => paletteSearch("   ", { kind: "currentTab" }));
});

test("an unknown workspace is rejected without creating a stray tab", async () => {
  globalThis.browser = fixture();
  const before = globalThis.browser._peek.tabs().length;
  await assert.rejects(() => paletteSearch("otters", { kind: "workspace", id: "nope" }));
  assert.strictEqual(globalThis.browser._peek.tabs().length, before);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/firefox-palette-search.test.js`
Expected: FAIL — `paletteSearch is not a function`.

- [ ] **Step 3: Add the permission**

In `firefox/manifest.json`, change the `permissions` array to:

```json
  "permissions": [
    "tabs",
    "tabHide",
    "storage",
    "search",
    "scripting"
  ],
```

(`scripting` is unused until Task 6 but belongs with this one edit — a second
permission bump means a second re-sign of the add-on.)

- [ ] **Step 4: Implement it**

In `firefox/background.js`, below `openWorkspace()`:

```js
// Run a search, in one of three places.
//
// The search URL cannot be built by hand: search.get() returns only
// { name, isDefault, alias, favIconUrl } with no URL template, so driving a tab
// by tabId is the only way to use the user's own default engine.
async function paletteSearch(query, where) {
  const q = (query || "").trim();
  if (!q) throw new Error("Enter something to search for");
  const winId = await getCurrentWindowId();
  if (winId == null) throw new Error("No working window");
  const kind = where && where.kind;

  if (kind === "currentTab") {
    const [tab] = await browser.tabs.query({ active: true, windowId: winId });
    if (!tab) throw new Error("No active tab");
    await browser.search.search({ query: q, tabId: tab.id });
    return;
  }

  if (kind === "newTab") {
    // Visible and in the current workspace, so ordinary live tracking claims it.
    await browser.search.search({ query: q, disposition: "NEW_TAB" });
    return;
  }

  if (kind !== "workspace") throw new Error("unknown search target");

  const state = await getState();
  // Targeting where you already are is just a new tab.
  if (where.id === state.activeWorkspaceId) {
    await browser.search.search({ query: q, disposition: "NEW_TAB" });
    return;
  }
  if (!state.workspaces.some((w) => w.id === where.id)) throw new Error("workspace not found");

  // Mute live tracking: tabs.create below fires onCreated, and auto-save would
  // otherwise claim this tab for the ACTIVE workspace — the exact
  // cross-contamination invariant 1 exists to prevent.
  await setSwapping(true);
  try {
    // Create → hide → search, in that order. This is the sequence that was
    // measured working on Firefox 156.0b3; searching first would flash the
    // result on screen before we could hide it.
    const tab = await browser.tabs.create({ windowId: winId, active: false });
    const refused = await hideTabs([tab.id], winId);
    if (refused.length) {
      // hideTabs already logged it. Carry on: the tab is still correctly owned,
      // it is simply visible — the same outcome as any other tab that refuses
      // to hide, and never a reason to lose the user's search.
      derror("search tab would not hide; it will sit in the current workspace");
    }
    await browser.search.search({ query: q, tabId: tab.id });

    // Ownership only. The URL is deliberately NOT written into the workspace
    // record: the search has not resolved yet, and claimVisible will save the
    // real URL the first time the user switches out of that workspace. Until
    // then it lives in the session tab map, exactly like any other live tab.
    const map = await getTabMap();
    map[where.id] = [...(map[where.id] || []), tab.id];
    await setTabMap(map);
    dlog("searched", JSON.stringify(q), "into workspace", where.id, "as tab", tab.id);
  } finally {
    await setSwapping(false);
  }
}
```

Add the message case:

```js
      case "paletteSearch":
        await paletteSearch(msg.query, msg.where);
        return { ok: true };
```

Add `paletteSearch` to `module.exports`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `node --test tests/firefox-palette-search.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 6: Run the whole suite and commit**

```bash
node --test tests/*.test.js
git add firefox/manifest.json firefox/background.js tests/firefox-palette-search.test.js
git commit -m "feat: search from the palette into any workspace"
```

---

### Task 6: The shortcut, the injection host, and the real-page keyboard check

**Files:**
- Modify: `firefox/manifest.json` — add `commands`
- Modify: `firefox/background.js` — `commands.onCommand` handler
- Create: `shared/palette.js` (host only at this stage; the UI arrives in Task 7)
- Modify: `chrome/background.js` — explicit rejection

**Interfaces:**
- Consumes: nothing from Tasks 1–5 at runtime yet.
- Produces: `shared/palette.js` defines `window.__tabithaPaletteToggle()` and a `__tabithaPaletteHost` guard, both of which Task 7 replaces the internals of.

**Why this task exists separately:** every keyboard measurement so far was taken
on a top-level `moz-extension://` page. The palette runs in a shadow root inside
an ordinary https page. Step 6 closes that gap before any UI is built on top of
the assumption.

- [ ] **Step 1: Add the command to the manifest**

In `firefox/manifest.json`, add a top-level key. Cmd+Shift+K was measured firing
cleanly on macOS and costs nothing — Firefox's Web Console there is Cmd+Opt+K
and the toolbox is Cmd+Opt+I. Cmd+K was measured *refused*; do not use it.

```json
  "commands": {
    "open-palette": {
      "suggested_key": { "default": "Ctrl+Shift+K", "mac": "Command+Shift+K" },
      "description": "Open the Tabitha palette"
    }
  },
```

Also bump `version` to `0.2.0` — every AMO upload needs a unique version.

- [ ] **Step 2: Write the injection host**

Create `shared/palette.js`:

```js
// Tabitha palette — injected into the active page by the background on the
// keyboard shortcut. Re-injecting re-runs this file, so it toggles rather than
// stacking a second overlay.
//
// A shadow root, not an iframe. backdrop-filter cannot blur across an iframe
// boundary — the iframe is a separate document, so its backdrop is its own —
// and the frosted glass is the design. Shadow DOM gives the same style
// isolation while staying real page content.
(() => {
  const HOST_ID = "__tabitha_palette_host";

  if (window.__tabithaPaletteToggle) {
    window.__tabithaPaletteToggle();
    return;
  }

  const api = globalThis.browser ?? globalThis.chrome;

  let host = null;
  let root = null;

  function close() {
    if (!host) return;
    host.remove();
    host = null;
    root = null;
  }

  function open() {
    host = document.createElement("div");
    host.id = HOST_ID;
    // Inherited properties cross the shadow boundary, so reset before styling.
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";
    // documentElement, not body: fewer pages create a containing block there.
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "closed" });

    // Placeholder until Task 7. Proves the host mounts and takes keys.
    const probe = document.createElement("input");
    probe.setAttribute("aria-label", "Tabitha palette");
    root.appendChild(probe);
    probe.focus();
  }

  // Cmd+digit was measured cancellable inside page content, so preventDefault
  // genuinely stops Firefox switching tabs. Verified on a moz-extension page;
  // step 6 of this task re-verifies it here, on a real https page.
  function onKeydown(e) {
    if (!host) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (/^Digit[1-9]$/.test(e.code) && e.metaKey) {
      e.preventDefault();
      console.log("[TABITHA] palette would search into workspace", e.code.slice(5));
    }
  }
  window.addEventListener("keydown", onKeydown, true);

  window.__tabithaPaletteToggle = () => (host ? close() : open());
  window.__tabithaPaletteToggle();
})();
```

- [ ] **Step 3: Wire the command in the background**

In `firefox/background.js`, above the message router:

```js
// The shortcut opens the palette over whatever page you are on. activeTab is
// granted by activating an extension shortcut (Firefox 63+), so this needs no
// host permission and no install-time prompt.
browser.commands.onCommand.addListener(async (name) => {
  if (name !== "open-palette") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["palette.js"] });
  } catch (e) {
    // about:, addons.mozilla.org, view-source: and the PDF viewer refuse content
    // scripts. Fall back to the toolbar popup rather than doing nothing.
    derror("palette cannot inject here:", e);
    try {
      await browser.action.openPopup();
    } catch (_) {}
  }
});
```

- [ ] **Step 4: Make Chrome reject it explicitly**

In `chrome/background.js`, in the router's `switch`, above `default`:

```js
      // Firefox-only. Chrome has no hidden tabs, so a palette that searches into
      // a background workspace cannot exist here — see docs/2026-09-06-command-palette-spec.md.
      case "paletteState":
      case "jumpToTab":
      case "openWorkspace":
      case "paletteSearch":
        return { ok: false, error: "The palette is Firefox-only" };
```

- [ ] **Step 5: Sync and load**

```bash
node tools/sync.mjs
npx --yes web-ext run --firefox="/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox" --source-dir=firefox
```

- [ ] **Step 6: Verify on a real https page — this is the gate**

Navigate to any ordinary https page (github.com will do — a real site with its
own key handlers, not a blank page).

1. Press **Cmd+Shift+K**. The probe input must appear and take focus.
2. Press **Cmd+2**. Expected: the console logs `palette would search into workspace 2` and **the browser does not switch to tab 2**. Have at least three tabs open, with this page at tab 3 or later, or a switch is invisible.
3. Press **Esc**. The overlay closes.
4. Press **Cmd+Shift+K** twice. It toggles; it does not stack two overlays.
5. Navigate to `about:config` and press Cmd+Shift+K. Expected: the toolbar popup opens instead, and `derror` logs the injection failure.

If step 2 switches tabs, stop. The Cmd+digit binding does not survive in a page
context and Task 7's key map needs to move to Ctrl+digit or Alt+digit — both were
also measured reaching page content. Record which it was in the spec before
continuing.

- [ ] **Step 7: Commit**

```bash
git add firefox/manifest.json firefox/background.js chrome/background.js shared/palette.js
git commit -m "feat: bind the palette to Cmd+Shift+K and inject it into the active page"
```

---

### Task 7: The overlay UI

**Files:**
- Modify: `shared/palette.js` — replace the placeholder with the real UI
- Create: `shared/palette.css.js` (the stylesheet as an exported string, so it can be adopted into the shadow root)

**Interfaces:**
- Consumes: `paletteState`, `jumpToTab`, `openWorkspace`, `paletteSearch` from Tasks 3–5; `rankPaletteItems` from Task 1.
- Produces: the finished feature. Nothing depends on it.

**Why the CSS is a JS file:** a `<style>` element injected into a page with a
strict CSP can be blocked. A constructed stylesheet adopted into the shadow root
is not, and `palette.css` as a real file would need `web_accessible_resources`
plus a fetch. One string in one file avoids both.

- [ ] **Step 1: Write the stylesheet**

Create `shared/palette.css.js`:

```js
// Palette styles, as a string so they can be adopted into a closed shadow root
// via CSSStyleSheet — which a strict page CSP cannot block, unlike a <style>.
//
// Tokens mirror popup.css so the palette and the popup are visibly one product.
// Dark only, like the popup: no light variant.
globalThis.TABITHA_PALETTE_CSS = `
/* Light is the base: the COMPLETE palette lives on bare :host, so no colour has
   its only definition inside a media query. Dark redefines the same tokens
   twice — once for the system preference (unless the user pinned light), once
   for an explicit dark override — so a pinned choice wins in both directions.
   prefers-color-scheme here reflects the browser setting, not the host page's. */
:host {
  --scrim: rgba(20, 20, 24, .18);
  --panel: rgba(250, 250, 252, .72);
  --border: rgba(0, 0, 0, .10);
  --line: rgba(0, 0, 0, .08);
  --fg: #1c1c1f;
  --muted: #6b6b73;
  --sel: rgba(0, 0, 0, .06);
  --kbd: rgba(0, 0, 0, .07);
  --shadow: 0 24px 64px rgba(0, 0, 0, .22), 0 2px 8px rgba(0, 0, 0, .12);
}

@media (prefers-color-scheme: dark) {
  :host(:not([data-theme="light"])) {
    --scrim: rgba(10, 10, 12, .42);
    --panel: rgba(31, 31, 34, .72);
    --border: rgba(255, 255, 255, .10);
    --line: rgba(255, 255, 255, .08);
    --fg: #e8e8ea;
    --muted: #9a9aa2;
    --sel: rgba(255, 255, 255, .08);
    --kbd: rgba(255, 255, 255, .08);
    --shadow: 0 24px 64px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .35);
  }
}

:host([data-theme="dark"]) {
  --scrim: rgba(10, 10, 12, .42);
  --panel: rgba(31, 31, 34, .72);
  --border: rgba(255, 255, 255, .10);
  --line: rgba(255, 255, 255, .08);
  --fg: #e8e8ea;
  --muted: #9a9aa2;
  --sel: rgba(255, 255, 255, .08);
  --kbd: rgba(255, 255, 255, .08);
  --shadow: 0 24px 64px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .35);
}

* { box-sizing: border-box; }

.scrim {
  position: fixed;
  inset: 0;
  display: grid;
  justify-items: center;
  align-items: start;
  padding-top: 14vh;
  background: var(--scrim);
  backdrop-filter: blur(3px);
  font: 14px/1.4 -apple-system, system-ui, sans-serif;
  color: var(--fg);
}

.panel {
  width: min(640px, calc(100vw - 48px));
  max-height: 62vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  backdrop-filter: blur(24px) saturate(180%);
  box-shadow: var(--shadow);
  animation: rise 120ms ease-out;
}
@keyframes rise {
  from { opacity: 0; transform: scale(.98); }
  to   { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .panel { animation: none; }
}

.query {
  width: 100%;
  padding: 16px 18px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: inherit;
  font: 20px/1.3 -apple-system, system-ui, sans-serif;
  outline: none;
}
.query::placeholder { color: var(--muted); }

.results { overflow-y: auto; padding: 6px 0; }
.results:empty { display: none; }

.group {
  padding: 8px 18px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--muted);
}

.row {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 18px;
  cursor: default;
}
.row[aria-selected="true"] { background: var(--sel); }
.row .ico { display: flex; color: var(--muted); }
.row .ico img { width: 16px; height: 16px; border-radius: 3px; }
.row .text { min-width: 0; }
.row .title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row .sub {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row .hint {
  font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--muted);
}

.foot {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 8px 18px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--muted);
}
kbd {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--kbd);
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--fg);
}
`;
```

Note `:host` carries no `all: initial` here. That reset is applied as an inline
style in `palette.js` instead, where it cannot be beaten by anything the page
does — and keeping it in one place stops the two from drifting. `all` does not
touch custom properties, so the tokens above are safe either way.

- [ ] **Step 2: Replace the placeholder UI**

Replace the `open()` function and add rendering, in `shared/palette.js`. The
whole file becomes:

```js
// Tabitha palette — injected into the active page by the background on the
// keyboard shortcut. Re-injecting re-runs this file, so it toggles rather than
// stacking a second overlay.
//
// A shadow root, not an iframe. backdrop-filter cannot blur across an iframe
// boundary — the iframe is a separate document, so its backdrop is its own —
// and the frosted glass is the design. Shadow DOM gives the same style
// isolation while staying real page content.
//
// This file stays dumb, like popup.js: it renders and sends messages. Every
// decision lives in firefox/background.js.
(() => {
  if (window.__tabithaPaletteToggle) {
    window.__tabithaPaletteToggle();
    return;
  }

  const api = globalThis.browser ?? globalThis.chrome;
  const { rankPaletteItems } = globalThis.TabithaCore;

  let host = null;
  let root = null;
  let items = [];
  let shown = [];
  let sel = 0;
  let workspaces = [];

  const send = (msg) => api.runtime.sendMessage(msg);

  function close() {
    if (!host) return;
    host.remove();
    host = null;
    root = null;
  }

  function labelFor(item) {
    if (item.kind === "workspace") return "Workspace";
    const ws = workspaces.find((w) => w.id === item.workspaceId);
    return ws ? ws.name : "Unfiled";
  }

  function render() {
    const q = root.querySelector(".query").value;
    shown = rankPaletteItems(items, q);
    sel = Math.min(sel, Math.max(0, shown.length - 1));

    const list = root.querySelector(".results");
    list.textContent = "";
    shown.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === sel));

      const ico = document.createElement("span");
      ico.className = "ico";
      ico.textContent = item.kind === "workspace" ? "▦" : item.hidden ? "○" : "●";

      const text = document.createElement("span");
      text.className = "text";
      const title = document.createElement("div");
      title.className = "title";
      // textContent, never innerHTML: titles come from page content and from
      // imported backup files, neither of which is trusted markup.
      title.textContent = item.title;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = labelFor(item) + (item.url ? " · " + item.url : "");
      text.append(title, sub);

      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = i === sel ? "↵" : "";

      row.append(ico, text, hint);
      row.addEventListener("mousemove", () => { sel = i; render(); });
      row.addEventListener("click", () => activate());
      list.appendChild(row);
    });
  }

  async function activate() {
    const item = shown[sel];
    if (!item) return;
    close();
    if (item.kind === "workspace") await send({ type: "openWorkspace", id: item.workspaceId });
    else if (item.tabId != null) await send({ type: "jumpToTab", tabId: item.tabId });
    else await send({ type: "openWorkspace", id: item.workspaceId });
  }

  async function search(where) {
    const q = root.querySelector(".query").value;
    close();
    await send({ type: "paletteSearch", query: q, where });
  }

  function onKeydown(e) {
    if (!host) return;
    const q = root.querySelector(".query");

    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); return; }

    // Cmd+digit was measured cancellable inside page content: preventDefault
    // genuinely stops Firefox switching tabs. Without it, Cmd+2 jumps to tab 2.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && e.metaKey) {
      e.preventDefault();
      const ws = workspaces[Number(digit[1]) - 1];
      if (ws) search({ kind: "workspace", id: ws.id });
      return;
    }
    if (e.key === "Enter" && e.metaKey) { e.preventDefault(); search({ kind: "newTab" }); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      // A selected result wins; otherwise the typed text is a search.
      if (shown.length && q.value.trim() && shown[sel]) activate();
      else search({ kind: "currentTab" });
    }
  }

  async function open() {
    // State first, THEN paint. Fetching after mounting would show the overlay in
    // the system theme for one frame before a pinned override applied — a
    // visible flash on every open.
    const state = await send({ type: "paletteState" });
    if (!state || !state.ok) return;
    items = state.items;
    workspaces = state.workspaces;

    host = document.createElement("div");
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";
    // documentElement, not body: fewer pages create a containing block there.
    // "system" means no attribute, so the stylesheet's media query decides.
    if (state.theme === "light" || state.theme === "dark") {
      host.setAttribute("data-theme", state.theme);
    }
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "closed" });

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(globalThis.TABITHA_PALETTE_CSS);
    root.adoptedStyleSheets = [sheet];

    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML =
      '<div class="panel" role="dialog" aria-modal="true" aria-label="Tabitha palette">' +
      '<input class="query" type="text" placeholder="Search tabs, workspaces, or the web…" autocomplete="off" spellcheck="false" />' +
      '<div class="results" role="listbox"></div>' +
      '<div class="foot">' +
      "<span><kbd>↵</kbd> this tab</span>" +
      "<span><kbd>⌘↵</kbd> new tab</span>" +
      "<span><kbd>⌘1–9</kbd> workspace</span>" +
      "<span><kbd>esc</kbd> close</span>" +
      "</div></div>";
    root.appendChild(scrim);

    scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
    root.querySelector(".query").addEventListener("input", () => { sel = 0; render(); });
    root.querySelector(".query").focus();
    render();
  }

  window.addEventListener("keydown", onKeydown, true);
  window.__tabithaPaletteToggle = () => (host ? close() : open());
  window.__tabithaPaletteToggle();
})();
```

Note the `scrim.innerHTML` is a fixed literal with no interpolation — that is
safe. Every value that comes from a tab, a workspace or a backup goes through
`textContent` in `render()`.

- [ ] **Step 3: Inject core.js and the stylesheet alongside**

`palette.js` uses `rankPaletteItems` and `TABITHA_PALETTE_CSS`, so both must be
injected first. In `firefox/background.js`, change the `executeScript` call to:

```js
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      // Order matters: core.js defines TabithaCore and palette.css.js defines
      // the stylesheet, both of which palette.js reads at load.
      files: ["core.js", "palette.css.js", "palette.js"],
    });
```

- [ ] **Step 4: Sync and reload**

```bash
node tools/sync.mjs
npx --yes web-ext run --firefox="/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox" --source-dir=firefox
```

- [ ] **Step 5: Manual acceptance, on a real https page**

Set up: three workspaces, each with two or three tabs, visited at least once so
they are materialised.

1. Cmd+Shift+K opens the overlay. It is frosted, centred, 14vh down, and the page behind is blurred and darkened.
2. Type part of a tab title in *another* workspace. It appears, labelled with that workspace's name.
3. Enter on it: the browser switches workspace and lands on that tab. Nothing closed, nothing reloaded.
4. Cmd+Shift+K, type a fresh query, Enter: the current tab runs the search.
5. Cmd+Shift+K, type, Cmd+Enter: a new tab opens in the current workspace with the results.
6. Cmd+Shift+K, type, Cmd+2: **nothing visible happens**, and you stay where you are. Switch to workspace 2 — the search tab is there, loaded.
7. Switch to a workspace, then back. The palette's tab is still owned by workspace 2.
8. Switch macOS to Light Appearance and reopen the palette: the panel is light frosted, text is dark, and the page behind is still pushed back by a soft scrim. Switch back to Dark and confirm it follows.
9. `node --test tests/*.test.js` still passes.

- [ ] **Step 6: Update the docs**

`CLAUDE.md` is required to stay current. Add to the Message protocol section the
four new types, to Data model the two new fields, to Layout the two new
`shared/` files, and to Run and test the new test files. Note that the palette
follows `prefers-color-scheme` while `popup.css` is dark-only, so the two do not
match in light mode. Add to Known limitations: a workspace's search tab is only
in the session tab map until the first switch out of that workspace, so a browser
restart before then loses it.

- [ ] **Step 7: Commit**

```bash
git add shared/palette.js shared/palette.css.js firefox/background.js CLAUDE.md
git commit -m "feat: frosted-glass command palette overlay"
```

---

### Task 8: Theme override on the options page

**Files:**
- Modify: `shared/options.html` — add the control
- Modify: `shared/options.js` — load and save it
- Modify: `firefox/background.js` — `setPaletteTheme` message, and `paletteTheme` on the `getState` response
- Test: `tests/firefox-palette-theme.test.js` (create)

**Interfaces:**
- Consumes: `getPaletteTheme()` and `PALETTE_THEMES` from Task 3.
- Produces: message `setPaletteTheme { theme }` returning `{ ok: true }`; `getState` gains `paletteTheme`. Nothing depends on this task — the overlay works on `"system"` without it.

**Why this is separate from Task 7:** the overlay is complete and shippable
following the system setting. The override is a preference surface, and a
reviewer could reasonably accept the overlay while rejecting how the setting is
presented.

- [ ] **Step 1: Write the failing test**

Create `tests/firefox-palette-theme.test.js`:

```js
// The stored theme becomes a data-theme attribute in a page's DOM, so it is
// validated on the way in as well as on the way out.
const { test } = require("node:test");
const assert = require("node:assert");

const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { setPaletteTheme, getPaletteTheme } = require("../firefox/background.js");
const { makeBrowser } = require("./fake-browser");

test("a valid theme is stored", async () => {
  globalThis.browser = makeBrowser();
  await setPaletteTheme("dark");
  assert.strictEqual(globalThis.browser._peek.local().paletteTheme, "dark");
  assert.strictEqual(await getPaletteTheme(), "dark");
});

test("system is storable, and is the default when nothing is stored", async () => {
  globalThis.browser = makeBrowser();
  assert.strictEqual(await getPaletteTheme(), "system");
  await setPaletteTheme("system");
  assert.strictEqual(await getPaletteTheme(), "system");
});

test("an invalid theme is rejected and nothing is written", async () => {
  globalThis.browser = makeBrowser({ local: { paletteTheme: "dark" } });
  await assert.rejects(() => setPaletteTheme("hot-pink"));
  assert.strictEqual(globalThis.browser._peek.local().paletteTheme, "dark");
});

test("setting the theme does not disturb workspaces", async () => {
  globalThis.browser = makeBrowser({
    local: { workspaces: [{ id: "A", name: "Work", tabs: [] }], activeWorkspaceId: "A" },
  });
  await setPaletteTheme("light");
  const local = globalThis.browser._peek.local();
  assert.strictEqual(local.workspaces.length, 1);
  assert.strictEqual(local.activeWorkspaceId, "A");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/firefox-palette-theme.test.js`
Expected: FAIL — `setPaletteTheme is not a function`.

- [ ] **Step 3: Implement the setter**

In `firefox/background.js`, directly below `getPaletteTheme()`:

```js
async function setPaletteTheme(theme) {
  if (!PALETTE_THEMES.includes(theme)) throw new Error("unknown theme: " + theme);
  // Its own key, so this can never race a workspaces write.
  await browser.storage.local.set({ paletteTheme: theme });
}
```

Add the message case, and extend the existing `getState` case so the options page
can show the current value:

```js
      case "getState": {
        const state = await getState();
        const activeTab = await readActiveTab();
        const paletteTheme = await getPaletteTheme();
        return { ...state, activeTab, paletteTheme };
      }
```

```js
      case "setPaletteTheme":
        await setPaletteTheme(msg.theme);
        return { ok: true };
```

Add `setPaletteTheme` to `module.exports`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test tests/firefox-palette-theme.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the control to the options page**

In `shared/options.html`, add a section alongside the existing backup/restore one
(match the surrounding markup's classes — it reuses `popup.css`):

```html
    <section class="section">
      <h2 class="section-head">Palette appearance</h2>
      <p class="hint">The Cmd+Shift+K palette follows your system setting unless you pin it.</p>
      <select id="paletteTheme">
        <option value="system">Follow system</option>
        <option value="light">Always light</option>
        <option value="dark">Always dark</option>
      </select>
      <span id="themeSaved" class="saved" hidden>Saved</span>
    </section>
```

- [ ] **Step 6: Wire it up**

In `shared/options.js`, add:

```js
const themeEl = document.getElementById("paletteTheme");
const themeSaved = document.getElementById("themeSaved");

// Reflect the stored value on load. An unknown value falls back to "system"
// because the background already normalised it.
send({ type: "getState" }).then((state) => {
  if (state && state.paletteTheme) themeEl.value = state.paletteTheme;
});

themeEl.addEventListener("change", async () => {
  const res = await send({ type: "setPaletteTheme", theme: themeEl.value });
  if (!res || !res.ok) return;
  themeSaved.hidden = false;
  setTimeout(() => { themeSaved.hidden = true; }, 1500);
});
```

`shared/options.js` has no `send()` helper — it calls `api.runtime.sendMessage`
directly (see lines 57, 128, 157). Match that existing style rather than
introducing a helper for two call sites, so replace `send({...})` above with
`api.runtime.sendMessage({...})`.

- [ ] **Step 7: Sync and check by hand**

```bash
node tools/sync.mjs
npx --yes web-ext run --firefox="/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox" --source-dir=firefox
```

1. Open the options page from the popup's cog. The dropdown reads "Follow system".
2. Set "Always light". Reopen the palette on a page — it is light even with the system in dark mode.
3. Set "Always dark", reopen — dark even with the system in light mode.
4. Set back to "Follow system" and confirm it tracks the system again.
5. Reload the extension and confirm the setting survived.

- [ ] **Step 8: Run the whole suite and commit**

```bash
node --test tests/*.test.js
git add shared/options.html shared/options.js firefox/background.js tests/firefox-palette-theme.test.js
git commit -m "feat: let the palette theme be pinned light or dark"
```


---

## Self-review notes

**Spec coverage.** Theming → Task 3 (state), Task 7 (tokens), Task 8 (override).
Shortcut → Task 6. Overlay host and design → Tasks 6 and 7.
Tab/workspace/saved search → Tasks 1, 3, 7. Enter / Cmd+Enter / Cmd+digit → Task
5 (background) and Task 7 (bindings). Jump-to-tab and open-workspace → Task 4.
Data model → Task 2. Chrome rejection → Task 6. The unverified page-context
keyboard question → Task 6 step 6, which is a hard gate.

**Known gaps, deliberately left.** Workspace icons are fetched in `paletteState`
but Task 7 renders a glyph rather than the stored Lucide path — wiring
`ICON_SVG` in needs `popup.js`'s helper extracted to a shared file, which is a
refactor this plan does not attempt. The palette's search tab is not written to
the workspace's saved `tabs[]` until the next claim; the reasoning is in Task 5
and the limitation is documented in Task 7 step 6.
