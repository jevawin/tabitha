// Tabitha — Chrome background service worker (MV3).
// Owns all state, live tab tracking, and the swap.
//
// Chrome has no way to hide a tab, so switching here closes the old tabs and
// reopens the new ones. That flashes and reloads pages; it is a compromise, not
// a design. The Firefox target (../firefox/background.js) does it properly with
// tabs.hide(). Keep the two strategies in their own files — only genuinely
// browser-agnostic logic belongs in shared/core.js.

// ---------- Shared core ----------
// In the service worker, core.js is a sibling file (tools/sync.mjs copies it
// here). Under Node it is required from shared/. Either way the same helpers
// land in scope.
if (typeof importScripts === "function") importScripts("core.js");
const { isTrackableUrl, cleanName, normalizeIcon, buildMovedState } =
  typeof require === "function" ? require("../shared/core.js") : globalThis.TabithaCore;

// ---------- Dev-only logging ----------
// An unpacked install reports installType "development", a Web Store one
// "normal". getSelf() needs no management permission. Defaults to on, which is
// right for an extension you load yourself, and no-ops under Node (tests).
let TABITHA_DEBUG = true;
try {
  chrome.management
    .getSelf()
    .then((info) => {
      TABITHA_DEBUG = info.installType === "development";
    })
    .catch(() => {});
} catch (_) {
  // No management namespace (Node tests). Leave logging on.
}
function dlog(...args) {
  if (TABITHA_DEBUG) console.log("[TABITHA]", ...args);
}
function derror(...args) {
  if (TABITHA_DEBUG) console.error("[TABITHA]", ...args);
}

dlog("service worker loaded");

// ---------- State helpers ----------
// Persistent data lives in chrome.storage.local.
// The transient "swapping" guard lives in chrome.storage.session
// so it is cleared on browser restart and never sticks.

async function getState() {
  const s = await chrome.storage.local.get({ workspaces: [], activeWorkspaceId: null });
  return s;
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

async function isSwapping() {
  const s = await chrome.storage.session.get({ swapping: false });
  return s.swapping;
}

async function setSwapping(v) {
  await chrome.storage.session.set({ swapping: v });
}

// Get the window the user is actually working in (not the popup).
async function getCurrentWindowId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.windowId : null;
}

// Read the working window's active tab as a render-only summary for the popup.
async function readActiveTab() {
  const winId = await getCurrentWindowId();
  if (winId == null) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
  if (!tab) return null;
  return {
    url: tab.url || "",
    title: tab.title || "",
    favIconUrl: tab.favIconUrl || "",
    trackable: isTrackableUrl(tab.url)
  };
}

// Read the current window's tabs as a saveable list.
async function readWindowTabs(winId) {
  const tabs = await chrome.tabs.query({ windowId: winId });
  return tabs
    .filter((t) => isTrackableUrl(t.url))
    .map((t) => ({ url: t.url, pinned: !!t.pinned }));
}

// Save the current window's tabs into a given workspace.
async function snapshotInto(wsId, winId) {
  if (!wsId || winId == null) return;
  const saved = await readWindowTabs(winId);
  const { workspaces } = await getState();
  const ws = workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  ws.tabs = saved;
  await setState({ workspaces });
}

// ---------- Live tracking (spec 3) ----------
// On any tab change, snapshot the current window into the active workspace.
// Muted while swapping, and when no workspace is active (Default state).

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
  await snapshotInto(activeWorkspaceId, winId);
}

chrome.tabs.onCreated.addListener(scheduleSync);
chrome.tabs.onRemoved.addListener(scheduleSync);
chrome.tabs.onMoved.addListener(scheduleSync);
chrome.tabs.onUpdated.addListener((id, info) => {
  // Only react to URL changes or a finished load, not every keystroke event.
  if (info.url || info.status === "complete") scheduleSync();
});

// ---------- Actions ----------

// "Save current tabs": adopt the current window as a new workspace.
// Does NOT swap — the open tabs stay, now tracked under the new name.
async function createWorkspace(name, icon) {
  const clean = cleanName(name);
  if (!clean) throw new Error("Name is required");
  const winId = await getCurrentWindowId();
  const tabs = await readWindowTabs(winId);
  const ws = {
    id: crypto.randomUUID(),
    name: clean,
    tabs
  };
  const ic = normalizeIcon(icon);
  if (ic) ws.icon = ic;
  const state = await getState();
  state.workspaces.push(ws);
  state.activeWorkspaceId = ws.id; // creating one drops you into it
  await setState(state);
  return ws;
}

// "Start empty": create an empty workspace, then swap into it.
// The swap closes the current tabs and opens one blank tab, so the
// user lands in a fresh, tracked space. All swap invariants are
// inherited from switchWorkspace (save outgoing, guard, open-before-close).
async function createEmptyWorkspace(name, icon) {
  const clean = cleanName(name);
  if (!clean) throw new Error("Name is required");
  const ws = {
    id: crypto.randomUUID(),
    name: clean,
    tabs: []
  };
  const ic = normalizeIcon(icon);
  if (ic) ws.icon = ic;
  const state = await getState();
  state.workspaces.push(ws);
  await setState(state);
  await switchWorkspace(ws.id);
  return ws;
}

async function deleteWorkspace(id) {
  const state = await getState();
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  if (state.activeWorkspaceId === id) state.activeWorkspaceId = null;
  await setState(state);
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

// The swap (spec 4). Open new tabs, then close old. Guarded so the
// close events do not wipe the workspace we are leaving.
async function switchWorkspace(targetId) {
  const winId = await getCurrentWindowId();
  if (winId == null) return;

  const state = await getState();
  const target = state.workspaces.find((w) => w.id === targetId);
  if (!target) return;

  // 1. Save the workspace we are leaving, while its tabs are still open.
  if (state.activeWorkspaceId && state.activeWorkspaceId !== targetId) {
    await snapshotInto(state.activeWorkspaceId, winId);
  }

  // 2. Mute live tracking for the duration of the swap.
  await setSwapping(true);
  try {
    // 3. Capture the tabs to close BEFORE opening anything new.
    const oldTabs = await chrome.tabs.query({ windowId: winId });
    const oldIds = oldTabs.map((t) => t.id);

    // 4. Open the target workspace's tabs first (so the window never empties).
    const urls = target.tabs || [];
    if (urls.length === 0) {
      await chrome.tabs.create({ windowId: winId }); // one blank tab
    } else {
      for (const t of urls) {
        await chrome.tabs.create({ windowId: winId, url: t.url, pinned: t.pinned });
      }
    }

    // 5. Close the old tabs.
    if (oldIds.length) await chrome.tabs.remove(oldIds);

    // 6. Mark the target active.
    await setState({ activeWorkspaceId: targetId });
  } finally {
    // 7. Always release the guard, even if something above threw.
    await setSwapping(false);
  }
}

// ---------- Move current tab (spec: Move tab to workspace) ----------

// Resolve the working window's active tab as a saveable { url, pinned }.
// Throws if it is not http/https — chrome:// pages can't be reopened later.
async function resolveActiveSaveableTab(winId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
  if (!tab) throw new Error("No active tab");
  if (!isTrackableUrl(tab.url)) throw new Error("This page can't be moved");
  return { tab, saveable: { url: tab.url, pinned: !!tab.pinned } };
}

// Open a blank tab first if this is the only tab, so the window never empties
// (invariant 1), then close the moved tab.
async function closeMovedTab(winId, tabId) {
  const remaining = await chrome.tabs.query({ windowId: winId });
  if (remaining.length <= 1) {
    await chrome.tabs.create({ windowId: winId });
  }
  // Idempotent: the tab may already be gone (e.g. the user closed it between
  // saving state and this call). The end state — tab closed — is what we want,
  // so a "No tab with id" rejection is not an error.
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    if (!/No tab with id/i.test(String(e))) throw e;
  }
}

async function moveActiveTab(targetId) {
  const winId = await getCurrentWindowId();
  if (winId == null) throw new Error("No working window");
  const state = await getState();
  if (targetId === state.activeWorkspaceId) {
    throw new Error("Tab is already in this workspace");
  }
  const { tab, saveable } = await resolveActiveSaveableTab(winId);
  // Add the tab to the target's saved set...
  await setState(buildMovedState(state, targetId, saveable)); // throws if target missing
  // ...drop the live tab so the swap's source-save doesn't keep a copy...
  await closeMovedTab(winId, tab.id);
  // ...then follow it: switch into the target (opens its tabs, incl. the moved one).
  await switchWorkspace(targetId);
}

// Move the active tab into a brand-new workspace AND follow it there: the new
// workspace becomes active and the window is left showing just that tab. Unlike
// a swap, the moved tab is never closed/reopened — it stays open as-is (no flash,
// keeps its scroll/form state); we only close the other tabs around it.
async function moveActiveTabToNew(name, icon) {
  const clean = cleanName(name);
  if (!clean) throw new Error("Name is required");
  const winId = await getCurrentWindowId();
  if (winId == null) throw new Error("No working window");
  const state = await getState();
  const { tab, saveable } = await resolveActiveSaveableTab(winId);
  const id = crypto.randomUUID();

  // Mute live tracking while we reshape the window (same reason as the swap).
  await setSwapping(true);
  try {
    // Save the workspace we're leaving WITHOUT the moved tab, so it doesn't
    // keep a copy. Skipped in Default state (no active source — invariant 4).
    if (state.activeWorkspaceId) {
      const src = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (src) {
        const winTabs = await chrome.tabs.query({ windowId: winId });
        src.tabs = winTabs
          .filter((t) => t.id !== tab.id && isTrackableUrl(t.url))
          .map((t) => ({ url: t.url, pinned: !!t.pinned }));
      }
    }
    // Add the new workspace seeded with the moved tab and make it active.
    const seeded = { id, name: clean, tabs: [saveable] };
    const ic = normalizeIcon(icon);
    if (ic) seeded.icon = ic;
    state.workspaces.push(seeded);
    state.activeWorkspaceId = id;
    await setState(state);

    // Keep the moved tab open; close everything else. The moved tab remains, so
    // the window never empties (invariant 1).
    const others = (await chrome.tabs.query({ windowId: winId }))
      .map((t) => t.id)
      .filter((tid) => tid !== tab.id);
    if (others.length) await chrome.tabs.remove(others);
  } finally {
    await setSwapping(false);
  }
  return state.workspaces.find((w) => w.id === id);
}

// Replace every workspace with an imported set. activeWorkspaceId goes to null
// on purpose: Default tracks nothing and closes nothing (invariant 4), and an
// imported id would point at a workspace whose tabs are not open.
//
// Re-validates rather than trusting the caller: the options page has already run
// parseBackup, but this is the only door into storage and it should hold on its
// own.
async function importWorkspaces(list) {
  const workspaces = (Array.isArray(list) ? list : []).map((w) => {
    const icon = normalizeIcon(w.icon);
    const tabs = (Array.isArray(w.tabs) ? w.tabs : [])
      .filter((t) => t && isTrackableUrl(t.url))
      .map((t) => ({ url: t.url, pinned: t.pinned === true }));
    return { id: w.id, name: w.name, tabs, ...(icon ? { icon } : {}) };
  });
  await setState({ workspaces, activeWorkspaceId: null });
  dlog("imported", workspaces.length, "workspaces");
  return workspaces.length;
}

// ---------- Message router (popup -> background) ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      dlog("message:", msg && msg.type, msg);
      switch (msg.type) {
        case "getState": {
          const state = await getState();
          const activeTab = await readActiveTab();
          sendResponse({ ...state, activeTab });
          break;
        }
        case "exportState": {
          const { workspaces } = await getState();
          sendResponse({ ok: true, workspaces });
          break;
        }
        case "importState":
          sendResponse({ ok: true, count: await importWorkspaces(msg.workspaces) });
          break;
        case "create":
          sendResponse({ ok: true, ws: await createWorkspace(msg.name, msg.icon) });
          break;
        case "createEmpty":
          sendResponse({ ok: true, ws: await createEmptyWorkspace(msg.name, msg.icon) });
          break;
        case "switch":
          await switchWorkspace(msg.id);
          sendResponse({ ok: true });
          break;
        case "delete":
          await deleteWorkspace(msg.id);
          sendResponse({ ok: true });
          break;
        case "rename":
          await renameWorkspace(msg.id, msg.name);
          sendResponse({ ok: true });
          break;
        case "setIcon":
          await setWorkspaceIcon(msg.id, msg.icon);
          sendResponse({ ok: true });
          break;
        case "moveTab":
          await moveActiveTab(msg.targetId);
          sendResponse({ ok: true });
          break;
        case "moveTabToNew":
          sendResponse({ ok: true, ws: await moveActiveTabToNew(msg.name, msg.icon) });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      derror("handler failed:", msg && msg.type, e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep the channel open for the async work
});

// Exported for unit tests (Node). Harmless no-op in the service worker.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { moveActiveTab, moveActiveTabToNew, createWorkspace, createEmptyWorkspace, setWorkspaceIcon, switchWorkspace, deleteWorkspace, importWorkspaces };
}
