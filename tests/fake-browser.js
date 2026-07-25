// In-memory `browser` fake for action tests (storage + tabs), deep-copying on
// get/set like real storage. Extracted so multiple test files can share it.
//
// It models the Firefox behaviour that actually bites:
//   - tabs.hide() resolves even when tabs were ineligible, hiding what it can
//     and staying silent about the rest;
//   - the active tab cannot be hidden;
//   - pinned tabs cannot be hidden;
//   - a tab flagged `unhideable` stands in for one sharing screen/mic/camera.
// A fake that lies is worse than no test — add to it rather than around it.
const noopListener = { addListener() {} };

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (k in obj) o[k] = obj[k];
  return o;
}

function makeBrowser({ local = {}, session = {}, tabs = [] } = {}) {
  const localStore = structuredClone({ workspaces: [], activeWorkspaceId: null, ...local });
  const sessionStore = structuredClone({ swapping: false, tabMap: {}, ...session });
  // Tabs default to visible so fixtures need no `hidden` field.
  let tabStore = structuredClone(tabs).map((t) => ({ hidden: false, pinned: false, ...t }));
  let nextId = Math.max(0, ...tabStore.map((t) => t.id)) + 1;

  const query = (q = {}) => {
    let res = tabStore.slice();
    if (q.windowId != null) res = res.filter((t) => t.windowId === q.windowId);
    // single-window model: lastFocusedWindow matches everything
    if (q.active) res = res.filter((t) => t.active);
    if (q.hidden != null) res = res.filter((t) => !!t.hidden === q.hidden);
    if (q.pinned != null) res = res.filter((t) => !!t.pinned === q.pinned);
    return Promise.resolve(structuredClone(res));
  };

  // Firefox: pinned, active, closing and media-sharing tabs are not eligible.
  const canHide = (t) => !t.active && !t.pinned && !t.unhideable;

  return {
    management: {
      getSelf: () => Promise.resolve({ installType: "development" }),
    },
    storage: {
      local: {
        get: (defaults) => Promise.resolve(structuredClone({ ...defaults, ...pick(localStore, Object.keys(defaults)) })),
        set: (patch) => { Object.assign(localStore, structuredClone(patch)); return Promise.resolve(); },
      },
      session: {
        get: (defaults) => Promise.resolve(structuredClone({ ...defaults, ...pick(sessionStore, Object.keys(defaults)) })),
        set: (patch) => { Object.assign(sessionStore, structuredClone(patch)); return Promise.resolve(); },
      },
    },
    tabs: {
      query,
      create: (props) => {
        const t = {
          id: nextId++,
          windowId: props.windowId,
          url: props.url || "",
          active: false,
          pinned: !!props.pinned,
          hidden: false,
        };
        tabStore.push(t);
        return Promise.resolve(structuredClone(t));
      },
      update: (id, props) => {
        const t = tabStore.find((x) => x.id === id);
        if (!t) return Promise.reject(new Error("No tab with id: " + id));
        if (props.active) {
          for (const other of tabStore) if (other.windowId === t.windowId) other.active = false;
          t.active = true;
          t.hidden = false; // activating a hidden tab reveals it
        }
        return Promise.resolve(structuredClone(t));
      },
      remove: (ids) => {
        const arr = Array.isArray(ids) ? ids : [ids];
        const closedActive = tabStore.some((t) => arr.includes(t.id) && t.active);
        tabStore = tabStore.filter((t) => !arr.includes(t.id));
        if (closedActive) {
          const visible = tabStore.filter((t) => !t.hidden);
          if (visible.length) visible[visible.length - 1].active = true;
        }
        return Promise.resolve();
      },
      // Resolves regardless. Ineligible tabs are simply not hidden — no error,
      // no report. This silence is the reason background.js verifies afterwards.
      hide: (ids) => {
        const arr = Array.isArray(ids) ? ids : [ids];
        for (const t of tabStore) if (arr.includes(t.id) && canHide(t)) t.hidden = true;
        return Promise.resolve();
      },
      show: (ids) => {
        const arr = Array.isArray(ids) ? ids : [ids];
        for (const t of tabStore) if (arr.includes(t.id)) t.hidden = false;
        return Promise.resolve();
      },
      onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener,
    },
    runtime: { onMessage: noopListener },
    _peek: {
      local: () => localStore,
      session: () => sessionStore,
      tabs: () => tabStore,
      visible: () => tabStore.filter((t) => !t.hidden),
    },
  };
}

module.exports = { makeBrowser };
