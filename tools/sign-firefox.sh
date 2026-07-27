#!/usr/bin/env bash
# Sign the Firefox build for self-distribution and drop the .xpi in
# web-ext-artifacts/. Release Firefox will not permanently install an unsigned
# extension, so this is the only route to a build that survives a restart.
#
# Credentials live in a file OUTSIDE the repo (default ~/.config/tabitha/amo.env)
# so they cannot be committed. Nothing here ever echoes them. Override the
# location with TABITHA_AMO_ENV.
#
# AMO rejects a version it has already seen: bump "version" in
# firefox/manifest.json before re-signing.

set -euo pipefail

ENV_FILE="${TABITHA_AMO_ENV:-$HOME/.config/tabitha/amo.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: no credentials file at $ENV_FILE" >&2
  echo "       create it with WEB_EXT_API_KEY and WEB_EXT_API_SECRET," >&2
  echo "       from https://addons.mozilla.org/en-US/developers/addon/api/key/" >&2
  exit 1
fi

if grep -q 'replace-me' "$ENV_FILE"; then
  echo "error: $ENV_FILE still holds placeholder values — fill them in first." >&2
  exit 1
fi

# set -a exports what the file defines; web-ext reads both from the environment.
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

if [ -z "${WEB_EXT_API_KEY:-}" ] || [ -z "${WEB_EXT_API_SECRET:-}" ]; then
  echo "error: WEB_EXT_API_KEY or WEB_EXT_API_SECRET missing from $ENV_FILE" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# firefox/ is only a complete extension after shared/ is copied in.
node tools/sync.mjs

echo "signing firefox/ (version $(node -p 'require("./firefox/manifest.json").version'))..."

# npx, not a devDependency: the repo stays dependency-free by design.
exec npx --yes web-ext sign \
  --source-dir=firefox \
  --channel=unlisted \
  --artifacts-dir=web-ext-artifacts
