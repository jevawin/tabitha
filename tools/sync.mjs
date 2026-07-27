// Copy shared/ into chrome/ and firefox/ so each folder is a complete,
// loadable extension.
//
// Browsers cannot follow a path out of the extension root, so a manifest in
// chrome/ cannot reference ../shared/popup.html. The copies are the price of
// that. They are gitignored — shared/ is the only source of truth. Editing a
// copy is always a mistake; it will be overwritten by the next sync.
//
// Run: node tools/sync.mjs      (no dependencies, stdlib only)

import { cp, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = join(root, "shared");
const TARGETS = ["chrome", "firefox"];

// Everything in shared/ is copied. Listed explicitly rather than globbed so a
// stray file in shared/ never silently ships.
const ASSETS = ["popup.html", "popup.css", "popup.js", "options.html", "options.js", "core.js", "icon-data.json", "icons"];

async function main() {
  const present = await readdir(SHARED);
  const missing = ASSETS.filter((a) => !present.includes(a));
  if (missing.length) {
    console.error(`shared/ is missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  for (const target of TARGETS) {
    for (const asset of ASSETS) {
      const dest = join(root, target, asset);
      // Remove first so a deleted shared file doesn't linger in the copy.
      await rm(dest, { recursive: true, force: true });
      await cp(join(SHARED, asset), dest, { recursive: true });
    }
    console.log(`synced shared/ -> ${target}/`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
