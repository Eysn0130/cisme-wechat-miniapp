from pathlib import Path
from urllib.parse import urlsplit,unquote
import os,sys,json,hashlib,subprocess,shlex,re
os.umask(0o077)
state=Path(sys.argv[1]);operation=sys.argv[2]
assert os.geteuid()==0 and re.fullmatch(r'/opt/cisme-trial/member-reset-upgrades/[-a-z0-9]+',str(state)) and re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}',operation)
assert state.stat().st_uid==0 and state.stat().st_mode&0o077==0
code=Path('/tmp/cisme-points-snapshot.mjs').read_bytes();assert hashlib.sha256(code).hexdigest()=='8a7db1bbbcf054c5370d01fec575d99a36cc9838152805401e726defe6dd562f'
config={}
for line in Path('/opt/cisme-trial/runtime.env').read_text().splitlines():
 if line and not line.startswith('#') and '=' in line:
  k,v=line.split('=',1);p=shlex.split(v);config[k]=p[0] if len(p)==1 else v
u=urlsplit(config['DATABASE_URL']);assert config['APP_ENV']=='staging' and u.hostname=='127.0.0.1' and u.username=='cisme_trial' and u.path=='/cisme_trial'
env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PGPASSWORD':unquote(u.password),'PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000'}
file,key=state/(operation+'.dump.aesgcm'),state/(operation+'.key');aad=json.dumps({'database':'cisme_trial','operation':operation,'scope':'same-host-database-only'},sort_keys=True,separators=(',',':'))
node='/opt/node-v24.14.0-linux-x64/bin/node';args=lambda mode:[node,'--input-type=module','-e',code.decode(),mode,str(file),str(key),aad]
children=[]
try:
 dump=subprocess.Popen(['/usr/sbin/runuser','-u','cisme-trial','--','/usr/bin/pg_dump','--format=custom','--no-owner','--no-acl','--no-password','--host=127.0.0.1','--port=5432','--username=cisme_trial','--dbname=cisme_trial'],env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL);children.append(dump)
 enc=subprocess.Popen(args('encrypt'),stdin=dump.stdout,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL);children.append(enc);dump.stdout.close();raw,_=enc.communicate(timeout=120)
 assert enc.returncode==0 and dump.wait(timeout=20)==0,'SNAPSHOT_FAILED';created=json.loads(raw)
 verified=json.loads(subprocess.check_output(args('verify'),stderr=subprocess.DEVNULL,timeout=120));assert verified['authenticated'] and created['plainSha256']==verified['plainSha256'] and created['plainBytes']==verified['plainBytes'],'SNAPSHOT_AUTHENTICATION_FAILED'
 assert created['plainBytes']<=64*1024*1024,'ONE_TIME_SNAPSHOT_MEMORY_BOUND'
 decoded=subprocess.run(args('decrypt'),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=120)
 assert decoded.returncode==0 and len(decoded.stdout)==created['plainBytes'] and hashlib.sha256(decoded.stdout).hexdigest()==created['plainSha256'],'SNAPSHOT_DECRYPTION_FAILED'
 listing=subprocess.run(['/usr/bin/pg_restore','--list'],input=decoded.stdout,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=120);toc=listing.stdout
 assert listing.returncode==0 and b'TABLE DATA public member' in toc and b'TABLE DATA public schema_migration' in toc,'SNAPSHOT_STRUCTURE_FAILED'
 record={'schemaVersion':1,'authenticated':True,'pgRestoreListVerified':True,'database':'cisme_trial','scope':'same-host-database-only','fullRecoveryQualified':False,'restorePerformed':False,'backupReference':operation,'encryptedFile':str(file),'keyFile':str(key),'aad':aad,'plainSha256':created['plainSha256'],'plainBytes':created['plainBytes'],'cipherSha256':hashlib.sha256(file.read_bytes()).hexdigest()}
 p=state/(operation+'-private.json');p.write_text(json.dumps(record)+'\n');p.chmod(0o600)
 print(json.dumps({'backupReference':operation,'readOnlySnapshot':True,'authenticated':True,'pgRestoreListVerified':True,'encryptedBytes':file.stat().st_size,'scope':'same-host-database-only','restorePerformed':False,'fullRecoveryQualified':False}))
finally:
 for p in children:
  if p.poll() is None:p.kill();p.wait()
