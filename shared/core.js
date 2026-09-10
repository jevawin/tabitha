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

  // A hidden tab that belongs to no workspace of OURS, and whose URL we still
  // have saved, is garbage: see firefox/background.js collectOrphanTabs for
  // why they pile up (tabMap is session storage, so a restart forgets which
  // hidden tab belongs to which workspace, and nothing can ever re-adopt it
  // because the only ownership path only ever looks at VISIBLE tabs).
  //
  // `hidden` alone is NOT enough to call a tab ours: `tabs.hide` is a shared
  // permission — Sidebery, Simple Tab Groups and Panorama all use it too — so
  // a hidden tab found at startup could belong to a different extension
  // entirely, stashed there on purpose. (An earlier version of this predicate
  // assumed "only this extension hides tabs at all"; that was never actually
  // true and a reviewer caught it before it shipped.) What we actually know,
  // precisely, is what produces the leak: a superseded materialize() duplicate
  // is by definition a tab whose URL is still sitting in one of our own
  // workspaces' saved `tabs[]` records. So `savedUrls` (every URL in every
  // workspace's `tabs[]`, built by the caller) gates collection too, via exact
  // string equality on the same value already used everywhere else in this
  // codebase — no fragment or query stripping, no fuzzy matching. Two URLs
  // differing only by fragment are different tabs, not a match.
  //
  // This is deliberately conservative: a genuine orphan whose saved URL has
  // since changed (edited, or the tab navigated before hiding) will not match
  // and will survive uncollected. That is the correct trade for an automatic,
  // unconfirmed deletion — leaving some real garbage behind beats closing
  // something that was not ours.
  //
  // Be clear about what this does NOT establish: a URL match is not proof of
  // ownership. tabHide is a shared permission (Sidebery, Simple Tab Groups and
  // Panorama all use it), so another extension's stashed tab sitting on a URL
  // Tabitha also has saved WILL still be collected. The residual risk is
  // accepted rather than eliminated, because a tab id cannot be attributed to
  // an extension after a restart — the collision is narrow (a page the user
  // already keeps in a workspace) and the URL is recoverable, but it is real.
  //
  // `!tab.pinned` is kept explicit even though a pinned tab cannot currently
  // be hidden (Firefox refuses). Pinned tabs are deliberately owned by no
  // workspace and must never be closed by this — the exclusion has to survive
  // on its own, not depend on today's inability to hide one.
  function isCollectableOrphanTab(tab, ownedIds, savedUrls) {
    return (
      !!tab.hidden &&
      !tab.pinned &&
      isTrackableUrl(tab.url) &&
      !ownedIds.has(tab.id) &&
      savedUrls.has(tab.url)
    );
  }

  // Workspace names are mandatory. Returns a trimmed name, or null if blank.
  function cleanName(name) {
    const n = (name || "").trim();
    return n.length ? n : null;
  }

  // Cap on stored icon path markup — guards storage against absurd payloads.
  const MAX_ICON_PATHS = 4096;

  // The entire element/attribute surface used across all 1628 Lucide icons in
  // the committed dataset (measured directly from shared/icon-data.json's
  // `nodes`, freshly regenerated — NOT copied from an earlier estimate: an
  // initial pass over this task missed `<line>`'s x1/x2/y1/y2 endpoints, which
  // only showed up once the real dataset existed to check against). No
  // `href`, no `style`, no event handler ever appears, so an allowlist of
  // exactly this surface is sufficient by measurement, not by hope — and it
  // is what will let the palette render icon geometry with createElementNS +
  // setAttribute instead of innerHTML, which is the whole point: the palette
  // overlay lives inside arbitrary web pages, where markup injection would be
  // a real escalation. (The palette renderer itself is a later change — see
  // shared/palette.js, which still shows a fixed glyph.)
  const ICON_NODE_TAGS = ["circle", "ellipse", "line", "path", "polygon", "polyline", "rect"];
  const ICON_NODE_ATTRS = ["cx", "cy", "d", "fill", "height", "points", "r", "rx", "ry", "width", "x", "x1", "x2", "y", "y1", "y2"];

  // 32 is well above the largest real Lucide icon (15 elements, measured), so
  // this only ever bites a corrupted or hostile payload. Same reasoning for
  // the attribute-value cap: the longest real `d` value measured across the
  // dataset is 461 chars, so 1024 leaves headroom without letting a single
  // attribute balloon storage.
  const MAX_ICON_NODES = 32;
  const MAX_ICON_NODE_ATTR_LEN = 1024;

  // The per-node and per-attribute caps above bound a single node, but not
  // the array as a whole: 32 nodes x 16 attrs x 1024 chars is ~529KB of
  // otherwise-valid output, 130x MAX_ICON_PATHS (which guards this same
  // geometry in its markup form). This caps the serialised total instead.
  // 4096 mirrors MAX_ICON_PATHS's order of magnitude; the largest real icon
  // in the dataset serialises to 857 chars (measured), so there is ample
  // headroom for legitimate icons and none for an attack that relies on
  // stacking many large-but-individually-valid nodes/attributes.
  const MAX_ICON_NODES_TOTAL_LEN = 4096;

  // Clean a `nodes` array ([[tag, {attr: value}], ...]) down to exactly the
  // allowlisted shape, or null if the input isn't even an array (or nothing
  // survived cleaning — see below). Invalid individual nodes/attributes are
  // dropped rather than failing the whole icon — an icon that renders with
  // one stray element missing is a better failure mode than an icon that
  // silently reverts to no icon at all. Coerces nothing: a non-string
  // attribute value is dropped, never stringified, because coercion is how a
  // hostile object (e.g. one with a malicious toString) would sneak a string
  // out of this function.
  function normalizeIconNodes(nodes) {
    if (!Array.isArray(nodes)) return null;
    const out = [];
    for (const entry of nodes) {
      if (out.length >= MAX_ICON_NODES) break;
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [tag, attrs] = entry;
      if (typeof tag !== "string" || !ICON_NODE_TAGS.includes(tag)) continue;
      if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) continue;
      const cleanAttrs = {};
      for (const key of Object.keys(attrs)) {
        if (!ICON_NODE_ATTRS.includes(key)) continue;
        const value = attrs[key];
        if (typeof value !== "string" || value.length > MAX_ICON_NODE_ATTR_LEN) continue;
        cleanAttrs[key] = value;
      }
      out.push([tag, cleanAttrs]);
    }
    // Nothing survived cleaning (an empty input, or every entry was junk):
    // treat that the same as "not an array" and return null, not []. An
    // empty array is truthy and would otherwise look "already backfilled" to
    // firefox/background.js's needsBackfill check, permanently skipping a
    // record whose geometry never actually made it through.
    if (out.length === 0) return null;
    // All-or-nothing on total size, consistent with normalizeIcon's existing
    // all-or-nothing behaviour on `paths`: reject the whole value rather than
    // truncating it, which would silently produce a partial icon.
    if (JSON.stringify(out).length > MAX_ICON_NODES_TOTAL_LEN) return null;
    return out;
  }

  // TRUST BOUNDARY: `paths` is injected via innerHTML (ICON_SVG in popup.js) and is
  // trusted ONLY because it originates from the extension's own committed icon
  // dataset, never from web content. Do not wire an untrusted source into setIcon
  // or create.
  // Validate/normalize an icon picked in the popup before it is stored. Returns a
  // clean { name, paths } (plus `nodes` when present and valid) or null (null =>
  // the record gets no icon and renders the default sentinel).
  //
  // `paths`/`name` validation is unchanged from before `nodes` existed, so a
  // record saved before this change (name+paths, no nodes) keeps validating
  // exactly as it did. `nodes` is a pure addition: absent or invalid input
  // just means the field is left off, never a reason to reject the icon.
  function normalizeIcon(icon) {
    if (!icon || typeof icon !== "object") return null;
    const { name, paths, nodes } = icon;
    if (typeof name !== "string" || typeof paths !== "string") return null;
    if (!name.trim() || !paths.trim()) return null;
    if (paths.length > MAX_ICON_PATHS) return null;
    const out = { name, paths };
    const cleanNodes = normalizeIconNodes(nodes);
    if (cleanNodes !== null) out.nodes = cleanNodes;
    return out;
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
  // injected with innerHTML by ICON_SVG in popup.js. `icon.nodes` is dropped for
  // the identical reason, even though it is meant to be rendered with
  // createElementNS + setAttribute rather than innerHTML once the palette
  // renderer catches up: geometry from a user-supplied file is still untrusted,
  // and the palette's allowlist is a belt to core.js's normal suspenders, not a
  // replacement for re-resolving from the committed dataset.
  // The caller re-resolves both paths and nodes from icon-data.json by name, so
  // neither hostile markup nor hostile geometry can ever reach the DOM.
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
      // Name only. Never carry `paths` or `nodes` across the trust boundary.
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

  // Default view (no query): how many of an expanded section's items show
  // before the rest fold behind a "+N more" row. The point of grouping is
  // "my workspaces, and what's in them" rather than a wall of tabs — see the
  // palette-ui brief's wireframe.
  const PALETTE_COLLAPSED_TABS = 5;

  // "Fully expanded" (every item, no cap — reached by activating a "more"
  // row) is tracked in the SAME `expanded` Set as "expanded at all", not a
  // second set: a workspace id present in the set means "open, capped at
  // PALETTE_COLLAPSED_TABS"; that id plus this suffix means "open, showing
  // everything". One Set is the single source of truth for a section's
  // closed/capped/full state, so a caller (palette.js owns and mutates the
  // Set across a palette session) can never get two collections out of sync
  // with each other. U+0000 can never appear in a real workspace id (a
  // crypto.randomUUID()) or be produced by String(null) (the unfiled
  // section's key), so the composed key is always unambiguous.
  const PALETTE_FULL_SUFFIX = "\u0000full";

  // The active workspace defaults to "capped" (open) purely from being
  // active — see visibilityFor's `isActive` check below — with no entry in
  // `expanded` needed to get there. That means deleting the id (what
  // collapsing every other section does) can't close the active one: "not in
  // the set" is exactly what already means "use the default". This marker is
  // the explicit override — "the user closed this even though it would
  // otherwise default open" — using the same key-composition trick as
  // PALETTE_FULL_SUFFIX. collapseSection sets it unconditionally on every
  // collapse (harmless for a non-active id, whose default is already
  // collapsed), so palette.js never has to ask "is this the active one?"
  // itself.
  const PALETTE_COLLAPSED_SUFFIX = "\u0000collapsed";

  // Group the palette's flat `items` (tab/saved/workspace mix) into rows the
  // overlay can render as sections: a header row per workspace, followed by
  // that workspace's tabs (collapsed to a header-only summary unless it is
  // active or the caller has expanded it — see `expanded` below). Pure — see
  // buildPaletteRows below for the ordering rules, which mirror the
  // palette-grouping brief exactly.
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
  //
  // `expanded` is a Set of workspace ids (plus `null` for the unfiled
  // section) the user has manually opened, in the two-state encoding
  // documented above PALETTE_FULL_SUFFIX. Ignored entirely while a query is
  // present: every matching section is shown fully expanded regardless of
  // it, per the brief ("the 5-tab cap does not apply while a query is
  // present").
  function buildPaletteRows(items, workspaces, activeWorkspaceId, query, expanded) {
    const wsList = Array.isArray(workspaces) ? workspaces : [];
    const itemList = Array.isArray(items) ? items : [];
    const needle = (query || "").trim();
    const expandedIds = expanded instanceof Set ? expanded : new Set();

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

    // "full" (query mode, or manually expanded to "show all"): every tab
    // shown, no cap, no more-row. "collapsed": header only. "capped":
    // PALETTE_COLLAPSED_TABS tabs, plus a more-row if any remain.
    function visibilityFor(id, isActive) {
      if (needle) return "full";
      if (expandedIds.has(`${id}${PALETTE_FULL_SUFFIX}`)) return "full";
      // The plain id (explicit "open") is checked before the collapsed
      // marker: an explicit expand always wins over an explicit collapse, so
      // a stale/overlapping marker (the two are never meant to coexist —
      // palette.js's expandCapped/expandFull delete one before adding the
      // other — but nothing here should silently depend on that ordering)
      // resolves the same way a human would read "open again after closing".
      if (expandedIds.has(id)) return "capped";
      // Checked before the isActive default below: an explicit collapse
      // must win over "active workspaces default open", or the active
      // section could never actually be closed — see PALETTE_COLLAPSED_SUFFIX.
      if (expandedIds.has(`${id}${PALETTE_COLLAPSED_SUFFIX}`)) return "collapsed";
      if (isActive) return "capped";
      return "collapsed";
    }

    // Sections, not a flat row list, so the final cap can protect headers —
    // see the budget pass below. Each section is { header, tabs }: the header
    // row plus that section's tab-and-more rows, already in their final
    // display order (pre budget-pass truncation).
    const sections = [];
    const tabRows = (workspaceId, list) =>
      list.map((it) => ({ kind: "tab", item: it, workspaceId, selectable: true, depth: 1 }));
    const moreRow = (workspaceId, count) => ({
      kind: "more", item: null, workspaceId, count, selectable: true, depth: 1,
    });
    // Applies the section's visibility state to its full candidate list —
    // `fullTabs` is already query-filtered where relevant (or unfiltered for
    // a name match), so "full" here just means "render it all, don't cap".
    const rowsFor = (workspaceId, fullTabs, vis) => {
      if (vis === "full") return tabRows(workspaceId, fullTabs);
      if (vis === "collapsed") return [];
      const shown = fullTabs.slice(0, PALETTE_COLLAPSED_TABS);
      const out = tabRows(workspaceId, shown);
      const hidden = fullTabs.length - shown.length;
      if (hidden > 0) out.push(moreRow(workspaceId, hidden));
      return out;
    };
    const headerRow = (ws, fullTabs, vis) => ({
      kind: "header",
      item: headerItemFor(ws),
      workspaceId: ws.id,
      selectable: true,
      depth: 0,
      // The true total, independent of how many are actually rendered below
      // — a collapsed section still needs to say "3 tabs" on its header.
      count: fullTabs.length,
      expanded: vis !== "collapsed",
    });
    const unfiledHeaderRow = (fullTabs, vis) => ({
      kind: "header",
      item: null,
      workspaceId: null,
      // Selectable now, unlike the pre-collapse palette: the wireframe gives
      // "Not in a workspace" the same chevron/number/toggle affordance as a
      // real workspace, so it must be navigable and toggleable like one.
      // Activating it is still a no-op (item is null; see palette.js's
      // activate(), unchanged), only the toggle behaves.
      selectable: true,
      depth: 0,
      count: fullTabs.length,
      expanded: vis !== "collapsed",
    });
    const pushSection = (header, tabs) => sections.push({ header, tabs });

    let anyNameMatched = false;

    if (!needle) {
      // Every workspace, active one first, then stored order. Visibility
      // decides how much of each shows — see visibilityFor above.
      const ordered = [
        ...wsList.filter((w) => w.id === activeWorkspaceId),
        ...wsList.filter((w) => w.id !== activeWorkspaceId),
      ];
      for (const ws of ordered) {
        const fullTabs = byWs.get(ws.id) || [];
        const vis = visibilityFor(ws.id, ws.id === activeWorkspaceId);
        pushSection(headerRow(ws, fullTabs, vis), rowsFor(ws.id, fullTabs, vis));
      }
      if (unfiled.length) {
        const vis = visibilityFor(null, false);
        pushSection(unfiledHeaderRow(unfiled, vis), rowsFor(null, unfiled, vis));
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
        const fullTabs = byWs.get(ws.id) || [];
        pushSection(headerRow(ws, fullTabs, "full"), rowsFor(ws.id, fullTabs, "full"));
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
        const matchedTabs = rankedPool.filter((r) => r.__ws.id === ws.id).map((r) => r.__orig);
        pushSection(headerRow(ws, matchedTabs, "full"), rowsFor(ws.id, matchedTabs, "full"));
      }

      // 3. Unfiled always goes last, regardless of how its own matches would
      // score against the workspaces above — it has no name to match by, so
      // it can only ever land in this "matching items" bucket, and the brief
      // is explicit that it goes last, not interleaved by score.
      const rankedUnfiled = rankPaletteItems(unfiled, needle);
      if (rankedUnfiled.length) {
        pushSection(unfiledHeaderRow(rankedUnfiled, "full"), rowsFor(null, rankedUnfiled, "full"));
      }
    }

    // Budget pass: a flat rows.slice(0, MAX_PALETTE_RESULTS) can truncate mid
    // section and drop a later section's header entirely — the palette exists
    // to show workspace structure, so losing a whole workspace this way is
    // worse than losing some of its tabs. Every section that made it this far
    // "qualifies" (it matched, or the query was empty) and always keeps its
    // header; only tab/more rows are ever trimmed to make room.
    //
    // This runs on the already visibility-truncated section.tabs above, so in
    // ordinary no-query use (most sections collapsed to zero rows, the rest
    // capped at PALETTE_COLLAPSED_TABS) it is a no-op — the scenario it still
    // protects is a query matching many large workspaces by name, or many
    // sections manually expanded to "full" at once, where visibility alone
    // no longer bounds the row count.
    //
    // If even one header per section can't fit under the cap, there is no
    // budget left for any tabs at all, and headerless tab rows (a tab with no
    // section title above it) would be more confusing than a workspace being
    // absent — so whole sections are dropped by rank instead, same as the old
    // flat cap did, just at section granularity rather than row granularity.
    let keptSections = sections;
    let tabBudget = MAX_PALETTE_RESULTS - sections.length;
    if (tabBudget < 0) {
      keptSections = sections.slice(0, MAX_PALETTE_RESULTS);
      tabBudget = 0;
    }

    // Round-robin the remaining budget across kept sections in their existing
    // rank order: each section's best (first) item, then each section's
    // second-best, and so on. One unit per section per pass keeps a
    // many-item section from starving a small one — the exact failure this
    // replaces (a 60-tab workspace silently deleting a 1-tab workspace's
    // entire row).
    const tabsKept = keptSections.map(() => 0);
    let remaining = tabBudget;
    while (remaining > 0) {
      let progressed = false;
      for (let i = 0; i < keptSections.length && remaining > 0; i++) {
        if (tabsKept[i] < keptSections[i].tabs.length) {
          tabsKept[i]++;
          remaining--;
          progressed = true;
        }
      }
      if (!progressed) break; // every kept section's tabs are fully included
    }

    const rows = [];
    keptSections.forEach((section, i) => {
      rows.push(section.header);
      // slice, not a filter — preserves each section's own existing order,
      // round-robin only ever decides how many of the leading items survive.
      rows.push(...section.tabs.slice(0, tabsKept[i]));
    });

    // Numbering: 1-based position among selectable rows, in the order they
    // appear on screen, capped at 9 (Cmd+digit only reaches that far) —
    // headers, tabs and more-rows all take a number, since Cmd+N in
    // palette.js activates whichever row owns it, "more" included.
    let n = 0;
    for (const row of rows) {
      if (row.selectable) {
        n += 1;
        row.num = n <= 9 ? n : null;
      } else {
        row.num = null;
      }
    }

    // defaultSel must always land on a selectable row, or -1. The empty-query
    // and "a workspace name matched" cases both want the leading header
    // (always row 0, always selectable, when rows exist); a tabs/items-only
    // match wants the first tab row instead. nextSelectableIndex is reused
    // for the fallback searches so this stays consistent with arrow-key
    // navigation rather than re-implementing "find a selectable row".
    let defaultSel;
    if (!needle || anyNameMatched) {
      defaultSel = rows.length && rows[0].selectable ? 0 : nextSelectableIndex(rows, -1, 1);
    } else {
      const firstTab = rows.findIndex((r) => r.kind === "tab" && r.selectable);
      defaultSel = firstTab >= 0 ? firstTab : nextSelectableIndex(rows, -1, 1);
    }

    return { rows, defaultSel };
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

  // Whether a bare ArrowLeft/ArrowRight in the palette's query input should
  // drive the section tree (collapse/expand) rather than act as an ordinary
  // text-caret key. Pure so palette.js's onKeydown (untestable — there is no
  // DOM harness for it) can stay a thin wrapper around a decision that is
  // actually covered by a test.
  //
  // Only when the query is empty AND no modifier is held: focus lives in the
  // query input the whole time the palette is open, so once there is any
  // text, Left/Right have to mean "move the caret" (or option-jump a word,
  // shift-select, ...) or the user can never fix a typo without hitting
  // Escape first. An empty query is the one case with nothing meaningful to
  // collapse mid-search anyway — buildPaletteRows shows the unfiltered tree
  // then, same as on open — so repurposing the bare arrow keys there doesn't
  // take anything away from typing.
  function paletteArrowTargetsTree(query, modifiers) {
    const m = modifiers || {};
    return !(query || "").trim() && !m.shiftKey && !m.altKey && !m.metaKey && !m.ctrlKey;
  }

  // ---------- Exports ----------
  // The one name this file is allowed to put on the global scope. background.js
  // destructures from it in the browser; the tests require() it.
  const TabithaCore = { isTrackableUrl, isCollectableOrphanTab, cleanName, MAX_ICON_PATHS, normalizeIcon, ICON_NODE_TAGS, ICON_NODE_ATTRS, normalizeIconNodes, buildMovedState, parseBackup, MAX_IMPORT_WORKSPACES, MAX_IMPORT_TABS, rankPaletteItems, MAX_PALETTE_RESULTS, buildPaletteRows, nextSelectableIndex, PALETTE_COLLAPSED_TABS, PALETTE_FULL_SUFFIX, PALETTE_COLLAPSED_SUFFIX, paletteArrowTargetsTree };

  if (typeof globalThis !== "undefined") globalThis.TabithaCore = TabithaCore;
  if (typeof module !== "undefined" && module.exports) module.exports = TabithaCore;
})();
