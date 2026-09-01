#!/usr/bin/env python3
"""
Mechanical half of the typography pass on apps/dashboard/src/styles.css.

Every edit is keyed to the exact current text of the line, so the script refuses rather
than guesses if the file has moved on. Temporary: deleted once the pass is verified.

The scale, and what each role is for:

  --type-page-title      the one <h1>/<h2> naming the screen
  --type-section-title   a panel heading
  --type-body            prose and any figure read as prose
  --type-label           a control, a table cell, a form field
  --type-meta            a micro-label, a note, a unit

Mapping from the literals that were there: 9-10px -> meta, 11-12px -> label,
13-15px -> body, 18-34px -> section-title, the page-title clamp -> page-title.
"""
import re
import sys
from pathlib import Path

SHEET = Path("apps/dashboard/src/styles.css")
FLUX = Path("apps/dashboard/src/flux/flux.css")

META = "  font-size: var(--type-meta);"
LABEL = "  font-size: var(--type-label);"
BODY = "  font-size: var(--type-body);"
SECTION = "  font-size: var(--type-section-title);"
PAGE = "  font-size: var(--type-page-title);"

FONT_SIZE = {
    239: ("font-size: 13px;", BODY),
    283: ("font-size: 10px;", META),
    335: ("font-size: 10px;", META),
    344: ("font-size: clamp(34px, 7vw, 68px);", PAGE),
    364: ("font-size: 10px;", META),
    383: ("font-size: 10px;", META),
    416: ("font-size: 10px;", META),
    424: ("font-size: 25px;", SECTION),
    431: ("font-size: 9px;", META),
    462: ("font-size: 18px;", SECTION),
    470: ("font-size: 15px;", BODY),
    477: ("font-size: 9px;", META),
    507: ("font-size: 11px;", LABEL),
    535: ("font-size: 10px;", META),
    546: ("font-size: 12px;", LABEL),
    553: ("font-size: 9px;", META),
    577: ("font-size: 10px;", META),
    630: ("font-size: 10px;", META),
    666: ("font-size: 9px;", META),
    687: ("font-size: 11px;", LABEL),
    693: ("font-size: clamp(22px, 4vw, 34px);", SECTION),
    700: ("font-size: 10px;", META),
    784: ("font-size: 10px;", META),
    800: ("font-size: 13px;", BODY),
    813: ("font-size: 11px;", LABEL),
    826: ("font-size: 11px;", LABEL),
    849: ("font-size: 18px;", SECTION),
    857: ("font-size: 10px;", META),
    867: ("font-size: 12px;", LABEL),
    872: ("font-size: 10px;", META),
    877: ("font-size: 11px;", LABEL),
    898: ("font-size: 10px;", META),
    908: ("font-size: 11px;", LABEL),
    926: ("font-size: 11px;", LABEL),
    945: ("font-size: 12px;", LABEL),
    949: ("font-size: 15px;", BODY),
    959: ("font-size: 10px;", META),
    977: ("font-size: 10px;", META),
    999: ("font-size: 10px;", META),
    1013: ("font-size: 12px;", LABEL),
    1067: ("font-size: 11px;", LABEL),
    1086: ("font-size: 12px;", LABEL),
    1096: ("font-size: 10px;", META),
}

# Tracking that was the display face's tight setting, or decoration.
LETTER_SPACING = {
    337: ("letter-spacing: 0.12em;", "  letter-spacing: 0.08em;"),
    347: ("letter-spacing: -0.065em;", "  letter-spacing: -0.02em;"),
    426: ("letter-spacing: -0.045em;", "  letter-spacing: -0.02em;"),
    464: ("letter-spacing: -0.04em;", "  letter-spacing: -0.02em;"),
    472: ("letter-spacing: -0.04em;", "  letter-spacing: -0.02em;"),
    695: ("letter-spacing: -0.05em;", "  letter-spacing: -0.02em;"),
    851: ("letter-spacing: -0.04em;", "  letter-spacing: -0.02em;"),
    951: ("letter-spacing: -0.03em;", "  letter-spacing: -0.02em;"),
}

# The display family is retired: weight carries the hierarchy instead.
DISPLAY_FAMILY_LINES = [343, 423, 461, 469, 692, 848, 948]

FLUX_LETTER_SPACING = {
    75: ("letter-spacing: -0.04em;", "  letter-spacing: -0.02em;"),
    82: ("letter-spacing: -0.04em;", "  letter-spacing: -0.02em;"),
    172: ("letter-spacing: -0.06em;", "  letter-spacing: -0.02em;"),
    180: ("letter-spacing: 0.22em;", "  letter-spacing: 0.08em;"),
    195: ("letter-spacing: 0.16em;", "  letter-spacing: 0.08em;"),
    338: ("letter-spacing: 0.14em;", "  letter-spacing: 0.08em;"),
}


def apply(path: Path, edits: dict, drops=None) -> None:
    lines = path.read_text(encoding="utf8").splitlines()
    for number, (expected, replacement) in edits.items():
        current = lines[number - 1]
        if expected not in current:
            sys.exit(f"{path}:{number} expected {expected!r}, found {current!r}")
        lines[number - 1] = replacement
    for number in drops or []:
        current = lines[number - 1]
        if "font-family: var(--bayz-font-display);" not in current:
            sys.exit(f"{path}:{number} expected the display family, found {current!r}")
        lines[number - 1] = None
    path.write_text("\n".join(line for line in lines if line is not None) + "\n", encoding="utf8")


apply(SHEET, {**FONT_SIZE, **LETTER_SPACING}, DISPLAY_FAMILY_LINES)
apply(FLUX, FLUX_LETTER_SPACING)

sheet = SHEET.read_text(encoding="utf8")
leftovers = [
    value.strip()
    for value in re.findall(r"font-size\s*:([^;}]*)", sheet)
    if "var(--type-" not in value and value.strip() != "inherit"
]
print("styles.css font-size declarations bypassing the scale:", leftovers)
print("styles.css display-family references:", sheet.count("--bayz-font-display"))
