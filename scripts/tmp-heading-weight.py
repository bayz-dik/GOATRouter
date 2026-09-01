#!/usr/bin/env python3
"""
Raise the weights the retired display face used to supply.

`Archivo Black` is heavy at `font-weight: 400` — the weight IS the face. Six rules that
named it therefore declared 400, and when the family was retired those rules silently
became regular-weight Archivo: the headings lost every bit of the heft the design had.
The typography contract did not catch it, because it asserts the family and the scale and
says nothing about weight.

Keyed to the exact current line text so the script refuses rather than guesses.
Temporary: deleted once verified.
"""
import sys
from pathlib import Path

SHEET = Path("apps/dashboard/src/styles.css")

# line -> (expected, replacement, what it styles)
EDITS = {
    397: ("font-weight: 400;", "  font-weight: 800;", ".screen-title"),
    518: ("font-weight: 400;", "  font-weight: 800;", ".panel-head h2"),
    525: ("font-weight: 400;", "  font-weight: 800;", ".panel-head h3"),
    748: ("font-weight: 400;", "  font-weight: 800;", ".status-panel strong"),
    903: ("font-weight: 400;", "  font-weight: 800;", ".bayz-panel > h2"),
    1002: ("font-weight: 400;", "  font-weight: 800;", ".bayz-list-item strong"),
}

lines = SHEET.read_text(encoding="utf8").splitlines()
for number, (expected, replacement, what) in EDITS.items():
    current = lines[number - 1]
    if expected not in current:
        sys.exit(f"{SHEET}:{number} ({what}) expected {expected!r}, found {current!r}")
    lines[number - 1] = replacement
SHEET.write_text("\n".join(lines) + "\n", encoding="utf8")

remaining = [
    (index + 1, line.strip())
    for index, line in enumerate(lines)
    if "font-weight: 400" in line
]
print("rules still at weight 400:", remaining)
