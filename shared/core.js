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

  // ---------- Exports ----------
  // The one name this file is allowed to put on the global scope. background.js
  // destructures from it in the browser; the tests require() it.
  const TabithaCore = { isTrackableUrl, cleanName, MAX_ICON_PATHS, normalizeIcon, buildMovedState, parseBackup, MAX_IMPORT_WORKSPACES, MAX_IMPORT_TABS };

  if (typeof globalThis !== "undefined") globalThis.TabithaCore = TabithaCore;
  if (typeof module !== "undefined" && module.exports) module.exports = TabithaCore;
})();
