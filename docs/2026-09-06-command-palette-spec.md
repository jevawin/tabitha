# Tabitha command palette — spec

**Status:** design settled, not built. Firefox only.
**Date:** 2026-09-06.

A Spotlight/Alfred-style overlay for searching tabs and workspaces, and for
firing a search into any workspace — including one you are not currently in.

## Why Firefox only

The palette's headline capability is "run this search in a background workspace
without leaving the one I'm in". That needs a tab that is open, loading, and not
on screen. Only Firefox has one. Chrome would have to append a URL to a stored
record and open nothing, which is a different and much weaker feature.

Chrome also fails the smaller parts: it holds only the active workspace's tabs
open, so cross-workspace tab search there is a URL list with no titles, and
jumping to a tab in another workspace costs a full close-and-reopen swap.

`chrome/background.js` rejects every message type added here. That is deliberate;
do not half-implement it.

## Measured constraints

Everything below was measured on Firefox Developer Edition 156.0b3 with a
throwaway add-on, not inferred from docs. Where a claim is unverified it says so.

| Question | Answer | How |
|---|---|---|
| Bind Cmd+T via `commands`? | **No** | MDN: browser-used combos don't fire. [Bug 1325692](https://bugzilla.mozilla.org/show_bug.cgi?id=1325692) says it's unenforced, so it may appear to work — do not rely on it |
| `chrome_url_overrides.newtab` as the palette host? | **No** | Page never gets keyboard focus. `focus()` at 0/1/10/50/150/400/1000/2000ms all failed; the address bar keeps it |
| Cmd+K for the palette? | **No** | Firefox keeps it for the search bar |
| Cmd+Shift+K? | **Yes** | Fires cleanly. Free on macOS — the Web Console is Cmd+Opt+K, the toolbox Cmd+Opt+I |
| Cmd+digit inside page content? | **Yes, if prevented** | Controlled test: digit 1 `preventDefault()`ed did not switch tabs; digit 2 left un-prevented did |
| Cmd+Enter inside page content? | **Yes** | Reaches the page, `cancelable=true` |
| `search.search({query, tabId})` on a **hidden** tab? | **Yes** | Tab navigated to the default engine, title populated, `hidden` still `true` afterwards |
| Build the default engine's search URL ourselves? | **No** | `search.get()` returns only `{name, isDefault, alias, favIconUrl}` — no URL template. Driving a tab by `tabId` is the only route |

**Unverified, and it gates Task 5:** every keyboard measurement above was taken
on a top-level `moz-extension://` page. The palette runs in a shadow root inside
an ordinary https page. Very likely identical; not the same thing.

## Interaction

Cmd+Shift+K opens the overlay over whatever page you are on. It is user-editable
at `about:addons` → Manage Extension Shortcuts.

Typing filters a single ranked list drawn from three sources:

- **Open tabs**, across every workspace — the active workspace's visible tabs and
  every other workspace's hidden ones, all live with real titles.
- **Saved tabs**, for workspaces not yet materialised this browser session. These
  have no live tab, so they are matched on title and URL from storage.
- **Workspaces** themselves, which open at their last-active tab.

Below the matches sit the search actions, which are always present:

| Key | Action |
|---|---|
| `Enter` | Search in the current tab |
| `Cmd+Enter` | Search in a new tab in the current workspace |
| `Cmd+1`…`Cmd+9` | Search in a new **hidden** tab in workspace N — does not switch |
| `↑` `↓` | Move selection |
| `Esc` | Close |

Selecting an open tab jumps to it, switching workspace first if it lives in
another one. Selecting a workspace switches to it and lands on its last-active
tab.

Cmd+1…9 is the distinctive one: the search runs in a workspace you are not in,
the tab stays hidden, and you stay exactly where you are.

## Visual design

Frosted glass, dark. It should read as part of macOS rather than part of the
page it is floating over.

- **Scrim** over the whole viewport: `rgba(10,10,12,.42)` plus a light
  `blur(3px)`, so the page recedes but stays recognisable.
- **Panel** at `min(640px, 100vw - 48px)`, 14vh from the top — Spotlight's
  position, not dead centre. `rgba(31,31,34,.72)` over
  `backdrop-filter: blur(24px) saturate(180%)`, a 1px `rgba(255,255,255,.10)`
  hairline, `border-radius: 14px`, and a deep soft shadow.
- **Query input** at 20px, no border, transparent, muted placeholder.
- **Rows** 44px, three columns: icon (workspace icon or favicon), title over a
  muted secondary line, and a right-aligned key hint. Selected row is a flat
  `rgba(255,255,255,.08)` fill — no accent bar, no blue.
- **Section headers** 11px uppercase, `letter-spacing: .04em`, muted.
- **Footer** repeating the key hints in `<kbd>` chips.
- Entrance is 120ms, `scale(.98) → 1` with opacity, skipped entirely under
  `prefers-reduced-motion`.

### Theming

The overlay follows the system light/dark setting by default, and the user can
pin it either way.

- **Light** is the same frosted construction inverted: a `rgba(250,250,252,.72)`
  panel, a soft `rgba(20,20,24,.18)` scrim, dark text. Not a white panel on a
  white scrim — the scrim still darkens slightly, because its job is to push the
  page back so the panel reads as floating above it.
- **Dark** is the palette described above.
- **Default is `system`**, read from `prefers-color-scheme` inside the shadow
  root, which reflects the browser setting rather than the host page's.

The override is a `paletteTheme: "system" | "light" | "dark"` value in
`storage.local`, set on the options page and returned by `paletteState`. The
overlay applies it as a `data-theme` attribute on the shadow host.

CSS structure: the complete light palette is defined on bare `:host`; only the
tokens change under `@media (prefers-color-scheme: dark)` guarded as
`:host(:not([data-theme="light"]))`; and again under `:host([data-theme="dark"])`
so an explicit choice wins in both directions. No colour may have its only
definition inside a media query.

**Known mismatch:** `popup.css` is dark-only, so with the system in light mode
the palette will be light while the popup stays dark. Theming the popup is a
separate change and deliberately out of scope here.

### Shadow DOM, not an iframe

The overlay is a `closed` shadow root on a div appended to `document.documentElement`,
styled with `adoptedStyleSheets`.

An iframe was rejected for one concrete reason: **`backdrop-filter` inside an
iframe cannot blur the page behind the iframe.** It is a separate document, so
its backdrop is its own. The frosted-glass effect is the design, so the overlay
has to be real page content. Shadow DOM gives the style isolation an iframe
would have given, without that cost.

Two consequences to handle rather than discover:

- Inherited properties cross the shadow boundary, so the host needs
  `all: initial` before our own styles are applied.
- Constructed stylesheets via `adoptedStyleSheets` sidestep page CSP, which a
  `<style>` element injected into a strict-CSP page may not.

## Data model changes

Additive. Backup `version` stays `1`.

```
paletteTheme?: "system" | "light" | "dark"   // NEW — top-level, defaults "system"

workspaces: [
  { id, name, icon?,
    lastActiveUrl?: string,        // NEW — where "open this workspace" lands
    tabs: [{ url, pinned, title? }] // NEW — title, so unmaterialised
  }                                 //        workspaces are searchable
]
```

`title` matters because a workspace not yet opened this session has no live tab
to read a title from. Without it, searching those workspaces means matching raw
URLs, which is barely better than searching a bookmark file.

`lastActiveUrl` is stored rather than a tab id because tab ids die with the
browser session and the whole point is that this survives a restart.

Both are optional on read: existing stored records and older backups have
neither, and must keep working untouched.

`parseBackup()` and `importWorkspaces()` currently strip unknown fields, so both
need updating or the new fields will not survive an export/import round trip.

## Message protocol additions

| Message | Returns | Notes |
|---|---|---|
| `paletteState` | `{ ok, items, workspaces, activeWorkspaceId, theme }` | One shot — the overlay does no assembly of its own. `theme` is `"system"` \| `"light"` \| `"dark"` |
| `jumpToTab` `{ tabId }` | `{ ok }` | Switches workspace first if the tab lives elsewhere |
| `openWorkspace` `{ id }` | `{ ok }` | Switch, then land on `lastActiveUrl` if it resolves |
| `paletteSearch` `{ query, where }` | `{ ok }` | `where` is `{kind:"currentTab"}`, `{kind:"newTab"}`, or `{kind:"workspace", id}` |

## Invariants this must not break

The existing ones in `CLAUDE.md` all still apply. Three are live hazards here:

1. **Invariant 1 (mute live tracking during a switch).** The create/hide/search
   sequence fires `tabs.onCreated`. Without the `swapping` guard, auto-save
   claims the new hidden tab for the *active* workspace — the exact
   cross-contamination bug the guard exists to prevent.
2. **Invariant 11 (a switch never closes a tab).** Nothing in the palette closes
   anything. `jumpToTab` reassigns and switches; it never removes.
3. **Invariant 8 (`core.js` touches no browser API).** Ranking and filtering are
   pure and live in `core.js`; everything that reads tabs lives in
   `firefox/background.js`.

## Out of scope

Fuzzy matching beyond substring scoring, search-engine selection (always the
default engine), history and bookmark search, reordering results by frecency,
and any Chrome implementation.
