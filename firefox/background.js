// Tabitha — Firefox background event page (MV3).
// Owns all state, live tab tracking, and the switch.
//
// Switching calls tabs.hide() on the tabs you are leaving and tabs.show() on the
// ones you are going to. Firefox does not discard a hidden tab — the page keeps
// running — so scroll position, half-typed forms, playing media and open
// websockets all survive a switch.
//
// This is why the Firefox target exists. Chrome has no equivalent (see
// ../chrome/background.js). Do not port that file's workarounds here.

// ---------- Shared core ----------
// The manifest lists core.js before this file, so its helpers are already on the
// global scope in the browser. Under Node (tests) they come from require.
const { isTrackableUrl, cleanName, normalizeIcon, buildMovedState } =
  typeof require === "function" ? require("../shared/core.js") : globalThis.TabithaCore;

// ---------- Dev-only logging ----------
// A temporary install (about:debugging) reports installType "development"; a
// packaged one reports "normal". management.getSelf() needs no permission.
// Defaults to on, which is right for an extension you load yourself.
let TABITHA_DEBUG = true;
try {
  browser.management
    .getSelf()
    .then((info) => {
      TABITHA_DEBUG = info.installType === "development";
    })
    .catch(() => {});
} catch (_) {
  // No browser.management under Node (tests). Leave logging on.
}

function dlog(...args) {
  if (TABITHA_DEBUG) console.log("[TABITHA]", ...args);
}
function derror(...args) {
  if (TABITHA_DEBUG) console.error("[TABITHA]", ...args);
}

dlog("background loaded");

// ---------- State helpers ----------
// Persistent data lives in storage.local.
// The transient "swapping" guard and the workspace -> live tab ids map live in
// storage.session, which is cleared on browser restart. That is exactly the
// lifetime of a tab id, so the map can never go stale across runs.

async function getState() {
  return browser.storage.local.get({ workspaces: [], activeWorkspaceId: null });
}

async function setState(patch) {
  await browser.storage.local.set(patch);
}

async function isSwapping() {
  const s = await browser.storage.session.get({ swapping: false });
  return s.swapping;
}

async function setSwapping(v) {
  await browser.storage.session.set({ swapping: v });
}

async function getTabMap() {
  const s = await browser.storage.session.get({ tabMap: {} });
  return s.tabMap || {};
}

async function setTabMap(map) {
  await browser.storage.session.set({ tabMap: map });
}

// Get the window the user is actually working in (not the popup).
async function getCurrentWindowId() {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.windowId : null;
}

// Read the working window's active tab as a render-only summary for the popup.
async function readActiveTab() {
  const winId = await getCurrentWindowId();
  if (winId == null) return null;
  const [tab] = await browser.tabs.query({ active: true, windowId: winId });
  if (!tab) return null;
  return {
    url: tab.url || "",
    title: tab.title || "",
    favIconUrl: tab.favIconUrl || "",
    trackable: isTrackableUrl(tab.url)
  };
}

// ---------- Ownership ----------
// Membership is live tab ids, held in tabMap. The active workspace owns the
// window's visible tabs; every other workspace owns a set of hidden ones.
// Pinned tabs are owned by nobody: Firefox refuses to hide a pinned tab, so
// they stay visible in every workspace (the same as Safari).

async function idsClaimedByOthers(wsId) {
  const map = await getTabMap();
  const out = new Set();
  for (const [id, ids] of Object.entries(map)) {
    if (id === wsId) continue;
    for (const tabId of ids || []) out.add(tabId);
  }
  return out;
}

// Visible, unpinned, http/s tabs a workspace may take. Tabs another workspace
// still claims are skipped — that happens when the user un-hides a tab through
// Firefox's own hidden-tab menu, and we must not swallow it.
async function readOwnableTabs(winId, wsId, steal) {
  const tabs = await browser.tabs.query({ windowId: winId, hidden: false });
  const others = steal ? new Set() : await idsClaimedByOthers(wsId);
  return tabs.filter((t) => !t.pinned && isTrackableUrl(t.url) && !others.has(t.id));
}

// Record which live tabs a workspace owns, and save their URLs. Returns the ids.
// `steal` takes tabs away from whichever workspace held them ("Save current
// tabs" forking the window into a new workspace is the only caller that does).
async function claimVisible(wsId, winId, { excludeTabId = null, steal = false } = {}) {
  if (!wsId || winId == null) return [];
  const tabs = (await readOwnableTabs(winId, wsId, steal)).filter((t) => t.id !== excludeTabId);
  const ids = tabs.map((t) => t.id);

  const map = await getTabMap();
  for (const key of Object.keys(map)) {
    if (key !== wsId) map[key] = (map[key] || []).filter((id) => !ids.includes(id));
  }
  map[wsId] = ids;
  await setTabMap(map);

  const { workspaces } = await getState();
  const ws = workspaces.find((w) => w.id === wsId);
  if (ws) {
    ws.tabs = tabs.map((t) => ({ url: t.url, pinned: false }));
    await setState({ workspaces });
  }
  return ids;
}

// The workspace's tab ids that still exist. Self-healing: ids for tabs the user
// closed are dropped as they are read. An empty result means "not live yet",
// which is normal, not an error — it is what triggers materialize.
async function liveIds(wsId, winId) {
  const map = await getTabMap();
  const ids = map[wsId] || [];
  if (!ids.length) return [];
  const alive = new Set((await browser.tabs.query({ windowId: winId })).map((t) => t.id));
  const kept = ids.filter((id) => alive.has(id));
  if (kept.length !== ids.length) {
    map[wsId] = kept;
    await setTabMap(map);
  }
  return kept;
}

// Open a workspace's saved tabs. This is the ONLY path that opens tabs from
// URLs, and it runs at most once per workspace per browser session — after this
// the workspace is a set of live tabs that only ever gets hidden and shown.
// Callers must hold the swapping guard.
async function materialize(ws, winId) {
  const saved = (ws.tabs || []).filter((t) => isTrackableUrl(t.url));
  const ids = [];
  for (const t of saved) {
    // Inactive so materializing never steals focus mid-switch.
    const tab = await browser.tabs.create({ windowId: winId, url: t.url, active: false });
    ids.push(tab.id);
  }
  if (!ids.length) {
    const tab = await browser.tabs.create({ windowId: winId, active: false });
    ids.push(tab.id);
  }
  const map = await getTabMap();
  map[ws.id] = ids;
  await setTabMap(map);
  dlog("materialized", ws.name, "with", ids.length, "tabs");
  return ids;
}

// tabs.hide() resolves even when some tabs were ineligible — it hides what it
// can and stays silent about the rest. Pinned tabs, the active tab, tabs being
// closed and tabs sharing screen/mic/camera all refuse. So verify rather than
// assume, and report what stayed behind.
async function hideTabs(ids, winId) {
  if (!ids.length) return [];
  await browser.tabs.hide(ids);
  const stillVisible = (await browser.tabs.query({ windowId: winId, hidden: false }))
    .filter((t) => ids.includes(t.id));
  if (stillVisible.length) {
    derror("refused to hide:", stillVisible.map((t) => t.url));
  }
  return stillVisible.map((t) => t.id);
}

// ---------- Live tracking (auto-save) ----------
// On any tab change, re-claim the window's visible tabs for the active
// workspace. A tab opened with Cmd+T is visible, so it is picked up with no
// special case. Muted while switching, and when no workspace is active.

let debounceTimer = null;
function scheduleSync() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(syncNow, 400);
}

async function syncNow() {
  debounceTimer = null;
  if (await isSwapping()) return;
  const { activeWorkspaceId } = await getState();
  if (!activeWorkspaceId) return; // Default (null) state: nothing to track
  const winId = await getCurrentWindowId();
  if (winId == null) return;
  await claimVisible(activeWorkspaceId, winId);
}

browser.tabs.onCreated.addListener(scheduleSync);
browser.tabs.onRemoved.addListener(scheduleSync);
browser.tabs.onMoved.addListener(scheduleSync);
browser.tabs.onUpdated.addListener((id, info) => {
  // Only react to URL changes or a finished load, not every keystroke event.
  if (info.url || info.status === "complete") scheduleSync();
});

// ---------- Actions ----------

// "Save current tabs": adopt the window's visible tabs as a new workspace.
// Does NOT switch — the tabs stay open and visible, now owned by the new name.
// Steals them from whichever workspace held them, so the window is forked into
// the new workspace rather than duplicated across two.
async function createWorkspace(name, icon) {
  const clean = cleanName(name);
  if (!clean) throw new Error("Name is required");
  const winId = await getCurrentWindowId();
  const ws = { id: crypto.randomUUID(), name: clean, tabs: [] };
  const ic = normalizeIcon(icon);
  if (ic) ws.icon = ic;

  const state = await getState();
  state.workspaces.push(ws);
  state.activeWorkspaceId = ws.id; // creating one drops you into it
  await setState(state);

  await claimVisible(ws.id, winId, { steal: true });
  const after = await getState();
  return after.workspaces.find((w) => w.id === ws.id);
}

// "Start empty": create an empty workspace, then switch into it. The switch
// materializes it as one blank tab and hides everything else. Nothing closes.
async function createEmptyWorkspace(name, icon) {
  const clean = cleanName(name);
  if (!clean) throw new Error("Name is required");
  const ws = { id: crypto.randomUUID(), name: clean, tabs: [] };
  const ic = normalizeIcon(icon);
  if (ic) ws.icon = ic;
  const state = await getState();
  state.workspaces.push(ws);
  await setState(state);
  await switchWorkspace(ws.id);
  return ws;
}

// Deleting a workspace closes its tabs. They are open (just hidden) now, so
// leaving them behind would strand them: no workspace would own them and only
// Firefox's hidden-tab menu could reach them.
async function deleteWorkspace(id) {
  const winId = await getCurrentWindowId();
  const state = await getState();

  await setSwapping(true);
  try {
    const ids = await liveIds(id, winId);
    if (ids.length) {
      // Never let the window reach zero tabs (invariant 2).
      const all = await browser.tabs.query({ windowId: winId });
      if (all.length <= ids.length) await browser.tabs.create({ windowId: winId });
      await browser.tabs.remove(ids);
    }
    const map = await getTabMap();
    delete map[id];
    await setTabMap(map);

    state.workspaces = state.workspaces.filter((w) => w.id !== id);
    if (state.activeWorkspaceId === id) state.activeWorkspaceId = null;
    await setState(state);
  } finally {
    await setSwapping(false);
  }
}

async function renameWorkspace(id, name) {
  const state = await getState();
  const ws = state.workspaces.find((w) => w.id === id);
  if (ws) ws.name = (name && name.trim()) || ws.name;
  await setState(state);
}

// Set or clear a single workspace's icon. Invalid/absent icon clears it (the
// record then renders the default sentinel). No-op for an unknown id.
async function setWorkspaceIcon(id, icon) {
  const state = await getState();
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return;
  const ic = normalizeIcon(icon);
  if (ic) ws.icon = ic;
  else delete ws.icon;
  await setState(state);
}

// The switch. Show the target's tabs, hide the ones you are leaving. No tab is
// closed, so nothing reloads. Tabs are opened only when the target has none
// live yet (its first activation this browser session).
async function switchWorkspace(targetId) {
  const winId = await getCurrentWindowId();
  if (winId == null) return;

  const state = await getState();
  const target = state.workspaces.find((w) => w.id === targetId);
  if (!target) return;
  if (state.activeWorkspaceId === targetId) return; // already here

  // Mute live tracking: the show/hide below fires tab events that would
  // otherwise feed back into auto-save and cross-contaminate workspaces.
  await setSwapping(true);
  try {
    // 1. Record and save what we are leaving, while its tabs are still visible.
    const outgoing = state.activeWorkspaceId
      ? await claimVisible(state.activeWorkspaceId, winId)
      : [];

    // 2. Get the target's live tabs, opening its saved URLs only if it has none.
    let ids = await liveIds(targetId, winId);
    if (!ids.length) ids = await materialize(target, winId);

    // 3. Reveal them.
    await browser.tabs.show(ids);

    // 4. Put the active tab inside the target. This must happen BEFORE the hide
    //    below: Firefox refuses to hide the active tab, and hiding the whole
    //    outgoing set would otherwise leave one of them stubbornly on screen.
    const inTarget = (await browser.tabs.query({ windowId: winId })).filter((t) => ids.includes(t.id));
    if (inTarget.length && !inTarget.some((t) => t.active)) {
      await browser.tabs.update(inTarget[0].id, { active: true });
    }

    // 5. Hide the outgoing set.
    await hideTabs(outgoing.filter((id) => !ids.includes(id)), winId);

    // 6. Mark the target active.
    await setState({ activeWorkspaceId: targetId });
  } finally {
    // 7. Always release the guard, even if something above threw.
    await setSwapping(false);
  }
}

// ---------- Move current tab ----------

// Resolve the working window's active tab as a saveable { url, pinned }.
// Throws if it is not http/https — about: pages can't be reopened later.
async function resolveActiveSaveableTab(winId) {
  const [tab] = await browser.tabs.query({ active: true, windowId: winId });
  if (!tab) throw new Error("No active tab");
  if (!isTrackableUrl(tab.url)) throw new Error("This page can't be moved");
  return { tab, saveable: { url: tab.url, pinned: false } };
}

// Move the active tab into an existing workspace and follow it there. Ownership
// is reassigned; the tab itself is never closed, hidden or reloaded, so it keeps
// its scroll position and any unsubmitted form.
async function moveActiveTab(targetId) {
  const winId = await getCurrentWindowId();
  if (winId == null) throw new Error("No working window");
  const state = await getState();
  if (targetId === state.activeWorkspaceId) {
    throw new Error("Tab is already in this workspace");
  }
  const target = state.workspaces.find((w) => w.id === targetId);
  if (!target) throw new Error("target not found");
  const { tab, saveable } = await resolveActiveSaveableTab(winId);
  const sourceId = state.activeWorkspaceId;

  await setSwapping(true);
  try {
    // Record the move in storage first (throws if the target vanished).
    await setState(buildMovedState(state, targetId, saveable));

    // Open the target's other tabs only if it isn't live yet, then take
    // ownership of the moved tab.
    let ids = await liveIds(targetId, winId);
    if (!ids.length) ids = await materialize(target, winId);

    const map = await getTabMap();
    if (!ids.includes(tab.id)) ids = [...ids, tab.id];
    map[targetId] = ids;
    if (sourceId) map[sourceId] = (map[sourceId] || []).filter((id) => id !== tab.id);
    await setTabMap(map);

    // Save the source without the moved tab.
    if (sourceId) await claimVisible(sourceId, winId, { excludeTabId: tab.id });
  } finally {
    await setSwapping(false);
  }

  // Follow it: show the target, hide the rest.
  await switchWorkspace(targetId);
}

// Move the active tab into a brand-new workspace AND follow it there. Only the
// other tabs are hidden; the moved tab stays exactly as it is.
async function moveActiveTabToNew(name, icon) {
  const clean = cleanName(name);
  if (!clean) throw new Error("Name is required");
  const winId = await getCurrentWindowId();
  if (winId == null) throw new Error("No working window");
  const state = await getState();
  const { tab, saveable } = await resolveActiveSaveableTab(winId);
  const id = crypto.randomUUID();

  await setSwapping(true);
  try {
    // Save the workspace we're leaving WITHOUT the moved tab, so it doesn't keep
    // a copy. Skipped in Default state (no active source — invariant 6).
    const outgoing = state.activeWorkspaceId
      ? await claimVisible(state.activeWorkspaceId, winId, { excludeTabId: tab.id })
      : (await readOwnableTabs(winId, null, true)).map((t) => t.id).filter((i) => i !== tab.id);

    const seeded = { id, name: clean, tabs: [saveable] };
    const ic = normalizeIcon(icon);
    if (ic) seeded.icon = ic;
    const fresh = await getState();
    fresh.workspaces.push(seeded);
    fresh.activeWorkspaceId = id;
    await setState(fresh);

    const map = await getTabMap();
    map[id] = [tab.id];
    await setTabMap(map);

    await browser.tabs.update(tab.id, { active: true });
    await hideTabs(outgoing.filter((i) => i !== tab.id), winId);
  } finally {
    await setSwapping(false);
  }
  const after = await getState();
  return after.workspaces.find((w) => w.id === id);
}

// Replace every workspace with an imported set. activeWorkspaceId goes to null
// on purpose: Default tracks nothing and closes nothing (invariant 4), and the
// imported workspaces own no live tabs yet — they materialize on first switch.
//
// The existing workspaces' tabs are closed first. In Firefox they are open (just
// hidden), so dropping the records that own them would strand them exactly as
// deleting a workspace without closing its tabs would: nothing would own them and
// only Firefox's hidden-tab menu could reach them. The tab map goes with them,
// or a re-import in the same session would find stale ids, skip materialize and
// silently show the old tabs instead of the imported URLs.
//
// Re-validates rather than trusting the caller: the options page has already run
// parseBackup, but this is the only door into storage and it should hold on its
// own.
async function importWorkspaces(list) {
  const workspaces = [];
  for (const w of Array.isArray(list) ? list : []) {
    const name = cleanName(w && w.name);
    if (!name) continue; // a nameless record is unreachable in the popup
    const icon = normalizeIcon(w.icon);
    const tabs = (Array.isArray(w.tabs) ? w.tabs : [])
      .filter((t) => t && isTrackableUrl(t.url))
      .map((t) => ({ url: t.url, pinned: t.pinned === true }));
    const id = typeof w.id === "string" && w.id ? w.id : crypto.randomUUID();
    workspaces.push({ id, name, tabs, ...(icon ? { icon } : {}) });
  }

  const winId = await getCurrentWindowId();
  const existing = (await getState()).workspaces;

  // Mute live tracking: the closes below would otherwise feed back into
  // auto-save (invariant 1).
  await setSwapping(true);
  try {
    if (winId != null) {
      const doomed = [];
      const doom = (id) => { if (!doomed.includes(id)) doomed.push(id); };

      for (const ws of existing) {
        for (const id of await liveIds(ws.id, winId)) doom(id);
      }

      // The map alone is not enough. tabMap lives in storage.session, which is
      // cleared on browser restart — and "restart, then restore a backup" is the
      // most likely path to this function. The map is then empty, so the loop
      // above finds nothing and the session-restored tabs stay on screen. Since
      // activeWorkspaceId ends up null, no switch would ever hide them either;
      // the first switch into an imported workspace would have claimVisible
      // write them into it, silently mutating the backup the user just restored.
      // So take the window's remaining ownable visible tabs too, and leave a
      // clean window behind. steal=true because no workspace's claim outlives an
      // import anyway. Pinned and non-http/s tabs are excluded by
      // readOwnableTabs: they can belong to no workspace, so they survive here
      // exactly as they do everywhere else.
      for (const t of await readOwnableTabs(winId, null, true)) doom(t.id);

      if (doomed.length) {
        // Never let the window reach zero tabs (invariant 3). One check over the
        // whole doomed set — the surviving tabs are precisely the ones no
        // workspace can own, and there may be none of them.
        const all = await browser.tabs.query({ windowId: winId });
        if (all.length <= doomed.length) await browser.tabs.create({ windowId: winId });
        await browser.tabs.remove(doomed);
        dlog("import closed", doomed.length, "tabs to leave a clean window");
      }
    }
    await setTabMap({});
    await setState({ workspaces, activeWorkspaceId: null });
  } finally {
    await setSwapping(false);
  }
  dlog("imported", workspaces.length, "workspaces");
  return workspaces.length;
}

// ---------- Message router (popup -> background) ----------
browser.runtime.onMessage.addListener(async (msg) => {
  try {
    dlog("message:", msg && msg.type, msg);
    switch (msg.type) {
      case "getState": {
        const state = await getState();
        const activeTab = await readActiveTab();
        return { ...state, activeTab };
      }
      case "exportState": {
        const { workspaces } = await getState();
        return { ok: true, workspaces };
      }
      case "importState":
        return { ok: true, count: await importWorkspaces(msg.workspaces) };
      case "create":
        return { ok: true, ws: await createWorkspace(msg.name, msg.icon) };
      case "createEmpty":
        return { ok: true, ws: await createEmptyWorkspace(msg.name, msg.icon) };
      case "switch":
        await switchWorkspace(msg.id);
        return { ok: true };
      case "delete":
        await deleteWorkspace(msg.id);
        return { ok: true };
      case "rename":
        await renameWorkspace(msg.id, msg.name);
        return { ok: true };
      case "setIcon":
        await setWorkspaceIcon(msg.id, msg.icon);
        return { ok: true };
      case "moveTab":
        await moveActiveTab(msg.targetId);
        return { ok: true };
      case "moveTabToNew":
        return { ok: true, ws: await moveActiveTabToNew(msg.name, msg.icon) };
      default:
        return { ok: false, error: "unknown message" };
    }
  } catch (e) {
    derror("handler failed:", msg && msg.type, e);
    return { ok: false, error: String(e) };
  }
});

// Exported for unit tests (Node). Harmless no-op in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    switchWorkspace,
    createWorkspace,
    createEmptyWorkspace,
    deleteWorkspace,
    renameWorkspace,
    setWorkspaceIcon,
    moveActiveTab,
    moveActiveTabToNew,
    importWorkspaces,
  };
}
