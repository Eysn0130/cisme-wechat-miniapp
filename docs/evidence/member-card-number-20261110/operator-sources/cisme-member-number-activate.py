from pathlib import Path
from urllib.parse import urlsplit
import os,sys,re,json,hashlib,subprocess,shlex,tarfile,time,urllib.request,stat
os.umask(0o077)
head,archive_sha,ci_run=sys.argv[1:4]
assert os.geteuid()==0 and re.fullmatch('[a-f0-9]{40}',head) and re.fullmatch('[a-f0-9]{64}',archive_sha) and ci_run.isdigit()
root=Path('/opt/cisme-trial');node='/opt/node-v24.14.0-linux-x64/bin/node';old=root/'releases/tencent-release-f82c144c241b';candidate=root/'releases'/('tencent-release-'+head[:12]);archive=Path('/tmp/cisme-member-number-build-86ac8e3/dist')/(candidate.name+'.tar.gz')
assert archive.is_file() and hashlib.sha256(archive.read_bytes()).hexdigest()==archive_sha
config={};runtime_bytes=(root/'runtime.env').read_bytes()
for line in runtime_bytes.decode().splitlines():
 if line and not line.startswith('#') and '=' in line:
  k,v=line.split('=',1);p=shlex.split(v);config[k]=p[0] if len(p)==1 else v
u=urlsplit(config['DATABASE_URL']);assert config['APP_ENV']=='staging' and u.hostname=='127.0.0.1' and u.username=='cisme_trial' and u.path=='/cisme_trial'
assert config.get('ALLOW_DEV_ADAPTERS')=='false' and config.get('COMMERCE_ORDER_FLOW_ENABLED')=='true' and config.get('COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED')=='true' and config.get('COMMERCE_FULFILLMENT_ENABLED')=='true'
assert config.get('RUN_BACKGROUND_WORKER','false')=='false';port=int(config['PORT']);assert 1<=port<=65535
units=['cisme-trial-api.service','cisme-trial-worker.service'];production=['cisme-api.service','cisme-worker.service']
def command(args,**kwargs):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=120,**kwargs)
def settings(unit):return dict(line.split('=',1) for line in command(['systemctl','show',unit,'--no-pager','-p','ExecStart','-p','WorkingDirectory','-p','EnvironmentFiles','-p','MainPID','-p','ActiveState','-p','DropInPaths']).stdout.splitlines() if '=' in line)
prod_before={unit:settings(unit) for unit in production};prod_env_sha=hashlib.sha256(Path('/opt/cisme/runtime.env').read_bytes()).hexdigest()
original_units={unit:settings(unit) for unit in units}
for unit,s in original_units.items():
 assert str(old) in s['ExecStart'] and s['WorkingDirectory']==str(root) and s['ActiveState']=='active'
 assert s['DropInPaths']=='/etc/systemd/system/'+unit+'.d/90-member-points.conf /etc/systemd/system/'+unit+'.d/95-logistics-query.conf /etc/systemd/system/'+unit+'.d/96-address-return-media.conf'
state_root=root/'member-card-upgrades';state_root.mkdir(mode=0o700,exist_ok=True);assert state_root.stat().st_uid==0 and state_root.stat().st_mode&0o077==0
state=state_root/('apply-'+head[:12]);state.mkdir(mode=0o700)
(state/'runtime.before.env').write_bytes(runtime_bytes)
grant_path=Path(config['COMMERCE_FULFILLMENT_AUTHORIZATION_FILE']);assert str(grant_path)=='/opt/cisme-trial/operations/commerce-closure-20261110/merchant/shipping.json'
grant_bytes=grant_path.read_bytes();grant_stat=grant_path.stat();assert stat.S_ISREG(grant_stat.st_mode) and grant_stat.st_mode&0o077==0
(state/'shipping.before.json').write_bytes(grant_bytes);grant=json.loads(grant_bytes)
assert grant['mode']=='wechat-shipping-sync' and grant['environment']=='staging' and grant['dataScope']=='owner-authorized-experience-commerce' and grant['databaseName']=='cisme_trial'
assert set(grant['capabilities'])=={'shipping.query','shipping.upload','logistics.accounts.read','logistics.tracking.read','logistics.query.register'}
assert grant['appId']==config['WECHAT_APP_ID'] and grant['merchantId']==config['COMMERCE_FULFILLMENT_MERCHANT_ID']
context={'sourceHead':head,'archiveSha256':archive_sha,'ciRunId':int(ci_run),'oldRelease':str(old),'candidate':str(candidate),'ownerInstruction':'Owner selected member card and real fixed private membership number. Add one-to-one mapping only; preserve original identities, assets, commerce, permissions and production isolation','runtimeSha256':hashlib.sha256(runtime_bytes).hexdigest()}
(state/'context-private.json').write_text(json.dumps(context)+'\n')
with tarfile.open(archive,'r:gz') as source:
 for member in source.getmembers():
  parts=Path(member.name).parts;assert parts and parts[0]==candidate.name and not Path(member.name).is_absolute() and '..' not in parts
 assert not candidate.exists();source.extractall(root/'releases',filter='data')
manifest=json.loads((candidate/'release-manifest.json').read_text());old_manifest=json.loads((old/'release-manifest.json').read_text())
assert manifest['sourceHead']==head and manifest['buildPlatform']=={'os':'linux','arch':'x64','libc':'glibc'} and manifest['migrations'][:-1]==old_manifest['migrations'] and len(manifest['migrations'])==114 and manifest['migrations'][-1]=='202611100006_member_card_number.sql'
for name in old_manifest['migrations']:assert manifest['hashes']['db/migrations/'+name]==old_manifest['hashes']['db/migrations/'+name]
for directory,dirs,files in os.walk(candidate):
 os.chown(directory,0,0);os.chmod(directory,0o755)
 for name in files:
  p=Path(directory)/name
  if not p.is_symlink():os.chown(p,0,0);os.chmod(p,0o444|(p.stat().st_mode&0o111))
verified=json.loads(command([node,str(candidate/'migrate.mjs'),'verify']).stdout);assert verified['verified'] and verified['sourceHead']==head and verified['migrations']==114
child_env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','DATABASE_URL':config['DATABASE_URL']}
def facts(mode):return json.loads(command([node,'/tmp/cisme-member-number-db-facts.mjs',mode,str(state),str(old/'package.json')],env=child_env).stdout)
def replace_grant(value):
 temporary=grant_path.with_name(grant_path.name+'.logistics-tmp');temporary.write_bytes(value);os.chmod(temporary,stat.S_IMODE(grant_stat.st_mode));os.chown(temporary,grant_stat.st_uid,grant_stat.st_gid);temporary.replace(grant_path)
drops=[];active=False;stopped=False
try:
 command(['systemctl','stop',*units]);stopped=True;assert all(settings(unit)['ActiveState']=='inactive' for unit in units)
 baseline=facts('before');backup_ref='MEMBER-CARD-PREDEPLOY-'+head[:12]
 backup=json.loads(command(['/usr/bin/python3','/tmp/cisme-member-number-encrypted-snapshot.py',str(state),backup_ref]).stdout);assert backup['authenticated'] and backup['pgRestoreListVerified']
 (state/'snapshot-public.json').write_text(json.dumps(backup)+'\n')
 # The only application data addition is stable private member-card mapping.
 migrated=command([node,str(candidate/'migrate.mjs'),'up'],env={**child_env,'CISME_MIGRATION_APPROVAL_REF':'OWNER-MEMBER-CARD-NUMBER-20261110','CISME_PREDEPLOY_BACKUP_REF':backup_ref}).stdout
 (state/'migration.log').write_text(migrated)
 preserved=facts('after');assert preserved['allFactsPreserved']
 assert grant_path.read_bytes()==grant_bytes
 fence=state/'maintenance.env';fence.write_text('CISME_MIGRATION_READ_ONLY=true\n')
 for unit,entry in [(units[0],'index.js'),(units[1],'worker.js')]:
  drop=Path('/etc/systemd/system')/(unit+'.d/97-member-card-number.conf');assert not drop.exists();drops.append(drop)
  drop.write_text('[Service]\nEnvironmentFile='+str(fence)+'\nExecStart=\nExecStart='+node+' '+str(candidate/entry)+'\n');drop.chmod(0o644)
 command(['systemctl','daemon-reload']);command(['systemctl','start',units[0]])
 def fetch(path):
  with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=10) as response:return json.loads(response.read())
 for attempt in range(30):
  try:
   if fetch('/health/ready')['status']=='ready':break
  except Exception:
   if attempt==29:raise
   time.sleep(1)
 caps=fetch('/v1/capabilities');commerce=fetch('/v1/commerce/orders/status');assert caps['pointsRulesEnabled'] and caps['pointsRedemptionEnabled'] and commerce['orderFlowEnabled'] and commerce['paymentAvailable']
 # Recheck exact old facts after API startup, while independent worker remains
 # paused. No synthetic order or customer command is sent to the live service.
 preserved=facts('after');assert preserved['allFactsPreserved']
 fence.write_text('CISME_MIGRATION_READ_ONLY=false\n');command(['systemctl','restart',units[0]]);command(['systemctl','start',units[1]])
 for attempt in range(30):
  try:
   if fetch('/health/ready')['status']=='ready':break
  except Exception:
   if attempt==29:raise
   time.sleep(1)
 assert all(settings(unit)['ActiveState']=='active' for unit in units)
 assert (root/'runtime.env').read_bytes()==runtime_bytes and hashlib.sha256(Path('/opt/cisme/runtime.env').read_bytes()).hexdigest()==prod_env_sha
 assert {unit:settings(unit) for unit in production}==prod_before
 result={'schemaVersion':1,'deployed':True,'environment':'isolated-trial','host':'124.223.74.198','sourceHead':head,'ciRunId':int(ci_run),'archiveSha256':archive_sha,'migrations':114,'schemaChanged':True,'backup':backup,'preservation':preserved,'pointsPreserved':True,'productionPreserved':True,'runtimeEnvironmentPreserved':True,'shippingGrantPreserved':True,'privateMembershipNumberEnabled':True,'existingMemberFactsUnchanged':True,'identifierUsedForAuthorization':False,'agentMoneyMovements':0,'realMemberTestWrites':0,'stateDirectory':str(state),'fullRecoveryQualified':False}
 (state/'activation-public.json').write_text(json.dumps(result)+'\n');active=True;print(json.dumps(result))
finally:
 if stopped and not active:
  subprocess.run(['systemctl','stop',*units],capture_output=True)
  for drop in drops:drop.unlink(missing_ok=True)
  assert grant_path.read_bytes()==grant_bytes
  subprocess.run(['systemctl','daemon-reload'],capture_output=True);subprocess.run(['systemctl','start',*units],capture_output=True)
  (state/'activation-rolled-back').write_text('Old runtime and grant restored; additive issued member identifiers retained, no database rollback or deletion.\n')
