from pathlib import Path
import hashlib, json, sys

root = Path('/Users/mini/CISME')
path = root / 'docs/evidence/visual/current-source-acceptance.json'
manifest = json.loads(path.read_text())
manifest['previousSourceRecord'] = 'docs/evidence/visual/' + sys.argv[1]
manifest['note'] = 'Current source follows the user-requested minimal Rednote publisher: no AI chooser, AI submission requirement or persistent teaching/gate copy. Real rights/public-consent settings use a native bottom sheet. Server gates and full review/recovery lifecycle remain factual. Native offline, isolated API and real-account/device evidence are separate; full40-route/device acceptance remains blocked.'
path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
files = ['custom-tab-bar/index.ts','custom-tab-bar/index.wxml','custom-tab-bar/index.wxss','custom-tab-bar/index.json','pages/community-compose/index.ts','pages/community-compose/index.wxml','pages/community-compose/index.wxss','pages/community-compose/index.json']
entries=[]
for name in files:
    source=(root/'apps/miniprogram'/name).read_bytes()
    fixture=(Path('/tmp/cisme-compose-native-20261101')/name).read_bytes()
    assert source == fixture, name
    entries.append({'file':name,'sha256':hashlib.sha256(source).hexdigest(),'fixtureByteIdentical':True})
proof={'packageSourceSha256':manifest['packageSourceSha256'],'copiedSources':entries,'scope':'Offline fixtures replace network, authentication, persistent backup storage and public-detail return stimulus only. Real-account and physical-device flows remain unverified.'}
(root/'docs/evidence/community-compose-minimal-20261101/source-proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
print(manifest['packageSourceSha256'])
