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

// Icons arrive name-only: parseBackup strips `paths` because it reaches
// innerHTML in the popup and an imported file is untrusted. Re-resolve from our
// own committed dataset, and drop any name it does not contain.
async function resolveIcons(workspaces) {
  if (!workspaces.some((w) => w.icon)) return workspaces;
  let byName = new Map();
  try {
    const data = await fetch("icon-data.json").then((r) => r.json());
    byName = new Map(data.map((i) => [i.name, i.paths]));
  } catch (e) {
    dlog("icon-data.json unavailable, importing without icons", e);
  }
  return workspaces.map((w) => {
    if (!w.icon) return w;
    const paths = byName.get(w.icon.name);
    if (!paths) {
      const { icon: _drop, ...rest } = w;
      return rest;
    }
    return { ...w, icon: { name: w.icon.name, paths } };
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
