from pathlib import Path
from urllib.parse import urlsplit
import os,sys,re,json,hashlib,subprocess,shlex,stat,fcntl,time,urllib.request,pwd
os.umask(0o077)
ROOT=Path('/opt/cisme-trial');OPS=ROOT/'operations/member-reset-20261113';NODE='/opt/node-v24.14.0-linux-x64/bin/node'
UNITS=['cisme-trial-api.service','cisme-trial-worker.service'];FORMAL=['cisme-api.service','cisme-worker.service']
def need(v,e):
 if not v:raise RuntimeError(e)
def command(a,**kw):
 r=subprocess.run(a,capture_output=True,timeout=180,**kw)
 if r.returncode:
  (OPS/'command.stderr-private.txt').write_bytes(r.stderr);raise RuntimeError('COMMAND_FAILED:'+Path(a[0]).name)
 return r
def pg(sql):return command(['/usr/sbin/runuser','-u','postgres','--','/usr/bin/psql','--no-psqlrc','--set','ON_ERROR_STOP=1','--tuples-only','--no-align','--dbname','postgres','--command',sql]).stdout.decode().strip()
def settings(unit):return command(['systemctl','show',unit,'--no-pager','-p','ExecStart','-p','WorkingDirectory','-p','EnvironmentFiles','-p','DropInPaths','-p','MainPID','-p','ActiveState']).stdout.decode()
def private(p):
 s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o077 and s.st_nlink==1,'PRIVATE_FILE_REQUIRED');return p.read_bytes()
def healthy(port):
 for i in range(30):
  try:
   with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/health/ready',timeout=3) as r:
    if json.load(r)['status']=='ready':return
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('TRIAL_NOT_READY')
def main():
 need(os.geteuid()==0 and len(sys.argv)==2 and sys.argv[1] in ['rehearse','apply'],'ACTION_REQUIRED');action=sys.argv[1]
 lock=os.open('/run/lock/cisme-production-trial.lock',os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 cfg={};runtime=(ROOT/'runtime.env').read_bytes();need((ROOT/'runtime.env').stat().st_uid==0,'RUNTIME_OWNER_REQUIRED')
 for line in runtime.decode().splitlines():
  if line and not line.startswith('#') and '=' in line:
   k,v=line.split('=',1);a=shlex.split(v);cfg[k]=a[0] if len(a)==1 else v
 u=urlsplit(cfg['DATABASE_URL']);need(cfg['APP_ENV']=='staging' and u.hostname=='127.0.0.1' and u.username=='cisme_trial' and u.path=='/cisme_trial','TRIAL_ONLY')
 production={x:settings(x) for x in FORMAL};production_env=(Path('/opt/cisme/runtime.env')).read_bytes();trial={x:settings(x) for x in UNITS}
 need(all('ActiveState=active' in x and 'tencent-release-eeeb891cfa36' in x for x in trial.values()),'TRIAL_SOURCE_DRIFT')
 binding=json.loads(private(OPS/'binding.json'))
 for name in ['reset-trial.py','filtered-copy.mjs','encrypted-snapshot.py']:need(hashlib.sha256(private(OPS/name)).hexdigest()==binding['helpers'][name],'HELPER_DRIFT')
 plan=json.loads(private(Path('/tmp/cisme-trial-reset-plan-private.json')));need(len(plan['targetMemberIds'])==7,'EXACT_SEVEN_TARGETS_REQUIRED')
 if action=='apply':need(binding.get('ciConclusion')=='success' and re.fullmatch('[a-f0-9]{40}',binding.get('mainHead','')),'MERGED_CI_REQUIRED')
 parent=ROOT/'member-reset-upgrades';parent.mkdir(mode=0o700,exist_ok=True);need(parent.stat().st_uid==0 and not parent.stat().st_mode&0o077,'STATE_PERMISSIONS')
 run=str(int(time.time()));state=parent/(action+'-20261113-'+run);state.mkdir(mode=0o700);(state/'runtime.before.env').write_bytes(runtime)
 dest='cisme_trial_reset_'+action+'_20261113_'+run;archive='cisme_trial_archive_20261113_b990812538ab'
 need(not pg("SELECT datname FROM pg_database WHERE datname IN ('"+dest+"','"+archive+"')"),'DESTINATION_EXISTS')
 stopped=False;swapped=False;opened=False;drops=[];report={}
 try:
  if action=='apply':command(['systemctl','stop',*UNITS]);stopped=True
  backup_ref='MEMBER-RESET-'+action.upper()+'-20261113-b990812538ab'
  backup=json.loads(command(['/usr/bin/python3',str(OPS/'encrypted-snapshot.py'),str(state),backup_ref]).stdout);need(backup['authenticated'] and backup['pgRestoreListVerified'],'BACKUP_REQUIRED')
  meta=json.loads(private(state/(backup_ref+'-private.json')));crypto=Path('/tmp/cisme-points-snapshot.mjs').read_bytes();need(hashlib.sha256(crypto).hexdigest()=='8a7db1bbbcf054c5370d01fec575d99a36cc9838152805401e726defe6dd562f','CRYPTO_HELPER_DRIFT')
  dumped=command([NODE,'--input-type=module','-e',crypto.decode(),'decrypt',meta['encryptedFile'],meta['keyFile'],meta['aad']]).stdout;need(len(dumped)==meta['plainBytes'] and hashlib.sha256(dumped).hexdigest()==meta['plainSha256'],'DECRYPT_VERIFY_REQUIRED')
  pg('CREATE DATABASE '+dest+' OWNER cisme_trial TEMPLATE template0');pg('REVOKE CONNECT ON DATABASE '+dest+' FROM PUBLIC')
  def restore(section):
   r=command(['/usr/sbin/runuser','-u','postgres','--','/usr/bin/pg_restore','--exit-on-error','--no-owner','--no-acl','--role=cisme_trial','--section='+section,'--dbname='+dest],input=dumped);need(not r.stderr or b'error:' not in r.stderr.lower(),'RESTORE_FAILED')
  restore('pre-data')
  child={'PATH':'/usr/bin:/bin','DATABASE_URL':cfg['DATABASE_URL'],'RESET_DESTINATION':dest,'RESET_REPORT_FILE':str(state/'filtered-copy-private.json')}
  code=private(OPS/'filtered-copy.mjs').decode();original=json.loads(private(Path('/tmp/cisme-trial-reset-members-private.json')));code=code.replace("JSON.parse(readFileSync('/tmp/cisme-trial-reset-members-private.json','utf8'))",json.dumps(original,ensure_ascii=False));r=command(['/usr/sbin/runuser','-u','postgres','--',NODE,'--input-type=module'],input=code.encode(),env=child);report=json.loads(r.stdout);(state/'filtered-copy-private.json').write_text(json.dumps(report)+'\n')
  restore('post-data');report['constraintsValidated']=True;report['encryptedBackup']=backup
  check=command(['/usr/sbin/runuser','-u','postgres','--','/usr/bin/psql','--no-psqlrc','--tuples-only','--no-align','--dbname='+dest,'--command',"SELECT count(*)||':'||count(*) FILTER(WHERE NOT convalidated) FROM pg_constraint WHERE connamespace='public'::regnamespace"]).stdout.decode().strip();need(check.endswith(':0'),'UNVALIDATED_CONSTRAINTS');report['constraintCount']=int(check.split(':')[0])
  pg('ALTER DATABASE '+dest+' ALLOW_CONNECTIONS false');pg("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='"+dest+"' AND pid<>pg_backend_pid()")
  report['action']=action;report['formalUnchanged']=production=={x:settings(x) for x in FORMAL} and production_env==Path('/opt/cisme/runtime.env').read_bytes();need(report['formalUnchanged'],'FORMAL_CHANGED')
  if action=='apply':
   # The old database is sealed and retained for recovery. No immutable source row is edited or deleted.
   fence=state/'maintenance.env';fence.write_text('CISME_MIGRATION_READ_ONLY=true\n')
   for unit in UNITS:
    d=Path('/etc/systemd/system')/(unit+'.d');d.mkdir(exist_ok=True);p=d/'zzzzzz-member-reset.conf';need(not p.exists(),'DROPIN_EXISTS');p.write_text('[Service]\nEnvironmentFile='+str(fence)+'\n');p.chmod(0o644);drops.append(p)
   command(['systemctl','daemon-reload']);pg('ALTER DATABASE cisme_trial ALLOW_CONNECTIONS false');pg("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cisme_trial' AND pid<>pg_backend_pid()")
   pg('ALTER DATABASE cisme_trial RENAME TO '+archive);swapped=True
   pg('ALTER DATABASE '+archive+' OWNER TO postgres');pg('REVOKE CONNECT ON DATABASE '+archive+' FROM PUBLIC,cisme_trial')
   pg('ALTER DATABASE '+dest+' RENAME TO cisme_trial');pg('ALTER DATABASE cisme_trial ALLOW_CONNECTIONS true')
   command(['systemctl','start',UNITS[0]]);healthy(int(cfg['PORT']))
   # Only after schema, all retained facts, sequences, administrator assets and health checks pass, reopen writers.
   fence.write_text('CISME_MIGRATION_READ_ONLY=false\n');command(['systemctl','restart',UNITS[0]]);healthy(int(cfg['PORT']));opened=True;command(['systemctl','start',UNITS[1]])
   report['oldDatabaseSealed']=pg("SELECT datallowconn::text||':'||pg_get_userbyid(datdba) FROM pg_database WHERE datname='"+archive+"'")=='false:postgres';need(report['oldDatabaseSealed'],'ARCHIVE_NOT_SEALED');report['activeDatabase']='cisme_trial';report['archivedDatabase']=archive;report['trialHealthy']=True
  report['formalUnchanged']=production=={x:settings(x) for x in FORMAL} and production_env==Path('/opt/cisme/runtime.env').read_bytes();need(report['formalUnchanged'],'FORMAL_CHANGED');need(runtime==(ROOT/'runtime.env').read_bytes(),'RUNTIME_CHANGED')
  (state/'receipt-public.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
 except Exception:
  if pg("SELECT datname FROM pg_database WHERE datname='"+dest+"'"):pg('ALTER DATABASE '+dest+' ALLOW_CONNECTIONS false')
  if stopped and not swapped:
   for d in drops:d.unlink(missing_ok=True)
   command(['systemctl','daemon-reload']);command(['systemctl','start',*UNITS])
  # After cutover, never automatically restore an old database over potentially accepted writes.
  # A failure here leaves the sealed archive and exact root-private state for explicit forward repair.
  raise
if __name__=='__main__':main()
