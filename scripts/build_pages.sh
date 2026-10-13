#!/usr/bin/env bash
# Builds the read-only static snapshot of PLUME for GitHub Pages into ./site.
# Needs the local stack running (make dev) in the state you want to publish, e.g. after the demo journey.
#   1. export verbatim GET responses + recorded chain reads (scripts/export_static_snapshot.py)
#   2. next build with output: "export", basePath /PLUME, NEXT_PUBLIC_STATIC_SNAPSHOT=1
#   3. add the snapshot data, the demo video and .nojekyll
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_PATH="${PAGES_BASE_PATH:-/PLUME}"
cd "$ROOT"
(cd backend && uv run python ../scripts/export_static_snapshot.py)
SNAP_DATE="$(python3 -c "import json;print(json.load(open('frontend/snapshot/index.json'))['exported_at'][:10])")"
rm -rf frontend/.next-pages site
(cd frontend && NEXT_PUBLIC_STATIC_SNAPSHOT=1 NEXT_PUBLIC_BASE_PATH="$BASE_PATH" NEXT_PUBLIC_SNAPSHOT_DATE="$SNAP_DATE" \
  npx next build)
mv frontend/.next-pages site  # with a custom distDir, the export is written there
cp -R frontend/snapshot site/snapshot
mkdir -p site/demo
cp demo-video/output/plume-demo-final.mp4 demo-video/output/subtitles.srt site/demo/
touch site/.nojekyll
echo "✓ site/ ready ($(du -sh site | cut -f1)) — base path $BASE_PATH, snapshot $SNAP_DATE"
