"""Read-only WXSS inventory; literal differences are review candidates, not defects."""
from collections import Counter
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3] / 'apps/miniprogram'
REPRESENTATIVES = {
    'pages/settings/index.wxss', 'pages/profile/index.wxss',
    'components/address-editor/index.wxss', 'components/care-onboarding/index.wxss',
    'components/section-tabs/index.wxss', 'styles/action-hierarchy.wxss',
    'custom-tab-bar/index.wxss',
}
files = []
for path in sorted(ROOT.rglob('*.wxss')):
    source = path.read_text()
    outside_fallback = re.sub(r'var\([^)]*\)', '', source)
    files.append({
        'file': path.relative_to(ROOT).as_posix(),
        'tokens': sorted(set(re.findall(r'var\((--cisme-[\w-]+)', source))),
        'literalColorsOutsideVar': dict(Counter(re.findall(r'#[0-9a-fA-F]{3,8}\b', outside_fallback))),
        'literalFonts': sorted(set(re.findall(r'font-size:\s*([\d.]+(?:px|rpx))', source))),
        'literalRadii': sorted(set(re.findall(r'border-radius:\s*([^;}]+)', source))),
    })
report = {
    'schemaVersion': 1,
    'nativeStylesheetsScanned': len(files),
    'filesUsingSemanticTokens': sum(bool(item['tokens']) for item in files),
    'interpretation': 'A literal is not automatically a defect. Compare semantic role, accepted design, contrast and native rendering before changing it.',
    'adoption': 'Settings adopts list primitives and existing semantic tokens. Shared address-editor adopts existing color/type/input roles. Other consumers are not bulk migrated.',
    'representatives': [item for item in files if item['file'] in REPRESENTATIVES],
    'files': files,
}
output = Path(__file__).with_name('token-inventory.json')
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: report[key] for key in ('nativeStylesheetsScanned', 'filesUsingSemanticTokens')}))
