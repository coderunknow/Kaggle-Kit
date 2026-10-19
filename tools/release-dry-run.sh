#!/usr/bin/env bash
# Local dry run of the release automation of .github/workflows/release.yml.
#
# It runs the steps of the workflow that do not need GitHub: the checks, the
# build, the staging of the artifacts and their validation. The publish step
# is not part of it, the upload is done by the workflow.
#
#   tools/release-dry-run.sh [version] [tag]
#
set -euo pipefail

VERSION="${1:-0.1.0-dev1}"
TAG="${2:-v$VERSION}"
SOURCE_SHA="$(git rev-parse HEAD)"
STAGE="release"

cd "$(dirname "$0")/.."

echo "== checks =="
python3 tools/run_checks.py --output checks.json \
  --command "npm run typecheck" \
  --command "npm run lint" \
  --command "npm test" \
  --command "python3 -m unittest discover -s notebooks -p 'test_*.py'" \
  --command "python3 -m unittest discover -s tools -p 'test_*.py'"

echo "== build =="
npm run build
npm run check:integration

echo "== stage =="
rm -rf "$STAGE"
mkdir -p "$STAGE"

python3 tools/build_notebook.py \
  --source notebooks/qwen3_8_27b_api.py \
  --output "$STAGE/$TAG-notebook.ipynb" \
  --version "$VERSION" \
  --tag "$TAG" \
  --source-sha "$SOURCE_SHA"

APP_DIR="$STAGE/app"
mkdir -p "$APP_DIR/dist"
cp -r dist/client "$APP_DIR/dist/client"
mkdir -p "$APP_DIR/dist/server"
cp dist/server/index.js "$APP_DIR/dist/server/index.js"
cp package.json "$APP_DIR/package.json"
cp README.md "$APP_DIR/README.md"
cp LICENSE "$APP_DIR/LICENSE"
printf '%s\n' \
  'Kaggle-Kit application bundle' \
  '' \
  '  node dist/server/index.js' \
  '' \
  'The backend serves the built client and the API on http://127.0.0.1:8787.' \
  'It has no runtime dependencies. Set KAGGLE_KIT_PORT, KAGGLE_KIT_HOST,' \
  'KAGGLE_KIT_ALLOWED_HOSTS or KAGGLE_KIT_BLOCK_PRIVATE_NETWORKS to change the defaults.' \
  > "$APP_DIR/README-RUN.txt"
( cd "$APP_DIR" && zip -qr "../$TAG-app.zip" . )
rm -rf "$APP_DIR"

git archive --format=zip --prefix="kaggle-kit-$VERSION/" \
  -o "$STAGE/$TAG-source.zip" "$SOURCE_SHA"

python3 tools/build_release_report.py \
  --stage "$STAGE" \
  --checks checks.json \
  --environment docs/release/environment.json \
  --version "$VERSION" \
  --tag "$TAG" \
  --source-sha "$SOURCE_SHA" \
  --output "$STAGE/verification-report.json"

python3 tools/build_manifest.py \
  --stage "$STAGE" \
  --version "$VERSION" \
  --tag "$TAG" \
  --source-sha "$SOURCE_SHA" \
  --output "$STAGE/manifest.json" \
  --checksums "$STAGE/SHA256SUMS"

echo "== validate =="
python3 tools/validate_release.py \
  --stage "$STAGE" \
  --version "$VERSION" \
  --tag "$TAG" \
  --source-sha "$SOURCE_SHA"

echo "== the staged release =="
ls -la "$STAGE"
