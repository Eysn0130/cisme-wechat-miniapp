"""Correct the newly prepared secret anchor without modifying live configuration."""
from pathlib import Path
import os,json,subprocess,hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
assert os.geteuid()==0
base=Path('/opt/cisme/prepared/r5-20260926')
old=Path('/opt/cisme/secrets/wechat-pay');new=Path('/etc/cisme-wechat-pay')
assert not new.exists() and old.is_dir() and not old.is_symlink()
before=Path('/opt/cisme/runtime.env').read_bytes();current=Path('/opt/cisme/current').resolve()
assert all(p.stat().st_uid==0 and p.stat().st_mode&0o022==0 and not p.is_symlink() for p in [Path('/'),Path('/etc')])
original={str(p.relative_to(old)):p.read_bytes() for p in old.rglob('*') if p.is_file()}
old.rename(new)
manifest=new/'trusted-public-keys.json'
data=manifest.read_text().replace(str(old),str(new))
manifest.write_text(data)
env=(base/'runtime.production.closed.authorized.env').read_text().replace(str(old),str(new))
candidate=base/'runtime.production.closed.authorized.v2.env'
os.umask(0o077)
def put(p,data):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
put(candidate,env.encode())
assert all((new/name).read_bytes()==data for name,data in original.items() if name!='trusted-public-keys.json')
protection=json.dumps({'environment':env,'materials':{str(p.relative_to(new)):p.read_text() for p in new.rglob('*') if p.is_file()}},ensure_ascii=False).encode()
key=Path('/etc/cisme/backup-aes256.key').read_bytes();nonce=os.urandom(12);aad=b'CISME-R5-AUTHORIZED-MATERIALS-V2-v1'
cipher=AESGCM(key).encrypt(nonce,protection,aad);assert AESGCM(key).decrypt(nonce,cipher,aad)==protection
put(base/'authorized-materials-and-config-v2.aesgcm',nonce+cipher)
checks={}
for kind in ['api','worker']:
 source='cisme-'+kind+'.service'
 props=['User','Group','ProtectSystem','ProtectHome','PrivateTmp','NoNewPrivileges','ReadWritePaths','ReadOnlyPaths','InaccessiblePaths']
 actual=subprocess.check_output(['systemctl','show',source,*[arg for prop in props for arg in ['-p',prop]]],text=True).splitlines()
 args=['systemd-run','--quiet','--wait','--pipe','--collect','--service-type=exec','--unit=cisme-r5-path-v2-'+kind]
 args+=['--property='+prop for prop in actual if prop.split('=',1)[1]]
 args+=['--property=PrivateNetwork=yes','--property=EnvironmentFile='+str(candidate),'/opt/node-v24.14.0-linux-x64/bin/node','/opt/cisme/prepared/r5-runtime-check/material-runtime-check.js']
 r=subprocess.run(args,capture_output=True,timeout=60)
 put(base/('path-v2-'+kind+'.stdout'),r.stdout);put(base/('path-v2-'+kind+'.stderr'),r.stderr)
 checks[kind]=json.loads(r.stdout);assert r.returncode==0 and checks[kind]['ok'] and all(checks[kind]['capabilities'].values())
assert Path('/opt/cisme/runtime.env').read_bytes()==before and Path('/opt/cisme/current').resolve()==current
report={'privateMaterialRoot':str(new),'candidateEnvironment':str(candidate),'existingMaterialBytesUnchanged':True,'trustManifestPathUpdated':True,'encryptedProtectionVerified':True,'sameBackupKey':True,'checks':checks,'productionDeployed':False,'liveEnvironmentChanged':False}
put(base/'private-path-correction-result.json',json.dumps(report,indent=2).encode())
exporter=Path('/opt/cisme/prepared/r5-status-tools/export-production-status.py')
text=exporter.read_text().replace('runtime.production.closed.authorized.env','runtime.production.closed.authorized.v2.env')
text=text.replace("'prepared':prepared", "'privatePathCorrection':json.loads((base/'private-path-correction-result.json').read_text()),'prepared':prepared")
exporter.write_text(text)
print(json.dumps({'privateMaterialRoot':str(new),'apiWorkerCapabilitiesVerified':True,'encryptedProtectionVerified':True,'materialBytesUnchanged':True,'productionDeployed':False}))
subprocess.run(['python3',str(exporter)],check=True)
