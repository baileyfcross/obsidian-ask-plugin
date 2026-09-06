#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RELEASE_DIR="$ROOT_DIR/release"
PACKAGE_NAME="local-vault-ai"
PACKAGE_DIR="$RELEASE_DIR/$PACKAGE_NAME"
ZIP_FILE="$RELEASE_DIR/$PACKAGE_NAME.zip"

echo "======================================"
echo " Local Vault AI - Package Build"
echo "======================================"
echo

cd "$ROOT_DIR"

echo "[1/5] Running TypeScript check..."
npm run typecheck

echo
echo "[2/5] Building plugin..."
npm run build

echo
echo "[3/5] Preparing release directory..."

rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"

echo
echo "[4/5] Copying runtime files..."

cp "$ROOT_DIR/main.js" "$PACKAGE_DIR/"
cp "$ROOT_DIR/manifest.json" "$PACKAGE_DIR/"
cp "$ROOT_DIR/styles.css" "$PACKAGE_DIR/"

echo
echo "[5/5] Creating ZIP package..."

rm -f "$ZIP_FILE"

cd "$RELEASE_DIR"

if command -v zip >/dev/null 2>&1; then
    zip -r "$(basename "$ZIP_FILE")" "$PACKAGE_NAME"
else
    echo
    echo "ERROR: 'zip' command was not found."
    echo
    echo "Install zip or create the archive manually from:"
    echo "$PACKAGE_DIR"
    exit 1
fi

echo
echo "======================================"
echo " Package complete"
echo "======================================"
echo
echo "Runtime files:"
echo "$PACKAGE_DIR"
echo
echo "ZIP package:"
echo "$ZIP_FILE"
