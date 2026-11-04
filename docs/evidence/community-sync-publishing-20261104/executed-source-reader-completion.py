import base64,hashlib,json,types,time,pwd,stat,datetime
from pathlib import Path
meta={'installed': True, 'runner': '/opt/cisme-trial/sync-publication-health-runners/31a4fcf97364', 'bindingSha256': '6dc3b5628e14c2654b8dd4ac2b5d3d78d68c94469e2f18d30cf3665b8614ac7f', 'codeSha256': '2e210dc21a093be778a1d25e52b31830ca95742c8a722779f65c7d6205b2b35f', 'oldHelperPreserved': True, 'businessDataChanged': False, 'workerHeartbeatFresh': True, 'completedAfterCurrentWorkerStart': True, 'completedAtUtc': '2026-11-04T11:17:07.685Z', 'fileMode': '0600', 'ownerVerified': True};runner=Path(meta['runner']);source=runner/'trial-sync-publication-health-fix.py';raw=source.read_bytes()
assert hashlib.sha256(raw).hexdigest()==meta['codeSha256']
F=types.ModuleType('verified_health_correction');F.__file__=str(source);exec(compile(raw,str(source),'exec'),F.__dict__)
M,app,fix=F.load(runner/'health-fix-binding.json',meta['bindingSha256']);H=M.H
# The original package reader remains unchanged on disk and handles every
# other request. Only this fixed guard file is read through the documented
# GitHub contents endpoint, with its real bytes/hash/size checked below.
original=H.source_bytes;proof=[]
def exact_guard_source(path,head):
 if(path,head)!=(F.SOURCE,fix['sourceHead']):return original(path,head)
 url='https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/contents/'+path+'?ref='+head
 value=H.parse(H.response(url,256*1024))
 assert value.get('path')==path and value.get('type')=='file'and value.get('encoding')=='base64'
 body=base64.b64decode(value['content'].replace('\n','').replace('\r',''),validate=True)
 assert 0<len(body)<=128*1024 and len(body)==value.get('size') and H.git_blob(body)==value.get('sha')
 assert body==M.protected(source,128*1024) and M.sha(body)==fix['codeSha256']
 proof.append({'path':path,'commit':head,'sha256':M.sha(body),'gitBlob':value['sha'],'realHttpsResponse':True,'packageReaderUnchanged':True})
 return body
H.source_bytes=exact_guard_source
try:result=F.complete(M,app,fix)
finally:H.source_bytes=original
assert result['activeVerified']and result['publicUgcEnabled']and len(proof)==1
state=Path(result['upgradeState']);M.D.general.store(state/'fixed-source-reader-verification.json',(json.dumps(proof,sort_keys=True)+'\n').encode())
heartbeat=Path('/opt/cisme-trial/tmp/cisme-worker-heartbeat.json');i=heartbeat.lstat()
assert stat.S_ISREG(i.st_mode)and i.st_uid==pwd.getpwnam('cisme-trial').pw_uid and stat.S_IMODE(i.st_mode)==0o600
value=json.loads(heartbeat.read_bytes());at=datetime.datetime.fromisoformat(value['completedAtUtc'].replace('Z','+00:00')).timestamp()
assert 0<=time.time()-at<=120
print(json.dumps({**result,'sourceReaderVerification':proof,'workerHeartbeatFresh':True,'applicationOrBusinessDataChangedByCompletion':False},sort_keys=True))
