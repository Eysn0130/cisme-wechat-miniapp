#!/usr/bin/env python3
"""Rehearse old API/Worker against the SAME newly-owned staging DB/objects.
Never restore an old DB, run down migrations, or access production resources.
"""
import base64,hashlib,hmac,json,os,pathlib,pwd,re,shlex,socket,subprocess,sys,time,urllib.request
ROOT=pathlib.Path('/opt/cisme');SOURCE='f346736d379e9d8b177426f17ffb58a4e4e32cca';PREVIOUS='202653d35b745c9cad2e47cba248dcf9e4706946'
UNITS=['cisme-staging-api','cisme-staging-worker']
def require(ok,code):
    if not ok:raise RuntimeError(code)
def command(args,data=None):
    r=subprocess.run(args,input=data,text=True,capture_output=True,timeout=45);require(r.returncode==0,'BOUNDED_ROLLBACK_COMMAND_FAILED');return r.stdout.strip()
def main(run):
    require(os.geteuid()==0 and socket.gethostname()=='VM-4-15-ubuntu' and re.fullmatch(r'rc20260922-[a-f0-9]{8}',run),'STAGING_TARGET_REQUIRED')
    state=ROOT/'staging-acceptance'/run;owned=json.loads((state/'ownership.json').read_text());a=json.loads((state/'activated.json').read_text());accept=json.loads((state/'acceptance.json').read_text())
    current=ROOT/'current';envfile=pathlib.Path('/etc/cisme/runtime.env');envbytes=envfile.read_bytes();database='cisme_accept_'+run.replace('-','_')
    require(owned['database']==database and owned['instanceId']=='lhins-ei4hz4fi' and owned['sourceHead']==SOURCE and a['sourceHead']==SOURCE and a['activated'] and accept['sourceHead']==SOURCE,'OWNED_ACCEPTED_CANDIDATE_REQUIRED')
    require(str(current.resolve())==owned['directory'] and hashlib.sha256(envbytes).hexdigest()==a['candidateEnvSha256'],'CURRENT_CANDIDATE_DRIFT')
    config=dict(shlex.split(l,comments=False)[0].split('=',1) for l in envbytes.decode().splitlines() if l.strip() and not l.lstrip().startswith('#'))
    require(config['APP_ENV']=='staging' and config['COMMERCE_ORDER_FLOW_ENABLED']=='false' and config['OBJECT_STORAGE_DRIVER']=='api_gateway','ISOLATED_CONFIG_REQUIRED')
    require((current/'tmp').resolve()==pathlib.Path(owned['objects']),'OWNED_OBJECTS_REQUIRED')
    previous=pathlib.Path(a['oldDirectory']);manifest=json.loads((previous/'release-manifest.json').read_text())
    require(previous==ROOT/'releases'/'rc20260922-00c7d2e9-202653d35b74' and manifest['sourceHead']==PREVIOUS,'EXACT_PREVIOUS_RELEASE_REQUIRED')
    require(manifest['hashes'].get('index.js')=='de8cd37e7c1e94b8c139cd1e068cfd61695aed46d29b191c1e0e03c4083cd7de','PREVIOUS_API_DRIFT')
    files=['release-manifest.json',*manifest['hashes']]
    for name in files:
        require(not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts and (previous/name).is_file() and not (previous/name).is_symlink(),'UNSAFE_PREVIOUS_ARTIFACT')
        if name in manifest['hashes']:require(hashlib.sha256((previous/name).read_bytes()).hexdigest()==manifest['hashes'][name],'PREVIOUS_ARTIFACT_DRIFT')
    os.umask(0o077);started=state/'application-rollback-v2-started.json'
    with started.open('x') as f:json.dump({'database':database,'sourceHead':SOURCE,'previousSourceHead':PREVIOUS,'sameDatabase':True,'sameObjects':True},f)
    slot=ROOT/'releases'/(run+'-rollback-v2-'+PREVIOUS[:12]);slot.mkdir(mode=0o750);identity=pwd.getpwnam('cisme')
    for name in files:
        dest=slot/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((previous/name).read_bytes())
    for path in [slot,*slot.rglob('*')]:os.chown(path,identity.pw_uid,identity.pw_gid);os.chmod(path,0o750 if path.is_dir() else 0o640)
    (slot/'node_modules').symlink_to(previous/'node_modules',target_is_directory=True);(slot/'tmp').symlink_to(owned['objects'],target_is_directory=True)
    def sql(query):return command(['runuser','-u','postgres','--','psql','-X','-v','ON_ERROR_STOP=1','-At','-d',database],query)
    owner=sql("SELECT id FROM member WHERE display_name='SYNTHETIC acceptance owner';");require(re.fullmatch(r'[a-f0-9-]{36}',owner),'SYNTHETIC_OWNER_REQUIRED')
    new_id=sql("INSERT INTO privacy_request(member_id,kind,message,due_at) VALUES('"+owner+"','other','SYNTHETIC write after backup before application rollback',now()+interval '30 days') RETURNING id;").splitlines()[0]
    obj=pathlib.Path(owned['objects'])/'post-backup-synthetic-object.bin'
    with obj.open('xb') as f:f.write(b'SYNTHETIC post-backup object, retain across application rollback\n')
    object_hash=hashlib.sha256(obj.read_bytes()).hexdigest()
    payload=base64.urlsafe_b64encode(json.dumps({'memberId':owner,'principalId':'member:'+owner,'adapter':'wechat','provider':'wechat_miniprogram','appId':config['WECHAT_APP_ID'],'expiresAt':int(time.time()*1000)+300000},separators=(',',':')).encode()).decode().rstrip('=')
    token=payload+'.'+base64.urlsafe_b64encode(hmac.new(config['APP_SESSION_SECRET'].encode(),payload.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    def ready_and_fact():
        for attempt in range(30):
            try:
                with urllib.request.urlopen('https://staging-api.cisme.cn/health/ready',timeout=3) as response:require(response.status==200,'HTTPS_NOT_READY')
                req=urllib.request.Request('http://127.0.0.1:3100/v1/me/privacy-requests',headers={'Authorization':'Bearer '+token})
                with urllib.request.urlopen(req,timeout=3) as response:rows=json.load(response)
                require(any(row['id']==new_id for row in rows),'NEW_WRITE_NOT_READABLE');return
            except Exception:
                if attempt==29:raise RuntimeError('ROLLBACK_HEALTH_OR_NEW_WRITE_FAILED')
                time.sleep(.5)
    def switch(target,phase):
        require(envfile.read_bytes()==envbytes,'ENV_CHANGED_DURING_REHEARSAL')
        link=ROOT/('current-'+run+'-'+phase);require(not link.exists() and not link.is_symlink(),'TEMP_LINK_EXISTS');link.symlink_to(target,target_is_directory=True);os.replace(link,current)
    ready_and_fact();old_passed=False
    try:
        command(['systemctl','stop',*UNITS]);switch(slot,'rehearsal-old');command(['systemctl','start',*UNITS]);ready_and_fact()
        require(command(['systemctl','is-active',*UNITS]).split()==['active','active'],'OLD_SERVICES_NOT_RUNNING');old_passed=True
    finally:
        command(['systemctl','stop',*UNITS]);switch(owned['directory'],'rehearsal-return');command(['systemctl','start',*UNITS]);ready_and_fact()
    require(envfile.read_bytes()==envbytes and hashlib.sha256(obj.read_bytes()).hexdigest()==object_hash and sql('SELECT count(*) FROM schema_migration;')=='76','POST_ROLLBACK_INVARIANT_FAILED')
    report={'runId':run,'sourceHead':SOURCE,'previousSourceHead':PREVIOUS,'rollbackApiWorkerHealthy':old_passed,'candidateRestored':True,'postBackupBusinessWriteReadableInBoth':True,'postBackupObjectRetained':True,'sameDatabaseThroughout':True,'sameObjectRootThroughout':True,'databaseBackupRestored':False,'downMigrationExecuted':False,'productionTouched':False,'fullProductionRollbackAccepted':False}
    (state/'application-rollback.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if __name__=='__main__':
    try:
        require(len(sys.argv)==2,'RUN_ID_REQUIRED');main(sys.argv[1])
    except Exception as e:
        print(json.dumps({'ok':False,'code':str(e) if type(e) is RuntimeError else 'ROLLBACK_REHEARSAL_FAILED_REVIEW_REQUIRED'}));sys.exit(1)
