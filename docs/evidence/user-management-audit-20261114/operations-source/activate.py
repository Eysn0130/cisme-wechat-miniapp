from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
import os,sys,re,json,hashlib,subprocess,shlex,tarfile,time,urllib.request,urllib.error,stat,fcntl,posixpath,pwd
os.umask(0o077)
ROOT=Path('/opt/cisme-trial');OPS=ROOT/'operations/user-management-audit-20261114';NODE='/opt/node-v24.14.0-linux-x64/bin/node'
BASE='98830dde8976d6373a9f673d417745a7ef26b38c'
UNITS=['cisme-trial-api.service','cisme-trial-worker.service'];PRODUCTION=['cisme-api.service','cisme-worker.service']
def need(value,code):
 if not value:raise RuntimeError(code)
def sha(data):return hashlib.sha256(data).hexdigest()
def command(args,**kw):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=150,**kw)
def protected(path,owners=(0,)):
 st=path.lstat();need(stat.S_ISREG(st.st_mode) and st.st_uid in owners and not st.st_mode&0o077 and st.st_nlink==1,'PRIVATE_INPUT_REQUIRED');return path.read_bytes()
def runtime_input(path,service):
 st=path.lstat();need(stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_gid==pwd.getpwnam(service).pw_gid and stat.S_IMODE(st.st_mode) in (0o600,0o640) and st.st_nlink==1,'PROTECTED_RUNTIME_REQUIRED');return path.read_bytes()
def settings(unit):
 raw=command(['systemctl','show',unit,'--no-pager','-p','ExecStart','-p','WorkingDirectory','-p','EnvironmentFiles','-p','DropInPaths','-p','MainPID','-p','ActiveState']).stdout
 result={}
 for line in raw.splitlines():
  if '=' in line:k,v=line.split('=',1);result.setdefault(k,[]).append(v)
 return result
def fetch(port,path):
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=10) as response:return json.loads(response.read())
def healthy(port):
 for attempt in range(30):
  try:
   if fetch(port,'/health/ready')['status']=='ready':return
  except Exception:
   if attempt==29:raise
   time.sleep(1)
 raise RuntimeError('CANDIDATE_NOT_READY')
def main():
 need(os.geteuid()==0,'ROOT_REQUIRED');need(len(sys.argv)==2 and sys.argv[1] in ['prepare','apply'],'ACTION_REQUIRED')
 action=sys.argv[1];plan=json.loads(protected(OPS/'binding.json'));head=plan['sourceHead'];tree=plan['sourceTree']
 need(re.fullmatch('[a-f0-9]{40}',head) and re.fullmatch('[a-f0-9]{40}',tree),'SOURCE_BINDING_INVALID')
 need(plan['baselineHead']==BASE and re.fullmatch('[a-f0-9]{64}',plan['archiveSha256']),'BASELINE_BINDING_INVALID')
 need(plan['rootMemberId']=='8d2b65b6-c165-4186-b4d0-5fdda9c67456','CANONICAL_ROOT_BINDING_REQUIRED')
 for name in ['activate.py','db-facts.mjs','encrypted-snapshot.py']:need(sha(protected(OPS/name))==plan['helpers'][name],'HELPER_HASH_MISMATCH')
 archive=OPS/('tencent-release-'+head[:12]+'.tar.gz');need(sha(protected(archive))==plan['archiveSha256'],'ARCHIVE_HASH_MISMATCH')
 old=ROOT/'releases'/('tencent-release-'+BASE[:12]);candidate=ROOT/'releases'/('tencent-release-'+head[:12]);prior=json.loads((old/'release-manifest.json').read_text())
 need(prior['sourceHead']==BASE and len(prior['migrations'])==117,'OLD_RELEASE_DRIFT')
 crypto=Path('/tmp/cisme-points-snapshot.mjs');need(crypto.is_file() and sha(crypto.read_bytes())=='8a7db1bbbcf054c5370d01fec575d99a36cc9838152805401e726defe6dd562f','SNAPSHOT_HELPER_REQUIRED')
 cfg={};runtime=runtime_input(ROOT/'runtime.env','cisme-trial')
 for line in runtime.decode().splitlines():
  if line and not line.startswith('#') and '=' in line:
   k,v=line.split('=',1);p=shlex.split(v);cfg[k]=p[0] if len(p)==1 else v
 u=urlsplit(cfg['DATABASE_URL']);need(cfg['APP_ENV']=='staging' and u.hostname=='127.0.0.1' and u.username=='cisme_trial' and u.path=='/cisme_trial','TRIAL_DATABASE_REQUIRED')
 need(cfg.get('ALLOW_DEV_ADAPTERS')=='false' and cfg.get('COMMERCE_ORDER_FLOW_ENABLED')=='true','RUNTIME_SCOPE_DRIFT')
 before={unit:settings(unit) for unit in UNITS};production={unit:settings(unit) for unit in PRODUCTION};production_env=runtime_input(Path('/opt/cisme/runtime.env'),'cisme');port=int(cfg['PORT'])
 for unit,value in before.items():need(value['ActiveState']==['active'] and str(old) in value['ExecStart'][0] and value['WorkingDirectory']==[str(ROOT)],'OLD_UNIT_DRIFT')
 with tarfile.open(archive,'r:gz') as package:
  manifest=package.getmember(candidate.name+'/release-manifest.json');need(manifest.isfile(),'MANIFEST_REQUIRED');incoming=json.loads(package.extractfile(manifest).read())
  for member in package.getmembers():
   parts=PurePosixPath(member.name).parts;need(parts and parts[0]==candidate.name and not PurePosixPath(member.name).is_absolute() and '..' not in parts,'ARCHIVE_PATH_INVALID')
   need(member.isfile() or member.isdir() or member.issym() or member.islnk(),'ARCHIVE_TYPE_INVALID')
   if member.issym() or member.islnk():
    target=posixpath.normpath(posixpath.join(posixpath.dirname(member.name),member.linkname) if member.issym() else member.linkname)
    need(not member.linkname.startswith('/') and target.startswith(candidate.name+'/'),'ARCHIVE_LINK_ESCAPES_CANDIDATE')
 need(incoming['sourceHead']==head and incoming['sourceTree']==tree and incoming['buildPlatform']=={'os':'linux','arch':'x64','libc':'glibc'},'CANDIDATE_SOURCE_INVALID')
 need(incoming['migrations']==prior['migrations'] and len(incoming['migrations'])==117,'MIGRATION_DELTA_INVALID')
 need(all(incoming['hashes']['db/migrations/'+name]==prior['hashes']['db/migrations/'+name] for name in prior['migrations']),'HISTORICAL_SQL_CHANGED')
 if action=='prepare':
  print(json.dumps({'preparedOnly':True,'sourceHead':head,'sourceTree':tree,'archiveSha256':plan['archiveSha256'],'migrationsBefore':117,'migrationsAfter':117,'additiveTables':0,'realMemberWrites':0,'runtimeChanged':False}));return
 need(plan['ciConclusion']=='success' and type(plan['ciRunId']) is int and plan['ciRunId']>0 and re.fullmatch('[a-f0-9]{40}',plan['mainHead']) and plan['mainTree']==tree and plan['sourceAncestorOfMain'] is True,'SUCCESSFUL_CI_AND_MERGED_MAIN_REQUIRED')
 lock=os.open('/run/lock/cisme-production-trial.lock',os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 need({unit:settings(unit) for unit in UNITS}==before,'UNITS_CHANGED_BEFORE_LOCK')
 parent=ROOT/'user-management-audits';parent.mkdir(mode=0o700,exist_ok=True);ps=parent.lstat();need(stat.S_ISDIR(ps.st_mode) and ps.st_uid==0 and ps.st_mode&0o077==0,'PRIVATE_STATE_PARENT_REQUIRED')
 state=parent/('apply-'+head[:12]);state.mkdir(mode=0o700);(state/'runtime.before.env').write_bytes(runtime);(state/'context-private.json').write_text(json.dumps(plan)+'\n')
 grant=Path(cfg['COMMERCE_FULFILLMENT_AUTHORIZATION_FILE']);grant_bytes=protected(grant,(0,pwd.getpwnam('cisme-trial').pw_uid))
 with tarfile.open(archive,'r:gz') as package:
  need(not candidate.exists(),'CANDIDATE_ALREADY_EXISTS');package.extractall(ROOT/'releases',filter='data')
 for directory,dirs,files in os.walk(candidate):
  os.chown(directory,0,0);os.chmod(directory,0o755)
  for name in files:
   path=Path(directory)/name
   if path.is_symlink():os.lchown(path,0,0)
   else:os.chown(path,0,0);os.chmod(path,0o444|(path.stat().st_mode&0o111))
 verified=json.loads(command([NODE,str(candidate/'migrate.mjs'),'verify']).stdout);need(verified['verified'] and verified['migrations']==117,'CANDIDATE_VERIFICATION_FAILED')
 child={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','DATABASE_URL':cfg['DATABASE_URL']}
 def facts(mode):return json.loads(command([NODE,str(OPS/'db-facts.mjs'),mode,str(state),str(old/'package.json')],env=child).stdout)
 facts('preflight');drops=[];stopped=False;opened=False;complete=False;fence=state/'maintenance.env'
 try:
  command(['systemctl','stop',*UNITS]);stopped=True;need(all(settings(x)['ActiveState']==['inactive'] for x in UNITS),'WRITERS_NOT_STOPPED')
  facts('before');backup_ref='USER-MANAGEMENT-AUDIT-PREDEPLOY-'+head[:12]
  backup=json.loads(command(['/usr/bin/python3',str(OPS/'encrypted-snapshot.py'),str(state),backup_ref]).stdout);need(backup['authenticated'] and backup['pgRestoreListVerified'],'ENCRYPTED_BACKUP_REQUIRED');(state/'snapshot-public.json').write_text(json.dumps(backup)+'\n')
  # Application-only release: verify every historical migration; run no DDL or data migration.
  preserved=facts('after');need(preserved['allOriginalColumnsAndRowsPreserved'],'OLD_FACTS_CHANGED')
  fence.write_text('CISME_MIGRATION_READ_ONLY=true\nPGOPTIONS=-c default_transaction_read_only=on\nMEMBER_ADMINISTRATION_ROOT_MEMBER_ID='+plan['rootMemberId']+'\n')
  for unit,entry in zip(UNITS,['index.js','worker.js']):
   drop=Path('/etc/systemd/system')/(unit+'.d/zzzzzzzz-user-management-audit-release.conf');need(not drop.exists(),'DROPIN_ALREADY_EXISTS');drops.append(drop);drop.write_text('[Service]\nEnvironmentFile='+str(fence)+'\nEnvironment=WECHAT_SHARE_ENV_VERSION=trial\nExecStart=\nExecStart='+NODE+' '+str(candidate/entry)+'\n');drop.chmod(0o644)
  command(['systemctl','daemon-reload']);command(['systemctl','start',UNITS[0]]);healthy(port)
  for path in ['/v1/management/users','/v1/management/users/00000000-0000-4000-8000-000000000001']:
   try:fetch(port,path);raise RuntimeError('USER_ADMIN_AUTHORIZATION_MISSING')
   except urllib.error.HTTPError as error:need(error.code in (401,403),'USER_ADMIN_ROUTE_NOT_CONNECTED')
  caps=fetch(port,'/v1/capabilities');commerce=fetch(port,'/v1/commerce/orders/status');need(caps['pointsRulesEnabled'] and caps['pointsRedemptionEnabled'] and commerce['orderFlowEnabled'] and commerce['paymentAvailable'],'EXISTING_CAPABILITIES_CHANGED')
  preserved=facts('after');need(protected(grant,(0,pwd.getpwnam('cisme-trial').pw_uid))==grant_bytes and runtime_input(ROOT/'runtime.env','cisme-trial')==runtime,'PRIVATE_CONFIG_CHANGED')
  need({x:settings(x) for x in PRODUCTION}==production and runtime_input(Path('/opt/cisme/runtime.env'),'cisme')==production_env,'PRODUCTION_CHANGED')
  fence.write_text('CISME_MIGRATION_READ_ONLY=false\nMEMBER_ADMINISTRATION_ROOT_MEMBER_ID='+plan['rootMemberId']+'\n');opened=True;command(['systemctl','restart',UNITS[0]]);command(['systemctl','start',UNITS[1]]);healthy(port)
  need(all(settings(x)['ActiveState']==['active'] and str(candidate) in settings(x)['ExecStart'][0] for x in UNITS),'CANDIDATE_PROCESS_NOT_ACTIVE')
  need({x:settings(x) for x in PRODUCTION}==production and runtime_input(Path('/opt/cisme/runtime.env'),'cisme')==production_env,'PRODUCTION_CHANGED')
  result={'schemaVersion':1,'deployed':True,'host':'124.223.74.198','environment':'isolated-trial','sourceHead':head,'sourceTree':tree,'mainHead':plan['mainHead'],'mainTree':plan['mainTree'],'ciRunId':plan['ciRunId'],'archiveSha256':plan['archiveSha256'],'migrationsBefore':117,'migrationsAfter':117,'oldFactsPreservedBeforeOpeningWrites':True,'preservation':preserved,'backup':backup,'realQualificationsApprovedByAgent':0,'realMemberTestWrites':0,'realMoneyOperationsByAgent':0,'productionPreserved':True,'shippingGrantPreserved':True,'stateDirectory':str(state),'fullRecoveryQualified':False}
  (state/'activation-public.json').write_text(json.dumps(result)+'\n');complete=True;print(json.dumps(result))
 finally:
  if stopped and not complete:
   subprocess.run(['systemctl','stop',*UNITS],capture_output=True)
   try:current_history=facts('history')['migrations']
   except Exception:current_history=None
   if opened or current_history!=117:
    fence.write_text('CISME_MIGRATION_READ_ONLY=true\nPGOPTIONS=-c default_transaction_read_only=on\nMEMBER_ADMINISTRATION_ROOT_MEMBER_ID='+plan['rootMemberId']+'\n')
    if len(drops)==2:subprocess.run(['systemctl','start',UNITS[0]],capture_output=True)
    (state/'forward-fix-required').write_text('Writes reopened or state uncertain; candidate fenced if installed. Worker stopped. No database rollback or data deletion.\n')
   else:
    for drop in drops:drop.unlink(missing_ok=True)
    subprocess.run(['systemctl','daemon-reload'],capture_output=True);subprocess.run(['systemctl','start',*UNITS],capture_output=True);(state/'old-runtime-restored').write_text('Old application restored before writes opened. Additive schema retained; no database rollback or data deletion.\n')
if __name__=='__main__':
 try:main()
 except Exception as error:
  code=str(error) if isinstance(error,RuntimeError) and re.fullmatch('[A-Z_]{5,90}',str(error)) else 'DEPLOYMENT_REFUSED'
  print(json.dumps({'deployed':False,'code':code}));sys.exit(1)
