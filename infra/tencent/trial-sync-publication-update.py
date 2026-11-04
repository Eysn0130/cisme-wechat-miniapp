#!/usr/bin/env python3
"""Exact836/schema106 -> synchronous ordinary publication on isolated trial.

Default preflight is read-only. Preserve old private inputs, packages, all SQL
bytes and production; take an authenticated encrypted database protection point
after draining both writers. Apply only107, two versioned notices, an explicit
user-authorized release record and community switch. Never create member
consent, permissions, test accounts or publication intents. No push registration.
"""
import argparse
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import time
import types

ROOT=Path('/opt/cisme-trial')
BASE='836ac3c8f86a8472f5de9c523a7f6cd0a0ef2236'
BASE_TREE='4c01fb56ed9f64fac4ca2ad33bb58215563b20b5'
BASE_HELPER=ROOT/'message-callback-runners'/BASE[:12]/'trial-message-callback-update.py'
BASE_HELPER_SHA='64ec9fe96342bb872a5ae0b338c0b4d350652b4d3354b93702ddabbe030ea799'
BASE_BINDING_SHA='984d72302623f19d44e1ab048350d6906f67306f53f0281325108652abacfdff'
RUNNERS=ROOT/'sync-publication-runners'
STATES=ROOT/'sync-publication-updates'
ACTIVE=STATES/'active-release.json'
SOURCE='infra/tencent/trial-sync-publication-update.py'
OP_SOURCE='infra/tencent/activate-trial-community.mjs'
LEGAL_SOURCE='docs/legal/community-direct-publishing-20261103/publication-candidate.json'
MIGRATION='202611040001_ugc_synchronous_image_safety.sql'
REFERENCE='cisme-user-direct-publication-20261104'
DELTA={'UGC_IMAGE_SAFETY_MODE':'wechat_v1_sync','UGC_SCAN_WORKER_MODE':'standalone',
 'UGC_GO_LIVE_GATE':'true','UGC_PROVENANCE_READY':'true','UGC_CONTENT_SAFETY_READY':'true',
 'UGC_LEGAL_APPROVAL_ID':REFERENCE}
M=H=C=D=None

class Refused(RuntimeError):pass
def need(value,code):
    if not value:raise Refused('SYNC_'+code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def protected(path,limit=8*1024**2):
    need(path.is_absolute() and '..' not in path.parts,'ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        s=parent.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'PROTECTED_PARENT_REQUIRED')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and
          stat.S_IMODE(s.st_mode)==0o600 and 0<s.st_size<=limit,'PROTECTED_FILE_REQUIRED')
        with os.fdopen(fd,'rb',closefd=False)as f:raw=f.read(limit+1)
        end=os.fstat(fd);need(len(raw)==s.st_size and (s.st_size,s.st_mtime_ns,s.st_ctime_ns)==
          (end.st_size,end.st_mtime_ns,end.st_ctime_ns),'PROTECTED_FILE_CHANGED')
        return raw
    finally:os.close(fd)

def load_baseline(active=False):
    global M,H,C,D
    need(os.geteuid()==0,'ROOT_REQUIRED');raw=protected(BASE_HELPER,128*1024)
    need(sha(raw)==BASE_HELPER_SHA,'BASELINE_HELPER_DRIFT')
    M=types.ModuleType('pinned836_callback');M.__file__=str(BASE_HELPER)
    exec(compile(raw,str(BASE_HELPER),'exec'),M.__dict__)
    b=M.binding(BASE_HELPER.parent/'application-binding.json',BASE_BINDING_SHA)
    record=M.active(b)if active else None
    if not active:M.load_baseline(False)
    H,C,D=M.H,M.C,M.D;H.target()
    return record

def binding(path,expected):
    raw=protected(path,128*1024);need(sha(raw)==expected,'BINDING_HASH_REQUIRED');b=json.loads(raw)
    need(b.get('kind')=='trial-sync-publication-update' and b.get('baselineHead')==BASE and
      b.get('migrations')==107,'BINDING_SCOPE_REQUIRED')
    need(all(isinstance(b.get(k),str)and re.fullmatch('[0-9a-f]{40}',b[k])for k in ('sourceHead','sourceTree')),
      'COMMITTED_SOURCE_REQUIRED')
    need(Path(__file__)==RUNNERS/b['sourceHead'][:12]/Path(SOURCE).name,'PINNED_RUNNER_REQUIRED')
    archive=Path(b.get('archivePath',''));need(archive.is_relative_to('/var/lib/cisme-dependency-stage')and
      archive.name=='archive.tar.gz' and type(b.get('archiveBytes'))is int and 0<b['archiveBytes']<=512*1024**2,'ARCHIVE_BINDING_REQUIRED')
    return b

def config_delta(config,raw):
    need(config.get('APP_ENV')=='staging' and config.get('UGC_GO_LIVE_GATE','false')=='false','CLOSED_TRIAL_REQUIRED')
    updated=[];seen=set()
    for line in raw.decode().splitlines():
        key=line.split('=',1)[0]
        if key in DELTA:
            need(key not in seen,'DUPLICATE_SETTING_REFUSED');seen.add(key);line=key+'='+DELTA[key]
        updated.append(line)
    updated.extend(key+'='+value for key,value in DELTA.items()if key not in seen)
    result=('\n'.join(updated)+'\n').encode();expected={**config,**DELTA}
    need(D.general.observe.audit.environment(result.decode())==expected,'EXACT_CONFIG_DELTA_REQUIRED')
    return expected,result

def artifact_contract(old,candidate,b):
    before,after=old['manifest'],candidate['manifest'];sql=before['migrations']
    need(before['sourceHead']==BASE and before['sourceTree']==BASE_TREE and len(sql)==106,'EXACT_BASELINE_REQUIRED')
    need(after['sourceHead']==b['sourceHead']and after['sourceTree']==b['sourceTree']and
      candidate['manifestSha256']==b['manifestSha256']and after.get('configurationIncluded')is False and
      after.get('buildPlatform')=={'os':'linux','arch':'x64','libc':'glibc'},'EXACT_CANDIDATE_REQUIRED')
    need(after['migrations']==sql+[MIGRATION] and set(b['migrationSha256'])==set(after['migrations']),'ONLY107_REQUIRED')
    names=['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+n for n in sql]
    need(all(old['files'][n]==candidate['files'][n]for n in names),'HISTORICAL_FILE_DRIFT')
    need(all(sha(candidate['files']['db/migrations/'+n])==b['migrationSha256'][n]for n in after['migrations']),'SQL_BINDING_DRIFT')
    need(old['dependenciesSha256']==candidate['dependenciesSha256']==H.DEPENDENCIES,'DEPENDENCY_DRIFT')

def source_permit(b,candidate):
    H.candidate_ci(b);base='https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/'
    commit=H.parse(H.response(base+'git/commits/'+b['sourceHead'],256*1024))
    need(commit.get('sha')==b['sourceHead']and commit.get('tree',{}).get('sha')==b['sourceTree'],'COMMITTED_TREE_REQUIRED')
    tree=H.parse(H.response(base+'git/trees/'+b['sourceTree']+'?recursive=1',4*1024**2))
    need(tree.get('sha')==b['sourceTree']and tree.get('truncated')is False and isinstance(tree.get('tree'),list),'COMPLETE_TREE_REQUIRED')
    entries={r['path']:r for r in tree['tree']};need(len(entries)==len(tree['tree']),'UNIQUE_SOURCE_ENTRIES_REQUIRED')
    runner=Path(__file__).parent
    required={SOURCE:protected(Path(__file__),128*1024),OP_SOURCE:protected(runner/'activate-trial-community.mjs'),
      LEGAL_SOURCE:protected(runner/'legal-candidate.json'),'scripts/release-migrate.mjs':candidate['files']['migrate.mjs']}
    required.update({'db/migrations/'+n:candidate['files']['db/migrations/'+n]for n in candidate['manifest']['migrations']})
    for path,raw in required.items():
        row=entries.get(path,{});need(row.get('type')=='blob'and row.get('mode')in ('100644','100755')and row.get('sha')==H.git_blob(raw),'COMMITTED_BYTES_REQUIRED')
    need(sha(H.source_bytes('package.json',b['sourceHead']))==H.SOURCE_PACKAGE and
      sha(H.source_bytes('package-lock.json',b['sourceHead']))==H.SOURCE_LOCK,'COMMITTED_PACKAGE_DRIFT')
    verified=H.parse(D.command([D.NODE,str(Path(candidate['directory'])/'migrate.mjs'),'verify']))
    need(verified.get('verified')is True and verified.get('sourceHead')==b['sourceHead']and
      verified.get('sourceTree')==b['sourceTree']and verified.get('migrations')==107,'CANDIDATE_VERIFY_REQUIRED')
    raw=protected(Path(b['archivePath']),512*1024**2)
    need(len(raw)==b['archiveBytes']and sha(raw)==b['archiveSha256'],'ARCHIVE_DRIFT')

def effective(plan,opened):return {**plan,'config':plan['openConfig'],'env':plan['openEnv']}if opened else plan

def verify(plan,opened=False,switched=False,active_raw=None,exact_pids=True):
    H.target();C.fixed_profile(plan['profile']);view=effective(plan,opened)
    D.verify_context(view,provenance=False,allow_candidate=switched)
    need({k:v for k,v in view['config'].items()if k not in DELTA}=={k:v for k,v in plan['config'].items()if k not in DELTA},'UNRELATED_CONFIG_DRIFT')
    need(not opened or all(view['config'].get(k)==v for k,v in DELTA.items()),'PUBLIC_CONFIG_DRIFT')
    need(all(H.read(Path(p),65536)==v for p,v in plan['history'].items()),'HISTORY_DRIFT')
    need(all(sha(protected(Path(p),v['limit']))==v['sha256']for p,v in plan['protectedBaselineInputs'].items()),'PRIVATE_INPUT_DRIFT')
    need((protected(ACTIVE,65536)if ACTIVE.exists()else None)==active_raw,'ACTIVE_RECORD_DRIFT')
    C.production_preserved(plan['production'],exact_pids);C.six_keys(view['config'],plan['production']['config'])
    artifact_contract(D.artifact(plan['old']['directory'],ROOT),D.artifact(plan['candidate']['directory'],ROOT),plan['binding'])

def journal(plan,allowed,drain=False):
    result=C.database_guard(plan['profile'],plan['config'],plan['ownership'],allowed,drain)
    H.S.schema101(plan['profile']);H.K.B.schema103(plan['profile']);H.K.schema104(plan['profile'],True)
    H.ugc_guards(plan['profile'],plan['ugcGuardBaseline']);H.direct_index(plan['profile'],True)
    definition=D.query(plan['profile'],"SELECT to_json(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='ugc_safety_scan'::regclass AND conname='ugc_safety_scan_provider_check'")
    need(('wechat_v1_sync'in definition)==(len(result)==107),'PROVIDER_CONSTRAINT_DRIFT')

def facts(profile,scoped=False,trace=None):
    tables=D.query(profile,"SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'")
    parts=[]
    for table in tables:
        need(re.fullmatch('[a-z][a-z0-9_]*',table),'TABLE_NAME_REQUIRED');where=''
        if table=='schema_migration':where=" WHERE version<>'"+MIGRATION+"'"
        if scoped:
            if table=='legal_document':where=" WHERE NOT(document_type IN ('privacy','terms') AND version IN ('2026-10-28-v4','2026-11-03-v5'))"
            if table=='ugc_go_live_approval':where=" WHERE approval_reference<>'"+REFERENCE+"'"
            if table=='emergency_switch':where=" WHERE key<>'community'"
            if table=='audit_log'and trace:
                need(re.fullmatch('[0-9a-f-]{36}',trace),'AUDIT_TRACE_REQUIRED');where=" WHERE trace_id IS DISTINCT FROM '"+trace+"'"
        parts.append("SELECT '"+table+"' name,jsonb_build_object('count',count(*),'sha256',encode(digest(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'),'sha256'),'hex')) fact FROM "+table+' t'+where)
    return D.query(profile,'SELECT jsonb_object_agg(name,fact ORDER BY name) FROM ('+' UNION ALL '.join(parts)+') s')

def running(plan):
    p=plan['profile'];cfg=plan['openConfig'];root=Path(p['root']);result={}
    for unit,entry in zip(p['units'],('index.js','worker.js')):
        need(D.property_value(unit,'User')==p['user']and D.property_value(unit,'ProtectSystem')=='strict','SERVICE_PROTECTION_REQUIRED')
        writable=[Path(v.lstrip('-+')).resolve()for v in D.property_value(unit,'ReadWritePaths').split()]
        secrets=[Path(v['path'])for v in D.private_inputs(p,cfg)];drop=D.dropin_inputs(unit)
        for path in (root/'runtime.env',root/'releases',D.unit_path(unit),D.unit_path(unit).with_name(unit+'.d'),
          *(Path(v)for v in drop['files']),Path(D.NODE),*secrets):
            need(not any(path.resolve()==v or path.resolve().is_relative_to(v)for v in writable),'SERVICE_WRITE_ACCESS_REFUSED')
        pid=D.property_value(unit,'MainPID');need(D.property_value(unit,'ActiveState')=='active'and re.fullmatch('[1-9][0-9]*',pid),'SERVICE_NOT_RUNNING')
        proc=Path('/proc')/pid;args=proc.joinpath('cmdline').read_bytes().split(b'\0');cwd=proc.joinpath('cwd').resolve()
        need(proc.stat().st_uid==pwd.getpwnam(p['user']).pw_uid and cwd==root and len(args)>=2 and args[0]==D.NODE.encode()and
          (cwd/os.fsdecode(args[1])).resolve()==Path(plan['candidate']['directory'])/entry and
          proc.joinpath('exe').resolve()==Path(D.NODE).resolve(),'PROCESS_BINDING_REQUIRED')
        env=dict(v.split('=',1)for v in proc.joinpath('environ').read_text().split('\0')if '='in v)
        need(all(env.get(k)==v for k,v in cfg.items())and all(env.get(k,'false')==cfg.get(k,'false')for k in (*D.CLOSED_FLAGS,*D.PREPARATION_FLAGS)),
          'RUNNING_ENV_DRIFT');result[unit]=pid
    return result

def public_contract(plan):
    p=plan['profile'];base='https://'+p['domain']
    for path in ('/health/ready','/v1/ugc/status'):
        raw=D.command(['/usr/bin/curl','--silent','--show-error','--fail','--noproxy','*','--max-time','10',
          '--proto','=https','--resolve',p['domain']+':443:127.0.0.1',base+path])
        need(len(raw)<16384,'PUBLIC_RESPONSE_LIMIT');value=json.loads(raw)
        need(value.get('status')=='ready' if path=='/health/ready' else value.get('publicEnabled')is True and value.get('draftsEnabled')is True,'PUBLIC_READBACK_REQUIRED')

def preflight(b):
    record=load_baseline(True);need(not ACTIVE.exists(),'EXISTING_ACTIVATION_REQUIRES_REVIEW')
    saved=protected(Path(record['upgradeState'])/'protected-plan.json');need(sha(saved)==record['privatePlanSha256'],'BASELINE_PLAN_DRIFT')
    base=C.decode_private(json.loads(saved));plan={**base,'config':base['callbackConfig'],'env':base['callbackEnv'],
      'old':D.artifact(base['candidate']['directory'],ROOT),'candidate':D.artifact(str(ROOT/'releases'/('tencent-release-'+b['sourceHead'][:12])),ROOT),
      'binding':b,'production':C.production_capture()}
    p=plan['profile'];need(D.closed_context(p,plan['config']),'BASELINE_CLOSED_REQUIRED')
    plan['units']={u:D.read_owned(D.unit_path(u))for u in p['units']};plan['dropIns']={u:D.dropin_inputs(u)for u in p['units']}
    plan['unitDefinitions']={u:D.unit_definition(u,plan['units'][u],entry,p,plan['dropIns'][u])for u,entry in zip(p['units'],('index.js','worker.js'))}
    plan['history']={**base['history'],str(M.ACTIVE):protected(M.ACTIVE,65536)}
    inputs=dict(base['protectedBaselineInputs'])
    for path in (BASE_HELPER,BASE_HELPER.parent/'application-binding.json',Path(record['upgradeState'])/'protected-plan.json',
      Path(__file__).parent/'activate-trial-community.mjs',Path(__file__).parent/'legal-candidate.json',Path(__file__).parent/'provider-probe.json'):
        raw=protected(path);inputs[str(path)]={'sha256':sha(raw),'limit':max(65536,len(raw))}
    plan['protectedBaselineInputs']=inputs
    plan['openConfig'],plan['openEnv']=config_delta(plan['config'],plan['env'])
    probe=protected(Path(__file__).parent/'provider-probe.json',65536);value=json.loads(probe)
    need(sha(probe)==b['probeSha256']and value.get('imageErrcode')==0 and value.get('imageExplicitSuccess')is True and
      value.get('runtimeGuardVerified')is True and value.get('businessDataCreated')is False and value.get('messagePushUsed')is False,'REAL_PROVIDER_CAPABILITY_REQUIRED')
    need(D.query(p,"SELECT count(*) FROM ugc_post WHERE state='pending_review'")==0,'PREEXISTING_PENDING_INTENT_REQUIRES_REVIEW')
    legal=protected(Path(__file__).parent/'legal-candidate.json');need(sha(legal)==b['legalCandidateSha256'],'LEGAL_CANDIDATE_DRIFT')
    plan['documents']=json.loads(legal);plan['legalBaselineSha256']=D.query(p,"SELECT to_json(encode(digest(jsonb_agg(to_jsonb(l) ORDER BY document_type,version)::text,'sha256'),'hex')) FROM legal_document l")
    plan['versions']=D.native_smoke(p,plan['candidate']['directory'],True)
    need(plan['versions']==D.native_smoke(p,plan['old']['directory'],True),'NATIVE_RUNTIME_DRIFT')
    artifact_contract(plan['old'],plan['candidate'],b);source_permit(b,plan['candidate']);verify(plan);journal(plan,[plan['old']['manifest']['migrations']])
    return plan

def apply(b,approval):
    need(re.fullmatch('[-A-Za-z0-9_:.]{8,120}',approval or ''),'OPERATION_REFERENCE_REQUIRED')
    fd=os.open('/run/lock/cisme-production-trial.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        s=os.fstat(fd);need(stat.S_ISREG(s.st_mode)and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600,'LOCK_REQUIRED')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);plan=preflight(b)
        STATES.mkdir(mode=0o700,exist_ok=True);D.owned_directory(STATES,True)
        D.general.store(STATES/('update-'+b['sourceHead'][:12]+'.started.json'),(json.dumps({'sourceHead':b['sourceHead'],'operationReference':approval})+'\n').encode())
        state=STATES/('commit-'+b['sourceHead'][:12]+'-'+str(time.time_ns()));state.mkdir(mode=0o700)
        H.backup_inputs(plan,state);stopped=False
        try:
            verify(plan);source_permit(b,plan['candidate']);stopped=True
            D.command(['systemctl','stop',*plan['profile']['units']],timeout=90);D.stopped(plan['profile'])
            verify(plan);journal(plan,[plan['old']['manifest']['migrations']],True)
            fence=facts(plan['profile']);scoped=facts(plan['profile'],True)
            backup=H.S.snapshot(plan,state,approval);H.S.validate_snapshot(backup,state,approval)
            plan.update(operationReference=approval,drainedFacts=fence,snapshotReceiptSha256=sha(protected(state/'predeploy-database/snapshot-private.json')))
            saved={**plan,'old':{k:v for k,v in plan['old'].items()if k!='files'},'candidate':{k:v for k,v in plan['candidate'].items()if k!='files'}}
            saved_raw=(json.dumps(C.encode_private(saved),sort_keys=True)+'\n').encode();D.general.store(state/'protected-plan.json',saved_raw)
            D.command(['/usr/sbin/runuser','-u','cisme-trial','--',D.NODE,str(Path(plan['candidate']['directory'])/'migrate.mjs'),'up'],
              env={**D.CLEAN,**plan['config'],'CISME_MIGRATION_APPROVAL_REF':approval,'CISME_PREDEPLOY_BACKUP_REF':backup['backupReference']},cwd=ROOT,timeout=180)
            journal(plan,[plan['candidate']['manifest']['migrations']],True);need(facts(plan['profile'])==fence,'EXISTING106_FACTS_CHANGED')
            payload={'reference':REFERENCE,'sourceHead':b['sourceHead'],'probeSha256':b['probeSha256'],
              'legalBaselineSha256':plan['legalBaselineSha256'],'documents':plan['documents']}
            payload_path=state/'activation-input.json';D.general.store(payload_path,(json.dumps(payload)+'\n').encode())
            activated=json.loads(D.command([D.NODE,str(Path(__file__).parent/'activate-trial-community.mjs'),str(payload_path)],
              env={**D.CLEAN,'TASK_RELEASE':plan['candidate']['directory'],'DATABASE_URL':plan['config']['DATABASE_URL']},timeout=30))
            need(activated.get('publicSwitchEnabled')is True and activated.get('memberConsentCreated')is False and
              facts(plan['profile'],True,activated['auditTrace'])==scoped,'UNRELATED_ACTIVATION_FACTS_CHANGED')
            D.general.store(state/'activation.json',(json.dumps(activated,sort_keys=True)+'\n').encode())
            temporary=ROOT/('.sync-runtime-'+str(time.time_ns()));D.general.store(temporary,plan['openEnv'])
            meta=plan['environmentMetadata'];os.chown(temporary,meta['uid'],meta['gid']);os.chmod(temporary,meta['mode']);os.replace(temporary,ROOT/'runtime.env')
            D.switch(effective(plan,True),plan['candidate']['directory']);verify(plan,True,True)
            started=time.time();D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
            for attempt in range(40):
                try:
                    running(plan);public_contract(plan)
                    heartbeat=Path(plan['profile']['root'])/'tmp/cisme-worker-heartbeat.json';info=heartbeat.lstat()
                    need(stat.S_ISREG(info.st_mode)and info.st_uid==pwd.getpwnam(plan['profile']['user']).pw_uid and info.st_mode&0o077==0,'HEARTBEAT_PROTECTION_REQUIRED')
                    at=datetime.fromisoformat(json.loads(heartbeat.read_bytes())['completedAtUtc'].replace('Z','+00:00')).timestamp()
                    need(started<=at<=time.time()and time.time()-at<=120,'NEW_HEARTBEAT_REQUIRED');break
                except Exception:
                    if attempt==39:raise
                    time.sleep(.5)
            verify(plan,True,True);journal(plan,[plan['candidate']['manifest']['migrations']])
            report={'kind':'trial-sync-publication-active','sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'upgradeState':str(state),
              'privatePlanSha256':sha(saved_raw),'migrationCount':107,'publicUgcEnabled':True,'messagePushRequired':False,
              'provider':'wechat_v1_sync','changedConfigKeys':list(DELTA),'memberConsentCreated':False,'authorityGranted':False,
              'productionChanged':False,'databaseRestored':False,'originalFactsPreservedExceptDeclaredReleaseFacts':True,
              'activation':activated,'ciRunId':b['ciRunId'],'ciVerifyJobId':b['ciVerifyJobId'],'privateValuesExported':False}
            raw=(json.dumps(report,sort_keys=True)+'\n').encode();D.atomic_bytes(ACTIVE,raw);verify(plan,True,True,raw)
            D.general.store(state/'deployed.json',raw);return report
        except Exception:
            if stopped:
                D.command(['systemctl','stop',*plan['profile']['units']],timeout=90)
                D.general.store(state/'forward-recovery-required.json',b'{"forwardRecoveryRequired":true,"databaseRestored":false}\n')
            raise
    finally:os.close(fd)

def active(b):
    load_baseline(False);raw=protected(ACTIVE,65536);record=json.loads(raw);state=Path(record['upgradeState'])
    need(state.parent==STATES and re.fullmatch('commit-'+b['sourceHead'][:12]+'-[0-9]+',state.name),'ACTIVE_STATE_REQUIRED')
    saved=protected(state/'protected-plan.json');need(sha(saved)==record['privatePlanSha256'],'ACTIVE_PLAN_DRIFT');plan=C.decode_private(json.loads(saved))
    need(plan['binding']==b,'ACTIVE_BINDING_DRIFT')
    for name in ('old','candidate'):plan[name]=D.artifact(plan[name]['directory'],ROOT)
    H.S.validate_snapshot(json.loads(protected(state/'predeploy-database/snapshot-private.json')),state,plan['operationReference'])
    need(sha(protected(state/'predeploy-database/snapshot-private.json'))==plan['snapshotReceiptSha256'],'SNAPSHOT_DRIFT')
    verify(plan,True,True,raw);running(plan);public_contract(plan);journal(plan,[plan['candidate']['manifest']['migrations']])
    return {**record,'readOnly':True,'activeVerified':True}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=('preflight','apply','active'),default='preflight',nargs='?')
    p.add_argument('--binding',type=Path,required=True);p.add_argument('--binding-sha256',required=True);p.add_argument('--operation-reference');a=p.parse_args()
    try:
        b=binding(a.binding,a.binding_sha256)
        value=apply(b,a.operation_reference)if a.action=='apply'else active(b)if a.action=='active'else {'readOnly':True,'sourceHead':preflight(b)['binding']['sourceHead'],'publicUgcEnabled':False}
        print(json.dumps(value,sort_keys=True));return 0
    except Exception as error:
        print(json.dumps({'ok':False,'code':str(error)if isinstance(error,Refused)else 'SYNC_REVIEW_REQUIRED','privateValuesExported':False}));return 1
if __name__=='__main__':raise SystemExit(main())
