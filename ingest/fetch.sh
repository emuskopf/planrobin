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
# 'beneficiary cost' matches both the standard AND the insulin beneficiary cost file.
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

# 2) Unzip the download. It may be either:
#      (a) the outer "Quarterly …" wrapper, which contains an inner SPUF_*.zip (+ PDFs), or
#      (b) the SPUF_*.zip itself, which contains the component zips directly.
#    CMS's direct file URL points at (b); the browser download is (a). Handle both.
unzip -o -j "$OUTER" -d "$TMP/l1" >/dev/null
INNER="$(find "$TMP/l1" -iname 'SPUF_*.zip' | head -1)"
if [ -n "$INNER" ]; then
  COMP="$TMP/l2"
  unzip -o -j "$INNER" -d "$COMP" >/dev/null   # (a) inner SPUF -> component zips
else
  COMP="$TMP/l1"                                # (b) download was already the SPUF zip
fi

# 3) Only the component zips we need -> their .txt into DEST (skip 'sample' and 'insulin').
found=0
while IFS= read -r z; do
  base="$(basename "$z")"
  low="$(echo "$base" | tr '[:upper:]' '[:lower:]')"
  echo "$low" | grep -Eq "$WANT" || continue
  echo "$low" | grep -Eq 'sample' && continue
  unzip -o -j "$z" -d "$DEST" >/dev/null
  found=$((found+1))
done < <(find "$COMP" -iname '*.zip')

echo "Extracted component files: $found"
ls -1 "$DEST"/*.txt
[ "$found" -ge 5 ] || { echo "ERROR: expected >=5 component files, got $found"; exit 1; }
