from pathlib import Path
import runpy,json,hashlib
root=Path('/Users/mini/CISME');out=Path(__file__).resolve().parent
runpy.run_path(str(root/'docs/evidence/community-three-entry-20261101/prepare-native-three-entry.py'))
fixture=Path('/tmp/cisme-compose-native-20261101')
api=fixture/'services/api.ts';api.write_text(api.read_text().replace('aiUsage:"unknown",','').replace('rightsConfirmed:false,publicConsentConfirmed:false,','').replace('Object.assign(post,{state:"pending_review",revisionState:"pending",version:post.version+1})','Object.assign(post,{state:"pending_review",revisionState:"pending",revision:post.revision+1,publicConsentConfirmed:true,version:post.version+1})'))
original=json.loads((root/'docs/evidence/community-three-entry-20261101/source-proof.json').read_text())
files=[]
for item in original['copiedSources']:
 name=item['file'];raw=(root/'apps/miniprogram'/name).read_bytes()
 assert raw==(fixture/name).read_bytes(),name
 files.append({'file':name,'sha256':hashlib.sha256(raw).hexdigest(),'fixtureByteIdentical':True})
assert len(files)==24
package=json.loads((root/'docs/evidence/visual/current-source-acceptance.json').read_text())['packageSourceSha256']
proof={'packageSourceSha256':package,'copiedSources':files,'sourceByteIdenticalFiles':24,'fixturePath':str(fixture),'network':False,'persistentStorage':False,'scope':'24 actual native page/tab/component/helper files byte-identical. Offline auth/API/storage/editorial/public-detail adapters; controlled state stimuli. Native Canvas and local FS actual official simulator. Not physical keyboard, permissions, hardware camera, real account/backend or deployment acceptance.'}
(out/'source-proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'packageSourceSha256':package,'sourceByteIdenticalFiles':24,'fixture':str(fixture)}))
