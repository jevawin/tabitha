// Tabitha palette — injected into the active page by the background on the
// keyboard shortcut. Re-injecting re-runs this file, so it toggles rather than
// stacking a second overlay.
//
// A shadow root, not an iframe. backdrop-filter cannot blur across an iframe
// boundary — the iframe is a separate document, so its backdrop is its own —
// and the frosted glass is the design. Shadow DOM gives the same style
// isolation while staying real page content.
(() => {
  const HOST_ID = "__tabitha_palette_host";

  if (window.__tabithaPaletteToggle) {
    window.__tabithaPaletteToggle();
    return;
  }

  const api = globalThis.browser ?? globalThis.chrome;

  let host = null;
  let root = null;

  function close() {
    if (!host) return;
    host.remove();
    host = null;
    root = null;
  }

  function open() {
    host = document.createElement("div");
    host.id = HOST_ID;
    // Inherited properties cross the shadow boundary, so reset before styling.
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";
    // documentElement, not body: fewer pages create a containing block there.
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "closed" });

    // Placeholder until Task 7. Proves the host mounts and takes keys.
    const probe = document.createElement("input");
    probe.setAttribute("aria-label", "Tabitha palette");
    root.appendChild(probe);
    probe.focus();
  }

  // Cmd+digit was measured cancellable inside page content, so preventDefault
  // genuinely stops Firefox switching tabs. Verified on a moz-extension page;
  // step 6 of this task re-verifies it here, on a real https page.
  function onKeydown(e) {
    if (!host) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (/^Digit[1-9]$/.test(e.code) && e.metaKey) {
      e.preventDefault();
      console.log("[TABITHA] palette would search into workspace", e.code.slice(5));
    }
  }
  window.addEventListener("keydown", onKeydown, true);

  window.__tabithaPaletteToggle = () => (host ? close() : open());
  window.__tabithaPaletteToggle();
})();
