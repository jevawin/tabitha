# Settings Menu and Backup/Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cog in the popup that opens a real options page with whole-state
Export/Import, then pin the Chrome extension id so moving the folder can never
orphan workspaces again.

**Architecture:** Validation is a pure `parseBackup()` in `shared/core.js`,
tested once and used by both targets. Two new message types (`exportState`,
`importState`) keep every decision in the background; the popup and options page
stay presentation-only. An imported icon's raw SVG is discarded and re-resolved
from our own `icon-data.json` by name, because `icon.paths` reaches `innerHTML`.

**Tech Stack:** Vanilla JS, Manifest V3, no build step, no dependencies. Node's
built-in test runner.

## Global Constraints

- **No dependencies, no bundler, no build step.** Stdlib and browser APIs only.
- **No new permissions.** `tabs` and `storage` only, both targets. File download
  via `Blob` + `<a download>` and file read via `<input type="file">` need none.
- **`shared/` is the only source of truth.** Never edit `chrome/` or `firefox/`
  copies; run `node tools/sync.mjs` after changing anything in `shared/`.
- **Everything added to `shared/core.js` goes INSIDE its IIFE.** A bare top-level
  declaration collides with `background.js` and stops both extensions loading.
  See `tests/browser-load.test.js`.
- **`tools/sync.mjs` `ASSETS` is an explicit list.** A new file in `shared/` that
  is not listed there never ships.
- Run tests with `node --test tests/*.test.js` (`node --test tests/` fails on
  Node 24).
- Dev logging via `dlog()`/`derror()`, never raw `console.log`.
- Comments explain *why*, not *what*.

---

### Task 1: `parseBackup()` validation in core.js

**Files:**
- Modify: `shared/core.js` (inside the IIFE)
- Modify: `tests/browser-load.test.js:78-90` (the exported-key assertion)
- Test: `tests/core-backup.test.js` (create)

**Interfaces:**
- Consumes: `cleanName()`, `isTrackableUrl()` — already in `core.js`.
- Produces: `parseBackup(text)` returning `{ ok: true, workspaces }` or
  `{ ok: false, error: string }`, never throwing. Each returned workspace is
  `{ id: string, name: string, tabs: [{url, pinned}], icon?: { name: string } }`
  — note `icon` carries **only** `name`, never `paths`. Also exports
  `MAX_IMPORT_WORKSPACES = 200` and `MAX_IMPORT_TABS = 500`.

- [ ] **Step 1: Write the failing test**

Create `tests/core-backup.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core-backup.test.js`
Expected: FAIL — `parseBackup is not a function`.

- [ ] **Step 3: Implement `parseBackup` in `shared/core.js`**

Insert **inside the IIFE**, after `buildMovedState` and before the
`// ---------- Exports ----------` block:

```js
  // Import caps. Rejection, not truncation: a file over these is a mistake or an
  // attack, and silently keeping part of it hides that.
  const MAX_IMPORT_WORKSPACES = 200;
  const MAX_IMPORT_TABS = 500;

  // Parse an exported backup. Returns { ok: true, workspaces } or
  // { ok: false, error }. Never throws — the caller shows `error` verbatim.
  //
  // TRUST BOUNDARY: this text comes from a user-chosen file and is untrusted,
  // unlike the committed icon dataset. `icon.paths` is dropped on purpose: it is
  // injected with innerHTML by ICON_SVG in popup.js. The caller re-resolves paths
  // from icon-data.json by name, so hostile markup can never reach the DOM.
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: "That file is not valid JSON." };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "That file is not a Tabitha backup." };
    }
    if (data.format !== "tabitha-workspaces") {
      return { ok: false, error: "That file is not a Tabitha backup." };
    }
    if (data.version !== 1) {
      return { ok: false, error: `Unsupported backup version: ${data.version}.` };
    }
    if (!Array.isArray(data.workspaces)) {
      return { ok: false, error: "That backup has no workspaces list." };
    }
    if (data.workspaces.length > MAX_IMPORT_WORKSPACES) {
      return {
        ok: false,
        error: `Too many workspaces (${data.workspaces.length}, max ${MAX_IMPORT_WORKSPACES}).`,
      };
    }

    const seen = new Set();
    const workspaces = [];
    for (const raw of data.workspaces) {
      if (!raw || typeof raw !== "object") continue;
      const name = cleanName(raw.name);
      if (!name) continue;

      const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
      if (rawTabs.length > MAX_IMPORT_TABS) {
        return {
          ok: false,
          error: `"${name}" has too many tabs (${rawTabs.length}, max ${MAX_IMPORT_TABS}).`,
        };
      }
      const tabs = rawTabs
        .filter((t) => t && isTrackableUrl(t.url))
        .map((t) => ({ url: t.url, pinned: t.pinned === true }));

      // A missing or duplicate id would collide in storage, so mint a fresh one.
      let id = typeof raw.id === "string" && raw.id ? raw.id : null;
      if (!id || seen.has(id)) id = crypto.randomUUID();
      seen.add(id);

      const ws = { id, name, tabs };
      const iconName =
        raw.icon && typeof raw.icon === "object" && typeof raw.icon.name === "string"
          ? raw.icon.name.trim()
          : "";
      // Name only. Never carry `paths` across the trust boundary.
      if (iconName) ws.icon = { name: iconName };
      workspaces.push(ws);
    }
    return { ok: true, workspaces };
  }
```

Then extend the export object in the same file:

```js
  const TabithaCore = { isTrackableUrl, cleanName, MAX_ICON_PATHS, normalizeIcon, buildMovedState, parseBackup, MAX_IMPORT_WORKSPACES, MAX_IMPORT_TABS };
```

- [ ] **Step 4: Update the exported-key assertion in `tests/browser-load.test.js`**

That test pins the exact `TabithaCore` key list, so it fails until updated.
Replace the array in the third test with:

```js
    [
      "MAX_ICON_PATHS",
      "MAX_IMPORT_TABS",
      "MAX_IMPORT_WORKSPACES",
      "buildMovedState",
      "cleanName",
      "isTrackableUrl",
      "normalizeIcon",
      "parseBackup",
    ].sort(),
```

- [ ] **Step 5: Run the full suite**

Run: `node --test tests/*.test.js`
Expected: PASS, 60 tests (48 existing + 12 new).

- [ ] **Step 6: Commit**

```bash
git add shared/core.js tests/core-backup.test.js tests/browser-load.test.js
git commit -m "feat: validate imported backups in core.js"
```

---

### Task 2: `exportState` and `importState` message types

**Files:**
- Modify: `chrome/background.js` (handler switch, new function, `module.exports`)
- Modify: `firefox/background.js` (handler switch, new function, `module.exports`)
- Test: `tests/chrome-backup-actions.test.js` (create)
- Test: `tests/firefox-backup-actions.test.js` (create)
- Modify: `CLAUDE.md` (Message protocol section)

**Interfaces:**
- Consumes: `getState()`, `setState()`, `isTrackableUrl()`, `normalizeIcon()` —
  all already present in both background files.
- Produces: `importWorkspaces(list)` returning the stored count, exported from
  both background modules for tests. Message `exportState` -> `{ ok, workspaces }`;
  message `importState { workspaces }` -> `{ ok, count }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/chrome-backup-actions.test.js`:

```js
const noopListener = { addListener() {} };
globalThis.chrome = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { test } = require("node:test");
const assert = require("node:assert");
const { makeChrome } = require("./fake-chrome");
const { importWorkspaces } = require("../chrome/background.js");

test("importWorkspaces replaces every existing workspace", async () => {
  const fake = makeChrome({
    local: { workspaces: [{ id: "old", name: "Old", tabs: [] }], activeWorkspaceId: "old" },
  });
  globalThis.chrome = fake;
  const count = await importWorkspaces([{ id: "new", name: "New", tabs: [] }]);
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(fake._peek.local().workspaces.map((w) => w.name), ["New"]);
});

// Invariant 4: Default tracks nothing and closes nothing. An imported id would
// point at a workspace whose tabs are not open.
test("importWorkspaces always clears activeWorkspaceId", async () => {
  const fake = makeChrome({
    local: { workspaces: [{ id: "old", name: "Old", tabs: [] }], activeWorkspaceId: "old" },
  });
  globalThis.chrome = fake;
  await importWorkspaces([{ id: "a", name: "A", tabs: [] }]);
  assert.strictEqual(fake._peek.local().activeWorkspaceId, null);
});

test("importWorkspaces drops an icon that has no paths", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  await importWorkspaces([{ id: "a", name: "A", tabs: [], icon: { name: "gem" } }]);
  assert.ok(!("icon" in fake._peek.local().workspaces[0]));
});

test("importWorkspaces keeps a fully-formed icon", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  const icon = { name: "gem", paths: '<path d="M1 1"/>' };
  await importWorkspaces([{ id: "a", name: "A", tabs: [], icon }]);
  assert.deepStrictEqual(fake._peek.local().workspaces[0].icon, icon);
});

test("importWorkspaces filters untrackable tabs", async () => {
  const fake = makeChrome({ local: {} });
  globalThis.chrome = fake;
  await importWorkspaces([
    { id: "a", name: "A", tabs: [{ url: "https://ok.com/" }, { url: "chrome://x" }] },
  ]);
  assert.deepStrictEqual(fake._peek.local().workspaces[0].tabs, [
    { url: "https://ok.com/", pinned: false },
  ]);
});

test("importing an empty list clears all workspaces", async () => {
  const fake = makeChrome({ local: { workspaces: [{ id: "a", name: "A", tabs: [] }] } });
  globalThis.chrome = fake;
  const count = await importWorkspaces([]);
  assert.strictEqual(count, 0);
  assert.deepStrictEqual(fake._peek.local().workspaces, []);
});
```

Create `tests/firefox-backup-actions.test.js` — identical, but with the Firefox
globals and module. Replace the first block and the two requires with:

```js
const noopListener = { addListener() {} };
globalThis.browser = {
  tabs: { onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener },
  runtime: { onMessage: noopListener },
};

const { test } = require("node:test");
const assert = require("node:assert");
const { makeBrowser } = require("./fake-browser");
const { importWorkspaces } = require("../firefox/background.js");
```

and in every test body replace `makeChrome(` with `makeBrowser(` and
`globalThis.chrome = fake` with `globalThis.browser = fake`. Keep the same six
test names and assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/chrome-backup-actions.test.js tests/firefox-backup-actions.test.js`
Expected: FAIL — `importWorkspaces is not a function`.

- [ ] **Step 3: Implement in `chrome/background.js`**

Add above the `module.exports` block:

```js
// Replace every workspace with an imported set. activeWorkspaceId goes to null
// on purpose: Default tracks nothing and closes nothing (invariant 4), and an
// imported id would point at a workspace whose tabs are not open.
//
// Re-validates rather than trusting the caller: the options page has already run
// parseBackup, but this is the only door into storage and it should hold on its
// own.
async function importWorkspaces(list) {
  const workspaces = (Array.isArray(list) ? list : []).map((w) => {
    const icon = normalizeIcon(w.icon);
    const tabs = (Array.isArray(w.tabs) ? w.tabs : [])
      .filter((t) => t && isTrackableUrl(t.url))
      .map((t) => ({ url: t.url, pinned: t.pinned === true }));
    return { id: w.id, name: w.name, tabs, ...(icon ? { icon } : {}) };
  });
  await setState({ workspaces, activeWorkspaceId: null });
  dlog("imported", workspaces.length, "workspaces");
  return workspaces.length;
}
```

Add to the handler switch, after the `getState` case:

```js
        case "exportState": {
          const { workspaces } = await getState();
          sendResponse({ ok: true, workspaces });
          break;
        }
        case "importState":
          sendResponse({ ok: true, count: await importWorkspaces(msg.workspaces) });
          break;
```

Add `importWorkspaces` to `module.exports`.

- [ ] **Step 4: Implement in `firefox/background.js`**

Add the identical `importWorkspaces` function (same comment, same body) above its
`module.exports`. Add to its handler switch, after the `getState` case — note
this file returns values rather than calling `sendResponse`:

```js
      case "exportState": {
        const { workspaces } = await getState();
        return { ok: true, workspaces };
      }
      case "importState":
        return { ok: true, count: await importWorkspaces(msg.workspaces) };
```

Add `importWorkspaces` to its `module.exports` list.

- [ ] **Step 5: Run the full suite**

Run: `node --test tests/*.test.js`
Expected: PASS, 72 tests.

- [ ] **Step 6: Document the protocol in `CLAUDE.md`**

In the "Message protocol (popup -> background)" section, add after the
`setIcon` entry:

```markdown
- `exportState` -> returns `{ ok, workspaces }` for the options page to write to
  a file. `activeWorkspaceId` is deliberately not exported: it is per-browser
  runtime state, not part of a backup.
- `importState` `{ workspaces }` -> replaces every workspace and sets
  `activeWorkspaceId` to `null` (invariant 4 — an imported id would point at a
  workspace whose tabs are not open). Returns `{ ok, count }`. Re-validates
  every record, so it is safe even though the options page already validated.
```

- [ ] **Step 7: Commit**

```bash
git add chrome/background.js firefox/background.js tests/chrome-backup-actions.test.js tests/firefox-backup-actions.test.js CLAUDE.md
git commit -m "feat: add exportState and importState message types"
```

---

### Task 3: Topbar, cog, and sentence-case headings

**Files:**
- Modify: `shared/popup.html:7-9` (add header before the first `<section>`)
- Modify: `shared/popup.css:34-43` (`.section-head`), `:187` (`.icon-picker-cat`), plus new topbar rules
- Modify: `shared/popup.js` (cog click handler)

**Interfaces:**
- Consumes: `api` (the `browser ?? chrome` alias already at the top of popup.js).
- Produces: nothing other tasks depend on. The cog calls
  `api.runtime.openOptionsPage()`, which Task 4 makes resolve to a real page.

- [ ] **Step 1: Add the header to `shared/popup.html`**

Immediately after `<body>` and before the first `<section class="section">`:

```html
    <header class="topbar">
      <span class="brand">Tabitha</span>
      <button id="settings" class="topbar-btn" title="Settings" aria-label="Settings">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    </header>
```

- [ ] **Step 2: Add topbar styles and switch headings to sentence case in `shared/popup.css`**

Add after the `body { ... }` rule:

```css
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
.brand { font-weight: 600; }
.topbar-btn {
  display: inline-flex;
  align-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 5px;
}
.topbar-btn:hover { color: var(--fg); background: #2a2a30; }
```

In `.section-head`, delete these two lines — the markup already reads "Create new
workspace", and the letter-spacing only existed to make uppercase legible:

```css
  letter-spacing: 0.05em;
  text-transform: uppercase;
```

In `.icon-picker-cat`, delete `text-transform: uppercase;` and
`letter-spacing: 0.05em;` for the same reason.

- [ ] **Step 3: Wire the cog in `shared/popup.js`**

Add next to the other `getElementById` lookups near the top:

```js
const settingsEl = document.getElementById("settings");
```

Add near the other event listeners:

```js
// Settings lives in a page, not the popup: a file picker opened from a popup
// steals focus and destroys the popup's JS context, so Import cannot work here.
settingsEl.addEventListener("click", () => {
  api.runtime.openOptionsPage();
});
```

- [ ] **Step 4: Sync and verify in the harness**

Run:
```bash
node tools/sync.mjs && node --test tests/*.test.js
```
Expected: sync prints both targets; tests PASS, 72 tests.

Then eyeball the layout:
```bash
python3 -m http.server 8731
```
Open `http://localhost:8731/test/harness.html`. Expected: "Tabitha" top-left, cog
top-right on one line above a divider; all headings sentence case.

The harness stubs `chrome.*` by hand and has **no** `runtime.openOptionsPage`, so
clicking the cog throws `TypeError: ...openOptionsPage is not a function`. Add a
stub to the harness's `chrome.runtime` object so it logs instead:

```js
      openOptionsPage: () => console.log("[harness] openOptionsPage()"),
```

`test/harness.html` is gitignored and local-only, so this change is not committed
and must not appear in Step 5's `git add`.

- [ ] **Step 5: Commit**

```bash
git add shared/popup.html shared/popup.css shared/popup.js
git commit -m "feat: add topbar with settings cog, sentence-case headings"
```

---

### Task 4: The options page

**Files:**
- Create: `shared/options.html`
- Create: `shared/options.js`
- Modify: `shared/popup.css` (append an Options page block)
- Modify: `tools/sync.mjs:21` (`ASSETS`)
- Modify: `.gitignore` (four new synced copies)
- Modify: `chrome/manifest.json`, `firefox/manifest.json` (`options_ui`)
- Modify: `CLAUDE.md` (File map), `README.md` (Backup and restore)

**Interfaces:**
- Consumes: `parseBackup()` from Task 1 (via `globalThis.TabithaCore`);
  `exportState` / `importState` from Task 2.
- Produces: nothing later tasks consume. Task 5 depends only on Export existing
  and working.

- [ ] **Step 1: Create `shared/options.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Tabitha settings</title>
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body class="options">
    <header class="topbar">
      <span class="brand">Tabitha settings</span>
    </header>

    <section class="section">
      <h2 class="section-head">Backup and restore</h2>
      <p class="hint">
        Export writes every workspace to a JSON file. Import replaces the
        workspaces in this browser with the ones in that file.
      </p>
      <div class="add-actions">
        <button id="export" class="primary">Export workspaces</button>
        <button id="importPick" class="primary">Import workspaces</button>
        <input id="importFile" type="file" accept="application/json,.json" hidden />
      </div>

      <div id="confirm" class="confirm" hidden>
        <p id="confirmText"></p>
        <ul id="confirmList" class="confirm-list"></ul>
        <div class="add-actions">
          <button id="confirmGo" class="primary">Replace</button>
          <button id="confirmCancel" class="primary">Cancel</button>
        </div>
      </div>

      <p id="status" class="status" hidden></p>
    </section>

    <script src="core.js"></script>
    <script src="options.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `shared/options.js`**

```js
// Tabitha (options page) — shared by both targets.
//
// Settings live in a page rather than the popup because a file picker opened
// from a popup steals focus and destroys the popup's JS context, so Import
// could never work there.
//
// Like the popup, this file holds no decisions: it reads a file, validates it,
// asks for confirmation, and sends a message. The background owns storage.

const api = globalThis.browser ?? globalThis.chrome;
const { parseBackup } = globalThis.TabithaCore;

let TABITHA_DEBUG = true;
try {
  api.management
    .getSelf()
    .then((info) => {
      TABITHA_DEBUG = info.installType === "development";
    })
    .catch(() => {});
} catch (_) {
  // No management namespace: leave logging on.
}
function dlog(...args) {
  if (TABITHA_DEBUG) console.log("[TABITHA]", ...args);
}

const exportEl = document.getElementById("export");
const importPickEl = document.getElementById("importPick");
const importFileEl = document.getElementById("importFile");
const confirmEl = document.getElementById("confirm");
const confirmTextEl = document.getElementById("confirmText");
const confirmListEl = document.getElementById("confirmList");
const confirmGoEl = document.getElementById("confirmGo");
const confirmCancelEl = document.getElementById("confirmCancel");
const statusEl = document.getElementById("status");

// Workspaces waiting on the user's confirmation.
let pending = null;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` status-${kind}` : ""}`;
  statusEl.hidden = !text;
}

function hideConfirm() {
  pending = null;
  confirmEl.hidden = true;
  confirmListEl.textContent = "";
}

// ---------- Export ----------

exportEl.addEventListener("click", async () => {
  setStatus("");
  const res = await api.runtime.sendMessage({ type: "exportState" });
  const payload = {
    format: "tabitha-workspaces",
    version: 1,
    exportedAt: new Date().toISOString(),
    workspaces: res.workspaces,
  };
  const stamp = payload.exportedAt.slice(0, 10);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `tabitha-workspaces-${stamp}.json`;
  a.click();
  // Revoking immediately can cancel the download in some builds; one turn is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  dlog("exported", res.workspaces.length, "workspaces");
  setStatus(`Exported ${res.workspaces.length} workspaces.`, "ok");
});

// ---------- Import ----------

importPickEl.addEventListener("click", () => {
  setStatus("");
  hideConfirm();
  // Reset so choosing the same file twice still fires `change`.
  importFileEl.value = "";
  importFileEl.click();
});

// Icons arrive name-only: parseBackup strips `paths` because it reaches
// innerHTML in the popup and an imported file is untrusted. Re-resolve from our
// own committed dataset, and drop any name it does not contain.
async function resolveIcons(workspaces) {
  if (!workspaces.some((w) => w.icon)) return workspaces;
  let byName = new Map();
  try {
    const data = await fetch("icon-data.json").then((r) => r.json());
    byName = new Map(data.map((i) => [i.name, i.paths]));
  } catch (e) {
    dlog("icon-data.json unavailable, importing without icons", e);
  }
  return workspaces.map((w) => {
    if (!w.icon) return w;
    const paths = byName.get(w.icon.name);
    if (!paths) {
      const { icon: _drop, ...rest } = w;
      return rest;
    }
    return { ...w, icon: { name: w.icon.name, paths } };
  });
}

importFileEl.addEventListener("change", async () => {
  const file = importFileEl.files && importFileEl.files[0];
  if (!file) return;

  const parsed = parseBackup(await file.text());
  if (!parsed.ok) {
    setStatus(parsed.error, "bad");
    return;
  }

  const current = await api.runtime.sendMessage({ type: "exportState" });
  pending = await resolveIcons(parsed.workspaces);

  confirmTextEl.textContent =
    `Replace ${current.workspaces.length} workspaces with ${pending.length} from this file? ` +
    "This cannot be undone.";
  for (const w of pending) {
    const li = document.createElement("li");
    // textContent, not innerHTML: names come from an untrusted file.
    li.textContent = `${w.name} — ${w.tabs.length} tabs`;
    confirmListEl.appendChild(li);
  }
  confirmEl.hidden = false;
});

confirmCancelEl.addEventListener("click", () => {
  hideConfirm();
  setStatus("Import cancelled. Nothing changed.");
});

confirmGoEl.addEventListener("click", async () => {
  if (!pending) return;
  const res = await api.runtime.sendMessage({ type: "importState", workspaces: pending });
  const n = res.count;
  hideConfirm();
  setStatus(`Imported ${n} workspaces. Open the popup and pick one.`, "ok");
});
```

- [ ] **Step 3: Append options styles to `shared/popup.css`**

```css
/* Options page. Wider than the popup, which is capped at 420px. */
body.options { min-width: 0; max-width: 720px; margin: 0 auto; }
.hint { margin: 0 0 12px; color: var(--muted); }
.status { margin: 12px 0 0; color: var(--muted); }
.status-ok { color: var(--green); }
.status-bad { color: var(--danger); }
.confirm { margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.confirm p { margin: 0 0 8px; }
.confirm-list { margin: 0 0 12px; padding-left: 18px; max-height: 220px; overflow-y: auto; color: var(--muted); }
```

- [ ] **Step 4: Register the new files in `tools/sync.mjs`**

Replace the `ASSETS` line:

```js
const ASSETS = ["popup.html", "popup.css", "popup.js", "options.html", "options.js", "core.js", "icon-data.json", "icons"];
```

- [ ] **Step 5: Gitignore the synced copies**

Add to the synced-copies block in `.gitignore`:

```
chrome/options.html
chrome/options.js
firefox/options.html
firefox/options.js
```

- [ ] **Step 6: Register the page in both manifests**

In `chrome/manifest.json` and `firefox/manifest.json`, add after the `"action"`
block:

```json
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
```

- [ ] **Step 7: Sync and run the suite**

Run:
```bash
node tools/sync.mjs && node --test tests/*.test.js
```
Expected: sync prints both targets; tests PASS, 72 tests. Confirm
`chrome/options.html` and `firefox/options.html` now exist and are untracked:
```bash
git status --short chrome/ firefox/
```
Expected: no `options.*` entries (they are gitignored).

- [ ] **Step 8: Verify in a real browser**

Load `chrome/` unpacked at `chrome://extensions`, click the cog. Expected: the
settings page opens in a tab. Click **Export workspaces** — a
`tabitha-workspaces-YYYY-MM-DD.json` file downloads. Open it and confirm it has
`format`, `version`, `exportedAt`, and every workspace.

Then click **Import workspaces**, pick that same file, and confirm the dialog
reads "Replace N workspaces with N from this file?". Click Replace. Expected:
"Imported N workspaces." and the popup still lists them all.

Also import a deliberately broken file to check the error path:
```bash
echo '{"format":"nope"}' > /tmp/bad.json
```
Expected: "That file is not a Tabitha backup." and nothing changes.

- [ ] **Step 9: Update the docs**

In `CLAUDE.md`, add to the File map, after the `popup.html` entry:

```markdown
- `options.html` / `options.js` — the settings page, opened by the popup's cog.
  Registered via `options_ui` with `open_in_tab`. It exists as a page rather than
  a popup panel because a file picker opened from a popup steals focus and
  destroys the popup's JS context, so Import could never work there. Holds
  backup/restore; reuses `popup.css`.
```

In `README.md`, add a section after the Firefox install notes:

```markdown
## Backup and restore

Click the cog in the popup to open settings.

**Export** writes every workspace to `tabitha-workspaces-YYYY-MM-DD.json`.
**Import** replaces the workspaces in this browser with that file's, after
showing you exactly what it will replace.

This is also how you move workspaces between Chrome and Firefox: export from one,
import into the other. The format is identical in both.

Imported icons are looked up by name in Tabitha's own icon set — the file's own
icon markup is discarded, so a backup from someone else cannot inject anything
into the UI.
```

- [ ] **Step 10: Commit**

```bash
git add shared/options.html shared/options.js shared/popup.css tools/sync.mjs .gitignore chrome/manifest.json firefox/manifest.json CLAUDE.md README.md
git commit -m "feat: add options page with workspace export and import"
```

---

### Task 5: Pin the Chrome extension id

**Do not start this task until Task 4 is merged and you have exported a backup
file.** Adding `key` changes the Chrome extension id, which orphans the current
`storage.local` exactly as the folder move did. Export first, add the key, then
import.

**Files:**
- Modify: `chrome/manifest.json` (add `"key"`)
- Modify: `CLAUDE.md` (note why the key exists)

**Interfaces:**
- Consumes: the Export button from Task 4.
- Produces: nothing. This is the final task.

- [ ] **Step 1: Export a backup through the UI**

Open the popup, click the cog, click **Export workspaces**. Keep the downloaded
file. This is the only copy of your data that survives the id change.

- [ ] **Step 2: Generate a keypair**

```bash
mkdir -p ~/.config/tabitha && openssl genrsa -out ~/.config/tabitha/chrome-key.pem 2048 && chmod 600 ~/.config/tabitha/chrome-key.pem
```
Expected: the file exists with `-rw-------` permissions. It lives outside the
repo, like `amo.env`, so it can never be committed.

- [ ] **Step 3: Derive the public key for the manifest**

```bash
openssl rsa -in ~/.config/tabitha/chrome-key.pem -pubout -outform DER 2>/dev/null | base64 | tr -d '\n'
```
Expected: one long base64 line starting `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A`.

- [ ] **Step 4: Add it to `chrome/manifest.json`**

Add as the first key inside the top-level object, with the base64 from Step 3:

```json
  "key": "MIIBIjANBgkqhkiG9w0B...",
```

- [ ] **Step 5: Confirm the id actually changed and is now path-independent**

Reload the extension at `chrome://extensions`. Expected: the id shown on the card
is **not** `bakdebcjmkoohcbfebhfflbgjbkbknlk` (the old path-derived one), and the
workspace list is empty — the id changed, so storage is fresh. That empty list is
the expected, planned outcome, not a failure.

- [ ] **Step 6: Import the backup**

Click the cog, **Import workspaces**, pick the file from Step 1, confirm.
Expected: every workspace is back.

- [x] **Step 7: Prove the fix works** — done 2026-07-28, for real rather than as
  a rehearsal. The repo moved from `Developer/pathway/tabitha` to
  `Developer/personal/tabitha`. Chrome reloaded the extension from the new path,
  the id was unchanged and every workspace was still there. The key works.

- [ ] **Step 8: Document it in `CLAUDE.md`**

Add to the Layout or Run and test section:

```markdown
### Why chrome/manifest.json has a "key"

Chrome derives an unpacked extension's id by hashing the absolute path of its
folder. Moving the folder therefore changes the id, and the extension wakes up
against an empty `storage.local` with every workspace apparently gone. That
happened once, during the monorepo restructure, and recovering the data meant
hand-parsing a LevelDB.

`"key"` pins the id to a keypair instead. The private half is at
`~/.config/tabitha/chrome-key.pem` (chmod 600, outside the repo); only the public
half is in the manifest, which is safe to commit. Do not change or remove it —
doing so orphans every stored workspace again. Firefox needs no equivalent: its
id comes from `browser_specific_settings.gecko.id`.
```

- [ ] **Step 9: Commit**

```bash
git add chrome/manifest.json CLAUDE.md
git commit -m "fix: pin the Chrome extension id so moving the folder is safe"
```
