import pathlib,subprocess,json,time,os,pwd,urllib.request,urllib.error,hashlib
b=pathlib.Path('/opt/cisme/rehearsals/r3-20260926-1100');u=pwd.getpwnam('cisme');node='/opt/node-v24.14.0-linux-x64/bin/node'
launcher=b/'harness/entry.mjs';launcher.write_text("import {readFile} from 'node:fs/promises';const b='/opt/cisme/rehearsals/r3-20260926-1100';const env=JSON.parse(await readFile(b+'/runtime.json','utf8'));const kind=process.argv[2];if(!['index','worker','maintenance'].includes(kind))throw Error('BAD_TARGET');Object.assign(process.env,env,{TMPDIR:b+'/tmp'});if(kind==='maintenance')Object.assign(process.env,{PORT:'31959',CISME_MIGRATION_READ_ONLY:'true'});process.argv[1]=b+'/candidate/'+(kind==='maintenance'?'index':kind)+'.js';await import(process.argv[1]);")
os.chown(launcher,u.pw_uid,u.pw_gid);os.chmod(launcher,0o600)
facts={'mainArtifact':False,'productionTouched':False,'externalNetwork':'systemd IPAddressDeny=any; IPAddressAllow=localhost','checks':[]};started=[]
def cmd(args):return subprocess.run(args,text=True,capture_output=True,check=True).stdout.strip()
def start(kind):
 unit='cisme-r3-'+kind+'-1100';cmd(['systemd-run','--unit='+unit,'--collect','--property=User=cisme','--property=WorkingDirectory='+str(b/'work'),'--property=IPAddressDeny=any','--property=IPAddressAllow=localhost','--property=NoNewPrivileges=true',node,str(launcher),kind]);started.append(unit);return unit
def http(path,body=None,token=None,port=31957,key=None):
 headers={}
 if body is not None:headers['content-type']='application/json'
 if token:headers['authorization']='Bearer '+token
 if key:headers['idempotency-key']=key
 request=urllib.request.Request('http://127.0.0.1:'+str(port)+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
 try:r=urllib.request.urlopen(request,timeout=3)
 except urllib.error.HTTPError as e:r=e
 return r.status,json.loads(r.read())
def waitready(port):
 for i in range(12):
  try:
   status,data=http('/health/ready',port=port)
   if status==200:return data
  except Exception:pass
  time.sleep(.5)
 raise Exception('NOT_READY_'+str(port))
try:
 api=start('index');worker=start('worker');facts['checks'].append({'mainApiReady':waitready(31957)})
 for i in range(20):
  if (b/'tmp/cisme-worker-heartbeat.json').exists():break
  time.sleep(.5)
 heartbeat=json.loads((b/'tmp/cisme-worker-heartbeat.json').read_text());facts['checks'].append({'independentWorkerHeartbeat':heartbeat})
 for unit in [api,worker]:
  state=cmd(['systemctl','show',unit,'-p','MainPID','-p','ActiveState','-p','IPAddressDeny','-p','IPAddressAllow','-p','User']);facts['checks'].append({'service':unit,'state':state})
 maintenance=start('maintenance');waitready(31959)
 status,body=http('/v1/identity/dev',{},port=31959);assert status==503 and body['code']=='SERVICE_MIGRATING';facts['checks'].append({'maintenanceBlocksWrites':{'status':status,'code':body['code']}})
 cmd(['systemctl','stop',api]);started.remove(api);api=start('index');waitready(31957)
 status,identity=http('/v1/identity/dev',{'externalUserId':'r3-linux-runtime-synthetic-member','displayName':'R3 合成演练会员','consents':[{'documentType':'privacy','version':'r3-synthetic'},{'documentType':'terms','version':'r3-synthetic'}]});assert status==200
 result=json.loads((b/'runtime-result.json').read_text());ids=next(x['value'] for x in result['checks'] if x['name']=='syntheticIds')
 query="SELECT source_quote_id FROM commerce_order WHERE id='"+ids['order']+"';"
 quote=cmd(['/usr/sbin/runuser','-u','cisme','--','/usr/lib/postgresql/16/bin/psql','-X','-At','-h',str(b/'socket'),'-p','31956','-d','cisme_r3_runtime','-c',query])
 status,order=http('/v1/me/orders',{'quoteId':quote},identity['sessionToken'],key='acceptance-order-pending-0001');assert status==200 and order['id']==ids['order'];facts['checks'].append({'afterRestartOrderRetry':{'status':status,'sameOrderId':True,'oldBackupUsed':False}})
 facts['ok']=True
finally:
 for unit in started:
  subprocess.run(['systemctl','stop',unit],capture_output=True)
  log=subprocess.run(['journalctl','-u',unit,'--no-pager','-o','cat'],capture_output=True,text=True)
  (b/'logs'/str(unit+'.log')).write_text(log.stdout)
 (b/'standalone-result.json').write_text(json.dumps(facts,indent=2)+'\n');os.chmod(b/'standalone-result.json',0o600)
 print(json.dumps(facts))
