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
- `shared/core.js` — pure helpers used by both backgrounds: `isTrackableUrl`,
  `cleanName`, `normalizeIcon`, `buildMovedState`, `MAX_ICON_PATHS`. **Nothing in
  here may touch `chrome.*` / `browser.*`.** That rule is what keeps it testable
  once instead of twice.
- `shared/icon-data.json` — generated, committed Lucide dataset: array of
  `{ name, category, tags, paths }`. Lazy-fetched by the popup only when the icon
  picker opens.
- `shared/icons/` — toolbar icon. `folder.svg` is the Lucide source; the PNGs are
  rasterized from it. Regenerate:
  `cd shared/icons && for s in 16 32 48 128; do rsvg-convert -w $s -h $s folder.svg -o icon$s.png; done`
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
      tabs: [{ url: string, pinned: boolean }],
      icon?: { name: string, paths: string } }
  ],
  activeWorkspaceId: string | null
}
```

`icon` is optional. `icon.paths` (the Lucide inner SVG markup) is stored so a row
renders without loading `icon-data.json`. Absent `icon` renders the `ellipsis`
default sentinel.

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
    closes tabs, and only `materialize` opens them. Adding a `tabs.remove` to the
    switch path means the design has gone wrong.
12. **Activate a target tab before hiding the outgoing set.**
13. **Never assume `tabs.hide()` worked.** Verify, because it fails silently.

## Message protocol (popup -> background)

Identical in both targets, so the popup stays shared. Chrome's listener returns
`true` to keep the async channel open; Firefox's is `async` and returns the
response directly.

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
- `delete` `{ id }` -> removes a workspace. **Firefox also closes its tabs** —
  they are open (just hidden) there, so leaving them would strand them.
- `rename` `{ id, name }` -> renames a workspace (inline pencil-edit in the popup).

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

Node tests — `node --test tests/*.test.js` (`node --test tests/` fails on Node 24).
They run against `shared/` and the two `background.js` files directly, so a sync
is not required first.

- `tests/core-*.test.js` — the shared pure helpers, tested once.
- `tests/chrome-*.test.js` — Chrome actions against `tests/fake-chrome.js`.
- `tests/firefox-*.test.js` — Firefox actions against `tests/fake-browser.js`.
- `tests/icon-data.test.js` — generated dataset sanity (shape + exclusions).

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
