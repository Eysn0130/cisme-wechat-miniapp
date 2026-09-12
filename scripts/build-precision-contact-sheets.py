"""Build navigation contact sheets from hash-scoped native simulator frames.

Usage: python3 scripts/build-precision-contact-sheets.py REVIEW_ID BASELINE_ID
The sheets are indexes; the original PNGs remain the visual evidence.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import sys


ROOT = Path(__file__).resolve().parents[1] / "docs/evidence/visual"
current = ROOT / sys.argv[1]
baseline = ROOT / sys.argv[2]
out = current / "contact-sheets"
out.mkdir(exist_ok=True)
font_path = "/System/Library/Fonts/HelveticaNeue.ttc"
font = ImageFont.truetype(font_path, 18)
small = ImageFont.truetype(font_path, 14)


def route(root, name):
    return root / "screenshots/raw" / f"pages__{name}__index.png"


def composer(root, name):
    return root / "composer-current/screenshots" / name


def sheet(filename, items, columns=4, cell_width=220):
    margin, gap, label_height = 18, 16, 48
    frames = []
    for label, path in items:
        if not path.exists():
            raise FileNotFoundError(path)
        im = Image.open(path).convert("RGB")
        height = round(im.height * cell_width / im.width)
        frames.append((label, im.resize((cell_width, height), Image.Resampling.LANCZOS)))
    image_height = max(im.height for _, im in frames) + label_height
    rows = (len(frames) + columns - 1) // columns
    canvas = Image.new("RGB", (margin * 2 + columns * cell_width + (columns - 1) * gap,
                                margin * 2 + rows * image_height + (rows - 1) * gap), "#f8f5f9")
    draw = ImageDraw.Draw(canvas)
    for index, (label, im) in enumerate(frames):
        row, col = divmod(index, columns)
        x = margin + col * (cell_width + gap)
        y = margin + row * (image_height + gap)
        canvas.paste(im, (x, y))
        draw.text((x + 4, y + image_height - label_height + 9), label, fill="#30273a", font=small)
    canvas.save(out / filename, optimize=True)


sheet("button-family-contact-sheet.png", [
    ("Home CTA", route(current, "home")),
    ("Product CTA", route(current, "product")),
    ("Checkout CTA", route(current, "checkout")),
    ("Settings rows", route(current, "settings")),
    ("Management CTA", route(current, "management-catalog")),
    ("Management actions", current / "screenshots/management-product-actions.png"),
    ("Sheet tile / cancel", composer(current, "08-image-entry-sheet.png")),
    ("Composer icons", composer(current, "01-empty-disabled-safe-area.png")),
    ("Admin resolve", composer(current, "14-admin-empty.png")),
])

sheet("typography-contact-sheet.png", [
    ("Home", route(current, "home")),
    ("Settings", route(current, "settings")),
    ("Product", route(current, "product")),
    ("Checkout", route(current, "checkout")),
    ("Privacy", route(current, "privacy-rights")),
    ("Support", route(current, "support")),
    ("Management", route(current, "management")),
    ("Admin chat", route(current, "management-support-chat")),
])

sheet("composer-contact-sheet.png", [
    (f"{n:02d} {name}", path) for n, name, path in [
        (1, "empty", composer(current, "01-empty-disabled-safe-area.png")),
        (2, "one line", composer(current, "02-one-line-active.png")),
        (3, "three lines", composer(current, "03-three-lines.png")),
        (4, "six lines", composer(current, "04-six-lines-expanded.png")),
        (5, "eight lines", composer(current, "05-eight-lines-internal-scroll.png")),
        (6, "long CJK", composer(current, "06-long-copy-fixed-icons.png")),
        (7, "keyboard fixture", composer(current, "07-keyboard-inset-fixture.png")),
        (8, "image sheet", composer(current, "08-image-entry-sheet.png")),
        (9, "attachment sheet", composer(current, "09-attachment-entry-sheet.png")),
        (10, "order picker", composer(current, "10-owned-order-picker.png")),
        (11, "order draft", composer(current, "11-order-draft-send-active.png")),
        (12, "send reset", composer(current, "12-send-ack-reset.png")),
        (13, "thread edge", composer(current, "13-thread-scrollbar-near-edge.png")),
        (14, "admin empty", composer(current, "14-admin-empty.png")),
        (15, "admin six", composer(current, "15-admin-six-lines.png")),
        (16, "admin eight", composer(current, "16-admin-eight-lines-capped.png")),
    ]
], columns=4)

sheet("bottom-sheet-contact-sheet.png", [
    ("Image sheet", composer(current, "08-image-entry-sheet.png")),
    ("Attachment sheet", composer(current, "09-attachment-entry-sheet.png")),
    ("Order picker", composer(current, "10-owned-order-picker.png")),
    ("Order draft", composer(current, "11-order-draft-send-active.png")),
])

sheet("admin-composer-contact-sheet.png", [
    ("Queue", route(current, "management-support")),
    ("Admin empty", composer(current, "14-admin-empty.png")),
    ("Admin six", composer(current, "15-admin-six-lines.png")),
    ("Admin eight", composer(current, "16-admin-eight-lines-capped.png")),
])

sheet("before-after-precision-contact-sheet.png", [
    ("BEFORE catalog", route(baseline, "management-catalog")),
    ("AFTER catalog", route(current, "management-catalog")),
    ("BEFORE admin", route(baseline, "management-support-chat")),
    ("AFTER admin", route(current, "management-support-chat")),
    ("BEFORE sheet", composer(baseline, "08-image-entry-sheet.png")),
    ("AFTER sheet", composer(current, "08-image-entry-sheet.png")),
    ("BEFORE composer", composer(baseline, "01-empty-disabled-safe-area.png")),
    ("AFTER composer", composer(current, "01-empty-disabled-safe-area.png")),
    ("BEFORE actions", current / "before-sources/management-product-actions-c8eaee45.png"),
    ("AFTER actions", current / "screenshots/management-product-actions.png"),
], columns=2)

sheet("management-inline-before-after.png", [
    ("BEFORE c8eaee45", current / "before-sources/management-product-actions-c8eaee45.png"),
    ("AFTER current", current / "screenshots/management-product-actions.png"),
], columns=2)

print(f"Wrote seven contact sheets to {out}")
