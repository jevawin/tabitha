// Regenerate icon-data.json from a pinned Lucide release.
// Run:  node tools/gen-icon-data.mjs
// Dev-only. Not shipped, not a runtime dependency — same spirit as the
// rsvg-convert PNG regeneration documented in CLAUDE.md.

import { execSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LUCIDE_VERSION = "0.544.0"; // pin deliberately; bump on purpose
const EXCLUDE = new Set([
  "square-pen", "trash-2", "save", "folder-plus", "list-end", "check", "folder", "ellipsis",
]);

// 1. Pull the pinned package tarball into a temp dir (nothing lands in the repo).
//    lucide-static gives us the rendered SVG node geometry (icon-nodes.json).
const dir = mkdtempSync(join(tmpdir(), "lucide-"));
execSync(`npm pack lucide-static@${LUCIDE_VERSION}`, { cwd: dir, stdio: "inherit" });
const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
execSync(`tar -xzf "${tgz}"`, { cwd: dir });
const pkg = join(dir, "package");

// 2. name -> SVG node array (the core geometry).
const iconNodes = JSON.parse(readFileSync(join(pkg, "icon-nodes.json"), "utf8"));
// name -> search tags from the static build (fallback if the repo lacks them).
let staticTags = {};
try { staticTags = JSON.parse(readFileSync(join(pkg, "tags.json"), "utf8")); } catch { /* name-only search */ }

// 3. Categories (and richer tags) come from the Lucide SOURCE repo at the SAME
//    pinned tag. lucide-static does not ship categories.json, but the source
//    repo carries per-icon metadata in icons/<name>.json:
//      { "tags": [...], "categories": [...] }
//    The repo tags releases by bare version (no "v" prefix).
const categoryOf = {};
const repoTags = {};
const titleCase = (s) =>
  String(s)
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
try {
  const srcUrl = `https://codeload.github.com/lucide-icons/lucide/tar.gz/refs/tags/${LUCIDE_VERSION}`;
  // -f makes curl exit non-zero on HTTP errors (e.g. a 404 for a missing tag),
  // so a bad tag throws here and we degrade to "Other" rather than untar garbage.
  execSync(`curl -fsSL -o lucide-src.tgz "${srcUrl}"`, { cwd: dir, stdio: "inherit" });
  execSync(`tar -xzf lucide-src.tgz`, { cwd: dir });
  const iconsDir = join(dir, `lucide-${LUCIDE_VERSION}`, "icons");
  if (!existsSync(iconsDir)) throw new Error(`icons dir missing: ${iconsDir}`);
  for (const f of readdirSync(iconsDir)) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -5);
    let meta;
    try { meta = JSON.parse(readFileSync(join(iconsDir, f), "utf8")); } catch { continue; }
    // An icon may list several categories; take the first for a single bucket.
    const cat = Array.isArray(meta.categories) && meta.categories[0];
    if (cat) categoryOf[name] = titleCase(cat);
    if (Array.isArray(meta.tags) && meta.tags.length) repoTags[name] = meta.tags;
  }
} catch (e) {
  // Couldn't fetch/parse the source repo: leave everything uncategorised.
  console.warn(`category source unavailable, falling back to "Other": ${e.message}`);
}

// 4. Serialise nodes into the inner markup ICON_SVG() wraps.
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const serialize = (nodes) =>
  nodes.map(([tag, attrs]) => {
    // Only prepend a space when there are attrs, so a zero-attr node emits
    // `<tag/>` rather than a stray-space `<tag />`.
    const a = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
    return `<${tag}${a ? " " + a : ""}/>`;
  }).join("");

// 5. Build, dropping the app's own UI icons + the default sentinel.
//    Prefer the repo's per-icon tags (kept in sync with categories from the same
//    source); fall back to lucide-static's tags.json so search never regresses.
//
//    `nodes` carries the SAME geometry as `paths` (icon-nodes.json, straight
//    from lucide-static, untransformed) but as structured [tag, attrs] pairs
//    instead of markup, so the palette can render it with createElementNS +
//    setAttribute — no string ever gets parsed into DOM there. `paths` is
//    kept alongside it because the popup still renders from it via innerHTML;
//    migrating the popup off `paths` is a separate, later change.
const out = [];
for (const [name, nodes] of Object.entries(iconNodes)) {
  if (EXCLUDE.has(name)) continue;
  out.push({
    name,
    category: categoryOf[name] || "Other",
    tags: repoTags[name] || staticTags[name] || [],
    paths: serialize(nodes),
    nodes,
  });
}
out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

// Pre-existing path bug, fixed here: this pointed at the repo root, a leftover
// from before the 2026-07-25 monorepo restructure moved the committed dataset
// into shared/ (see CLAUDE.md's "Layout" section) without updating this write
// target. It went unnoticed because regeneration is rare and the misplaced
// output landed as a harmless untracked file, never staged or committed.
writeFileSync(new URL("../shared/icon-data.json", import.meta.url), JSON.stringify(out));
const cats = new Set(out.map((e) => e.category));
const other = out.filter((e) => e.category === "Other").length;
console.log(
  `wrote icon-data.json: ${out.length} icons (lucide ${LUCIDE_VERSION}), ` +
    `${cats.size} categories, ${other} "Other" (${((other / out.length) * 100).toFixed(1)}%)`
);
