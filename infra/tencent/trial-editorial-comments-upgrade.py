#!/usr/bin/env python3
"""Exact isolated-trial45091/schema98 -> editorial comments/schema99 upgrade.

Default is read-only. Old operators and their metadata remain historical.
No production switch, database restore/down, credentials or business writes.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import types
import urllib.request
from urllib.parse import unquote,urlsplit

sys.dont_write_bytecode=True
ROOT=Path('/opt/cisme-trial')
OWNER=0
BASELINE_HEAD='45091a1259c2731eda21db7c367dff28513472bd'
BASELINE_TREE='e367fb91ca0f0442226271e055bb37af8b8b38e7'
BASELINE_MANIFEST='42d5df695132e1cf47668b5193823a900f3a8070ee1a0b3a6d1319833f56a61e'
BASELINE_ARCHIVE='2a9c2faad2a7a8c344bf9cb2fac985e19261b59037ff97aeb2182213e6692b04'
BASELINE_INDEX='c12f038a7cdf1e5d54197b2891fb7ab50f167cdeea0db3fe30f466de69a47522'
BASELINE_RUNNER=ROOT/'xhs-operator-runners'/BASELINE_HEAD[:12]
BASELINE_HELPER_SHA='1209a10685e9d85d1f9104d7f5cff0300bbbe012be61163f31188c650143b0e3'
BASELINE_BINDING_SHA='9510fb0828657558859cafe5825122f747239081d24fb5ddc9de98d2df1f3c7a'
DEPENDENCIES='d9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
SOURCE_PACKAGE='c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
SOURCE_LOCK='2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
MIGRATION='202610280001_editorial_comments.sql'
MIGRATION_SHA='cd945b213a0c546d27ff2a1ef6e7d1a90a232ec25d680415d45aa7113c64f3c1'
ACTIVE_NAME='editorial-comments-active-release.json'
STATE_PARENT=ROOT/'editorial-comment-upgrades'
STAGES=Path('/var/lib/cisme-dependency-stage')
NODE='/opt/node-v24.14.0-linux-x64/bin/node'
APP_ID='wx4eac2d4fb11d299b'
CLEAN={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}
N=A=D=None

class Refused(RuntimeError):pass

def need(value,code='COMMENTS_UPGRADE_REFUSED'):
    if not value:raise Refused(code)

def sha(data):return hashlib.sha256(data).hexdigest()

def unique(pairs):
    value={}
    for key,item in pairs:
        need(key not in value,'COMMENTS_DUPLICATE_JSON_KEY');value[key]=item
    return value

def parse(raw):return json.loads(raw,object_pairs_hook=unique)

def fixed_profile(profile):
    need(profile=={'root':'/opt/cisme-trial','user':'cisme-trial','database':'cisme_trial','domain':'staging-api.cisme.cn',
      'units':('cisme-trial-api.service','cisme-trial-worker.service'),'lock':'/run/lock/cisme-production-trial.lock','name':'trial'},'COMMENTS_TRIAL_ONLY')

def load_primitives(require_baseline=False):
    global N,A,D
    need(os.geteuid()==OWNER,'COMMENTS_ROOT_REQUIRED')
    path=BASELINE_RUNNER/'trial-no-schema-upgrade.py'
    raw=read(path,128*1024,True);need(sha(raw)==BASELINE_HELPER_SHA,'COMMENTS_PINNED_BASELINE_HELPER_REQUIRED')
    N=types.ModuleType('reviewed_comments_baseline');N.__file__=str(path)
    exec(compile(raw,str(path),'exec'),N.__dict__)
    old_binding=N.binding(BASELINE_RUNNER/'application-binding.json',BASELINE_BINDING_SHA)
    if require_baseline:
        context=N.active_context(old_binding)
        A,D=context['A'],context['D']
        need(context['binding']['sourceHead']==BASELINE_HEAD and context['binding']['sourceTree']==BASELINE_TREE,'COMMENTS_45091_BASELINE_REQUIRED')
        return context
    # This only loads pinned primitives. The old98 active_context/preflight is
    # intentionally NEVER invoked by this module's post99 active guard.
    owner,owner_binding=N.owner_module();A=owner.load_helper(owner_binding);D=A.D
    return None

def validate_binding(b):
    need(b.get('schemaVersion')==1 and b.get('kind')=='trial-editorial-comments-upgrade'
      and b.get('baselineHead')==BASELINE_HEAD and b.get('baselineTree')==BASELINE_TREE,'COMMENTS_BASELINE_BINDING_REQUIRED')
    need(all(re.fullmatch(r'[0-9a-f]{40}',b.get(k) or '') and b[k]!='0'*40 for k in ('sourceHead','sourceTree'))
      and b['sourceHead']!=BASELINE_HEAD and type(b.get('ciRunId'))is int and b['ciRunId']>0,'COMMENTS_EXACT_MAIN_REQUIRED')
    need(all(re.fullmatch(r'[0-9a-f]{64}',b.get(k) or '') for k in
      ('helperSha256','manifestSha256','archiveSha256','stageReceiptSha256','compatibilitySha256'))
      and type(b.get('archiveBytes'))is int and 0<b['archiveBytes']<=512*1024**2,'COMMENTS_FINAL_INPUTS_REQUIRED')
    need(b.get('dependenciesSha256')==DEPENDENCIES and b.get('migrations')==99 and b.get('migrationSha256')==MIGRATION_SHA,'COMMENTS_ONLY_SQL99_REQUIRED')
    need(sha(read(Path(__file__),128*1024,True))==b['helperSha256'],'COMMENTS_EXACT_HELPER_REQUIRED')
    return b

def binding(path,expected):
    need(re.fullmatch(r'[0-9a-f]{64}',expected or ''),'COMMENTS_BINDING_SHA_REQUIRED')
    raw=read(path,65536,True);need(sha(raw)==expected,'COMMENTS_BINDING_HASH_MISMATCH')
    return validate_binding(parse(raw))

def artifact_contract(old,candidate,b):
    before,after=old['manifest'],candidate['manifest']
    need(before.get('sourceHead')==BASELINE_HEAD and before.get('sourceTree')==BASELINE_TREE
      and old['manifestSha256']==BASELINE_MANIFEST,'COMMENTS_45091_ARTIFACT_REQUIRED')
    need(after.get('sourceHead')==b['sourceHead'] and after.get('sourceTree')==b['sourceTree']
      and candidate['manifestSha256']==b['manifestSha256'] and after.get('sourceLockSha256')==SOURCE_LOCK
      and after.get('node')=='v24.14.0' and after.get('buildPlatform')=={'os':'linux','arch':'x64','libc':'glibc'}
      and all(after.get(k)is False for k in ('configurationIncluded','deployed','releaseReady')),'COMMENTS_EXACT_LINUX_ARTIFACT_REQUIRED')
    prior=before.get('migrations',[])
    need(len(prior)==98 and prior==sorted(set(prior)) and prior[-1]=='202610260001_owned_editorial.sql'
      and after.get('migrations')==prior+[MIGRATION] and old['directory']!=candidate['directory'],'COMMENTS_EXACT_98_PLUS_99_REQUIRED')
    names=['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+name for name in prior]
    need(all(old['files'].get(name)==candidate['files'].get(name) and old['files'].get(name) for name in names),'COMMENTS_OLD_SQL_OR_DEPENDENCY_BYTES_CHANGED')
    need(sha(candidate['files'].get('db/migrations/'+MIGRATION,b''))==MIGRATION_SHA,'COMMENTS_SQL99_HASH_REQUIRED')
    need(old['dependenciesSha256']==candidate['dependenciesSha256']==DEPENDENCIES,'COMMENTS_FULL_DEPENDENCY_TREE_CHANGED')

def github_source(name,head):
    need(name in ('package.json','package-lock.json','scripts/release-migrate.mjs','db/migrations/'+MIGRATION)
      and re.fullmatch(r'[0-9a-f]{40}',head or ''),'COMMENTS_SOURCE_PATH_REQUIRED')
    req=urllib.request.Request('https://raw.githubusercontent.com/'+D.general.REPO+'/'+head+'/'+name,
      headers={'Cache-Control':'no-cache','User-Agent':'cisme-editorial-comments-preflight'})
    with urllib.request.build_opener(D.general.observe.NoRedirect()).open(req,timeout=12) as response:
        need(response.status==200,'COMMENTS_SOURCE_UNAVAILABLE')
        length=response.headers.get('Content-Length');limit=1024*1024
        need(length is None or re.fullmatch(r'[0-9]+',length),'COMMENTS_SOURCE_LENGTH_REQUIRED')
        expected=int(length)if length is not None else None
        need(expected is None or 0<expected<=limit,'COMMENTS_SOURCE_SIZE_REFUSED')
        raw=bytearray()
        while chunk:=response.read(min(65536,limit+1-len(raw))):
            raw.extend(chunk);need(len(raw)<=limit,'COMMENTS_SOURCE_TOO_LARGE')
        need(raw and (expected is None or len(raw)==expected),'COMMENTS_SOURCE_TRUNCATED')
    return bytes(raw)

def source_permit(b,candidate,main):
    need(main.get('sha')==b['sourceHead'] and main.get('tree')==b['sourceTree'] and main.get('ciRunId')==b['ciRunId'],'COMMENTS_LATEST_MAIN_PUSH_CI_REQUIRED')
    need(sha(github_source('package.json',b['sourceHead']))==SOURCE_PACKAGE and sha(github_source('package-lock.json',b['sourceHead']))==SOURCE_LOCK,'COMMENTS_SOURCE_DEPENDENCY_INPUT_CHANGED')
    for local,source in [('migrate.mjs','scripts/release-migrate.mjs'),('db/migrations/'+MIGRATION,'db/migrations/'+MIGRATION)]:
        need(candidate['files'][local]==github_source(source,b['sourceHead']),'COMMENTS_SOURCE_BYTES_MISMATCH')
    value=parse(D.command([NODE,str(Path(candidate['directory'])/'migrate.mjs'),'verify']))
    need(value.get('verified')is True and value.get('sourceHead')==b['sourceHead'] and value.get('sourceTree')==b['sourceTree']
      and value.get('migrations')==99,'COMMENTS_COMPLETE_ARTIFACT_REQUIRED')

def stage_binding(b,candidate):
    path=Path(b.get('stageReceipt',''))
    need(path.name=='stage-receipt.json' and path.parent.parent==STAGES,'COMMENTS_REVIEWED_STAGE_REQUIRED')
    raw=read(path,65536,True);need(sha(raw)==b['stageReceiptSha256'],'COMMENTS_STAGE_RECEIPT_DRIFT');r=parse(raw)
    need(r.get('staged')is True and r.get('deployed')is False and r.get('instanceId')=='lhins-61ikz4mi' and r.get('publicIpv4')=='124.223.74.198'
      and r.get('sourceHead')==b['sourceHead'] and r.get('sourceTree')==b['sourceTree'] and r.get('archiveSha256')==b['archiveSha256']
      and r.get('archiveSize')==b['archiveBytes'] and r.get('manifestSha256')==b['manifestSha256'] and r.get('dependenciesSha256')==DEPENDENCIES
      and r.get('migrations')==99 and r.get('privateStage')==str(path.parent) and r.get('candidateDirectories')==[candidate['directory']]
      and all(r.get(k)is False for k in ('servicesChanged','databaseChanged','configurationChanged','productionChanged','peerFilesChanged')),'COMMENTS_STAGE_BINDING_MISMATCH')
    archive=read(path.parent/'archive.tar.gz',512*1024**2,True)
    need(len(archive)==b['archiveBytes'] and sha(archive)==b['archiveSha256'],'COMMENTS_ARCHIVE_MISMATCH')
    return str(path)

def compatibility(b,old):
    path=Path(b.get('compatibilityReceipt',''));stage=Path(b['stageReceipt']).parent
    need(path.parent==stage and path.name=='rollback-compatibility.json','COMMENTS_COMPATIBILITY_PATH_REQUIRED')
    raw=read(path,65536,True);need(sha(raw)==b['compatibilitySha256'],'COMMENTS_COMPATIBILITY_HASH_REQUIRED');r=parse(raw)
    expected={'schemaVersion':1,'kind':'trial-baseline-schema99-compatibility','baselineHead':BASELINE_HEAD,'baselineTree':BASELINE_TREE,
      'baselineManifestSha256':BASELINE_MANIFEST,'baselineArchiveSha256':BASELINE_ARCHIVE,'indexSha256':old['manifest']['hashes']['index.js'],
      'dependenciesSha256':DEPENDENCIES,'migrationSha256':MIGRATION_SHA,'node':'v24.14.0','platform':{'os':'linux','arch':'x64','libc':'glibc'}}
    need(all(r.get(k)==v for k,v in expected.items()) and r.get('indexSha256')==BASELINE_INDEX
      and all(r.get(k)is True for k in ('actualLinuxArtifactExecuted','disposableDatabase','passed'))
      and all(r.get('checks',{}).get(k)is True for k in ('healthReady','currentLegal','articles','imageMedia','videoMedia','existingReactions')),'COMMENTS_ACTUAL_BASELINE_AT_99_COMPATIBILITY_REQUIRED')
    return r

def database_guard(profile,config,ownership,allowed,drain=False):
    fixed_profile(profile);safe,settings=D.general.observe.audit.database(config.get('DATABASE_URL',''))
    need(safe['databaseName']==safe['role']=='cisme_trial' and safe['host']=='127.0.0.1' and safe['port']==5432,'COMMENTS_TRIAL_ROLE_REQUIRED')
    D.trial.db_owned(ownership)
    actual=parse(D.command(['/usr/bin/psql','-XAt','-v','ON_ERROR_STOP=1','-d','cisme_trial','-c',
      "SELECT json_build_object('database',current_database(),'role',current_user)"],env={**CLEAN,**settings,'PGCONNECT_TIMEOUT':'3','PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=10000'}))
    need(actual=={'database':'cisme_trial','role':'cisme_trial'},'COMMENTS_ACTUAL_DATABASE_ROLE_REQUIRED')
    denied=subprocess.run(['/usr/bin/psql','-XAt','-v','ON_ERROR_STOP=1','-d','cisme','-c','SELECT true'],
      env={**CLEAN,**settings,'PGCONNECT_TIMEOUT':'3','PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=3000'},capture_output=True,timeout=5)
    need(denied.returncode!=0 and not denied.stdout and (b'pg_hba.conf rejects connection'in denied.stderr or b'permission denied for database'in denied.stderr),'COMMENTS_CROSS_DATABASE_REJECTION_REQUIRED')
    facts=D.database_facts(profile)
    need(facts.get('database')==facts.get('owner')=='cisme_trial' and facts.get('journal')in allowed
      and (not drain or facts.get('otherClients')==0),'COMMENTS_JOURNAL_OR_DRAIN_DRIFT')
    return facts['journal']

def schema99(profile):
    names=['editorial_comment','editorial_comment_like','editorial_comment_policy','editorial_comment_report','editorial_comment_safety_scan','editorial_comment_scan_claim']
    value=D.query(profile,"SELECT json_build_object('tables',(SELECT json_agg(c.relname ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ("+','.join("'"+name+"'"for name in names)+")), 'ownersSafe',NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'editorial_comment%' AND pg_get_userbyid(c.relowner)<>'cisme_trial'), 'threadTrigger',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='editorial_comment'::regclass AND tgname='editorial_comment_thread' AND tgenabled='O'), 'safetyTrigger',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='editorial_comment_safety_scan'::regclass AND tgname='editorial_comment_safety_immutable' AND tgenabled='O'))")
    need(value.get('tables')==sorted(names) and all(value.get(k)is True for k in ('ownersSafe','threadTrigger','safetyTrigger')),'COMMENTS_SCHEMA99_OBJECTS_REQUIRED')

def optional_private(path):
    return read(path,8*1024**2,True)if path.exists()or path.is_symlink()else None

def encode_private(value):
    if isinstance(value,bytes):return {'__cisme_bytes_v1':base64.b64encode(value).decode()}
    if isinstance(value,tuple):return {'__cisme_tuple_v1':[encode_private(item)for item in value]}
    if isinstance(value,list):return [encode_private(item)for item in value]
    if isinstance(value,dict):
        need(not any(key in value for key in ('__cisme_bytes_v1','__cisme_tuple_v1')),'COMMENTS_PRIVATE_CODEC_RESERVED_KEY')
        return {key:encode_private(item)for key,item in value.items()}
    need(value is None or type(value)in(str,int,bool,float),'COMMENTS_PRIVATE_CODEC_TYPE_REFUSED')
    return value

def decode_private(value):
    if isinstance(value,list):return [decode_private(item)for item in value]
    if isinstance(value,dict):
        if set(value)=={'__cisme_bytes_v1'}:return base64.b64decode(value['__cisme_bytes_v1'],validate=True)
        if set(value)=={'__cisme_tuple_v1'}:return tuple(decode_private(item)for item in value['__cisme_tuple_v1'])
        need(not any(key in value for key in ('__cisme_bytes_v1','__cisme_tuple_v1')),'COMMENTS_PRIVATE_CODEC_INVALID')
        return {key:decode_private(item)for key,item in value.items()}
    return value

def save_plan(plan,state):
    saved=dict(plan)
    for label in ('old','candidate'):saved[label]={key:value for key,value in plan[label].items()if key!='files'}
    raw=(json.dumps(encode_private(saved),sort_keys=True)+'\n').encode()
    need(len(raw)<=8*1024**2,'COMMENTS_PRIVATE_PLAN_TOO_LARGE')
    D.general.store(state/'protected-plan.json',raw)
    return sha(raw)

def verify_history(plan,active_allowed=()):
    need(read(ROOT/'dependency-active-release.json',private=True)==plan['dependencyActiveBytes']
      and read(ROOT/'application-active-release.json',private=True)==plan['applicationActiveBytes'],'COMMENTS_HISTORICAL_ACTIVE_DRIFT')
    need(optional_private(ROOT/ACTIVE_NAME)in(active_allowed or(None,)),'COMMENTS_UNKNOWN_ACTIVE_RECORD_DRIFT')

def verify_context(plan,provenance=True,candidate_allowed=False,active_allowed=(),exact_production_pids=True):
    fixed_profile(plan['profile']);D.verify_context(plan,provenance=provenance,allow_candidate=candidate_allowed)
    verify_history(plan,active_allowed);production_preserved(plan['production'],exact_production_pids)
    six_keys(plan['config'],plan['production']['config'])
    need(sha(read(Path(plan['stageReceipt']),65536,True))==plan['binding']['stageReceiptSha256'],'COMMENTS_STAGE_RECEIPT_DRIFT')
    compatibility(plan['binding'],plan['old'])
    need(article_fence(plan['profile'])==plan['articleFence'],'COMMENTS_EXISTING_ARTICLE_FACTS_DRIFT')

def preflight(b):
    context=load_primitives(True);profile,config=context['profile'],context['config'];fixed_profile(profile)
    need(optional_private(ROOT/ACTIVE_NAME)is None,'COMMENTS_EXISTING_UPGRADE_RECORD_REFUSED')
    need(config.get('APP_ENV')=='staging' and config.get('WECHAT_APP_ID')==APP_ID and D.closed_context(profile,config)
      and config.get('WECHAT_PHONE_BINDING_ENABLED','false')=='false' and config.get('COS_DIRECT_UPLOAD_ENABLED','false')=='false','COMMENTS_CLOSED_TRIAL_REQUIRED')
    old=D.artifact(str(context['release']),ROOT)
    candidate=D.artifact(str(ROOT/'releases'/('tencent-release-'+b['sourceHead'][:12])),ROOT)
    artifact_contract(old,candidate,b);main=D.general.reviewed_main();source_permit(b,candidate,main)
    stage=stage_binding(b,candidate);compatibility(b,old)
    initial={name:read(ROOT/name,private=True)for name in ('ownership.json','empty-database.json','migration-complete.json')}
    ownership=parse(initial['ownership.json']);production=production_capture();six_keys(config,production['config'])
    database_guard(profile,config,ownership,[old['manifest']['migrations']])
    # This snapshot covers all current articles, not the obsolete pre-migration6.
    fence=article_fence(profile);need(fence.get('publishedCount')==20,'COMMENTS_CURRENT_20_ARTICLES_REQUIRED')
    units={unit:D.read_owned(D.unit_path(unit))for unit in profile['units']}
    dropins={unit:D.dropin_inputs(unit)for unit in profile['units']}
    definitions={unit:D.unit_definition(unit,units[unit],entry,profile,dropins[unit])for unit,entry in zip(profile['units'],('index.js','worker.js'))}
    versions=D.native_smoke(profile,candidate['directory'],True)
    need(versions==D.native_smoke(profile,old['directory'],True),'COMMENTS_NATIVE_RUNTIME_CHANGED')
    return {'profile':profile,'main':main,'old':old,'candidate':candidate,'env':read(ROOT/'runtime.env',private=False),'config':config,
      'environmentMetadata':D.environment_metadata(profile),'privateInputs':D.private_inputs(profile,config),
      'units':units,'dropIns':dropins,'unitDefinitions':definitions,'ownership':ownership,'initialRecords':initial,
      'dependencyActiveBytes':read(ROOT/'dependency-active-release.json',private=True),
      'applicationActiveBytes':read(ROOT/'application-active-release.json',private=True),'production':production,
      'articleFence':fence,'stageReceipt':stage,'binding':b,'versions':versions}

def journal(plan,allowed,drain=False):
    return database_guard(plan['profile'],plan['config'],plan['ownership'],allowed,drain)

def public_contract(plan,with_comments):
    profile=plan['profile']
    def get(path):
        raw=D.command(['/usr/bin/curl','--fail','--silent','--noproxy','*','--connect-timeout','3','--max-time','8','--proto','=https',
          '--resolve',profile['domain']+':443:127.0.0.1','https://'+profile['domain']+path])
        need(len(raw)<=256*1024,'COMMENTS_PUBLIC_RESPONSE_TOO_LARGE');return parse(raw)
    capabilities=get('/v1/capabilities')
    need(all(capabilities.get(key)is False for key in ('communityPreviewEnabled','socialPreviewEnabled','ugcGoLiveGate','pointsRedemptionEnabled','pointsRulesEnabled','directMediaUploadEnabled')),'COMMENTS_UNRELATED_CAPABILITIES_OPENED')
    legal=get('/v1/legal');need(legal.get('ready')is True and all(any(d.get('document_type')==kind for d in legal.get('documents',[]))for kind in ('terms','privacy')),'COMMENTS_LEGAL_NOT_READY')
    if with_comments:
        item=get('/v1/editorial/articles?limit=1').get('items',[])
        need(len(item)==1 and re.fullmatch(r'[0-9a-f-]{36}',item[0].get('id','')),'COMMENTS_EXISTING_ARTICLE_NOT_READABLE')
        response=get('/v1/editorial/articles/'+item[0]['id']+'/comments?limit=1')
        need(type(response.get('commentsEnabled'))is bool and type(response.get('commentCount'))is int and response['commentCount']>=0
          and isinstance(response.get('comments'),list),'COMMENTS_PUBLIC_COMMENT_CONTRACT_FAILED')

def migrate(plan,backup,state,approval):
    validate_snapshot(backup,state,approval)
    journal(plan,[plan['old']['manifest']['migrations']],True)
    D.command(['/usr/sbin/runuser','-u','cisme-trial','--',NODE,str(Path(plan['candidate']['directory'])/'migrate.mjs'),'up'],
      env={**CLEAN,**plan['config'],'CISME_MIGRATION_APPROVAL_REF':approval,'CISME_PREDEPLOY_BACKUP_REF':backup['backupReference']},cwd=ROOT,timeout=180)
    journal(plan,[plan['candidate']['manifest']['migrations']],True);schema99(plan['profile'])

def active_record(plan,state,plan_sha,selected,migrations,rollback=False):
    return (json.dumps({'schemaVersion':1,'kind':'trial-editorial-comments-active-release','environment':'trial','instanceId':'lhins-61ikz4mi',
      'database':'cisme_trial','sourceHead':selected['manifest']['sourceHead'],'sourceTree':selected['manifest']['sourceTree'],
      'directory':selected['directory'],'manifestSha256':selected['manifestSha256'],'dependenciesSha256':DEPENDENCIES,
      'ownershipId':plan['ownership']['ownershipId'],'upgradeState':str(state),'privatePlanSha256':plan_sha,
      'baselineHead':BASELINE_HEAD,'migrationCount':len(migrations),'schemaChanged':len(migrations)==99,
      'applicationRollback':rollback,'databaseRestored':False,'initialAndDependencyHistoryPreserved':True},sort_keys=True)+'\n').encode()

def cutover(plan,state,approval):
    fixed_profile(plan['profile']);plan_sha=save_plan(plan,state);halted=False;published=None
    old_sql,new_sql=plan['old']['manifest']['migrations'],plan['candidate']['manifest']['migrations']
    try:
        verify_context(plan);journal(plan,[old_sql]);halted=True
        D.command(['systemctl','stop',*plan['profile']['units']],timeout=90);D.stopped(plan['profile'])
        verify_context(plan,provenance=False);journal(plan,[old_sql],True)
        backup=snapshot(plan,state,approval);validate_snapshot(backup,state,approval)
        verify_context(plan);migrate(plan,backup,state,approval)
        verify_context(plan,provenance=False);journal(plan,[new_sql],True)
        D.switch(plan,plan['candidate']['directory']);D.verify_units(plan,allow_candidate=True);verify_history(plan)
        started=time.time();D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
        versions=D.healthy(plan,plan['candidate']['directory'],started,True);public_contract(plan,True)
        verify_context(plan,candidate_allowed=True);journal(plan,[new_sql]);schema99(plan['profile'])
        published=active_record(plan,state,plan_sha,plan['candidate'],new_sql)
        D.atomic_bytes(ROOT/ACTIVE_NAME,published)
        verify_context(plan,provenance=False,candidate_allowed=True,active_allowed=(published,));journal(plan,[new_sql])
        report={'deployed':True,'environment':'trial','sourceHead':plan['main']['sha'],'migrationCountBefore':98,'migrationCountAfter':99,
          'snapshotAuthenticated':True,'snapshotScope':'same-host-database-only','fullRecoveryQualified':False,'databaseRestored':False,
          'versions':versions,'existing20ArticlesPreserved':True,'configurationChanged':False,'credentialsChanged':False,
          'productionChanged':False,'businessDataSeeded':False,'consentCreated':False,'authorityGranted':False}
        D.general.store(state/'deployed.json',(json.dumps(report,sort_keys=True)+'\n').encode());return report
    except Exception:
        if not halted:raise
        try:
            D.command(['systemctl','stop',*plan['profile']['units']],timeout=90);D.stopped(plan['profile'])
            verify_context(plan,provenance=False,candidate_allowed=True,active_allowed=(published,)if published else())
            actual=journal(plan,[old_sql,new_sql],True)
            if actual==new_sql:schema99(plan['profile'])
            # Neither DDL nor new comments are reversed. Only known app units
            # are restored, and only after every unknown drift check above.
            D.switch(plan,plan['old']['directory']);D.verify_units(plan)
            started=time.time();D.command(['systemctl','start',*plan['profile']['units']],timeout=60)
            D.healthy(plan,plan['old']['directory'],started,True);public_contract(plan,False)
            verify_context(plan,provenance=False,active_allowed=(published,)if published else());journal(plan,[actual])
            restored=active_record(plan,state,plan_sha,plan['old'],actual,True)
            D.atomic_bytes(ROOT/ACTIVE_NAME,restored)
            verify_context(plan,provenance=False,active_allowed=(restored,));journal(plan,[actual])
            D.general.store(state/'application-rollback.json',(json.dumps({'applicationRestored':True,'databaseRestored':False,'migrationCount':len(actual),'downMigrationExecuted':False})+'\n').encode())
        except Exception:
            stopped=False
            try:D.command(['systemctl','stop',*plan['profile']['units']],timeout=90);D.stopped(plan['profile']);stopped=True
            except Exception:pass
            D.general.store(state/'manual-recovery-required.json',(json.dumps({'servicesStopped':stopped,'unknownInputsOverwritten':False,'databaseRestored':False})+'\n').encode())
            raise Refused('COMMENTS_FAILED_FENCED_REVIEW_REQUIRED')from None
        raise Refused('COMMENTS_FAILED_45091_APP_RESTORED_SCHEMA_RETAINED')from None

def active_context(b):
    """Independent post99 guard. Old98 active_context is not called here."""
    validate_binding(b);load_primitives(False)
    identity=D.general.observe.identity();need(identity.get('instanceId')=='lhins-61ikz4mi' and identity.get('publicIpv4')=='124.223.74.198','COMMENTS_EXACT_INSTANCE_REQUIRED')
    raw=read(ROOT/ACTIVE_NAME,65536,True);active=parse(raw);state=Path(active.get('upgradeState',''))
    need(state.parent==STATE_PARENT and re.fullmatch(r'main-'+b['sourceHead'][:12]+r'-[0-9]+',state.name),'COMMENTS_ACTIVE_STATE_PATH_REQUIRED')
    plan_raw=read(state/'protected-plan.json',8*1024**2,True)
    need(sha(plan_raw)==active.get('privatePlanSha256'),'COMMENTS_PRIVATE_PLAN_DRIFT')
    plan=decode_private(parse(plan_raw));need(plan.get('binding')==b,'COMMENTS_ACTIVE_BINDING_DRIFT')
    fixed_profile(plan['profile'])
    old=D.artifact(plan['old']['directory'],ROOT);candidate=D.artifact(plan['candidate']['directory'],ROOT)
    artifact_contract(old,candidate,b)
    expected=active_record(plan,state,sha(plan_raw),candidate,candidate['manifest']['migrations'])
    need(raw==expected,'COMMENTS_NEW_ACTIVE_RELEASE_REQUIRED')
    verify_context(plan,provenance=False,candidate_allowed=True,active_allowed=(raw,),exact_production_pids=False)
    for unit,entry in zip(plan['profile']['units'],('index.js','worker.js')):
        need(D.unit_entry(D.read_owned(D.unit_path(unit)),entry,plan['profile'])==Path(candidate['directory']),'COMMENTS_ACTIVE_UNIT_PATH_REQUIRED')
    D.running(plan['profile'],candidate['directory'],plan['config'])
    journal(plan,[candidate['manifest']['migrations']]);schema99(plan['profile'])
    return {'A':A,'D':D,'profile':plan['profile'],'config':plan['config'],'release':Path(candidate['directory']),'binding':b}

def apply(b,approval):
    need(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}',approval or ''),'COMMENTS_OPERATION_REFERENCE_REQUIRED')
    need(os.geteuid()==OWNER,'COMMENTS_ROOT_REQUIRED');path=Path('/run/lock/cisme-production-trial.lock')
    parent=path.parent.lstat();need(stat.S_ISDIR(parent.st_mode)and parent.st_uid==0 and stat.S_IMODE(parent.st_mode)==0o1777,'COMMENTS_LOCK_PARENT_REQUIRED')
    fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd);need(stat.S_ISREG(info.st_mode)and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1,'COMMENTS_LOCK_REQUIRED')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);plan=preflight(b)
        STATE_PARENT.mkdir(mode=0o700,exist_ok=True);D.owned_directory(STATE_PARENT,True)
        marker=STATE_PARENT/('comments-'+b['sourceHead'][:12]+'.started.json')
        out=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(out,'wb')as stream:
            stream.write((json.dumps({'sourceHead':b['sourceHead'],'operationReference':approval},sort_keys=True)+'\n').encode());stream.flush();os.fsync(stream.fileno())
        state=STATE_PARENT/('main-'+b['sourceHead'][:12]+'-'+str(time.time_ns()));state.mkdir(mode=0o700)
        return cutover(plan,state,approval)
    finally:os.close(fd)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=('preflight','apply','active'),nargs='?',default='preflight')
    parser.add_argument('--binding',type=Path,required=True);parser.add_argument('--binding-sha256',required=True);parser.add_argument('--operation-reference')
    args=parser.parse_args()
    try:
        b=binding(args.binding,args.binding_sha256)
        if args.action=='apply':result=apply(b,args.operation_reference)
        elif args.action=='active':
            active_context(b);result={'readOnly':True,'activeVerified':True,'sourceHead':b['sourceHead'],'migrationCount':99,'privateValuesExported':False}
        else:
            plan=preflight(b);result={'readOnly':True,'deployed':False,'sourceHead':plan['main']['sha'],'migrationCountBefore':98,'migrationCountAfter':99,
              'sameHostSnapshotNotYetCreated':True,'productionPreserved':True,'rollbackCompatibilityVerified':True,'privateValuesExported':False}
        print(json.dumps(result,sort_keys=True));return 0
    except Exception as error:
        value=str(error)if isinstance(error,Refused)else''
        print(json.dumps({'ok':False,'code':value if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}',value)else'COMMENTS_REVIEW_REQUIRED','privateValuesExported':False}));return 1



def parents(path, private=False):
    need(path.is_absolute() and '..' not in path.parts, 'NO_SCHEMA_ABSOLUTE_PATH_REQUIRED')
    for parent in reversed(path.parents):
        st = parent.lstat()
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == OWNER and not st.st_mode & 0o022,
             'NO_SCHEMA_ROOT_PROTECTED_PARENT_REQUIRED')
    if private:
        # These root-only records share the service-traversable application root.
        # Their bytes still require a single-link, root-owned 0600 file in read().
        # Every ancestor must remain root-owned and non-writable by other users.
        root_record = path.parent == ROOT and path.name in (
            'application-active-release.json', 'dependency-active-release.json', ACTIVE_NAME,
            'ownership.json', 'empty-database.json', 'migration-complete.json')
        allowed_modes = (0o700, 0o750, 0o755) if root_record else (0o700,)
        need(stat.S_IMODE(path.parent.lstat().st_mode) in allowed_modes,
             'NO_SCHEMA_PRIVATE_PARENT_REQUIRED')


def read(path, limit=1024*1024, private=False):
    parents(path, private)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == OWNER and st.st_nlink == 1
             and not st.st_mode & (0o077 if private else 0o022) and 0 < st.st_size <= limit,
             'NO_SCHEMA_ROOT_PROTECTED_FILE_REQUIRED')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'NO_SCHEMA_FILE_TOO_LARGE')
        after = os.fstat(fd)
        need(len(data) == st.st_size and (after.st_size,after.st_mtime_ns,after.st_ctime_ns)
             == (st.st_size,st.st_mtime_ns,st.st_ctime_ns), 'NO_SCHEMA_FILE_CHANGED')
        return bytes(data)
    finally: os.close(fd)


def production_capture():
    p = {**D.PROFILES['production'],'name':'production'}
    cfg_bytes = D.read_owned(Path(p['root'])/'runtime.env', private=True)
    cfg = D.general.observe.audit.environment(cfg_bytes.decode())
    unit_bytes = {u:D.read_owned(D.unit_path(u)) for u in p['units']}
    dirs = {D.unit_entry(unit_bytes[u], e, p) for u,e in zip(p['units'],('index.js','worker.js'))}
    need(len(dirs) == 1, 'NO_SCHEMA_PRODUCTION_RELEASE_SPLIT')
    release = D.artifact(dirs.pop(), Path(p['root']))
    need(release['manifest'].get('sourceHead') == 'dbd2b88a47f622621c2b226b03339677b183fef8'
         and release['manifest'].get('sourceTree') == '7ced9ed2248a1e27a9f30f2995badab21fdddf79'
         and release['manifestSha256'] == '9dbf6789d5ab3e632929ae81e26180540786db7dbb8863354432e35772a18e00'
         and len(release['manifest']['migrations']) == 97 and release['dependenciesSha256'] == DEPENDENCIES,
         'NO_SCHEMA_PRODUCTION_BASELINE_REQUIRED')
    need(cfg.get('APP_ENV') == 'production' and D.closed_context(p,cfg)
         and cfg.get('WECHAT_PHONE_BINDING_ENABLED','false') == 'false', 'NO_SCHEMA_PRODUCTION_CONTEXT_REQUIRED')
    facts=D.database_facts(p)
    need(facts.get('database') == facts.get('owner') == 'cisme'
         and facts.get('journal') == release['manifest']['migrations'], 'NO_SCHEMA_PRODUCTION_DATABASE_REQUIRED')
    dropins={u:D.dropin_inputs(u) for u in p['units']}
    definitions={u:D.unit_definition(u,unit_bytes[u],entry,p,dropins[u])
                 for u,entry in zip(p['units'],('index.js','worker.js'))}
    return {'profile':p,'env':cfg_bytes,'config':cfg,'environmentMetadata':D.environment_metadata(p),
        'units':unit_bytes,'dropIns':dropins,'unitDefinitions':definitions,
        'privateInputs':D.private_inputs(p,cfg),'directory':release['directory'],
        'manifestBytes':D.read_owned(Path(release['directory'])/'release-manifest.json'),
        'activeBytes':D.read_owned(Path(p['root'])/'dependency-active-release.json',private=True),
        'journal':facts['journal'],'pids':D.running(p,release['directory'],cfg)}


def production_preserved(old, exact_pids=True):
    p = old['profile']; root = Path(p['root'])
    need(D.read_owned(root/'runtime.env',private=True) == old['env']
         and D.environment_metadata(p) == old['environmentMetadata']
         and D.private_inputs(p,old['config']) == old['privateInputs']
         and D.read_owned(root/'dependency-active-release.json',private=True) == old['activeBytes']
         and D.read_owned(Path(old['directory'])/'release-manifest.json') == old['manifestBytes']
         and (D.running(p,old['directory'],old['config']) == old['pids'] if exact_pids else bool(D.running(p,old['directory'],old['config']))), 'NO_SCHEMA_PRODUCTION_DRIFT')
    for u,entry in zip(p['units'],('index.js','worker.js')):
        need(D.read_owned(D.unit_path(u)) == old['units'][u] and D.dropin_inputs(u) == old['dropIns'][u],
             'NO_SCHEMA_PRODUCTION_UNIT_DRIFT')
        need(D.unit_definition(u,old['units'][u],entry,p)==old['unitDefinitions'][u],
             'NO_SCHEMA_PRODUCTION_EFFECTIVE_UNIT_DRIFT')
    facts=D.database_facts(p)
    need(facts.get('database') == facts.get('owner') == 'cisme' and facts.get('journal') == old['journal'],
         'NO_SCHEMA_PRODUCTION_DATABASE_DRIFT')


def article_fence(profile):
    # Actor attribution is independent of content_sha256. Keep it in the
    # private fence, including namespace metadata, never OpenID/contact data.
    identity=lambda owner:"(SELECT coalesce(json_agg(json_build_array(w.id::text,w.provider,w.adapter,w.app_id) ORDER BY w.id),'[]'::json) FROM wechat_identity w WHERE w.member_id="+owner+" AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id='"+APP_ID+"')"
    return D.query(profile,"SELECT json_build_object('publishedCount',count(*) FILTER(WHERE a.status='published'),"
      "'items',coalesce(json_agg(json_build_array(a.id::text,a.version,a.content_sha256,a.status,a.media,"
      "a.author_member_id::text,a.author_display_name,a.published_by::text,a.published_principal_id,author.status,publisher.status,"
      +identity('a.author_member_id')+","+identity('a.published_by')+") ORDER BY a.id),'[]'::json)) "
      "FROM editorial_article a JOIN member author ON author.id=a.author_member_id LEFT JOIN member publisher ON publisher.id=a.published_by")


def six_keys(trial, production):
    keys = ('APP_SESSION_SECRET','UPLOAD_TOKEN_SECRET','CONTACT_ENCRYPTION_KEY','CONTACT_HASH_KEY','PRIVACY_FORMAL_EXPORT_KEY')
    need(all(trial.get(k) and production.get(k) and trial[k] != production[k] for k in keys),
         'NO_SCHEMA_SECRET_ISOLATION_REQUIRED')
    t,p = urlsplit(trial.get('DATABASE_URL','')),urlsplit(production.get('DATABASE_URL',''))
    need(t.hostname == p.hostname == '127.0.0.1' and (t.port or 5432) == (p.port or 5432) == 5432
         and unquote(t.username or '') == unquote(t.path.lstrip('/')) == 'cisme_trial'
         and unquote(p.username or '') == unquote(p.path.lstrip('/')) == 'cisme'
         and t.password and p.password and unquote(t.password) != unquote(p.password)
         and not any((t.query,t.fragment,p.query,p.fragment)),
         'NO_SCHEMA_DATABASE_ISOLATION_REQUIRED')


# Snapshot primitives copied verbatim from the reviewed1209 helper; this module binds45091 AAD.
SNAPSHOT_JS = r"""
import {constants,createReadStream,createWriteStream} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
const [mode,file,keyPath,aad]=process.argv.slice(1),MAX=2*1024**3;
const need=x=>{if(!x)throw Error('SNAPSHOT_INVALID')};
async function protectedFile(path,max){
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const st=await h.stat();
 need(st.isFile()&&st.uid===process.getuid()&&(st.mode&0o777)===0o600&&st.nlink===1&&st.size<=max&&st.size>0);
 return {h,st};
}
try{
 if(mode==='encrypt'){
  const key=randomBytes(32),iv=randomBytes(12),kh=await open(keyPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await kh.writeFile(key);await kh.sync();await kh.close();
  const out=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await out.write(Buffer.concat([Buffer.from('CTS1'),iv]));
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
  const digest=createHash('sha256');let bytes=0,prefix=Buffer.alloc(0);
  const inspect=new Transform({transform(chunk,enc,cb){bytes+=chunk.length;if(bytes>MAX){cb(Error('SIZE'));return;}
   if(prefix.length<5)prefix=Buffer.concat([prefix,chunk]).subarray(0,5);digest.update(chunk);cb(null,chunk);}});
  await pipeline(process.stdin,inspect,cipher,createWriteStream(file,{fd:out.fd,autoClose:false}));
  need(bytes>5&&prefix.equals(Buffer.from('PGDMP')));await out.write(cipher.getAuthTag());await out.sync();await out.close();
  console.log(JSON.stringify({plainSha256:digest.digest('hex'),plainBytes:bytes,encrypted:true}));
 }else{
  need(mode==='verify'||mode==='decrypt');const keyFile=await protectedFile(keyPath,32);need(keyFile.st.size===32);
  const key=await keyFile.h.readFile();await keyFile.h.close();
  const {h,st}=await protectedFile(file,MAX+32);need(st.size>37);
  const header=Buffer.alloc(16),tag=Buffer.alloc(16);need((await h.read(header,0,16,0)).bytesRead===16);
  need(header.subarray(0,4).equals(Buffer.from('CTS1')));need((await h.read(tag,0,16,st.size-16)).bytesRead===16);
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(4));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(tag);
  const digest=createHash('sha256');let bytes=0;
  const sink=new Transform({transform(chunk,enc,cb){digest.update(chunk);bytes+=chunk.length;cb(null,mode==='decrypt'?chunk:undefined);}});
  const output=mode==='decrypt'?process.stdout:new Transform({transform(c,e,cb){cb();}});
  await pipeline(createReadStream(file,{fd:h.fd,autoClose:false,start:16,end:st.size-17}),decipher,sink,output);
  await h.close();if(mode==='verify')console.log(JSON.stringify({plainSha256:digest.digest('hex'),plainBytes:bytes,authenticated:true}));
 }
}catch{process.stderr.write('SNAPSHOT_OPERATION_FAILED\n');process.exitCode=1;}
"""


def crypto_args(mode, file, key, aad):
    return [NODE,'--input-type=module','-e',SNAPSHOT_JS,mode,str(file),str(key),aad]


def private_hash(path, limit=2 * 1024 ** 3 + 32):
    parents(path,private=True)
    fd = os.open(path,os.O_RDONLY | getattr(os,'O_NOFOLLOW',0))
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and stat.S_IMODE(info.st_mode) == 0o600
             and info.st_nlink == 1 and 0 < info.st_size <= limit, 'APPLICATION_SNAPSHOT_FILE_UNSAFE')
        result = hashlib.sha256()
        size = 0
        while chunk := os.read(fd,65536):
            size += len(chunk)
            need(size <= limit,'APPLICATION_SNAPSHOT_TOO_LARGE')
            result.update(chunk)
        after = os.fstat(fd)
        need(size == info.st_size and (after.st_size,after.st_mtime_ns,after.st_ctime_ns)
             == (info.st_size,info.st_mtime_ns,info.st_ctime_ns),'APPLICATION_SNAPSHOT_CHANGED')
        return {'sha256':result.hexdigest(),'bytes':size}
    finally:
        os.close(fd)


def snapshot(plan, state, approval):
    fixed_profile(plan['profile'])
    url = urlsplit(plan['config']['DATABASE_URL'])
    need(unquote(url.username or '') == 'cisme_trial' and url.hostname == '127.0.0.1'
         and (url.port or 5432) == 5432 and unquote(url.path.lstrip('/')) == 'cisme_trial',
         'APPLICATION_SNAPSHOT_TRIAL_DATABASE_REQUIRED')
    directory = state / 'predeploy-database'
    directory.mkdir(mode=0o700)
    D.owned_directory(directory,True)
    encrypted,key = directory / 'cisme_trial.dump.aesgcm',directory / 'snapshot.key'
    aad = json.dumps({'database':'cisme_trial','baseline':BASELINE_HEAD,'operationReference':approval,
                      'operation':state.name},sort_keys=True,separators=(',',':'))
    env = {**CLEAN,'PGPASSWORD':unquote(url.password or ''),
           'PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000'}
    dump = subprocess.Popen(['/usr/sbin/runuser','-u','cisme-trial','--','/usr/bin/pg_dump','--format=custom',
           '--no-owner','--no-acl','--no-password','--host=127.0.0.1','--port=5432','--username=cisme_trial',
           '--dbname=cisme_trial'],env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    encrypt = None
    try:
        encrypt = subprocess.Popen(crypto_args('encrypt',encrypted,key,aad),env=CLEAN,
                                   stdin=dump.stdout,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        dump.stdout.close()
        raw,_ = encrypt.communicate(timeout=600)
        need(encrypt.returncode == 0 and dump.wait(timeout=20) == 0 and len(raw) <= 4096,
             'APPLICATION_SNAPSHOT_DUMP_FAILED')
    finally:
        for process in (encrypt,dump):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
        if dump.stdout is not None and not dump.stdout.closed:
            dump.stdout.close()
    plain = D.json_bytes(raw)
    need(plain.get('encrypted') is True and re.fullmatch(r'[a-f0-9]{64}',plain.get('plainSha256',''))
         and type(plain.get('plainBytes')) is int and plain['plainBytes'] > 5,'APPLICATION_SNAPSHOT_DUMP_INVALID')
    cipher = private_hash(encrypted)
    key_binding = private_hash(key,32)
    need(key_binding['bytes'] == 32,'APPLICATION_SNAPSHOT_KEY_INVALID')
    verified = D.json_bytes(D.command(crypto_args('verify',encrypted,key,aad),timeout=600))
    need(verified.get('authenticated') is True and all(verified.get(k) == plain[k] for k in ('plainSha256','plainBytes')),
         'APPLICATION_SNAPSHOT_AUTHENTICATION_FAILED')
    decrypt = subprocess.Popen(crypto_args('decrypt',encrypted,key,aad),env=CLEAN,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    listing = None
    try:
        listing = subprocess.Popen(['/usr/bin/pg_restore','--list'],env=CLEAN,stdin=decrypt.stdout,
                                   stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        decrypt.stdout.close()
        table_of_contents,_ = listing.communicate(timeout=180)
        need(listing.returncode == 0 and decrypt.wait(timeout=20) == 0 and len(table_of_contents) <= 1024 * 1024
             and b'dbname: cisme_trial' in table_of_contents
             and b'TABLE DATA public schema_migration' in table_of_contents,'APPLICATION_SNAPSHOT_STRUCTURE_FAILED')
    finally:
        for process in (listing,decrypt):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
        if decrypt.stdout is not None and not decrypt.stdout.closed:
            decrypt.stdout.close()
    need(private_hash(encrypted) == cipher and private_hash(key,32) == key_binding,'APPLICATION_SNAPSHOT_CHANGED')
    record = {'scope':'same-host-database-only','database':'cisme_trial','baseline':BASELINE_HEAD,
              'backupReference':'TRIAL-SNAPSHOT-' + state.name,'encryptedFile':str(encrypted),'keyFile':str(key),
              'aad':aad,**plain,'cipher':cipher,'keyBinding':key_binding,
              'structureListSha256':sha(table_of_contents),'authenticated':True,'pgRestoreListVerified':True,
              'fullRecoveryQualified':False,'restorePerformed':False,'mediaIncluded':False,'remoteCopyCreated':False}
    D.general.store(directory / 'snapshot-private.json',(json.dumps(record,sort_keys=True)+'\n').encode())
    return record


def validate_snapshot(backup, state, approval):
    directory = state / 'predeploy-database'
    encrypted, key = directory / 'cisme_trial.dump.aesgcm', directory / 'snapshot.key'
    expected_aad = json.dumps({'database':'cisme_trial','baseline':BASELINE_HEAD,'operationReference':approval,
                              'operation':state.name},sort_keys=True,separators=(',',':'))
    need(backup.get('authenticated') is True and backup.get('pgRestoreListVerified') is True
         and backup.get('database') == 'cisme_trial' and backup.get('baseline') == BASELINE_HEAD
         and backup.get('scope') == 'same-host-database-only' and backup.get('restorePerformed') is False
         and backup.get('backupReference') == 'TRIAL-SNAPSHOT-' + state.name
         and backup.get('encryptedFile') == str(encrypted) and backup.get('keyFile') == str(key)
         and backup.get('aad') == expected_aad,
         'APPLICATION_REAL_SNAPSHOT_REQUIRED')
    need(D.json_bytes(read(directory / 'snapshot-private.json',private=True)) == backup
         and private_hash(encrypted) == backup['cipher'] and private_hash(key,32) == backup['keyBinding'],
         'APPLICATION_SNAPSHOT_CHANGED')
    verified = D.json_bytes(D.command(crypto_args('verify',encrypted,key,expected_aad),timeout=600))
    need(verified.get('authenticated') is True and all(verified.get(k) == backup[k] for k in ('plainSha256','plainBytes')),
         'APPLICATION_SNAPSHOT_AUTHENTICATION_FAILED')

if __name__=='__main__':raise SystemExit(main())
