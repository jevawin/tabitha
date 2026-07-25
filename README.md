# Tabitha

Safari-style workspaces for Chrome and Firefox. Switch a workspace and the tabs
on screen swap out for another set. The active workspace tracks tab changes live,
so it works like saved session state rather than a static bookmark list.

One repo, two extensions, one shared UI.

## Chrome and Firefox are not the same

**Firefox is the good one.** Hidden tabs vanish from the tab strip completely —
no group chip, no extra window, no marker of any kind — and Firefox keeps them
running while they're hidden. Pages hold their scroll position, half-typed forms
and playing audio. Switching is instant and opens nothing.

**Chrome is a compromise.** Chrome has no API for hiding a tab, so switching
closes the old tabs and reopens the new ones. Every page flashes and reloads.
Tab groups and hidden windows were both tried; each leaves a permanent marker
(a chip in the tab strip, or a window in the Dock), which defeats the point.

Use Firefox if you can. Chrome is here for when you need its DevTools.

## Layout

```
shared/     popup UI, icons, icon data, shared helpers  <- edit here
chrome/     Chrome manifest + close/reopen strategy
firefox/    Firefox manifest + hide/show strategy
tools/      sync.mjs, gen-icon-data.mjs
tests/      Node tests
```

`shared/` is the only source of truth. Browsers can't follow a path out of an
extension's root, so `tools/sync.mjs` copies `shared/` into `chrome/` and
`firefox/` to make each a complete, loadable extension. Those copies are
gitignored — never edit them.

## Load it

Sync first, every time you change anything in `shared/`:

```bash
node tools/sync.mjs
```

**Chrome**

1. Open `chrome://extensions`.
2. Turn on Developer mode (top right).
3. Load unpacked → pick the `chrome/` folder.
4. Pin the extension. Click the icon to open the popup.

After editing `chrome/background.js`, click the reload icon on the extension
card. The service worker caches the old code; reopening the popup isn't enough.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. Load Temporary Add-on → pick `firefox/manifest.json`.
3. Pin the extension. Click the icon to open the popup.

Temporary add-ons go away when you quit Firefox. The first time it hides a tab,
Firefox shows a one-time notice telling you tabs are being hidden and how to
reach them. That's Firefox guarding against extensions that hide tabs
maliciously. It can't be turned off and it only appears once.

## How it works

- **Save current tabs** — names the tabs on screen as a new workspace and drops
  you into it. Nothing opens or closes.
- **Start empty** — names a new, empty workspace and switches into it: the
  current tabs go away and a fresh blank tab opens.
- **Click a workspace** — swaps the current tabs for that workspace's.
- **Live state** — while you're in a workspace, opening, closing and navigating
  tabs updates it automatically. New tabs join it.
- **Move a tab** — use the move strip in the popup (shows the active tab with a
  workspace picker) to send the current tab elsewhere, or to a new workspace, and
  follow it there.
- **Rename** — click the pencil next to a name. Enter to save, Escape to cancel.
- **Delete** — removes the workspace. In Firefox it also closes its tabs.

Names are required — both create buttons stay disabled until you type one.

In Firefox, pinned tabs sit outside workspaces and show in all of them. Firefox
won't hide a pinned tab. Safari behaves the same way.

In Firefox, the first time you open a workspace after starting the browser its
saved pages load. After that, switching to it opens nothing.

## Test it

```bash
node --test tests/*.test.js
```

Tests run against `shared/` and both background files directly, so you don't need
to sync first.

Manual smoke test, either browser:

1. Open 3 tabs. Save as "A".
2. Type another name, click "Start empty" to land in "B". Open 2 tabs there.
3. Click A in the popup. B's tabs go away, A's come back.
4. In A, open a new tab. Switch to B and back. The new tab must still be in A.

Manual smoke test, Firefox only — this is the whole point:

1. In A, scroll a long page halfway and type into a search box without submitting.
2. Switch to B, then back to A.
3. The page should be exactly where you left it, text still there, no flash.
4. Play a video, switch away. You'll still hear it while it's hidden.

## Known limits

**Chrome** — switching reloads every page and loses its state. Inherent, not a
bug we can fix.

**Firefox** — hidden tabs stay loaded, so memory grows with the workspaces you've
opened this session. A tab sharing your screen, mic or camera won't hide until
the call ends. Firefox's own hidden-tab menu can reveal a hidden tab; it keeps
belonging to its workspace but sits visibly in the wrong one until you switch.

**Both** — one window at a time; only http/https tabs are saved; no reorder; no
sync across machines.

## Iterate in Claude Code

Open this folder in Claude Code and ask for changes, e.g.:
- "add keyboard shortcuts for switching"
- "add drag-to-reorder"
- "discard hidden tabs after an hour to save memory"
