#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# CHANGE THIS TO YOUR TEST VAULT
TEST_VAULT="/c/Users/baley/Documents/Coding Projects/obsidian-ask-plugin/test-vault"

PLUGIN_ID="local-vault-ai"
PLUGIN_DIR="$TEST_VAULT/.obsidian/plugins/$PLUGIN_ID"

echo "======================================"
echo " Local Vault AI - Test Deployment"
echo "======================================"
echo

cd "$ROOT_DIR"

echo "[1/4] Running TypeScript check..."
npm run typecheck

echo
echo "[2/4] Building plugin..."
npm run build

echo
echo "[3/4] Creating plugin directory..."

mkdir -p "$PLUGIN_DIR"

echo
echo "[4/4] Copying runtime files..."

cp "$ROOT_DIR/main.js" "$PLUGIN_DIR/main.js"
cp "$ROOT_DIR/manifest.json" "$PLUGIN_DIR/manifest.json"
cp "$ROOT_DIR/styles.css" "$PLUGIN_DIR/styles.css"

echo
echo "======================================"
echo " Deployment complete"
echo "======================================"
echo
echo "Installed to:"
echo "$PLUGIN_DIR"
echo
echo "Reload Local Vault AI in Obsidian."
