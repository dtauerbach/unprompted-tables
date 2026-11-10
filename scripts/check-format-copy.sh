#!/usr/bin/env bash
# The site keeps its own copy of the spectator format (src/lib/spectator.ts)
# and of its fixtures. They must match ours from the first export down, and
# the fixtures byte for byte, so a feed one side accepts the other does too.
# A site from before the format has nothing to compare.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
site="${SITE_DIR:?set SITE_DIR to an unprompted checkout}"
if [ ! -f "$site/src/lib/spectator.ts" ]; then
  echo "This site predates the spectator format; nothing to compare."
  exit 0
fi
from_export() { sed -n '/^export/,$p' "$1"; }
diff <(from_export "$here/packages/spectator/src/format.ts") \
  <(from_export "$site/src/lib/spectator.ts")
diff -r "$here/packages/spectator/fixtures" "$site/src/test/fixtures/spectator"
echo "The site's copy of the spectator format matches."
