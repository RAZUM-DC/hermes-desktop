#!/usr/bin/env bash
set -euo pipefail

arch="${1:?Usage: verify-macos-native-arch.sh x64|arm64 [output directory]}"
output_dir="${2:-dist}"
case "$arch" in
  x64) expected=x86_64; app_dir="$output_dir/mac" ;;
  arm64) expected=arm64; app_dir="$output_dir/mac-arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

# Match electron-builder's actual bundle, not an outdated productName.
shopt -s nullglob
apps=("$app_dir"/*.app)
if [ "${#apps[@]}" -ne 1 ]; then
  echo "Expected exactly one .app in $app_dir, found ${#apps[@]}" >&2
  exit 1
fi
node_file="${apps[0]}/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
test -f "$node_file"
file "$node_file"
# lipo validates a Mach-O binary and checks its architecture, not just its name.
# -verify_arch consumes all following arguments as architecture names.
lipo "$node_file" -verify_arch "$expected"

if [ "${MACOS_TEST_BUILD:-false}" = "true" ]; then
  test ! -e "${apps[0]}/Contents/Resources/app-update.yml"
  codesign --verify --deep --strict "${apps[0]}"
  codesign -dvv "${apps[0]}" 2>&1 | grep -q '^Signature=adhoc$'
fi
