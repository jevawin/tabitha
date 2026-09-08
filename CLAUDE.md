# CLAUDE.md

Context for Claude Code working on this project. Read this first.

**Keep this file current.** When you add a feature, change the architecture, add
a message type, alter the data model, or add tooling, update the matching section
here (Layout, Data model, Message protocol, Run and test, Invariants) in the same
change. Stale docs here are worse than none. Prune notes that no longer hold.

## What this is

**Tabitha** gives Safari-style **workspaces** to Chrome and Firefox. Switch a
workspace and the tabs on screen swap out for another set. The active workspace
tracks tab changes live, so it behaves like saved session state, not a static
bookmark list.

One repo, two extensions, one shared UI. Repo: `github.com/jevawin/tabitha`
(renamed from `chrome-tab-manager` on 2026-07-25 — GitHub redirects the old URL).

### The two targets are not equivalent

This is the single most important thing to understand before changing anything.

**Firefox is the real implementation.** `browser.tabs.hide()` / `.show()` do
exactly what Safari does: tabs vanish from the strip, stay loaded, come back
instantly. Firefox does not discard a hidden tab, so scroll position, half-typed
forms, playing media and open websockets all survive a switch.

**Chrome is a compromise.** Chrome has no API for hiding a tab. The switch closes
the old tabs and reopens the new ones, so every page flashes and reloads and
loses its state. Two alternatives were built and rejected in July 2026:

- **Native tab groups** (collapse/expand). Works, keeps state — but leaves a
  permanent collapsed chip in the tab strip for every hidden workspace. Rejected:
  a visible marker is exactly what the author is trying to avoid.
- **A hidden stash window** (move tabs to a minimised window). Also works — but
  parks a Chrome window in the Dock. No extension API can hide a window.

There is no third option. Chrome cannot do this cleanly. **Do not reintroduce tab
groups or stash windows.** If a proposed feature needs one, it is the wrong
feature — build it for Firefox instead.

## Layout

```
shared/     the source of truth for everything both targets use
chrome/     Chrome-specific: manifest + background strategy
firefox/    Firefox-specific: manifest + background strategy
tools/      sync.mjs, gen-icon-data.mjs
tests/      Node tests for shared core and both targets
docs/       design notes and handoffs
```

- `shared/popup.html` / `popup.css` / `popup.js` — the dropdown UI. Thin, and
  byte-identical across targets. Sends messages to the background and renders
  state. `popup.js` also holds the icon picker overlay (pure presentation) and
  the icon-box used in the create / move-new / rename flows.
- `shared/options.html` / `options.js` — the settings page, opened by the
  popup's cog. Registered via `options_ui` with `open_in_tab`. It exists as a
  page rather than a popup panel because a file picker opened from a popup
  steals focus and destroys the popup's JS context, so Import could never work
  there. Holds backup/restore; reuses `popup.css`.
- `shared/core.js` — pure helpers used by both backgrounds: `isTrackableUrl`,
  `cleanName`, `normalizeIcon`, `normalizeIconNodes`, `ICON_NODE_TAGS`,
  `ICON_NODE_ATTRS`, `buildMovedState`, `MAX_ICON_PATHS`. **Nothing in
  here may touch `chrome.*` / `browser.*`.** That rule is what keeps it testable
  once instead of twice.
- `shared/icon-data.json` — generated, committed Lucide dataset: array of
  `{ name, category, tags, paths, nodes }`. `nodes` (`[[tag, {attr: value}],
  ...]`, straight from lucide-static's `icon-nodes.json`, untransformed) is
  the structured form the palette renders with `createElementNS` +
  `setAttribute` — no markup parsing inside the page overlay. `paths` (the
  same geometry serialised to inner SVG markup) stays alongside it because the
  popup still renders icons with `innerHTML`; migrating the popup off `paths`
  is a later change. Lazy-fetched by the popup only when the icon picker
  opens; the palette never fetches it — a workspace row's `icon.nodes` already
  travels inside `paletteState`.
- `shared/icons/` — toolbar icon. `folder.svg` is the Lucide source; the PNGs are
  rasterized from it. Regenerate:
  `cd shared/icons && for s in 16 32 48 128; do rsvg-convert -w $s -h $s folder.svg -o icon$s.png; done`
- `shared/palette.js` — the Firefox-only command-palette overlay, injected into
  the active page on Cmd+Shift+, . Mounts a shadow root (never an iframe —
  `backdrop-filter` cannot blur across an iframe boundary) and renders tabs,
  saved records and workspaces grouped into rows by `buildPaletteRows` (which
  ranks with `rankPaletteItems`): each workspace is a selectable, collapsible
  header row with its tabs indented beneath, so searching a workspace NAME
  pulls in that whole workspace unfiltered. With no query, only the active
  workspace (plus anything the user has expanded this session, via the local
  `expanded` Set) shows its tabs — capped at `PALETTE_COLLAPSED_TABS` (5) with
  a trailing `{kind:"more"}` row, or uncapped if expanded to "full" (the same
  Set, keyed by id + `PALETTE_FULL_SUFFIX` — see `buildPaletteRows`' doc
  comment in `shared/core.js`); every other workspace, and the synthetic
  "Not in a workspace" section, show header-only. A query bypasses all of
  that — every matched section shows fully expanded, uncapped. `expanded` is
  fresh on every `open()`; it is presentation state, not persisted.
  Header rows render a real workspace icon (`icon.nodes`, re-validated via
  `normalizeIconNodes` even though the background already did — the last
  gate before it becomes DOM inside an arbitrary page) or the default
  ellipsis glyph. Tab rows render `favIconUrl` behind a scheme allowlist
  (`https:`/`http:`/`data:image/`) with an `onerror` fallback to a dot glyph,
  same pattern as `popup.js`'s move strip; a hidden tab dims instead of
  swapping glyph. Rows carry `num` (1-based, capped at 9) for the Cmd+1–9
  binding, which now activates whichever row owns that number (open a
  workspace/tab, or expand a "more" row) rather than firing a search — see
  "Known limitations" for where that binding moved. Dumb like `popup.js`
  otherwise: it renders and sends `paletteState` / `jumpToTab` /
  `openWorkspace` / `paletteSearch` messages; every *data* decision lives in
  `firefox/background.js` (collapse/expand is the one UI-only exception, kept
  local since it has nowhere else sensible to live). Every value that comes
  from a tab, workspace or imported backup is untrusted and must reach the
  DOM via `textContent`, a validated attribute, or `createElementNS` +
  `setAttribute` — never `innerHTML`.
- `shared/palette.css.js` — the palette's stylesheet as an exported JS string
  (`globalThis.TABITHA_PALETTE_CSS`), not a `.css` file or a `<style>` element.
  A constructed `CSSStyleSheet` adopted into the shadow root cannot be blocked
  by a strict page CSP the way an injected `<style>` can; a real `.css` file
  would need `web_accessible_resources` plus a fetch.
- `chrome/background.js` — close/reopen swap. Chrome's compromise strategy.
- `firefox/background.js` — hide/show switch. The real one.
- `tools/sync.mjs` — copies `shared/` into `chrome/` and `firefox/`.

The popup holds no logic beyond rendering and sending messages. All decisions
live in the background. Keep it that way.

### Why sync.mjs exists

A browser cannot follow a path out of the extension root, so a manifest in
`chrome/` cannot reference `../shared/popup.html`. Each target folder has to be a
complete extension. `node tools/sync.mjs` copies `shared/` into both.

**The copies are gitignored. `shared/` is the only source of truth.** Editing
`chrome/popup.js` or `firefox/core.js` is always a mistake — the next sync
overwrites it. If you change anything in `shared/`, run the sync before loading
the extension or the browser will run stale code.

### How core.js is loaded

Three environments, one file:

- **Firefox** — listed first in `background.scripts`, so its declarations land on
  the global scope that `background.js` then runs in.
- **Chrome** — `importScripts("core.js")` at the top of the service worker. This
  requires the manifest to *not* set `"type": "module"`.
- **Node** — `require("../shared/core.js")`, which is why tests can run without a
  sync having happened.

Each `background.js` opens with the same shim to cover all three. Leave it alone
unless you are changing how the extension loads.

## Data model

Persistent state in `storage.local`, identical in both targets:

```
{
  workspaces: [
    { id: string (uuid), name: string,
      tabs: [{ url: string, pinned: boolean, title?: string }],
      icon?: { name: string, paths: string, nodes?: [[string, object]] },
      lastActiveUrl?: string }
  ],
  activeWorkspaceId: string | null
}
```

`icon` is optional. `icon.paths` (the Lucide inner SVG markup) is stored so a row
renders without loading `icon-data.json`. `icon.nodes` (`[[tag, {attr: value}],
...]`, validated through `normalizeIconNodes`) is the same geometry structured
for the palette to render with `createElementNS` + `setAttribute` rather than
`innerHTML` — the palette overlay lives inside arbitrary web pages, where
markup injection would be a real escalation, so `shared/palette.js` renders a
workspace header's icon from `nodes` only, never `paths`. `nodes` is optional
and additive: a record with only `name`/`paths` (everything saved before this
field existed) still validates and renders in the popup exactly as before.
Every path that sets an icon populates `nodes` when it can: the popup's icon
picker sends it straight from the already-open dataset, and `options.js`
re-resolves it by name alongside `paths` on import. `firefox/background.js`'s
`backfillIconNodes()` (`runtime.onInstalled`) covers the remaining case —
records saved before `nodes` existed — resolving it against the committed
dataset by name, once, skipping the pass entirely when nothing needs it. A
backup import never carries `paths` or `nodes` across the trust boundary — `parseBackup` keeps
only `icon.name` and the caller re-resolves geometry from `icon-data.json`.
Absent `icon` renders the `ellipsis` default sentinel.

`tabs[].title` is the page title at the time it was last saved, used only so
the palette can show and rank a saved (currently hidden/unmaterialized) tab by
its title instead of its raw URL. `lastActiveUrl` records which of a
workspace's tabs was focused when it was last left, so `openWorkspace` and a
workspace row's palette entry can land on that tab rather than an arbitrary
one. Both are best-effort and may be absent on older records.

A separate top-level `storage.local` key, **Firefox only**: `paletteTheme:
"system" | "light" | "dark"`, defaulting to `"system"`. `"system"` means the
palette's stylesheet decides via `prefers-color-scheme`; `"light"`/`"dark"` pin
it. There is no UI to set this yet — read with a junk-value fallback to
`"system"` so a hand-edited or corrupted value never reaches the DOM as a
`data-theme` attribute.

`activeWorkspaceId === null` means the **Default** state: no workspace is tracked,
and nothing is closed or hidden automatically. It occurs only on fresh install or
after deleting the active workspace.

Transient state in `storage.session` (cleared on browser restart):

- Both: `{ swapping: boolean }` — the live-tracking mute guard.
- Firefox also: `{ tabMap: { [workspaceId]: number[] } }` — which live tab ids
  each workspace owns. Session storage on purpose: a tab id is only valid for one
  browser run, so the two lifetimes match exactly and the map can never go stale
  across runs. **Never move it to `storage.local`.**

`tabs[].pinned` is always `false` in Firefox. Firefox refuses to hide a pinned
tab, so pinned tabs belong to no workspace and stay visible in all of them — the
same as Safari. The field is kept for shape compatibility with Chrome's records.

## How it works

### Live tracking (auto-save), both targets
`scheduleSync()` debounces (~400ms) on `tabs.onCreated`, `onRemoved`, `onMoved`,
and URL/`complete` `onUpdated`. Muted while switching, and in Default state.

- **Chrome** — `syncNow()` snapshots the whole window into the active workspace.
- **Firefox** — `syncNow()` re-claims the window's *visible* tabs. A tab opened
  with Cmd+T is visible, so it is picked up with no special case.

### The switch — Chrome (`chrome/background.js`)
1. Save the workspace being left, while its tabs are still open.
2. Set `swapping = true`.
3. Capture old tab ids.
4. Open the target's tabs (or one blank tab if empty).
5. Close the old tabs.
6. Set `activeWorkspaceId`; release the guard in a `finally`.

Open before close: closing the last tab closes the window.

### The switch — Firefox (`firefox/background.js`)
1. Bail if the target is already active.
2. Set `swapping = true`.
3. `claimVisible()` the outgoing workspace — records its ids, saves its URLs.
4. Resolve the target's live ids; `materialize()` from saved URLs only if none.
5. `tabs.show()` them.
6. Activate one of the target's tabs.
7. `hideTabs()` the outgoing set.
8. Set `activeWorkspaceId`; release the guard in a `finally`.

Step 6 must come before step 7: **Firefox refuses to hide the active tab.** Skip
it and one outgoing tab stays stubbornly on screen. The fake enforces this, so
the ordering is caught by tests rather than only in the browser.

### Firefox ownership
The active workspace owns the window's **visible**, unpinned, http/s tabs. Every
other workspace owns a set of **hidden** ones, listed in `tabMap`. Pinned tabs are
owned by nobody. That single rule replaces any need to tag tabs.

`claimVisible()` skips tabs another workspace still claims, because Firefox lets
the user un-hide a tab from its own hidden-tab menu — that tab must not be
swallowed by whatever workspace happens to be active. `opts.steal` overrides the
skip; "Save current tabs" is the only caller that uses it.

### Why Firefox's `hideTabs()` verifies
`tabs.hide()` resolves even when some tabs were ineligible. It hides what it can
and says nothing about the rest. Pinned tabs, the active tab, tabs being closed
and **tabs sharing screen, microphone or camera** all refuse. A video call tab
will not hide. So `hideTabs()` re-queries afterwards and logs what stayed behind
rather than assuming success. The tab is left visible and still belongs to its
workspace — never silently lost.

## Invariants — do not break these

**Both targets**

1. **Mute live tracking during a switch.** Without the `swapping` guard, the
   switch's own tab events feed back into auto-save and wipe or cross-contaminate
   workspaces. This is the central bug the design exists to prevent.
2. **Save the outgoing workspace before its tabs are closed or hidden.**
3. **Never let the window reach zero tabs.** Closing the last tab closes the
   window.
4. **Default (`activeWorkspaceId === null`) never closes, hides or tracks tabs.**
5. **Only http/https tabs are tracked.** `chrome://`, `about:` and extension
   pages cannot be reliably reopened, so `isTrackableUrl()` filters them out.
6. **The target window is the last focused normal window**, resolved by
   `getCurrentWindowId()`. Never use the popup's own window.
7. **All persistent state goes through `getState` / `setState`.** The service
   worker / event page can unload at any time, so never rely on module-level
   variables for anything that must survive. The debounce timer is the one
   allowed exception and it is best-effort.
8. **`shared/core.js` never touches a browser API.** If a helper needs `tabs` or
   `storage`, it belongs in a target's `background.js`.
9. **Never edit a synced copy.** Change `shared/`, then run the sync.

**Chrome only**

10. **Open new tabs before closing old ones** (invariant 3's specific form here).

**Firefox only**

11. **A switch never closes a tab.** Hiding is the entire point. Only `delete`
    and `importState` close tabs — `delete` closes the one workspace's, `import`
    clears the window so a restored backup does not inherit whatever was on
    screen — and only `materialize` opens them. Adding a `tabs.remove` to the
    switch path means the design has gone wrong.
12. **Activate a target tab before hiding the outgoing set.**
13. **Never assume `tabs.hide()` worked.** Verify, because it fails silently.

## Message protocol (popup -> background)

Identical in both targets, so the popup stays shared. Chrome's listener returns
`true` to keep the async channel open; Firefox's is `async` and returns the
response directly.

The four `palette*`/`jumpToTab`/`openWorkspace` messages below are Firefox-only
in practice — `shared/palette.js` is the only sender, and it is injected only
by `firefox/background.js`'s Cmd+Shift+, command. The handlers still live in
the shared switch statement like every other message.

Workspace names are mandatory. The popup disables both create buttons until the
name field has non-whitespace text; `create`/`createEmpty` reject blank names.

- `getState` -> `{ workspaces, activeWorkspaceId, activeTab }` where `activeTab`
  is `{ url, title, favIconUrl, trackable } | null` for the move strip.
- `create` `{ name, icon? }` -> "Save current tabs": claims the current tabs as a
  new workspace and makes it active. Does not switch. Firefox *steals* them from
  whichever workspace held them, forking the window rather than duplicating it.
- `createEmpty` `{ name, icon? }` -> "Start empty": creates an empty workspace,
  then switches into it (one blank tab; the rest close in Chrome, hide in Firefox).
- `switch` `{ id }` -> runs the switch.
- `moveTab` `{ targetId }` -> moves the active tab into an existing workspace and
  **follows** it there. Rejects non-http/https tabs and the active workspace as
  target. Firefox reassigns ownership only — the tab is never closed, hidden or
  reloaded.
- `moveTabToNew` `{ name, icon? }` -> creates a new workspace seeded with the
  active tab and follows it there.
- `setIcon` `{ id, icon }` -> sets/clears one workspace's icon.
- `exportState` -> returns `{ ok, workspaces }` for the options page to write to
  a file. `activeWorkspaceId` is deliberately not exported: it is per-browser
  runtime state, not part of a backup.
- `importState` `{ workspaces }` -> replaces every workspace and sets
  `activeWorkspaceId` to `null` (invariant 4 — the imported workspaces own no
  live tabs until their first switch). Returns `{ ok, count }`. Re-validates
  every record rather than trusting the options page: a record whose name is
  blank is dropped, a missing id is minted, untrackable tabs and invalid icons
  are stripped — so `count` can be lower than the file's record count.
  **Firefox also empties the working window and clears `tabMap`** — it closes the
  old workspaces' live tabs (same reason as `delete`: they are open, just hidden,
  and dropping the records that own them would strand them) *and* every remaining
  ownable visible tab. The second part matters because `tabMap` is session
  storage: after a browser restart it is empty, so restart-then-restore would
  otherwise leave the session-restored tabs on screen for the next switch's
  `claimVisible` to write into the freshly imported workspace. Pinned and
  non-http/s tabs are not ownable, so they survive.
- `delete` `{ id }` -> removes a workspace. **Firefox also closes its tabs** —
  they are open (just hidden) there, so leaving them would strand them.
- `rename` `{ id, name }` -> renames a workspace (inline pencil-edit in the popup).
- `paletteState` -> `{ ok, items, workspaces, activeWorkspaceId, theme }` for
  the palette overlay. `items` mixes three kinds: `{kind:"tab", tabId, url,
  title, favIconUrl, workspaceId, hidden}` for a live tab (`favIconUrl` is
  page-controlled — `shared/palette.js` gates it behind a scheme allowlist
  before it ever reaches an `<img src>`), `{kind:"saved", tabId:null, url,
  title, workspaceId, hidden:true}` for a workspace's saved-but-not-live
  record (no `favIconUrl` — nothing live to read one from), and
  `{kind:"workspace", workspaceId, title, url, icon}` for the workspace
  itself (its `url` is `lastActiveUrl`). `theme` is `paletteTheme`
  from the data model above, already validated.
- `jumpToTab` `{ tabId }` -> brings one specific live tab to the front,
  switching workspace first if it belongs to one that is not active. Never
  closes anything.
- `openWorkspace` `{ id }` -> switches to a workspace and, if it has a
  `lastActiveUrl` among its live tabs, activates that tab specifically rather
  than an arbitrary one.
- `paletteSearch` `{ query, where }` -> runs a browser search and files the
  result tab into a workspace without switching there. `where` is
  `{kind:"currentTab"}` (search in place), `{kind:"newTab"}` (new tab in the
  current workspace) or `{kind:"workspace", id}` (a hidden tab created and
  owned by that workspace). The palette UI has no way to send this third form
  today — Cmd+1–9 used to fire it directly and was repurposed by the row-
  grouping change (see "Known limitations") to activate whichever numbered
  row is on screen instead. The handler, and this `where` kind, are kept
  as-is for a later command mode to expose again — do not remove them just
  because nothing currently calls them. See the Known limitations note below
  on when that last form's URL becomes durable.

## Run and test

No build, but there is a sync. Always:

```
node tools/sync.mjs
```

**Chrome** — `chrome://extensions` -> Developer mode on -> Load unpacked -> pick
`chrome/`. After editing the service worker you MUST click the reload icon on the
extension card; the MV3 service worker caches the old code and reopening the
popup is not enough.

**Firefox** — `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on ->
pick `firefox/manifest.json`. Reload with the button on the add-on's card.
Temporary add-ons are removed when Firefox closes.

The first time Firefox hides a tab it shows a one-time notice explaining that
tabs are being hidden, how to reach them, and offering to disable the extension.
That is expected and cannot be suppressed.

### Why chrome/manifest.json has a "key"

Chrome derives an unpacked extension's id by hashing the absolute path of its
folder. Moving the folder therefore changes the id, and the extension wakes up
against an empty `storage.local` with every workspace apparently gone. That
happened once, during the monorepo restructure, and recovering the data meant
hand-parsing a LevelDB.

`"key"` pins the id to a keypair instead, so the folder can move freely. The
private half is at `~/.config/tabitha/chrome-key.pem` (chmod 600, outside the
repo); only the public half is in the manifest, which is safe to commit. **Do not
change or remove it** — doing so orphans every stored workspace again. Firefox
needs no equivalent: its id comes from `browser_specific_settings.gecko.id`.

Verified in anger on 2026-07-28: the repo moved from `Developer/pathway/tabitha`
to `Developer/personal/tabitha`, Chrome reloaded the extension from the new path,
and the id and every workspace survived.

### Permanent Firefox install (AMO signing)

Release Firefox hard-enforces extension signing — `xpinstall.signatures.required`
exists but is ignored on Release and Beta, so an unsigned build can only ever be
a temporary add-on. For a build that survives restarts, self-distribute it: sign
via AMO on the **unlisted** channel, which signs it for you without publishing it
to the public directory.

```
./tools/sign-firefox.sh
```

That syncs `shared/` first, then signs. It reads credentials from
`~/Developer/_env/amo.env` (override with `TABITHA_AMO_ENV`):

```
WEB_EXT_API_KEY=user:12345:67
WEB_EXT_API_SECRET=...
```

Generate them at https://addons.mozilla.org/en-US/developers/addon/api/key/ —
the secret is shown once. That file is deliberately **outside the repo** and
`chmod 600`, so it cannot be committed; `.env`/`*.env` are gitignored as a second
line of defence. The key is account-level rather than per-add-on, so it lives in
`~/Developer/_env/` (moved there 2026-07-31, from `~/.config/tabitha/`) and is
shared by every add-on signed under this AMO account — Bloomreach Tools reads
the same file. Nothing echoes the values. If it leaks, revoke at that URL.
`npx` keeps the "no dependencies" rule intact — web-ext is never added to the
repo. The signed `.xpi` lands in `web-ext-artifacts/` (gitignored); install it at
`about:addons` -> gear -> Install Add-on From File.

Two constraints:

- **The extension id is permanent.** `tabitha@jevawin`, set in
  `firefox/manifest.json`. Changing it makes Firefox treat the result as a
  different extension, so stored workspaces do not carry over.
- **Every upload needs a unique version.** Bump `version` in
  `firefox/manifest.json` before re-signing or AMO rejects it.

Note that a signed build reports `installType === "normal"`, so `dlog()` /
`derror()` are silent in it. Use a temporary add-on when you need the logs.

Node tests — `node --test tests/*.test.js` (`node --test tests/` fails on Node 24).
They run against `shared/` and the two `background.js` files directly, so a sync
is not required first.

- `tests/core-*.test.js` — the shared pure helpers, tested once. Includes
  `tests/core-palette.test.js` for `rankPaletteItems`.
- `tests/chrome-*.test.js` — Chrome actions against `tests/fake-chrome.js`.
- `tests/firefox-*.test.js` — Firefox actions against `tests/fake-browser.js`.
  Includes `firefox-palette-model.test.js` (tab titles / `lastActiveUrl`
  bookkeeping), `firefox-palette-state.test.js` (`buildPaletteState` and the
  theme lookup), `firefox-palette-jump.test.js` (`jumpToTab` / `openWorkspace`),
  `firefox-palette-search.test.js` (`paletteSearch`'s three `where` kinds), and
  `firefox-icon-backfill.test.js` (`backfillIconNodes`: gains nodes, leaves an
  unknown name alone, doesn't rewrite an already-backfilled record, and skips
  the network call entirely when nothing needs it).
- `tests/icon-data.test.js` — generated dataset sanity (shape + exclusions),
  plus every entry's `nodes` round-tripping unchanged through
  `normalizeIconNodes` and every tag/attribute in the dataset falling inside
  `ICON_NODE_TAGS`/`ICON_NODE_ATTRS` — the check that would catch a future
  Lucide bump introducing a new element or attribute outside the allowlist.
- `tests/browser-load.test.js` — loads the real `core.js` + `background.js` into
  one vm global scope, the way a browser does. The other suites `require()`
  core.js, so each file gets its own module scope and a collision between them is
  invisible. That gap shipped a load-time SyntaxError that stopped both
  extensions starting. **`shared/core.js` must stay wrapped in its IIFE** — a
  bare top-level `function foo(){}` there collides with background.js's
  `const { foo } = ...` and the extension never starts.

`fake-browser.js` models the Firefox behaviour that actually bites: `hide()`
resolving while silently refusing ineligible tabs, the active tab and pinned tabs
being unhideable, and activating a hidden tab revealing it. Add to it rather than
working around it — a fake that lies is worse than no test. Tabs can be flagged
`unhideable` in a fixture to stand in for one sharing screen, mic or camera.

Manual smoke test, both targets:
1. Open 3 tabs. Save as "A".
2. Type another name, "Start empty" into "B". Open 2 tabs there.
3. Click A. B's tabs go away, A's come back.
4. In A, open a new tab. Switch to B and back. The new tab must still be in A.

Manual smoke test, Firefox only — this is the point of the Firefox target:
1. In A, scroll a long page halfway and type into a search box without submitting.
2. Switch to B, then back to A.
3. The page must be exactly where you left it, text still there, no flash.
4. Play a video, switch away — you should still hear it while it is hidden.

Icon picker dataset regen (after a Lucide bump — edit `LUCIDE_VERSION` in the
script): `node tools/gen-icon-data.mjs`. Commit the updated `icon-data.json`.

## Known limitations

**Chrome**
- Switching reloads every page and loses its state. Inherent; see "The two
  targets are not equivalent".
- Single window. Tracks the last focused normal window only.

**Firefox**
- All tabs stay loaded. Hiding is not discarding, so every workspace visited this
  session is still in memory. That is deliberate — it is what keeps page state
  alive. `tabs.discard()` on hide is the escape hatch, at the cost of that state.
- A tab sharing screen, mic or camera will not hide. Logged, left visible.
- Firefox's hidden-tab menu can reveal tabs behind our back. Handled: a revealed
  tab keeps its owner. It does sit visibly in the wrong workspace until you
  switch again.
- Temporary add-ons do not survive quitting Firefox.
- A search fired into a background workspace (`paletteSearch` with
  `where:{kind:"workspace", id}` — currently reachable only by a caller other
  than the palette UI, see the message protocol section above) lives only in
  session storage (`tabMap`) until that workspace is next opened — only then
  does `claimVisible` write its URL into `ws.tabs[]`. A browser restart before
  that first switch loses the search result; the workspace reopens without it.
- Cmd+1–9 in the palette used to fire that "search into workspace N" message
  directly. Grouping the palette by workspace repurposed the binding: each
  visible row (workspace header, tab, or a "+N more" row) now gets a number,
  and Cmd+N activates whichever row holds it — opens a workspace/tab, or
  expands a "more" row. The old behaviour has no UI trigger today; a later
  command mode is expected to bring it back under different keys.
- The palette follows `prefers-color-scheme` (light and dark, via
  `paletteTheme`); `popup.css` is dark-only. In light mode the popup and the
  palette do not visually match.
- The active workspace starts expanded on every palette open (capped, same as
  a manually expanded one) — but unlike the first cut of grouping, ← on its
  header now collapses it like any other section. `buildPaletteRows` tracks
  this with an explicit `PALETTE_COLLAPSED_SUFFIX` marker in the `expanded`
  Set: "active" is only a *default*, and the marker is the one way to
  override it, checked ahead of the default but behind a plain re-expand (the
  id back in the Set without the marker) so "open it again" always wins over
  a stale collapse. Reopening the palette clears `expanded` entirely, so the
  override never outlives one palette session.
- The palette overlay lives in a shadow root injected into the page, not an
  iframe — a shadow root can't block `backdrop-filter` blur the way an iframe
  boundary would. The tradeoff: a shadow root does not isolate input.
  `keydown`/`input` events are composed and cross the boundary, so a hostile
  page can observe keystrokes typed into the palette. This is permanent, not
  a bug to fix — the iframe alternative would lose the blur.
- Related, and **unverified**: favicons render via `<img src>` from the URL
  the tab or a saved record reports — the host page's own network context,
  not the extension's. If Firefox applies a page's Content-Security-Policy to
  a content script's injected DOM, a page serving `img-src 'none'` plus a
  `securitypolicyviolation` listener could passively learn the favicon URLs
  of every tab in every workspace, without the user typing anything into the
  palette. Nobody has checked whether page CSP actually reaches
  content-script-injected `<img>` elements in Firefox — this is a plausible
  risk, not a measured one. Investigate before relying on either answer.

**Both**
- The service worker / event page can unload mid-debounce, dropping a pending
  auto-save. It recovers on the next tab event.
- No reorder, no sync across machines. (Rename and per-workspace icons exist.)

## Open decisions (ask the user before assuming)

1. **Per-window workspaces.** Should each window remember its own active
   workspace, or stay global (current)? _Resolved 2026-06-29: stays global._
2. **Pinned tabs.** _Resolved 2026-06-29: per-workspace._ _Overturned 2026-07-25
   for Firefox: it refuses to hide pinned tabs, so they are window-global there —
   which is what Safari does anyway._
3. **Does Chrome stay?** It is kept for DevTools work. If Firefox becomes the
   daily driver, `chrome/` may be worth retiring rather than maintaining.

### Resolved

- **Detach removed (2026-06-29).** Switching always swaps tabs. To start fresh,
  use "Start empty". `activeWorkspaceId === null` survives only as an internal
  safe state.
- **Named Tabitha, monorepo (2026-07-25).** Repo renamed from
  `chrome-tab-manager`; the standalone `firefox-tab-manager` was folded in.
  Settles the naming question that was open in this file.
- **Chrome tab groups and stash windows rejected (2026-07-25).** See above.

## Style

- Plain functions, async/await, early returns.
- Comments explain *why*, not *what*, especially around the switch and the guard.
- Keep the popup dumb. New behaviour belongs in a background file.
- Dev-only logging: `dlog()` / `derror()`, defined inline in each `background.js`
  and in `popup.js`. They key off `management.getSelf().installType` —
  `"development"` for an unpacked/temporary install, `"normal"` for a packaged
  one — and default to on. `getSelf()` needs no permission in either browser.
  Prefer them over raw `console.log`.
- Icons are inlined [Lucide](https://lucide.dev) SVGs (ISC), `stroke="currentColor"`
  so they inherit text color. No icon dependency, no build step. In `popup.js`
  they are SVG strings (`ICON_EDIT`/`ICON_TRASH`); in `popup.html` they are inline
  `<svg>`; the move-to dropdown indicator is a `list-end` data-URI background on
  the `<select>` (`appearance: none`).
