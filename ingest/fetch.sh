#!/usr/bin/env bash
# Fetch + extract the quarterly CMS PUF down to the four component .txt files the
# ingestion needs. Handles the triple-nested zip (outer -> SPUF_YYYY.zip -> component
# .zips -> .txt) and skips the huge pharmacy-network / pricing files we don't load.
#
# Usage:
#   ingest/fetch.sh <SOURCE> <DEST_DIR>
#     SOURCE    an https URL to the outer quarterly zip, OR a local path to it
#     DEST_DIR  where the extracted .txt files are written (use as SOURCE_DIR for ingest)
#
# Requires: curl, unzip.
set -euo pipefail

SOURCE="${1:?usage: fetch.sh <url-or-zip> <dest-dir>}"
DEST="${2:?usage: fetch.sh <url-or-zip> <dest-dir>}"
WANT='plan information|basic drugs formulary|beneficiary cost|geographic locator'

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) Obtain the outer zip.
OUTER="$TMP/outer.zip"
case "$SOURCE" in
  http://*|https://*) echo "Downloading $SOURCE"; curl -fL --retry 3 -o "$OUTER" "$SOURCE" ;;
  *) echo "Using local $SOURCE"; cp "$SOURCE" "$OUTER" ;;
esac

# 2) Outer -> inner SPUF_YYYY.zip (+ docs).
unzip -o -j "$OUTER" -d "$TMP/l1" >/dev/null
INNER="$(find "$TMP/l1" -iname 'SPUF_*.zip' | head -1)"
[ -n "$INNER" ] || { echo "ERROR: no SPUF_*.zip inside outer zip"; exit 1; }

# 3) Inner -> component zips.
unzip -o -j "$INNER" -d "$TMP/l2" >/dev/null

# 4) Only the component zips we need -> their .txt into DEST (skip 'sample' and 'insulin').
found=0
while IFS= read -r z; do
  base="$(basename "$z")"
  low="$(echo "$base" | tr '[:upper:]' '[:lower:]')"
  echo "$low" | grep -Eq "$WANT" || continue
  echo "$low" | grep -Eq 'sample|insulin' && continue
  unzip -o -j "$z" -d "$DEST" >/dev/null
  found=$((found+1))
done < <(find "$TMP/l2" -iname '*.zip')

echo "Extracted component files: $found"
ls -1 "$DEST"/*.txt
[ "$found" -ge 4 ] || { echo "ERROR: expected >=4 component files, got $found"; exit 1; }
