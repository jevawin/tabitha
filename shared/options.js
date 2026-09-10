// Tabitha (options page) — shared by both targets.
//
// Settings live in a page rather than the popup because a file picker opened
// from a popup steals focus and destroys the popup's JS context, so Import
// could never work there.
//
// Like the popup, this file holds no decisions: it reads a file, validates it,
// asks for confirmation, and sends a message. The background owns storage.

const api = globalThis.browser ?? globalThis.chrome;
const { parseBackup } = globalThis.TabithaCore;

let TABITHA_DEBUG = true;
try {
  api.management
    .getSelf()
    .then((info) => {
      TABITHA_DEBUG = info.installType === "development";
    })
    .catch(() => {});
} catch (_) {
  // No management namespace: leave logging on.
}
function dlog(...args) {
  if (TABITHA_DEBUG) console.log("[TABITHA]", ...args);
}

const exportEl = document.getElementById("export");
const importPickEl = document.getElementById("importPick");
const importFileEl = document.getElementById("importFile");
const confirmEl = document.getElementById("confirm");
const confirmTextEl = document.getElementById("confirmText");
const confirmListEl = document.getElementById("confirmList");
const confirmGoEl = document.getElementById("confirmGo");
const confirmCancelEl = document.getElementById("confirmCancel");
const statusEl = document.getElementById("status");

// Workspaces waiting on the user's confirmation.
let pending = null;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` status-${kind}` : ""}`;
  statusEl.hidden = !text;
}

function hideConfirm() {
  pending = null;
  confirmEl.hidden = true;
  confirmListEl.textContent = "";
}

// ---------- Export ----------

exportEl.addEventListener("click", async () => {
  setStatus("");
  const res = await api.runtime.sendMessage({ type: "exportState" });
  // A background that failed answers { ok: false, error } — without this the
  // download would be built from an undefined list.
  if (!res || !res.ok) {
    dlog("export failed", res && res.error);
    setStatus("Couldn't read your workspaces. Try again.", "bad");
    return;
  }
  const payload = {
    format: "tabitha-workspaces",
    version: 1,
    exportedAt: new Date().toISOString(),
    workspaces: res.workspaces,
  };
  const stamp = payload.exportedAt.slice(0, 10);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `tabitha-workspaces-${stamp}.json`;
  a.click();
  // Revoking immediately can cancel the download in some builds; one turn is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  dlog("exported", res.workspaces.length, "workspaces");
  setStatus(`Exported ${res.workspaces.length} workspaces.`, "ok");
});

// ---------- Import ----------

importPickEl.addEventListener("click", () => {
  setStatus("");
  hideConfirm();
  // Reset so choosing the same file twice still fires `change`.
  importFileEl.value = "";
  importFileEl.click();
});

// Icons arrive name-only: parseBackup strips `paths` and `nodes` because both
// reach the DOM (innerHTML in the popup, createElementNS in the palette once
// its renderer catches up) and an imported file is untrusted. Re-resolve both
// from our own committed dataset, and drop any name it does not contain.
// Resolving only `paths` here would leave every imported icon rendering as
// the palette's default sentinel until the next backfill.
async function resolveIcons(workspaces) {
  if (!workspaces.some((w) => w.icon)) return workspaces;
  let byName = new Map();
  try {
    const data = await fetch("icon-data.json").then((r) => r.json());
    byName = new Map(data.map((i) => [i.name, { paths: i.paths, nodes: i.nodes }]));
  } catch (e) {
    dlog("icon-data.json unavailable, importing without icons", e);
  }
  return workspaces.map((w) => {
    if (!w.icon) return w;
    const resolved = byName.get(w.icon.name);
    if (!resolved) {
      const { icon: _drop, ...rest } = w;
      return rest;
    }
    return {
      ...w,
      icon: {
        name: w.icon.name,
        paths: resolved.paths,
        ...(resolved.nodes ? { nodes: resolved.nodes } : {}),
      },
    };
  });
}

importFileEl.addEventListener("change", async () => {
  const file = importFileEl.files && importFileEl.files[0];
  if (!file) return;

  const parsed = parseBackup(await file.text());
  if (!parsed.ok) {
    setStatus(parsed.error, "bad");
    return;
  }

  const current = await api.runtime.sendMessage({ type: "exportState" });
  // The count below comes from this reply; without it the confirmation would
  // read "Replace undefined workspaces".
  if (!current || !current.ok) {
    dlog("read-before-import failed", current && current.error);
    setStatus("Couldn't read your current workspaces, so nothing was changed.", "bad");
    return;
  }
  pending = await resolveIcons(parsed.workspaces);

  confirmTextEl.textContent =
    `Replace ${current.workspaces.length} workspaces with ${pending.length} from this file? ` +
    "This cannot be undone.";
  for (const w of pending) {
    const li = document.createElement("li");
    // textContent, not innerHTML: names come from an untrusted file.
    li.textContent = `${w.name} — ${w.tabs.length} tabs`;
    confirmListEl.appendChild(li);
  }
  confirmEl.hidden = false;
});

confirmCancelEl.addEventListener("click", () => {
  hideConfirm();
  setStatus("Import cancelled. Nothing changed.");
});

confirmGoEl.addEventListener("click", async () => {
  if (!pending) return;
  const res = await api.runtime.sendMessage({ type: "importState", workspaces: pending });
  hideConfirm();
  if (!res || !res.ok) {
    dlog("import failed", res && res.error);
    setStatus("Import failed. Check the file and try again.", "bad");
    return;
  }
  setStatus(`Imported ${res.count} workspaces. Open the popup and pick one.`, "ok");
});

// ---------- Palette theme ----------

const paletteSection = document.getElementById("paletteSection");
const themeEl = document.getElementById("paletteTheme");
const themeSaved = document.getElementById("themeSaved");

// The section starts hidden in the markup because this file is shared
// byte-identically with Chrome, which has no palette (no hidden tabs to
// theme, so the control would be inert there) and would otherwise show a
// dropdown that silently does nothing. Chrome's background doesn't return
// paletteTheme in its getState response, so its presence here is the signal
// we reveal on. Reflect the stored value at the same time.
//
// One getState round-trip covers both this and the orphan-cleanup section
// below (resolveOrphanSection) — they are unrelated concerns, but both are
// "reveal a hidden section if the state says so", so splitting into two
// messages would only double the trip for no benefit.
api.runtime.sendMessage({ type: "getState" }).then((state) => {
  if (state && state.paletteTheme) {
    themeEl.value = state.paletteTheme;
    paletteSection.hidden = false;
  }
  resolveOrphanSection(state);
});

// ---------- Automatic tab cleanup (B2: surfacing collectOrphanTabs) ----------
// Firefox writes lastOrphanCollection (storage.local) only when a startup
// pass actually closed something — see collectOrphanTabs in
// firefox/background.js. Chrome never writes the key at all, and a fresh
// Firefox profile that has never hit the leak has no record yet either, so
// "no record" is the ordinary case, not an error, and the section simply
// stays hidden for it.
const orphanSection = document.getElementById("orphanSection");
const orphanSummary = document.getElementById("orphanSummary");
const orphanList = document.getElementById("orphanList");

function resolveOrphanSection(state) {
  const rec = state && state.lastOrphanCollection;
  if (!rec || typeof rec !== "object") return;

  const when = new Date(rec.at);
  const whenText = Number.isNaN(when.getTime()) ? "an earlier run" : when.toLocaleString();
  const count = typeof rec.count === "number" ? rec.count : 0;
  const urls = Array.isArray(rec.urls) ? rec.urls : [];

  orphanSummary.textContent =
    `Last ran ${whenText}: closed ${count} tab${count === 1 ? "" : "s"}` +
    (urls.length < count ? ` (showing the first ${urls.length}).` : ".");

  orphanList.textContent = "";
  for (const url of urls) {
    const li = document.createElement("li");
    // textContent, not innerHTML: a URL here came from a tab the browser
    // reported, not from anything we authored — untrusted, same as every
    // other tab/record-derived string in this codebase.
    li.textContent = url;
    orphanList.appendChild(li);
  }

  orphanSection.hidden = false;
}

themeEl.addEventListener("change", async () => {
  const res = await api.runtime.sendMessage({ type: "setPaletteTheme", theme: themeEl.value });
  if (!res || !res.ok) return;
  themeSaved.hidden = false;
  setTimeout(() => {
    themeSaved.hidden = true;
  }, 1500);
});

// Exported for unit tests (Node) only — resolveIcons is the one piece of this
// file with real logic worth testing without a DOM. Harmless no-op in the
// browser, same pattern as core.js/background.js.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { resolveIcons };
}
