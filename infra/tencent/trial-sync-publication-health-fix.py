#!/usr/bin/env python3
"""Finish the already applied706 cutover after correcting its health JSON check.

No application, configuration, SQL, authority or user fact is written. Preserve
the original pinned helper and its failed receipt. Only its status:ready
predicate is corrected; all other guards and the authenticated snapshot remain.
The correction must be current main with a successful full verify job, and its
entire diff from the applied main is limited to these three operation files.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import types

APP='70629d32504399873ac44e7cacc2b159e896880d'
APP_TREE='f052dde0edb4e7a4ffc8cdeed79687e8ca0648cd'
ORIGINAL_SHA='73ca716a0cdfb97e963fd67a0ae22334cdda6752edbdb38ff286df0cb20d4ba3'
BINDING_SHA='ffb5ef3aafced5efb156621a4435fcdf04a2afdb95077351a469355eed8ae1b5'
ROOT=Path('/opt/cisme-trial')
ORIGINAL=ROOT/'sync-publication-runners'/APP[:12]/'trial-sync-publication-update.py'
SOURCE='infra/tencent/trial-sync-publication-health-fix.py'
ALLOWED={SOURCE,'infra/tencent/trial-sync-publication-update.py','infra/tencent/test_trial_sync_publication_update.py'}
_runtime=None

def public_contract(plan):
    M=_runtime;p=plan['profile'];base='https://'+p['domain']
    for path in ('/health/ready','/v1/ugc/status'):
        raw=M.D.command(['/usr/bin/curl','--silent','--show-error','--fail','--noproxy','*','--max-time','10',
          '--proto','=https','--resolve',p['domain']+':443:127.0.0.1',base+path])
        M.need(len(raw)<16384,'PUBLIC_RESPONSE_LIMIT');value=json.loads(raw)
        M.need(value.get('status')=='ready'if path=='/health/ready'else
          value.get('publicEnabled')is True and value.get('draftsEnabled')is True,'PUBLIC_READBACK_REQUIRED')

def load(path,expected):
    global _runtime
    raw=ORIGINAL.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=ORIGINAL_SHA:raise RuntimeError('FIX_ORIGINAL_HELPER_DRIFT')
    M=types.ModuleType('preserved_applied706_helper');M.__file__=str(ORIGINAL);exec(compile(raw,str(ORIGINAL),'exec'),M.__dict__)
    M.load_baseline(False)
    # protected() checks root ownership, all parents, size, mode, no links and
    # stable file metadata before its returned bytes can become executable.
    M.need(M.protected(ORIGINAL,128*1024)==raw,'FIX_ORIGINAL_HELPER_DRIFT')
    binding_raw=M.protected(path,65536);M.need(M.sha(binding_raw)==expected,'FIX_BINDING_DRIFT');fix=json.loads(binding_raw)
    M.need(fix.get('kind')=='trial-sync-publication-health-fix'and fix.get('applicationSourceHead')==APP,'FIX_SCOPE_REQUIRED')
    M.need(Path(__file__)==ROOT/'sync-publication-health-runners'/fix['sourceHead'][:12]/Path(SOURCE).name,'FIX_RUNNER_REQUIRED')
    M.need(M.sha(M.protected(Path(__file__),128*1024))==fix['codeSha256'],'FIX_CODE_DRIFT')
    app=M.binding(ORIGINAL.parent/'application-binding.json',BINDING_SHA)
    M.need(app['sourceHead']==APP and app['sourceTree']==APP_TREE,'FIX_APPLICATION_BINDING_DRIFT')
    _runtime=M;M.public_contract=public_contract
    return M,app,fix

def permit(M,fix):
    # Mutable main and CI checks remain live. Do not use a cached success flag.
    H=M.H;H.candidate_ci(fix)
    base='https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/'
    value=H.parse(H.response(base+'contents/'+SOURCE+'?ref='+fix['sourceHead'],256*1024))
    M.need(value.get('path')==SOURCE and value.get('type')=='file'and value.get('encoding')=='base64','FIX_COMMITTED_CODE_REQUIRED')
    code=base64.b64decode(value['content'].replace('\n','').replace('\r',''),validate=True)
    M.need(0<len(code)<=128*1024 and len(code)==value.get('size')and
      value.get('sha')==H.git_blob(code)and code==M.protected(Path(__file__),128*1024),'FIX_COMMITTED_CODE_REQUIRED')
    commit=H.parse(H.response(base+'git/commits/'+fix['sourceHead'],256*1024))
    M.need(commit.get('tree',{}).get('sha')==fix['sourceTree'],'FIX_SOURCE_TREE_REQUIRED')
    delta=H.parse(H.response(base+'compare/'+APP+'...'+fix['sourceHead'],2*1024**2))
    files=delta.get('files');M.need(delta.get('status')=='ahead'and delta.get('merge_base_commit',{}).get('sha')==APP and
      isinstance(files,list)and len(files)==3 and {f['filename']for f in files}==ALLOWED and
      all(f.get('status')in ('added','modified')for f in files),'FIX_APPLICATION_CHANGE_REFUSED')
    M.need(next(f for f in files if f['filename']==SOURCE).get('sha')==H.git_blob(code),'FIX_COMMITTED_CODE_REQUIRED')

def complete(M,app,fix):
    permit(M,fix)
    if M.ACTIVE.exists():return M.active(app)
    states=list(M.STATES.glob('commit-'+APP[:12]+'-*'));M.need(len(states)==1,'FIX_ONE_APPLIED_STATE_REQUIRED');state=states[0]
    saved=M.protected(state/'protected-plan.json');plan=M.C.decode_private(json.loads(saved));M.need(plan['binding']==app,'FIX_PLAN_DRIFT')
    for name in ('old','candidate'):plan[name]=M.D.artifact(plan[name]['directory'],ROOT)
    M.H.S.validate_snapshot(json.loads(M.protected(state/'predeploy-database/snapshot-private.json')),state,plan['operationReference'])
    M.need(M.sha(M.protected(state/'predeploy-database/snapshot-private.json'))==plan['snapshotReceiptSha256'],'FIX_SNAPSHOT_DRIFT')
    M.verify(plan,True,True);M.running(plan);public_contract(plan);M.journal(plan,[plan['candidate']['manifest']['migrations']])
    activated=json.loads(M.protected(state/'activation.json',65536))
    actual=M.D.query(plan['profile'],"SELECT jsonb_build_object('id',id,'reference',approval_reference,'sourceHead',evidence->>'sourceHead') FROM ugc_go_live_approval WHERE approval_reference='"+M.REFERENCE+"' AND revoked_at IS NULL AND signed_at<=clock_timestamp() AND expires_at>clock_timestamp()")
    M.need(actual=={'id':activated['approvalId'],'reference':M.REFERENCE,'sourceHead':APP}and
      activated.get('memberConsentCreated')is False and activated.get('authorityGranted')is False,'FIX_ACTUAL_APPROVAL_REQUIRED')
    correction={'sourceHead':fix['sourceHead'],'sourceTree':fix['sourceTree'],'codeSha256':fix['codeSha256'],
      'ciRunId':fix['ciRunId'],'ciVerifyJobId':fix['ciVerifyJobId'],'bindingSha256':M.sha(M.protected(Path(__file__).parent/'health-fix-binding.json',65536)),
      'directory':str(Path(__file__).parent),'originalHelperPreserved':True,'healthSchema':'status=ready',
      'applicationCodeChanged':False,'checksRemoved':False}
    report={'kind':'trial-sync-publication-active','sourceHead':APP,'sourceTree':APP_TREE,'upgradeState':str(state),
      'privatePlanSha256':M.sha(saved),'migrationCount':107,'publicUgcEnabled':True,'messagePushRequired':False,
      'provider':'wechat_v1_sync','changedConfigKeys':list(M.DELTA),'memberConsentCreated':False,'authorityGranted':False,
      'productionChanged':False,'databaseRestored':False,'originalFactsPreservedExceptDeclaredReleaseFacts':True,
      'activation':activated,'ciRunId':app['ciRunId'],'ciVerifyJobId':app['ciVerifyJobId'],'privateValuesExported':False,
      'healthGuardCorrection':correction}
    raw=(json.dumps(report,sort_keys=True)+'\n').encode();M.D.atomic_bytes(M.ACTIVE,raw)
    M.verify(plan,True,True,raw);M.D.general.store(state/'deployed-after-health-correction.json',raw)
    return M.active(app)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=('complete','active'),default='active',nargs='?')
    p.add_argument('--binding',type=Path,required=True);p.add_argument('--binding-sha256',required=True);a=p.parse_args()
    try:
        M,app,fix=load(a.binding,a.binding_sha256)
        result=complete(M,app,fix)if a.action=='complete'else M.active(app)
        print(json.dumps(result,sort_keys=True));return 0
    except Exception as e:
        code=str(e)
        if not code or not all(c.isupper()or c.isdigit()or c=='_'for c in code):code='FIX_REVIEW_REQUIRED'
        print(json.dumps({'ok':False,'code':code,'privateValuesExported':False}));return 1
if __name__=='__main__':raise SystemExit(main())
