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
//
// `_peek.calls()` is a separate recorder from `_peek.searches()`. It exists
// because two invariants around paletteSearch — the swapping guard being HELD
// (not just released) across create/hide/search, and the create-then-hide-
// then-search ordering — are invisible to state-only assertions: the guard
// reads false at the end whether or not it was ever taken, and the final tab
// state looks identical however the three calls were ordered. Deliberately
// NOT wired to real event emitters (that would mean driving the 400ms
// debounce from every test and risking a behaviour change under the whole
// Firefox suite) — a call log gets the same coverage for a blast radius of
// this one file.
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
  const searches = [];
  const calls = [];
  // Read swapping at the moment of the call, not the end of the test — that's
  // the whole point: it's what tells apart "held throughout" from "never taken".
  const logCall = (op, ids) => calls.push({ op, ids, swapping: sessionStore.swapping });

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
          title: props.title || "",
          active: false,
          pinned: !!props.pinned,
          hidden: false,
        };
        tabStore.push(t);
        logCall("create", t.id);
        return Promise.resolve(structuredClone(t));
      },
      get: (id) => {
        const t = tabStore.find((x) => x.id === id);
        return t
          ? Promise.resolve(structuredClone(t))
          : Promise.reject(new Error("No tab with id: " + id));
      },
      update: (id, props) => {
        const t = tabStore.find((x) => x.id === id);
        if (!t) return Promise.reject(new Error("No tab with id: " + id));
        if (props.active) {
          for (const other of tabStore) if (other.windowId === t.windowId) other.active = false;
          t.active = true;
          t.hidden = false; // activating a hidden tab reveals it
        }
        logCall("update", id);
        return Promise.resolve(structuredClone(t));
      },
      remove: (ids) => {
        const arr = Array.isArray(ids) ? ids : [ids];
        logCall("remove", arr);
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
        logCall("hide", arr);
        for (const t of tabStore) if (arr.includes(t.id) && canHide(t)) t.hidden = true;
        return Promise.resolve();
      },
      show: (ids) => {
        const arr = Array.isArray(ids) ? ids : [ids];
        logCall("show", arr);
        for (const t of tabStore) if (arr.includes(t.id)) t.hidden = false;
        return Promise.resolve();
      },
      onCreated: noopListener, onRemoved: noopListener, onMoved: noopListener, onUpdated: noopListener,
    },
    // Measured on Firefox 156.0b3: search.search({query, tabId}) navigates a
    // HIDDEN tab and leaves it hidden. Modelled here so the palette's
    // "search into a background workspace" path is covered by tests and not
    // only by a manual check.
    search: {
      search: ({ query, tabId, disposition }) => {
        if (tabId != null && disposition != null) {
          return Promise.reject(new Error("tabId and disposition are mutually exclusive"));
        }
        searches.push({ query, tabId: tabId ?? null, disposition: disposition ?? null });
        logCall("search", tabId ?? null);
        const url = "https://example-engine/?q=" + encodeURIComponent(query);
        if (tabId != null) {
          const t = tabStore.find((x) => x.id === tabId);
          if (!t) return Promise.reject(new Error("No tab with id: " + tabId));
          t.url = url;
          t.title = query + " — Search";
          return Promise.resolve(); // note: `hidden` is deliberately untouched
        }
        const t = {
          id: nextId++,
          windowId: tabStore.length ? tabStore[0].windowId : 1,
          url,
          title: query + " — Search",
          active: false,
          pinned: false,
          hidden: false,
        };
        tabStore.push(t);
        return Promise.resolve();
      },
    },
    runtime: {
      onMessage: noopListener,
      onInstalled: noopListener,
      // Real getURL resolves a path against the extension's own origin
      // (moz-extension://<id>/...); the backfill only ever uses the result as
      // a fetch() input, so a fake origin is enough to exercise that call.
      getURL: (path) => "moz-extension://fake/" + path,
    },
    _peek: {
      local: () => localStore,
      session: () => sessionStore,
      tabs: () => tabStore,
      visible: () => tabStore.filter((t) => !t.hidden),
      searches: () => structuredClone(searches),
      calls: () => structuredClone(calls),
    },
  };
}

module.exports = { makeBrowser };
