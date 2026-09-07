// Tabitha — shared core
//
// Pure helpers used by both the Chrome and Firefox background scripts. Nothing
// in here may touch chrome.*/browser.* — that is the whole point. It keeps the
// logic that is genuinely identical across targets in one place, tested once.
//
// Loaded three ways:
//   - Firefox: listed first in manifest background.scripts.
//   - Chrome:  pulled in by importScripts("core.js") at the top of background.js.
//   - Node:    required by the tests.
//
// EVERYTHING IS WRAPPED IN AN IIFE, and must stay that way. In both browsers
// this file and background.js share ONE global scope. A bare `function foo(){}`
// here would create a var-like global binding, which cannot coexist with the
// `const { foo } = ...` that background.js declares — the engine throws
// "Identifier 'foo' has already been declared" and the extension never starts.
// The IIFE keeps these names local, so `globalThis.TabithaCore` below is the
// single, deliberate export. See tests/browser-load.test.js.

(function () {
  // Only http/https tabs are trackable. chrome://, about: and extension pages
  // cannot be reliably reopened, so they are never saved into a workspace.
  function isTrackableUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
  }

  // Workspace names are mandatory. Returns a trimmed name, or null if blank.
  function cleanName(name) {
    const n = (name || "").trim();
    return n.length ? n : null;
  }

  // Cap on stored icon path markup — guards storage against absurd payloads.
  const MAX_ICON_PATHS = 4096;

  // TRUST BOUNDARY: `paths` is injected via innerHTML (ICON_SVG in popup.js) and is
  // trusted ONLY because it originates from the extension's own committed icon
  // dataset, never from web content. Do not wire an untrusted source into setIcon
  // or create.
  // Validate/normalize an icon picked in the popup before it is stored. Returns a
  // clean { name, paths } or null (null => the record gets no icon and renders the
  // default sentinel).
  function normalizeIcon(icon) {
    if (!icon || typeof icon !== "object") return null;
    const { name, paths } = icon;
    if (typeof name !== "string" || typeof paths !== "string") return null;
    if (!name.trim() || !paths.trim()) return null;
    if (paths.length > MAX_ICON_PATHS) return null;
    return { name, paths };
  }

  // Append a tab to a target workspace, returning a new state. Never mutates the
  // input, never persists — callers do that. The source workspace is left alone;
  // re-saving it is the caller's job, because how a tab leaves its old workspace
  // differs per browser.
  function buildMovedState(state, targetId, tab) {
    if (!state.workspaces.some((w) => w.id === targetId)) {
      throw new Error("target not found");
    }
    return {
      ...state,
      workspaces: state.workspaces.map((w) =>
        w.id === targetId ? { ...w, tabs: [...(w.tabs || []), tab] } : w
      ),
    };
  }

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

      // A missing or duplicate id would collide in storage, so mint a fresh one.
      let id = typeof raw.id === "string" && raw.id ? raw.id : null;
      if (!id || seen.has(id)) id = crypto.randomUUID();
      seen.add(id);

      const ws = { id, name, tabs };
      // Only an http/s URL is a valid landing target, same rule as tabs.
      if (isTrackableUrl(raw.lastActiveUrl)) ws.lastActiveUrl = raw.lastActiveUrl;
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

  // Group the palette's flat `items` (tab/saved/workspace mix) into rows the
  // overlay can render as sections: a header row per workspace, followed by
  // that workspace's tabs. Pure — see buildPaletteRows below for the ordering
  // rules, which mirror the palette-grouping brief exactly.
  //
  // Header rows are synthesized from the `workspaces` records themselves,
  // not read off any kind:"workspace" entry in `items`. That is deliberate:
  // it is the only way a workspace with zero tabs (or a caller that omits
  // per-workspace kind:"workspace" entries) still gets a header under the
  // "every workspace" empty-query rule, and buildPaletteState's kind:"workspace"
  // items carry the exact same fields (title/url/icon/workspaceId) anyway, so
  // the renderer sees an identical shape either way. Any kind:"workspace"
  // entry present in `items` is otherwise ignored, so it never becomes a
  // second, duplicate header.
  function buildPaletteRows(items, workspaces, activeWorkspaceId, query) {
    const wsList = Array.isArray(workspaces) ? workspaces : [];
    const itemList = Array.isArray(items) ? items : [];
    const needle = (query || "").trim();

    // Bucket the real (tab/saved) items by owning workspace. workspaceId ==
    // null (loose == so both null and undefined land here) means "unowned" —
    // the stale-tabMap case the brief calls out.
    const byWs = new Map();
    const unfiled = [];
    for (const it of itemList) {
      if (!it || it.kind === "workspace") continue;
      if (it.workspaceId == null) {
        unfiled.push(it);
        continue;
      }
      if (!byWs.has(it.workspaceId)) byWs.set(it.workspaceId, []);
      byWs.get(it.workspaceId).push(it);
    }

    const headerItemFor = (ws) => ({
      kind: "workspace",
      workspaceId: ws.id,
      title: ws.name,
      url: ws.lastActiveUrl || "",
      icon: ws.icon || null,
    });

    const rows = [];
    const pushHeader = (ws, selectable) =>
      rows.push({ kind: "header", item: headerItemFor(ws), workspaceId: ws.id, selectable: selectable !== false, depth: 0 });
    const pushTabs = (workspaceId, list) =>
      list.forEach((it) => rows.push({ kind: "tab", item: it, workspaceId, selectable: true, depth: 1 }));
    const pushUnfiledHeader = () =>
      rows.push({ kind: "header", item: null, workspaceId: null, selectable: false, depth: 0 });

    let anyNameMatched = false;

    if (!needle) {
      // Every workspace, active one first, then stored order. Each header is
      // followed by ALL of that workspace's items — nothing to filter.
      const ordered = [
        ...wsList.filter((w) => w.id === activeWorkspaceId),
        ...wsList.filter((w) => w.id !== activeWorkspaceId),
      ];
      for (const ws of ordered) {
        pushHeader(ws);
        pushTabs(ws.id, byWs.get(ws.id) || []);
      }
      if (unfiled.length) {
        pushUnfiledHeader();
        pushTabs(null, unfiled);
      }
    } else {
      // 1. Workspaces whose NAME matches the query, best score first, each
      // followed by ALL of its items (unfiltered — see the header comment
      // above and the brief's "unfiltered" requirement). Scored via the same
      // rankPaletteItems ladder used everywhere else, over a synthetic
      // one-field-per-workspace list, rather than a second scorer.
      const nameCandidates = wsList.map((ws) => ({ title: ws.name, url: "", __ws: ws }));
      const nameMatches = rankPaletteItems(nameCandidates, needle);
      const matchedWs = nameMatches.map((m) => m.__ws);
      const matchedIds = new Set(matchedWs.map((w) => w.id));
      anyNameMatched = matchedWs.length > 0;

      for (const ws of matchedWs) {
        pushHeader(ws);
        pushTabs(ws.id, byWs.get(ws.id) || []);
      }

      // 2. Remaining workspaces whose ITEMS match, best matching item first,
      // each followed by only its matching items. One rankPaletteItems call
      // over every remaining candidate (each tagged with its owning
      // workspace via a synthetic wrapper — the original item is carried
      // through untouched as __orig and is what ends up in the row, so
      // "item is the original object, unchanged" still holds) gives both
      // orderings for free: the sort is global by score with ties keeping
      // input order, so a workspace's best item is always the first time
      // that workspace appears in the sorted list, and filtering the sorted
      // list back down to one workspace preserves that workspace's own
      // relative (== per-workspace ranked) item order.
      const remaining = wsList.filter((w) => !matchedIds.has(w.id));
      const pool = [];
      for (const ws of remaining) {
        for (const it of byWs.get(ws.id) || []) {
          pool.push({ title: it.title, url: it.url, __ws: ws, __orig: it });
        }
      }
      const rankedPool = rankPaletteItems(pool, needle);
      const itemMatchedOrder = [];
      const seenWs = new Set();
      for (const r of rankedPool) {
        if (!seenWs.has(r.__ws.id)) {
          seenWs.add(r.__ws.id);
          itemMatchedOrder.push(r.__ws);
        }
      }
      for (const ws of itemMatchedOrder) {
        pushHeader(ws);
        pushTabs(
          ws.id,
          rankedPool.filter((r) => r.__ws.id === ws.id).map((r) => r.__orig)
        );
      }

      // 3. Unfiled always goes last, regardless of how its own matches would
      // score against the workspaces above — it has no name to match by, so
      // it can only ever land in this "matching items" bucket, and the brief
      // is explicit that it goes last, not interleaved by score.
      const rankedUnfiled = rankPaletteItems(unfiled, needle);
      if (rankedUnfiled.length) {
        pushUnfiledHeader();
        pushTabs(null, rankedUnfiled);
      }
    }

    const cappedRows = rows.slice(0, MAX_PALETTE_RESULTS);

    // defaultSel must always land on a selectable row, or -1. The empty-query
    // and "a workspace name matched" cases both want the leading header
    // (always row 0, always selectable, when rows exist); a tabs/items-only
    // match wants the first tab row instead. nextSelectableIndex is reused
    // for the fallback searches so this stays consistent with arrow-key
    // navigation rather than re-implementing "find a selectable row".
    let defaultSel;
    if (!needle || anyNameMatched) {
      defaultSel = cappedRows.length && cappedRows[0].selectable ? 0 : nextSelectableIndex(cappedRows, -1, 1);
    } else {
      const firstTab = cappedRows.findIndex((r) => r.kind === "tab" && r.selectable);
      defaultSel = firstTab >= 0 ? firstTab : nextSelectableIndex(cappedRows, -1, 1);
    }

    return { rows: cappedRows, defaultSel };
  }

  // Arrow-key stepping for a row list where some rows (the synthetic
  // "Unfiled" header) are not selectable. Skips over them in the direction
  // of travel and clamps at either end rather than wrapping — matching the
  // Math.min/Math.max clamp the overlay used before grouping existed. Falls
  // back to a scan from the top when `from` is not itself a valid selectable
  // row (e.g. -1 on first render), so a stale or out-of-range index can never
  // leave the selection permanently stuck. Returns -1 only when nothing in
  // `rows` is selectable; every path below terminates in at most one O(n)
  // pass, so it cannot loop forever.
  function nextSelectableIndex(rows, from, direction) {
    const list = Array.isArray(rows) ? rows : [];
    const n = list.length;
    if (n === 0) return -1;
    const d = direction < 0 ? -1 : 1;

    for (let i = from + d; i >= 0 && i < n; i += d) {
      if (list[i] && list[i].selectable) return i;
    }
    if (list[from] && list[from].selectable) return from; // nothing further; clamp in place
    for (let i = 0; i < n; i++) {
      if (list[i] && list[i].selectable) return i;
    }
    return -1;
  }

  // ---------- Exports ----------
  // The one name this file is allowed to put on the global scope. background.js
  // destructures from it in the browser; the tests require() it.
  const TabithaCore = { isTrackableUrl, cleanName, MAX_ICON_PATHS, normalizeIcon, buildMovedState, parseBackup, MAX_IMPORT_WORKSPACES, MAX_IMPORT_TABS, rankPaletteItems, MAX_PALETTE_RESULTS, buildPaletteRows, nextSelectableIndex };

  if (typeof globalThis !== "undefined") globalThis.TabithaCore = TabithaCore;
  if (typeof module !== "undefined" && module.exports) module.exports = TabithaCore;
})();
