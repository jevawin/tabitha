# Handoff — command palette, 2026-09-14

Where the palette work stands at the end of a long session. Read `CLAUDE.md`
first; it is current and describes how everything works. This file is only
the *state*: what is done, what is untested, what is open.

## Branches and builds

| | |
|---|---|
| Working branch | `feat/palette-actions` — on top of `main`, **not merged**, pushed to `origin` |
| `main` | Palette v1 merged (`ceacddf`), pushed to `origin` |
| Remote | Both branches pushed 2026-09-14 and level with `origin` |
| Latest signed build | `web-ext-artifacts/d3046d56397a478e8e9c-0.3.4.xpi` |
| Last build the user tested | 0.3.1 |
| Tests | 279 passing, `node --test tests/*.test.js` |

Every AMO upload burns its version number. Next build is **0.3.5**.

## 0.3.2 and 0.3.3 are BROKEN — use 0.3.4

In both, Cmd+Shift+, does nothing. A CSS comment in `shared/palette.css.js`
contained backticks, which closed the stylesheet's template literal early; the
file threw at load, so the palette never opened. `node --check` and all 275
tests passed, because nothing in the suite loaded that file. Fixed in 0.3.4,
with `tests/palette-load.test.js` added — it fails 4/4 when a stray backtick
is reintroduced.

## 0.3.4 is signed but untested

Install it, then first confirm **Cmd+Shift+, opens the palette at all**, then:

1. Delete a workspace not opened this session — must state its full tab count, not 0.
2. Type a query matching only a few tabs of a big workspace, then delete it — must state the **full** count, not the match count.
3. Current-tab dot glow no longer clipped; light-mode green a shade lighter.
4. A very long tab title still ends in `…`.
5. Type a new name — WORKSPACE group (two create rows), then WEB group (search in current tab ⏎, search in new tab ⌘⏎).
6. Type an exact workspace name — WORKSPACE label disappears, WEB stays.
7. Type something matching nothing — "Search in current tab" is highlighted.
8. URLs line up directly under their tab titles.
9. The current tab shows no "current" label.

Items 3, 4 and 8 were verified by reading the CSS only, never rendered.

Tested and passing on 0.3.1: rename (four scenarios, including mouse movement
and chevron clicks mid-edit), ⌥⏎ move, create rows, Enter searches rather than
creates, active tab pinned, icons.

## What was built this session (all on the branch or `main`)

- Palette v1: Cmd+Shift+, overlay, grouped by workspace, collapsible, icons,
  favicons, Cmd+1–9 row jumping, light/dark theming.
- Actions: create (from query), ⌥⏎ move current tab, ⇧⏎ rename inline,
  trash + two-step delete.
- Workspace / Web groups at the foot of the results.
- Structured Lucide icon geometry (`icon.nodes`) so the palette never parses markup.
- **Startup orphan GC.** Fixed a months-old leak: every restart orphaned each
  workspace's hidden tabs. Found as 366 unreachable tabs / ~700MB. Verified
  working on one restart (closed 33, zero survived). Wants a week of normal
  use to call it settled.

## Open backlog

1. **Icon picker in the palette.** The only thing keeping the popup alive. Needs
   the 837KB `icon-data.json` reachable from a content script, so it wants its
   own design pass.
2. **Toolbar button opens the palette** instead of the popup. Also the entry
   point no greedy page can swallow.
3. **Retire the popup** once 1 and 2 land.
4. **"Search into workspace N" has no UI route.** `paletteSearch
   {where:{kind:"workspace"}}` is built and tested; Cmd+1–9 was repurposed for
   row selection. Needs a new binding.
5. Merge `feat/palette-actions` to `main` once 0.3.4 passes its checks.

## Unverified — do not treat as fact

- **Stale palette after an extension update.** An already-open page may keep
  calling the old palette code via the `window.__tabithaPaletteToggle` guard
  until reloaded. Hypothesis only (55%). Test: update the extension, reopen the
  palette on a tab that had it open before. Fix if real: version-stamp the guard.
- **Favicon CSP leak.** Documented in `CLAUDE.md` Known limitations. Nobody has
  checked whether page CSP applies to content-script `<img>` in Firefox.
- **Delete count precision.** Close but not exact due to URL de-duplication in
  `buildPaletteState`. Error size is unmeasured — see the comment on `total` in
  `shared/core.js`.
- **Orphan GC long-term.** One restart observed. Check `about:performance` and
  the options page's cleanup record after several days.

## Measured facts worth not re-learning

All in project memory, loaded automatically:

- Cmd+T cannot host the palette — the address bar keeps focus.
- Cmd+K is refused by Firefox. A greedy page (Bloomreach) can swallow an
  extension command outright; hence Cmd+Shift+Comma.
- Cmd+digit is cancellable inside page content with `preventDefault()`.
- `search.search({query, tabId})` drives a hidden tab and it stays hidden.

## Working notes

- The review loop caught a real bug on almost every change: an untested
  `swapping` guard, a missing `activeTab` permission, a backfill losing
  concurrent writes, a false "only we hide tabs" premise, a rename fix that
  blocked one caller out of 14, and the delete count wrong twice. Keep
  reviewing changes that touch key routing, rename, delete, or tab closing.
- `shared/palette.js` has **no render harness**. `tests/palette-load.test.js` proves
  the injected files load, nothing more. Anything that can move into a
  pure function in `shared/core.js` should, so it can be tested.
- Scratch from this session (briefs, reports, review diffs, the SDD ledger)
  is in `.superpowers/sdd/2026-09-06-firefox-command-palette/`. It is gitignored,
  not needed to continue, and safe to delete.
