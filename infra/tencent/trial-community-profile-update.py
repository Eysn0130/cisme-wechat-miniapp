#!/usr/bin/env python3
"""Pinned706/schema107 -> additive community-profile/schema108, trial only.

Default preflight is read-only. Retains the open synchronous publication mode,
all credentials, notices, authority and original facts. Only the two trial
units switch after writer drain and an authenticated encrypted snapshot. No
database restore, real-account fixture, gate change or production deployment.
"""
import argparse
import base64
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import time
import types

ROOT=Path('/opt/cisme-trial')
BASE='70629d32504399873ac44e7cacc2b159e896880d'
BASE_TREE='f052dde0edb4e7a4ffc8cdeed79687e8ca0648cd'
BASE_MANIFEST='780b3644edff4eb8d221190df42bea89eafce078509e0ec2ff1a289537ffa13b'
FIX=ROOT/'sync-publication-health-runners/31a4fcf97364/trial-sync-publication-health-fix.py'
FIX_SHA='2e210dc21a093be778a1d25e52b31830ca95742c8a722779f65c7d6205b2b35f'
FIX_BINDING_SHA='6dc3b5628e14c2654b8dd4ac2b5d3d78d68c94469e2f18d30cf3665b8614ac7f'
SOURCE='infra/tencent/trial-community-profile-update.py'
MIGRATION='202611040002_community_biography.sql'
TAR_SHA='99a2c97bb429c56149c615396810899a5e13bc5c5d2500040aec33e69327e0f5'
RUNNERS=ROOT/'community-profile-runners'
STATES=ROOT/'community-profile-updates'
ACTIVE=STATES/'active-release.json'
M=H=C=D=None

class Refused(RuntimeError):pass
def need(value,code):
    if not value:raise Refused('PROFILE_'+code)
def sha(raw):return hashlib.sha256(raw).hexdigest()

def load():
    global M,H,C,D
    need(os.geteuid()==0,'ROOT_REQUIRED')
    raw=FIX.read_bytes();need(sha(raw)==FIX_SHA,'BASELINE_GUARD_DRIFT')
    fix=types.ModuleType('profile_pinned_health_guard');fix.__file__=str(FIX)
    exec(compile(raw,str(FIX),'exec'),fix.__dict__)
    M,app,_=fix.load(FIX.parent/'health-fix-binding.json',FIX_BINDING_SHA)
    need(M.protected(FIX,128*1024)==raw,'BASELINE_GUARD_DRIFT')
    H,C,D=M.H,M.C,M.D
    return app

def binding(path,expected):
    raw=M.protected(path,128*1024);need(sha(raw)==expected,'BINDING_DRIFT');b=json.loads(raw)
    need(b.get('kind')=='trial-community-profile-update' and b.get('baselineHead')==BASE and
      b.get('baselineTree')==BASE_TREE and b.get('migrations')==108,'BINDING_SCOPE_REQUIRED')
    need(all(isinstance(b.get(k),str)and re.fullmatch('[0-9a-f]{40}',b[k])for k in ('sourceHead','sourceTree')),
      'COMMITTED_SOURCE_REQUIRED')
    need(Path(__file__)==RUNNERS/b['sourceHead'][:12]/Path(SOURCE).name,'PINNED_RUNNER_REQUIRED')
    need(sha(M.protected(Path(__file__),128*1024))==b.get('helperSha256'),'HELPER_BINDING_REQUIRED')
    archive=Path(b.get('archivePath',''))
    need(archive.is_relative_to('/var/lib/cisme-dependency-stage') and archive.name=='archive.tar.gz' and
      type(b.get('archiveBytes'))is int and 0<b['archiveBytes']<=512*1024**2,'ARCHIVE_SCOPE_REQUIRED')
    return b

def artifact_contract(old,new,b):
    before,after=old['manifest'],new['manifest'];sql=before['migrations']
    need(before['sourceHead']==BASE and before['sourceTree']==BASE_TREE and len(sql)==107 and
      old['manifestSha256']==BASE_MANIFEST,'EXACT_BASELINE_REQUIRED')
    need(after['sourceHead']==b['sourceHead'] and after['sourceTree']==b['sourceTree'] and
      new['manifestSha256']==b['manifestSha256'] and after.get('configurationIncluded')is False and
      after.get('buildPlatform')=={'os':'linux','arch':'x64','libc':'glibc'},'EXACT_CANDIDATE_REQUIRED')
    need(after['migrations']==sql+[MIGRATION] and set(b['migrationSha256'])==set(after['migrations']),'ONLY108_REQUIRED')
    names=['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+n for n in sql]
    need(all(old['files'][n]==new['files'][n]for n in names),'HISTORICAL_FILE_DRIFT')
    need(all(sha(new['files']['db/migrations/'+n])==b['migrationSha256'][n]for n in after['migrations']),'SQL_BINDING_DRIFT')
    need(old['dependenciesSha256']==new['dependenciesSha256']==H.DEPENDENCIES,'DEPENDENCY_DRIFT')

def source_permit(b,candidate):
    H.candidate_ci(b)
    base='https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/'
    commit=H.parse(H.response(base+'git/commits/'+b['sourceHead'],256*1024))
    need(commit.get('sha')==b['sourceHead'] and commit.get('tree',{}).get('sha')==b['sourceTree'],'SOURCE_COMMIT_REQUIRED')
    tree=H.parse(H.response(base+'git/trees/'+b['sourceTree']+'?recursive=1',4*1024**2))
    need(tree.get('sha')==b['sourceTree'] and tree.get('truncated')is False and isinstance(tree.get('tree'),list),'COMPLETE_TREE_REQUIRED')
    entries={r['path']:r for r in tree['tree']};need(len(entries)==len(tree['tree']),'UNIQUE_TREE_REQUIRED')
    required={SOURCE:M.protected(Path(__file__),128*1024),'scripts/release-migrate.mjs':candidate['files']['migrate.mjs']}
    required.update({'db/migrations/'+n:candidate['files']['db/migrations/'+n]for n in candidate['manifest']['migrations']})
    for path,raw in required.items():
        row=entries.get(path,{})
        need(row.get('type')=='blob' and row.get('mode')in ('100644','100755') and row.get('sha')==H.git_blob(raw),'COMMITTED_BYTES_REQUIRED')
    need(sha(H.source_bytes('package.json',b['sourceHead']))==H.SOURCE_PACKAGE and
      sha(H.source_bytes('package-lock.json',b['sourceHead']))==H.SOURCE_LOCK,'COMMITTED_PACKAGE_DRIFT')

def baseline(app):
    record=M.active(app)
    need(record.get('sourceHead')==BASE and record.get('migrationCount')==107 and record.get('activeVerified')is True,'ACTIVE_BASELINE_REQUIRED')
    raw=M.protected(Path(record['upgradeState'])/'protected-plan.json')
    need(sha(raw)==record['privatePlanSha256'],'BASELINE_PLAN_DRIFT')
    base=C.decode_private(json.loads(raw))
    return record,base

def make_plan(b,base):
    config=base['openConfig'];p=base['profile'];C.fixed_profile(p)
    need(p['name']=='trial' and p['root']==str(ROOT) and p['database']=='cisme_trial' and
      config.get('APP_ENV')=='staging' and config.get('UGC_IMAGE_SAFETY_MODE')=='wechat_v1_sync' and
      config.get('UGC_GO_LIVE_GATE')=='true','OPEN_ISOLATED_TRIAL_REQUIRED')
    units={u:D.read_owned(D.unit_path(u))for u in p['units']}
    drops={u:D.dropin_inputs(u)for u in p['units']}
    plan={**base,'config':config,'env':base['openEnv'],'openConfig':config,'openEnv':base['openEnv'],
      'old':D.artifact(base['candidate']['directory'],ROOT),
      'candidate':D.artifact(str(ROOT/'releases'/('tencent-release-'+b['sourceHead'][:12])),ROOT),
      'binding':b,'production':C.production_capture(),'units':units,'dropIns':drops,
      'history':{**base['history'],str(M.ACTIVE):M.protected(M.ACTIVE,65536)},
      'unitDefinitions':{u:D.unit_definition(u,units[u],entry,p,drops[u])for u,entry in zip(p['units'],('index.js','worker.js'))}}
    artifact_contract(plan['old'],plan['candidate'],b)
    return plan

def verify(plan,switched=False,active_raw=None,exact_pids=True):
    H.target();C.fixed_profile(plan['profile']);D.verify_context(plan,provenance=False,allow_candidate=switched)
    need(all(H.read(Path(p),65536)==v for p,v in plan['history'].items()),'HISTORY_DRIFT')
    need(all(sha(M.protected(Path(p),v['limit']))==v['sha256']for p,v in plan['protectedBaselineInputs'].items()),'PRIVATE_INPUT_DRIFT')
    need((M.protected(ACTIVE,65536)if ACTIVE.exists()else None)==active_raw,'ACTIVE_RECORD_DRIFT')
    C.production_preserved(plan['production'],exact_pids);C.six_keys(plan['config'],plan['production']['config'])
    artifact_contract(D.artifact(plan['old']['directory'],ROOT),D.artifact(plan['candidate']['directory'],ROOT),plan['binding'])

def journal(plan,schemas,drain=False):
    rows=C.database_guard(plan['profile'],plan['config'],plan['ownership'],schemas,drain)
    H.S.schema101(plan['profile']);H.K.B.schema103(plan['profile']);H.K.schema104(plan['profile'],True)
    H.ugc_guards(plan['profile'],plan['ugcGuardBaseline']);H.direct_index(plan['profile'],True)
    definition=D.query(plan['profile'],"SELECT to_json(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='ugc_safety_scan'::regclass AND conname='ugc_safety_scan_provider_check'")
    need('wechat_v1_sync'in definition,'EXISTING_SAFETY_PROVIDER_REQUIRED')
    return len(rows)

def facts(profile,expanded=False):
    tables=D.query(profile,"SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public'")
    parts=[]
    for table in tables:
        need(re.fullmatch('[a-z][a-z0-9_]*',table),'TABLE_NAME_REQUIRED')
        where=" WHERE version<>'"+MIGRATION+"'"if table=='schema_migration'else''
        value="to_jsonb(t)-'community_bio'-'community_bio_revision'"if expanded and table=='member_profile'else'to_jsonb(t)'
        parts.append("SELECT '"+table+"' name,jsonb_build_object('count',count(*),'sha256',encode(digest(coalesce(jsonb_agg("+value+" ORDER BY ("+value+")::text)::text,'[]'),'sha256'),'hex')) fact FROM "+table+' t'+where)
    return D.query(profile,'SELECT jsonb_object_agg(name,fact ORDER BY name) FROM ('+' UNION ALL '.join(parts)+') s')

def stage(b,app):
    need(not ACTIVE.exists(),'ALREADY_ACTIVE')
    _,base=baseline(app);production=C.production_capture();p=base['profile']
    env=D.read_owned(ROOT/'runtime.env',private=True);units={u:D.read_owned(D.unit_path(u))for u in p['units']}
    archive=Path(b['archivePath']);raw=M.protected(archive,512*1024**2)
    need(len(raw)==b['archiveBytes']and sha(raw)==b['archiveSha256'],'ARCHIVE_BINDING_DRIFT')
    path=Path(__file__).parent/'reviewed-tar-primitives.py';code=M.protected(path,128*1024);need(sha(code)==TAR_SHA,'TAR_PRIMITIVE_DRIFT')
    tar=types.ModuleType('profile_pinned_tar');tar.__file__=str(path);exec(compile(code,str(path),'exec'),tar.__dict__)
    tar.HEAD=b['sourceHead'];tar.TREE=b['sourceTree'];tar.TOP='tencent-release-'+b['sourceHead'][:12]
    output=archive.parent/'expanded';output.mkdir(mode=0o700);release=tar.unpack(archive,output)
    manifest_raw=tar.read_regular(release/'release-manifest.json',expected_sha256=b['manifestSha256']);manifest=json.loads(manifest_raw)
    names={'index.js','worker.js','worker-once.js','migrate.mjs','package.json','package-lock.json'}|{'db/migrations/'+n for n in manifest['migrations']}
    need(set(manifest['hashes'])==names and {v.name for v in release.iterdir()}=={'node_modules','db','release-manifest.json','package.json','package-lock.json','index.js','worker.js','worker-once.js','migrate.mjs'} and
      {v.name for v in(release/'db').iterdir()}=={'migrations'} and {v.name for v in(release/'db/migrations').iterdir()}==set(manifest['migrations']),'RELEASE_CONTENT_SET_REQUIRED')
    candidate={'directory':str(release),'manifest':manifest,'manifestSha256':sha(manifest_raw),'dependenciesSha256':tar.dependency_digest(release/'node_modules'),
      'files':{n:tar.read_regular(release/n,expected_sha256=manifest['hashes'][n])for n in names}}
    old=D.artifact(base['candidate']['directory'],ROOT);artifact_contract(old,candidate,b);source_permit(b,candidate)
    selected=ROOT/'releases'/tar.TOP;need(not selected.exists()and not selected.is_symlink(),'EXISTING_CANDIDATE_REFUSED')
    os.rename(release,selected);plan=make_plan(b,base);verify(plan);journal(plan,[old['manifest']['migrations']])
    need(D.native_smoke(p,str(selected),True)==D.native_smoke(p,old['directory'],True),'NATIVE_RUNTIME_DRIFT')
    checked=json.loads(D.command([D.NODE,str(selected/'migrate.mjs'),'verify']))
    need(checked.get('verified')is True and checked.get('sourceHead')==b['sourceHead'] and checked.get('migrations')==108,'MIGRATOR_VERIFY_REQUIRED')
    baseline(app);C.production_preserved(production)
    need(D.read_owned(ROOT/'runtime.env',private=True)==env and all(D.read_owned(D.unit_path(u))==v for u,v in units.items()),'STAGING_CONTEXT_DRIFT')
    return {'staged':True,'deployed':False,'sourceHead':b['sourceHead'],'schema':108,'configurationChanged':False,'productionChanged':False}

def preflight(b,app):
    need(not ACTIVE.exists(),'ALREADY_ACTIVE');_,base=baseline(app);plan=make_plan(b,base)
    verify(plan);journal(plan,[plan['old']['manifest']['migrations']]);source_permit(b,plan['candidate'])
    need(D.native_smoke(plan['profile'],plan['candidate']['directory'],True)==D.native_smoke(plan['profile'],plan['old']['directory'],True),'NATIVE_RUNTIME_DRIFT')
    return plan

def healthy(plan,started):
    # The dependency-only runner predates public UGC and requires closed gates.
    # Verify the exact authorized open configuration with the pinned UGC runner.
    for attempt in range(40):
        try:
            M.running(plan);M.public_contract(plan)
            heartbeat=Path(plan['profile']['root'])/'tmp/cisme-worker-heartbeat.json';info=heartbeat.lstat()
            need(stat.S_ISREG(info.st_mode) and info.st_uid==pwd.getpwnam(plan['profile']['user']).pw_uid and
              info.st_mode&0o077==0,'HEARTBEAT_PROTECTION_REQUIRED')
            at=datetime.fromisoformat(json.loads(heartbeat.read_bytes())['completedAtUtc'].replace('Z','+00:00')).timestamp()
            need(started<=at<=time.time() and time.time()-at<=120,'NEW_HEARTBEAT_REQUIRED')
            break
        except Exception:
            if attempt==39:raise
            time.sleep(.5)
    return D.native_smoke(plan['profile'],plan['candidate']['directory'],True)

def apply(b,app,approval):
    need(re.fullmatch('[-A-Za-z0-9_:.]{8,120}',approval or ''),'OPERATION_REFERENCE_REQUIRED')
    plan=preflight(b,app);STATES.mkdir(mode=0o700,exist_ok=True);D.owned_directory(STATES,True)
    state=STATES/('commit-'+b['sourceHead'][:12]+'-'+str(time.time_ns()));state.mkdir(mode=0o700)
    H.backup_inputs(plan,state);stopped=False
    try:
        verify(plan);source_permit(b,plan['candidate']);stopped=True
        D.command(['systemctl','stop',*plan['profile']['units']],timeout=90);D.stopped(plan['profile'])
        verify(plan);journal(plan,[plan['old']['manifest']['migrations']],True)
        fence=facts(plan['profile']);backup=H.S.snapshot(plan,state,approval);H.S.validate_snapshot(backup,state,approval)
        plan.update(operationReference=approval,drainedFacts=fence,snapshotReceiptSha256=sha(M.protected(state/'predeploy-database/snapshot-private.json')))
        saved={**plan,'old':{k:v for k,v in plan['old'].items()if k!='files'},'candidate':{k:v for k,v in plan['candidate'].items()if k!='files'}}
        saved_raw=(json.dumps(C.encode_private(saved),sort_keys=True)+'\n').encode();D.general.store(state/'protected-plan.json',saved_raw)
        D.command(['/usr/sbin/runuser','-u','cisme-trial','--',D.NODE,str(Path(plan['candidate']['directory'])/'migrate.mjs'),'up'],
          env={**D.CLEAN,**plan['config'],'CISME_MIGRATION_APPROVAL_REF':approval,'CISME_PREDEPLOY_BACKUP_REF':backup['backupReference']},cwd=ROOT,timeout=180)
        journal(plan,[plan['candidate']['manifest']['migrations']],True)
        need(D.query(plan['profile'],"SELECT count(*) FROM member_profile WHERE community_bio<>'' OR community_bio_revision<>0")==0,'NEW_BIO_DEFAULTS_REQUIRED')
        need(facts(plan['profile'],True)==fence,'ORIGINAL_FACTS_CHANGED')
        D.switch(plan,plan['candidate']['directory']);verify(plan,True)
        started=time.time();D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
        healthy(plan,started)
        verify(plan,True);journal(plan,[plan['candidate']['manifest']['migrations']])
        report={'kind':'trial-community-profile-active','sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'upgradeState':str(state),
          'privatePlanSha256':sha(saved_raw),'migrationCount':108,'configurationChanged':False,'publicUgcEnabled':True,'provider':'wechat_v1_sync',
          'ordinaryPostsStillDirect':True,'memberConsentCreated':False,'authorityGranted':False,'productionChanged':False,'databaseRestored':False,
          'originalFactsPreservedAtMigration':True,'snapshotCryptoAadUsesHistoricalPrimitiveLabel':True,'ciRunId':b['ciRunId'],'ciVerifyJobId':b['ciVerifyJobId'],'privateValuesExported':False}
        raw=(json.dumps(report,sort_keys=True)+'\n').encode();D.atomic_bytes(ACTIVE,raw);verify(plan,True,raw)
        D.general.store(state/'deployed.json',raw);return report
    except Exception:
        if stopped:
            D.command(['systemctl','stop',*plan['profile']['units']],timeout=90)
            D.general.store(state/'forward-recovery-required.json',b'{"forwardRecoveryRequired":true,"databaseRestored":false}\n')
        raise

def active(b):
    raw=M.protected(ACTIVE,65536);record=json.loads(raw);state=Path(record['upgradeState'])
    need(state.parent==STATES and re.fullmatch('commit-'+b['sourceHead'][:12]+'-[0-9]+',state.name),'ACTIVE_STATE_REQUIRED')
    saved=M.protected(state/'protected-plan.json');need(sha(saved)==record['privatePlanSha256'],'ACTIVE_PLAN_DRIFT');plan=C.decode_private(json.loads(saved))
    need(plan['binding']==b,'ACTIVE_BINDING_DRIFT')
    for name in ('old','candidate'):plan[name]=D.artifact(plan[name]['directory'],ROOT)
    backup=json.loads(M.protected(state/'predeploy-database/snapshot-private.json'));H.S.validate_snapshot(backup,state,plan['operationReference'])
    need(sha(M.protected(state/'predeploy-database/snapshot-private.json'))==plan['snapshotReceiptSha256'],'SNAPSHOT_DRIFT')
    verify(plan,True,raw);M.running(plan);M.public_contract(plan);journal(plan,[plan['candidate']['manifest']['migrations']])
    return {**record,'readOnly':True,'activeVerified':True}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=('stage','preflight','apply','active'),default='preflight',nargs='?')
    p.add_argument('--binding',type=Path,required=True);p.add_argument('--binding-sha256',required=True);p.add_argument('--operation-reference');a=p.parse_args()
    try:
        app=load();b=binding(a.binding,a.binding_sha256)
        fd=os.open('/run/lock/cisme-production-trial.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(fd);need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600,'LOCK_REQUIRED');fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            result=stage(b,app)if a.action=='stage'else apply(b,app,a.operation_reference)if a.action=='apply'else active(b)if a.action=='active'else {'readOnly':True,'sourceHead':preflight(b,app)['binding']['sourceHead']}
        finally:os.close(fd)
        print(json.dumps(result,sort_keys=True));return 0
    except Exception as error:
        code=str(error);code=code if re.fullmatch('[A-Z0-9_]{4,160}',code)else'PROFILE_REVIEW_REQUIRED'
        print(json.dumps({'ok':False,'code':code,'privateValuesExported':False}));return 1
if __name__=='__main__':raise SystemExit(main())
