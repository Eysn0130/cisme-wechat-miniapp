import pathlib,subprocess,hashlib,json,os,pwd,time,urllib.request,urllib.error
b=pathlib.Path('/opt/cisme/rehearsals/r3-20260926-1100');u=pwd.getpwnam('cisme');node='/opt/node-v24.14.0-linux-x64/bin/node'
archive=pathlib.Path('/home/ubuntu/tencent-release-82656217d83d.tar.gz');expected='350de71b92aba931b42b9199ee2c3c5267464595dd15577af354fa037ffb22f2'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==expected
candidate=b/'final-candidate';candidate.mkdir(mode=0o700);os.chown(candidate,u.pw_uid,u.pw_gid)
subprocess.run(['tar','-xzf',str(archive),'-C',str(candidate),'--strip-components=1','--no-same-owner'],check=True)
subprocess.run(['chown','-R','cisme:cisme',str(candidate)],check=True)
manifest=json.loads((candidate/'release-manifest.json').read_text());assert manifest['sourceHead']=='82656217d83d9ebeb6febf646597a395625c74d6'
verify=json.loads(subprocess.check_output(['/usr/sbin/runuser','-u','cisme','--',node,str(candidate/'migrate.mjs'),'verify'],text=True))
tmp=b/'final-tmp';tmp.mkdir(mode=0o700);os.chown(tmp,u.pw_uid,u.pw_gid)
entry=b/'harness/final-entry.mjs';entry.write_text("import {readFile} from 'node:fs/promises';const b='/opt/cisme/rehearsals/r3-20260926-1100';const e=JSON.parse(await readFile(b+'/runtime.json','utf8'));Object.assign(process.env,e,{PORT:'31961',TMPDIR:b+'/final-tmp',UGC_SCAN_WORKER_MODE:'standalone',UGC_SCAN_BASE_URL:'https://synthetic.invalid'});const kind=process.argv[2];if(!['index','worker'].includes(kind))throw Error('TARGET');process.argv[1]=b+'/final-candidate/'+kind+'.js';await import(process.argv[1]);")
os.chown(entry,u.pw_uid,u.pw_gid);os.chmod(entry,0o600)
facts={'sourceHead':manifest['sourceHead'],'sourceTree':manifest['sourceTree'],'archiveSha256':expected,'manifestVerify':verify,'mainArtifact':False,'productionDeployed':False,'ugcScanner':'standalone scheduling enabled; no real provider or pending media','checks':[]};units=[]
def cmd(args):return subprocess.check_output(args,text=True).strip()
try:
 for kind in ['index','worker']:
  unit='cisme-r3-final-'+kind;cmd(['systemd-run','--unit='+unit,'--collect','--property=User=cisme','--property=WorkingDirectory='+str(b/'work'),'--property=IPAddressDeny=any','--property=IPAddressAllow=localhost','--property=NoNewPrivileges=true',node,str(entry),kind]);units.append(unit)
 for i in range(25):
  try:
   r=urllib.request.urlopen('http://127.0.0.1:31961/health/ready',timeout=2)
   if r.status==200 and (tmp/'cisme-worker-heartbeat.json').exists():break
  except Exception:pass
  time.sleep(.5)
 else:raise Exception('FINAL_RUNTIME_NOT_READY')
 facts['checks'].append({'ready':r.status,'heartbeat':json.loads((tmp/'cisme-worker-heartbeat.json').read_text())})
 for unit in units:facts['checks'].append({'unit':unit,'state':cmd(['systemctl','show',unit,'-p','ActiveState','-p','MainPID','-p','User'])})
 try:urllib.request.urlopen('http://127.0.0.1:31961/v1/me/privacy-requests',timeout=2);raise Exception('UNAUTH_ACCEPTED')
 except urllib.error.HTTPError as e:assert e.code==401;facts['checks'].append({'unauthenticatedPrivacy':e.code})
 time.sleep(1)
 facts['ok']=True
finally:
 for unit in units:
  subprocess.run(['systemctl','stop',unit],check=True)
  log=cmd(['journalctl','-u',unit,'--no-pager','-o','cat']);(b/'logs'/str(unit+'.log')).write_text(log)
  assert 'CISME_UGC_SAFETY_TICK_FAILED' not in log and 'CISME_WORKER_TICK_FAILED' not in log
 facts['live']={'current':str(pathlib.Path('/opt/cisme/current').resolve()),'api':cmd(['systemctl','is-active','cisme-api']),'worker':cmd(['systemctl','is-active','cisme-worker']),
 'journalCount':int(cmd(['/usr/sbin/runuser','-u','postgres','--','psql','-X','-At','-d','cisme','-c','SELECT count(*) FROM schema_migration'])),
 'pendingOutbox':int(cmd(['/usr/sbin/runuser','-u','postgres','--','psql','-X','-At','-d','cisme','-c','SELECT count(*) FROM outbox_event WHERE processed_at IS NULL']))}
 (b/'final-runtime-result.json').write_text(json.dumps(facts,indent=2)+'\n');os.chmod(b/'final-runtime-result.json',0o600);print(json.dumps(facts))
