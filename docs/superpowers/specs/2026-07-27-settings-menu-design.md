# Settings menu, backup/restore, and a stable Chrome id

Date: 2026-07-27
Status: approved, not yet implemented

## Why

Two problems, one shipping vehicle.

**Workspaces vanished from Chrome.** Chrome derives an unpacked extension's id by
hashing the absolute path of its folder. The monorepo restructure moved
`manifest.json` from the repo root into `chrome/`, the path changed, and Chrome
allocated a fresh empty `storage.local`. Nothing was deleted — the data sat under
the old id — but recovering it meant hand-parsing a LevelDB. That is an
unacceptable backup story.

**There is nowhere to put settings.** The popup has no header and no home for
anything that is not a workspace.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Settings surface | Options page in a tab | A file picker opened from an extension popup steals focus and destroys the popup's JS context, so Import cannot work there. A page also gives settings room to grow. |
| Import semantics | Replace all, after confirmation | Restore should mean restore. Merge cannot remove a workspace you wanted gone, and repeated imports accumulate near-duplicates. |
| `activeWorkspaceId` on import | Always `null` | Invariant 4: the Default state closes and hides nothing. An imported id would point at a workspace whose tabs are not open. |
| Imported `icon.paths` | Discarded, re-resolved by name | Untrusted markup must never reach `innerHTML`. See Security. |
| Validation | Pure `parseBackup()` in `shared/core.js` | Tested once, used by both targets, no browser APIs. |

## Out of scope

Sync across machines, workspace reordering, per-window workspaces, selective
(per-workspace) import, and automatic scheduled backups. Export/import is manual
and whole-state.

## Design

### 1. Stable Chrome extension id

Generate an RSA keypair. The base64 SPKI public key becomes `"key"` in
`chrome/manifest.json`, which pins the id to the key rather than the folder path.
The private key lives at `~/.config/tabitha/chrome-key.pem`, `chmod 600`, outside
the repo — same handling as `amo.env`.

Firefox needs nothing: its id already comes from
`browser_specific_settings.gecko.id`.

**Sequencing is not optional.** Adding `key` changes the Chrome id one last time
and orphans current storage. Order:

1. Ship Export/Import.
2. Export the current workspaces to a file.
3. Add `key`, reload the extension.
4. Import the file into the new id.

### 2. Topbar and cog (popup)

A slim header above the first section:

```
Tabitha                                    [cog]
------------------------------------------------
Create new workspace
```

Wordmark left, cog button right, separated from the body by the existing
`--line` border. The cog is an inline Lucide `settings` SVG at 16px with
`stroke="currentColor"`, matching every other icon in the popup. Clicking calls
`runtime.openOptionsPage()`.

### 3. Sentence-case headings

`.section-head` currently sets `text-transform: uppercase` and
`letter-spacing: 0.05em`. Drop both — the markup already reads "Create new
workspace". Do the same for `.icon-picker-cat`, which uppercases the picker's
category labels. Purely presentational; no markup changes.

### 4. Options page

New `shared/options.html` and `shared/options.js`. Both must be added to the
`ASSETS` list in `tools/sync.mjs` (it is explicit, never globbed) and to
`.gitignore` for both target copies.

Registered in both manifests:

```json
"options_ui": { "page": "options.html", "open_in_tab": true }
```

It reuses `popup.css` — one stylesheet, no duplicated tokens — with an appended
`/* Options page */` block. No new permissions.

Layout: a "Backup and restore" section with Export and Import, room below for
future settings.

### 5. Export

The page asks the background for state, then builds:

```json
{
  "format": "tabitha-workspaces",
  "version": 1,
  "exportedAt": "2026-07-27T00:00:00.000Z",
  "workspaces": [ ... ]
}
```

Downloaded via a `Blob` and an `<a download>` named
`tabitha-workspaces-YYYY-MM-DD.json`. This needs no `downloads` permission.

`activeWorkspaceId` is deliberately not exported; it is per-browser runtime
state, not part of a backup.

### 6. Import

1. `<input type="file" accept="application/json">`.
2. Read the text, run it through `parseBackup()`.
3. On failure, show the specific reason. Change nothing.
4. On success, confirm: "Replace 3 workspaces with 10?", listing incoming names.
5. On confirm, send `importState`. The background replaces `workspaces` and sets
   `activeWorkspaceId` to `null`.

### 7. Security: imported files are untrusted

`icon.paths` holds raw SVG markup and is injected with `innerHTML` by
`ICON_SVG` in `popup.js`. `core.js` already marks this a trust boundary: the
markup is safe *only* because it comes from the extension's own committed icon
dataset.

An imported file breaks that assumption. A hostile backup could carry a script
payload straight into the popup DOM.

**Therefore import discards `icon.paths` entirely** and re-resolves it from
`icon-data.json` by `icon.name`. An unrecognised name yields no icon and renders
the default sentinel. Untrusted markup never reaches the DOM, and
`normalizeIcon`'s existing contract is unchanged.

`parseBackup()` additionally:

- rejects non-object JSON, a missing/wrong `format`, or an unknown `version`
- requires `workspaces` to be an array; each entry needs a string `name`
- drops tabs failing `isTrackableUrl()`
- coerces `pinned` to a boolean
- regenerates missing or duplicate workspace ids via `crypto.randomUUID()`
  (available in both browsers and Node, and not a `chrome.*`/`browser.*` API, so
  `core.js` stays portable)
- caps the import at `MAX_IMPORT_WORKSPACES = 200` and
  `MAX_IMPORT_TABS = 500` per workspace, both exported from `core.js`. Over the
  cap is a rejection, not a silent truncation — a file that large is a mistake or
  an attack, and quietly dropping half of it would be worse than refusing it.

**Who re-resolves the icons.** `parseBackup()` is pure and cannot fetch, so it
returns each icon as `{ name }` with `paths` stripped. `options.js` then loads
`icon-data.json` once and fills in `paths` for every name it recognises, dropping
the icon entirely when it does not. Only then does it send `importState`. The
background still runs each icon through `normalizeIcon()`, so an icon that
somehow arrives without `paths` is rejected there too — two independent checks,
neither relying on the other.

### 8. Message protocol

- `exportState` -> `{ workspaces }`
- `importState { workspaces }` -> replaces all workspaces, sets
  `activeWorkspaceId: null`, returns `{ ok: true, count }`

Both popup and options page stay presentation-only. All decisions live in the
background, per the existing rule.

### 9. Tests

`tests/core-backup.test.js`, against `parseBackup()`:

- a valid file round-trips
- malformed JSON is rejected with a reason, not a throw
- wrong `format` tag rejected
- unknown `version` rejected
- **hostile `icon.paths` (`<script>`, `onload=`) is discarded, not sanitised**
- an icon survives as `{ name }` with `paths` always absent, whatever the input
- over-cap workspace or tab counts are rejected, not truncated
- non-http/https tabs are filtered out
- duplicate and missing ids are regenerated
- an empty `workspaces` array is valid (a legitimate way to clear)

Existing suites must stay green, including `tests/browser-load.test.js` — new
top-level names in `core.js` still go inside the IIFE.

### 10. Docs

Update `CLAUDE.md`: File map (options page), Message protocol (two new types),
Data model (import trust boundary), Run and test (new suite). Update `README.md`
with a short Backup and restore section.

## Risks

- **The key change orphans storage once more.** Mitigated by doing it after
  Export exists, and by the existing backup at
  `/Users/jevawin/Developer/tabitha-workspaces-backup.json`.
- **`options_ui` rendering differs slightly between Chrome and Firefox.** Both
  support `open_in_tab`; verify in both.
- **Re-resolving icons needs `icon-data.json` (516 KB) in the options page.**
  Loaded once, on import only.
