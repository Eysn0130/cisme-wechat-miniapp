"""Verify and checksum a hash-scoped WeChat DevTools precision review pack."""

from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import re
import sys
import xml.etree.ElementTree as ET

repo = Path(__file__).resolve().parents[1]
root = repo / "docs/evidence/visual" / sys.argv[1]
baseline = sys.argv[2]
before_inline_hash = sys.argv[3]
source = json.loads((root / "source-manifest.json").read_text())["miniProgram"]["sourceSha256"]
composer = json.loads((root / "composer-current/visual-evidence-manifest.json").read_text())
assert composer["packageSourceSha256"] == source
raw_routes = sorted((root / "screenshots/raw").glob("*.png"))
composer_frames = sorted((root / "composer-current/screenshots").glob("*.png"))
assert len(raw_routes) == 27, len(raw_routes)
assert len(composer_frames) == 16, len(composer_frames)

wxss = list((repo / "apps/miniprogram").rglob("*.wxss"))
properties = {}
for key in ["font-size", "font-weight", "line-height", "letter-spacing", "color", "padding", "gap", "border-radius"]:
    values = []
    for path in wxss:
        text = re.sub(r"/\*.*?\*/", "", path.read_text(), flags=re.S)
        values += re.findall(r"(?<![\w-])" + re.escape(key) + r"\s*:\s*([^;}]+)", text)
    values = [value.strip() for value in values]
    properties[key] = {"declarations": len(values), "unique": len(set(values)),
                       "topValues": [{"value": value, "count": count} for value, count in Counter(values).most_common(15)]}
icons = list((repo / "apps/miniprogram/assets/icons").rglob("*.svg"))
viewboxes = Counter()
missing = []
for path in icons:
    viewbox = ET.parse(path).getroot().get("viewBox")
    if viewbox:
        viewboxes[viewbox] += 1
    else:
        missing.append(str(path.relative_to(repo)))
inventory = {"schemaVersion": 1, "sourceSha256": source, "generatedAt": datetime.now(timezone.utc).isoformat(),
             "wxssFiles": len(wxss), "properties": properties,
             "icons": {"count": len(icons), "viewBoxes": dict(viewboxes), "missingViewBox": missing},
             "method": "Regex count of WXSS declarations after comment removal; not computed cascade or device pixels."}
(root / "precision-source-inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n")

def artifact(path):
    data = path.read_bytes()
    return {"path": str(path.relative_to(root)), "sha256": sha256(data).hexdigest(), "bytes": len(data)}

must_include = [root / "screenshots/management-product-actions.png",
                root / "before-sources" / f"management-product-actions-{before_inline_hash[:8]}.png"]
must_include += sorted((root / "contact-sheets").glob("*.png"))
must_include += [root / "admin-interaction-runtime-assertion.json"]
for path in must_include:
    assert path.is_file(), path
manifest = {
    "schemaVersion": 1, "sourceSha256": source, "generatedAt": datetime.now(timezone.utc).isoformat(),
    "baselineSourceSha256": baseline, "managementInlineBeforeSourceSha256": before_inline_hash,
    "currentRawRoutes": len(raw_routes), "currentComposerStates": len(composer_frames),
    "currentRouteManifest": "source-manifest.json", "currentComposerManifest": "composer-current/visual-evidence-manifest.json",
    "artifacts": [artifact(path) for path in must_include],
    "limitations": ["Contact sheets are navigation aids; raw simulator frames remain authoritative.",
                    "Synthetic fixture messages, times and IDs can differ across before/after captures.",
                    "No physical iOS/Android keyboard, system font scaling, camera or weak-network pass.",
                    "The screenshot bridge did not paint the system Modal; resolve confirmation is a runtime assertion only."]
}
(root / "precision-evidence-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
files = sorted(path for path in root.rglob("*") if path.is_file() and path.name != "SHA256SUMS")
(root / "SHA256SUMS").write_text("".join(f"{sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root)}\n" for path in files))
print(json.dumps({"sourceSha256": source, "rawRoutes": len(raw_routes), "composerStates": len(composer_frames),
                  "contactSheets": len(list((root / 'contact-sheets').glob('*.png'))), "checksummedFiles": len(files)}))
