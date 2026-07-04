#!/usr/bin/env bash
# Regenerate the hermetic acceptance-test fixture: a small REAL subset of the CMS PUF
# (header row + only the rows needed to reproduce the Milestone 0 case). Run from repo root
# with the full extracted PUF present in data/extracted/.
set -euo pipefail
SRC="data/extracted"
DST="tests/fixtures"
PI=$(ls "$SRC"/*'plan information'*.txt | grep -v sample | head -1)
BF=$(ls "$SRC"/*'basic drugs formulary'*.txt | grep -v sample | head -1)
BC=$(ls "$SRC"/*'beneficiary cost'*.txt | grep -v -e sample -e insulin | head -1)
IN=$(ls "$SRC"/*'insulin beneficiary cost'*.txt | grep -v sample | head -1)
GL=$(ls "$SRC"/*'geographic locator'*.txt | grep -v sample | head -1)

# plan information: header + the target plan H4461-046 rows
head -1 "$PI" > "$DST/plan information PPUF_2026Q1.txt"
awk -F'|' '$1=="H4461" && $2=="046"' "$PI" >> "$DST/plan information PPUF_2026Q1.txt"

# basic formulary: header + formulary 00026408 rows for the two duloxetine RXCUIs
head -1 "$BF" > "$DST/basic drugs formulary file PPUF_2026Q1.txt"
awk -F'|' '$1=="00026408" && ($4=="596934" || $4=="596930")' "$BF" >> "$DST/basic drugs formulary file PPUF_2026Q1.txt"

# beneficiary cost: header + all rows for the target plan
head -1 "$BC" > "$DST/beneficiary cost file PPUF_2026Q1.txt"
awk -F'|' '$1=="H4461" && $2=="046"' "$BC" >> "$DST/beneficiary cost file PPUF_2026Q1.txt"

# insulin beneficiary cost: header + all rows for the target plan
head -1 "$IN" > "$DST/insulin beneficiary cost file PPUF_2026Q1.txt"
awk -F'|' '$1=="H4461" && $2=="046"' "$IN" >> "$DST/insulin beneficiary cost file PPUF_2026Q1.txt"

# geographic locator: header + all Missouri rows
head -1 "$GL" > "$DST/geographic locator file PPUF_2026Q1.txt"
awk -F'|' 'NR>1 && $2=="Missouri"' "$GL" >> "$DST/geographic locator file PPUF_2026Q1.txt"

echo "Fixture line counts (incl header):"
wc -l "$DST"/*.txt
