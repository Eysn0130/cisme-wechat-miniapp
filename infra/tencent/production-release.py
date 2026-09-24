#!/usr/bin/env python3
"""Preserve-data, closed-commerce production application upgrade entry.

Default is read-only preflight. Apply requires protected, independently reviewed
backup/restore, rollback and writer-drain evidence; this tool never creates those
approvals. It never provisions a database, restores an old database, or changes
credentials/network permissions. Failure recovery changes application/config only.
"""
import argparse
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import time
import urllib.request

HERE=Path(__file__).resolve().parent

def module(name,filename):
    spec=importlib.util.spec_from_file_location(name,HERE/filename)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

observe=module('live_production','production-observation.py')
journal=module('live_journal','production-migration-audit.py')
require=observe.target.require
ROOT=Path('/opt/cisme');CURRENT=ROOT/'current';LIVE=observe.LIVE_ENV
NODE='/opt/node-v24.14.0-linux-x64/bin/node'
UNITS=('cisme-api.service','cisme-worker.service')
REPO='Eysn0130/cisme-wechat-miniapp'
CLOSED={'APP_ENV':'production','ALLOW_DEV_ADAPTERS':'false','COMMERCE_ORDER_FLOW_ENABLED':'false',
        'CISME_MIGRATION_READ_ONLY':'true','RUN_BACKGROUND_WORKER':'false'}


def sha(data):return hashlib.sha256(data).hexdigest()


def protected(path,limit=1024*1024):
    path=Path(path);require(path.is_absolute(),'ABSOLUTE_PROTECTED_PATH_REQUIRED')
    fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|getattr(os,'O_NOFOLLOW',0))
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_mode&0o027==0
                and info.st_size<=limit,'ROOT_PROTECTED_FILE_REQUIRED')
        chunks=[];size=0
        while True:
            data=os.read(fd,min(65536,limit+1-size))
            if not data:break
            size+=len(data);require(size<=limit,'PROTECTED_FILE_TOO_LARGE');chunks.append(data)
        return b''.join(chunks)
    finally:os.close(fd)


def protected_digest(path):
    fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|getattr(os,'O_NOFOLLOW',0))
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_mode&0o027==0
                and 0<info.st_size<=1024**4,'PROTECTED_BACKUP_REQUIRED')
        digest=hashlib.sha256()
        with os.fdopen(fd,'rb',closefd=False) as stream:
            while chunk:=stream.read(1024*1024):digest.update(chunk)
        return digest.hexdigest()
    finally:os.close(fd)


def receipt(path):return json.loads(protected(path),object_pairs_hook=observe.target.unique_keys)


def command(args,env=None,cwd=None,timeout=30):
    result=subprocess.run(args,env=env,cwd=cwd,capture_output=True,timeout=timeout)
    require(result.returncode==0,'PRODUCTION_COMMAND_FAILED')
    require(len(result.stdout)<=1024*1024,'PRODUCTION_COMMAND_OUTPUT_TOO_LARGE')
    return result.stdout


def local_https_ready():
    # Fixed loopback transport, genuine domain SNI/certificate validation. This
    # permits installing the closed candidate before separately approved public
    # firewall exposure. It never claims external-network reachability.
    value=command(['/usr/bin/curl','--silent','--output','/dev/null','--write-out','%{http_code}',
                   '--noproxy','*','--connect-timeout','3','--max-time','8','--proto','=https',
                   '--resolve','api.cisme.cn:443:127.0.0.1','https://api.cisme.cn/health/ready'],timeout=10)
    require(value==b'200','PRODUCTION_LOCAL_HTTPS_NOT_READY')


def require_services_stopped():
    for unit in UNITS:
        state=command(['systemctl','show',unit,'-p','ActiveState','--value']).decode().strip()
        pid=command(['systemctl','show',unit,'-p','MainPID','--value']).decode().strip()
        require(state=='inactive' and pid=='0','PRODUCTION_UNITS_NOT_STOPPED')


def github(path):
    # Fixed repository, HTTPS verification, no credentials or arbitrary URL input.
    require(path.startswith(('git/ref/heads/main','git/commits/','actions/workflows/ci.yml/runs?',
                             'contents/scripts/release-migrate.mjs?ref=')),'GITHUB_RESOURCE_REFUSED')
    request=urllib.request.Request('https://api.github.com/repos/'+REPO+'/'+path,
                                  headers={'Accept':'application/vnd.github+json','User-Agent':'cisme-production-preflight'})
    opener=urllib.request.build_opener(observe.NoRedirect())
    with opener.open(request,timeout=12) as response:
        require(response.status==200,'GITHUB_PROVENANCE_UNAVAILABLE');data=response.read(1024*1024+1)
    require(len(data)<=1024*1024,'GITHUB_RESPONSE_TOO_LARGE');return json.loads(data)


def reviewed_main(fetch=github):
    head=fetch('git/ref/heads/main')['object']['sha'];require(observe.target.git_sha(head),'GITHUB_MAIN_INVALID')
    commit=fetch('git/commits/'+head);tree=commit['tree']['sha']
    require(commit['sha']==head and observe.target.git_sha(tree),'GITHUB_TREE_INVALID')
    runs=fetch('actions/workflows/ci.yml/runs?branch=main&event=push&head_sha='+head+'&per_page=20').get('workflow_runs',[])
    eligible=[r for r in runs if r.get('head_sha')==head and r.get('head_branch')=='main' and r.get('event')=='push'
              and r.get('path')=='.github/workflows/ci.yml' and r.get('repository',{}).get('full_name')==REPO
              and type(r.get('id')) is int]
    require(eligible,'EXACT_MAIN_PUSH_CI_REQUIRED')
    latest=max(eligible,key=lambda r:r['id'])
    require(latest.get('status')=='completed' and latest.get('conclusion')=='success','LATEST_MAIN_CI_NOT_SUCCESSFUL')
    return {'sha':head,'tree':tree,'ciRunId':latest['id']}


def release_directory(path):
    path=Path(path)
    require(path.is_absolute() and path.parent==ROOT/'releases' and re.fullmatch(r'[a-zA-Z0-9_-]{8,100}',path.name),
            'PREPARED_PRODUCTION_RELEASE_REQUIRED')
    for directory in [ROOT,ROOT/'releases',path]:
        info=directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and not directory.is_symlink() and info.st_uid==0
                and info.st_mode&0o022==0,'IMMUTABLE_RELEASE_DIRECTORY_REQUIRED')
    # Verify ownership beneath the root too: an otherwise root-owned release
    # must not load an API file or installed dependency writable by the service.
    # npm .bin links are allowed only inside this same protected release tree.
    for count,entry in enumerate(path.rglob('*'),1):
        require(count<=100000,'RELEASE_ENTRY_LIMIT_EXCEEDED')
        info=entry.lstat()
        require(info.st_uid==0,'IMMUTABLE_RELEASE_CONTENT_REQUIRED')
        if stat.S_ISLNK(info.st_mode):
            resolved=entry.resolve(strict=True)
            require(resolved.is_relative_to(path),'RELEASE_LINK_ESCAPES_CANDIDATE')
        else:
            require((stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))
                    and info.st_mode&0o022==0,'IMMUTABLE_RELEASE_CONTENT_REQUIRED')
    return path


def preflight(directory,candidate_env,fetch=github,*,services_stopped=False):
    identity=observe.identity() # Wrong instance must fail before other work.
    directory=release_directory(directory)
    manifest=receipt(directory/'release-manifest.json');main=reviewed_main(fetch)
    require(manifest.get('sourceHead')==main['sha'] and manifest.get('sourceTree')==main['tree'],
            'CANDIDATE_NOT_CURRENT_MAIN')
    # Hash the migration entry before executing even its verify mode.
    migration_bytes=protected(directory/'migrate.mjs',20*1024*1024)
    require(sha(migration_bytes)==manifest.get('hashes',{}).get('migrate.mjs'),
            'MIGRATION_ENTRY_HASH_MISMATCH')
    source=fetch('contents/scripts/release-migrate.mjs?ref='+main['sha'])
    require(source.get('type')=='file' and source.get('encoding')=='base64'
            and source.get('path')=='scripts/release-migrate.mjs','REVIEWED_MIGRATION_SOURCE_REQUIRED')
    reviewed=base64.b64decode(source['content'].replace('\n',''),validate=True)
    require(migration_bytes==reviewed,'MIGRATION_ENTRY_NOT_REVIEWED_MAIN_SOURCE')
    verified=json.loads(command(['/usr/sbin/runuser','-u','cisme','--',NODE,str(directory/'migrate.mjs'),'verify'],
                                env={'PATH':'/usr/bin:/bin'},cwd=directory))
    require(verified.get('verified') is True and verified.get('sourceHead')==main['sha']
            and verified.get('sourceTree')==main['tree'],'FULL_CANDIDATE_VERIFICATION_REQUIRED')
    target=observe.guard_for_upgrade(candidate_env,manifest,main['sha'],main['tree'])
    candidate=observe.protected_environment(candidate_env)
    require(all(candidate.get(k)==v for k,v in CLOSED.items()),'CLOSED_COMMERCE_MAINTENANCE_CONFIG_REQUIRED')
    suppression=Path(candidate.get('PRIVACY_SUPPRESSION_DIR',''))
    require(str(suppression)=='/var/lib/cisme/privacy-suppression','PRIVACY_SUPPRESSION_TARGET_REQUIRED')
    try:suppression_info=suppression.lstat()
    except OSError:raise observe.target.Refused('PRIVACY_SUPPRESSION_DIRECTORY_MISSING')
    require(stat.S_ISDIR(suppression_info.st_mode) and suppression_info.st_uid==pwd.getpwnam('cisme').pw_uid
            and suppression_info.st_mode&0o077==0,'PRIVACY_SUPPRESSION_DIRECTORY_UNSAFE')
    writable=command(['systemctl','show','cisme-api.service','--property=ReadWritePaths','--value']).decode().split()
    require(str(suppression) in writable,'PRIVACY_SUPPRESSION_SERVICE_ACCESS_REQUIRED')
    require(not any(k.startswith(('LD_','DYLD_','PG','PYTHON')) or (k.startswith('NODE_') and k!='NODE_ENV')
                    or k in ('BASH_ENV','ENV','PATH','HOME','PWD','SHELL','IFS') for k in candidate),
            'PROCESS_INJECTION_CONFIGURATION_REFUSED')
    live=observe.protected_environment(LIVE)
    require(all(candidate.get(k)==live.get(k) for k in ('PORT','API_LISTEN_HOST')),'IMPLICIT_API_BINDING_CHANGE_REFUSED')
    # An ordinary release must not change session, contact, webhook or upload keys.
    for key in set(live)|set(candidate):
        if re.search(r'SECRET|PASSWORD|TOKEN|(?:^|_)KEY(?:_|$)',key):
            require(candidate.get(key)==live.get(key),'IMPLICIT_SECRET_CHANGE_REFUSED')
    history=journal.inspect();plan=journal.compare(history['journal'],manifest['migrations'])
    old=CURRENT.resolve(strict=True)
    require(CURRENT.is_symlink() and old.parent==ROOT/'releases' and old!=directory,'EXISTING_PRODUCTION_RELEASE_REQUIRED')
    prior={'directory':str(old),'indexSha256':sha((old/'index.js').read_bytes()),
           'workerSha256':sha((old/'worker.js').read_bytes()),'packageLockSha256':sha((old/'package-lock.json').read_bytes())}
    if services_stopped:
        # This recheck runs after the deliberate stop, before any migration.
        # A 200 would require the old API to keep serving while supposedly drained.
        require_services_stopped()
    else:
        # Initial preflight still requires the existing local TLS/upstream.
        local_https_ready()
    return {'schemaVersion':1,'observedAtUtc':datetime.now(timezone.utc).isoformat(),'identity':identity,
            'target':target,'main':main,'candidateDirectory':str(directory),'manifestSha256':sha(protected(directory/'release-manifest.json')),
            'candidateEnvironmentSha256':sha(protected(candidate_env)),'liveEnvironmentSha256':sha(protected(LIVE)),
            'previous':prior,'migrationPlan':plan,'readOnly':True,'deployed':False,'productionValidated':False,
            'commerceEnabled':False,'permissionGranted':False}


def qualifications(path,plan):
    q=receipt(path)
    require(q.get('schemaVersion')==1 and q.get('kind')=='reviewed-production-upgrade'
            and q.get('instanceId')=='lhins-61ikz4mi' and q.get('database')=='cisme'
            and q.get('candidateHead')==plan['main']['sha'] and q.get('candidateTree')==plan['main']['tree']
            and q.get('manifestSha256')==plan['manifestSha256'] and q.get('previous')==plan['previous']
            and q.get('approvedPendingMigrations')==plan['migrationPlan']['pending'],'REVIEWED_UPGRADE_BINDING_REQUIRED')
    # Each reference must point to a protected receipt actually reviewed by the
    # operator. No success/approval defaults, placeholders or arbitrary hooks.
    for key,kind in [('restore','production-protected-restore'),('rollback','same-data-application-rollback'),
                     ('writers','production-writer-inventory-and-drain'),('migrationReview','production-history-and-sql-review')]:
        ref=q.get(key,{})
        require(isinstance(ref,dict) and re.fullmatch(r'[a-f0-9]{64}',ref.get('sha256','')),'UPGRADE_EVIDENCE_REQUIRED')
        data=protected(ref.get('path',''))
        require(sha(data)==ref['sha256'],'UPGRADE_EVIDENCE_HASH_MISMATCH')
        value=json.loads(data)
        require(value.get('kind')==kind and value.get('instanceId')=='lhins-61ikz4mi'
                and value.get('candidateHead')==plan['main']['sha'] and value.get('previous')==plan['previous']
                and value.get('verified') is True and value.get('syntheticOnly') is False,'REAL_PRODUCTION_EVIDENCE_REQUIRED')
        if key=='restore':
            require(value.get('backupSha256')==q.get('backup',{}).get('sha256')
                    and value.get('globalsAndRolesVerified') is True and value.get('cosObjectRestoreVerified') is True
                    and value.get('encryptionKeyRecoveryVerified') is True
                    and value.get('privacySuppressionRestoreVerified') is True,'COMPLETE_PRODUCTION_RESTORE_REQUIRED')
        if key=='rollback':
            require(value.get('sameDatabase') is True and value.get('newWritesPreserved') is True
                    and value.get('coversPartialForwardMigration') is True,'DATA_PRESERVING_ROLLBACK_REQUIRED')
        if key=='writers':
            require(value.get('externalConsumersDisabled') is True and value.get('unresolvedConsumers')==[],
                    'EXTERNAL_WRITERS_NOT_DRAINED')
        if key=='migrationReview':
            require(value.get('approvedPendingMigrations')==plan['migrationPlan']['pending']
                    and value.get('historicalSqlIntegrityVerified') is True,'HISTORICAL_SQL_REVIEW_REQUIRED')
        observed=datetime.fromisoformat(value['observedAtUtc'].replace('Z','+00:00'))
        age=(datetime.now(timezone.utc)-observed).total_seconds()
        require(0<=age<=(900 if key=='writers' else 86400),'FRESH_PRODUCTION_QUALIFICATION_REQUIRED')
    backup=q.get('backup',{})
    backup_path=Path(backup.get('path',''))
    require(backup_path.is_absolute() and str(backup_path).startswith('/var/backups/cisme-')
            and backup_path.suffix=='.aesgcm','ENCRYPTED_PRODUCTION_BACKUP_REQUIRED')
    require(protected_digest(backup_path)==backup.get('sha256'),'PREDEPLOY_BACKUP_HASH_MISMATCH')
    require(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}',q.get('reviewReference','')),'REVIEW_REFERENCE_REQUIRED')
    return q


def store(path,data,mode=0o600):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
    try:
        with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    except BaseException:raise


def switch(directory,env_bytes,label):
    # No database restore or down migration exists in this entry.
    env_temp=LIVE.with_name('.runtime-'+label+'.env');store(env_temp,env_bytes,0o640)
    os.chown(env_temp,0,pwd.getpwnam('cisme').pw_gid)
    link=ROOT/('.current-'+label);require(not link.exists() and not link.is_symlink(),'CUTOVER_TEMP_EXISTS')
    link.symlink_to(directory,target_is_directory=True)
    os.replace(env_temp,LIVE);os.replace(link,CURRENT)


def healthy(directory):
    for attempt in range(30):
        try:
            require(command(['systemctl','is-active',*UNITS]).decode().split()==['active','active'],'PRODUCTION_UNITS_NOT_ACTIVE')
            for unit in UNITS:
                pid=command(['systemctl','show',unit,'-p','MainPID','--value']).decode().strip()
                require(re.fullmatch(r'[1-9][0-9]*',pid) and Path('/proc/'+pid+'/cwd').resolve()==directory,'RUNNING_RELEASE_MISMATCH')
            local_https_ready()
            return
        except Exception:
            if attempt==29:raise observe.target.Refused('PRODUCTION_ACTIVATION_HEALTH_FAILED')
            time.sleep(1)


def apply(directory,candidate_env,qualification,approval):
    require(os.geteuid()==0,'PRODUCTION_ROOT_REQUIRED')
    require(re.fullmatch(r'[-A-Za-z0-9_:.]{8,120}',approval or ''),'EXPLICIT_UPGRADE_APPROVAL_REFERENCE_REQUIRED')
    observe.identity() # No lock/state/config write on staging or a wrong host.
    info=ROOT.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and info.st_mode&0o022==0,'PROTECTED_PRODUCTION_ROOT_REQUIRED')
    # This local lock coordinates this entry only; external writer inventory and
    # drain evidence are required separately and cannot be inferred from it.
    fd=os.open(ROOT/'.production-upgrade.lock',os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_mode&0o077==0,'PROTECTED_UPGRADE_LOCK_REQUIRED')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        plan=preflight(directory,candidate_env);q=qualifications(qualification,plan)
        state=ROOT/'production-upgrades'/('main-'+plan['main']['sha'][:12]+'-'+str(time.time_ns()))
        parent=state.parent;parent.mkdir(mode=0o700,exist_ok=True);info=parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and info.st_mode&0o077==0,'PROTECTED_UPGRADE_STATE_REQUIRED')
        state.mkdir(mode=0o700)
        return cutover(plan,directory,candidate_env,q,approval,state)
    finally:os.close(fd)


def cutover(plan,directory,candidate_env,q,approval,state):
    """Internal engine; only apply() supplies validated, fresh qualifications."""
    old_env=protected(LIVE);new_env=protected(candidate_env);old=Path(plan['previous']['directory'])
    require(sha(old_env)==plan['liveEnvironmentSha256'] and sha(new_env)==plan['candidateEnvironmentSha256'],
            'PREPARED_ENVIRONMENT_CHANGED')
    config=observe.audit.environment(new_env.decode('utf-8'))
    store(state/'previous.env',old_env)
    store(state/'preflight.json',(json.dumps(plan,indent=2)+'\n').encode())
    require(sha(protected(LIVE))==plan['liveEnvironmentSha256'],'LIVE_ENVIRONMENT_CHANGED')
    command(['systemctl','stop',*UNITS],timeout=90)
    migrated=False;activated=False
    try:
        other=journal.query("SELECT count(*) FROM pg_stat_activity WHERE datname='cisme' AND backend_type='client backend' AND pid<>pg_backend_pid()")
        require(other==0,'UNDRAINED_PRODUCTION_DATABASE_CLIENTS')
        # Repeat independently sourced main/CI and live target check directly
        # before migration. If main moved, return to preflight/review.
        fresh=preflight(directory,candidate_env,services_stopped=True)
        require(fresh['main']==plan['main'] and fresh['previous']==plan['previous']
                and fresh['migrationPlan']==plan['migrationPlan']
                and fresh['candidateEnvironmentSha256']==plan['candidateEnvironmentSha256']
                and fresh['liveEnvironmentSha256']==plan['liveEnvironmentSha256'],'PRODUCTION_PREFLIGHT_DRIFT')
        output=command(['/usr/sbin/runuser','-u','cisme','--',NODE,str(Path(directory)/'migrate.mjs'),'up'],
            env={'PATH':'/usr/bin:/bin',**config,'CISME_MIGRATION_APPROVAL_REF':approval,
                 'CISME_PREDEPLOY_BACKUP_REF':'backup:'+q['backup']['sha256']},cwd=directory,timeout=1800)
        applied=[json.loads(line)['applied'] for line in output.splitlines() if line]
        require(applied==plan['migrationPlan']['pending'],'APPLIED_MIGRATION_SET_MISMATCH');migrated=True
        observe.guard_for_upgrade(candidate_env,receipt(Path(directory)/'release-manifest.json'),plan['main']['sha'],plan['main']['tree'])
        require(sha(protected(LIVE))==plan['liveEnvironmentSha256'] and sha(protected(candidate_env))==plan['candidateEnvironmentSha256'],
                'CUTOVER_ENVIRONMENT_CHANGED')
        switch(Path(directory),new_env,state.name);activated=True
        command(['systemctl','start',*UNITS],timeout=60);healthy(Path(directory))
    except Exception:
        # Qualification must cover every candidate schema, including partial
        # forward migration. Never roll data back to a pre-cutover snapshot.
        command(['systemctl','stop',*UNITS],timeout=90)
        require(protected(LIVE) in (old_env,new_env),'ROLLBACK_ENVIRONMENT_DRIFT_MANUAL_RECOVERY_REQUIRED')
        require(sha((old/'index.js').read_bytes())==plan['previous']['indexSha256']
                and sha((old/'worker.js').read_bytes())==plan['previous']['workerSha256']
                and sha((old/'package-lock.json').read_bytes())==plan['previous']['packageLockSha256'],'ROLLBACK_ARTIFACT_DRIFT')
        switch(old,old_env,state.name+'-rollback');command(['systemctl','start',*UNITS],timeout=60);healthy(old)
        store(state/'application-rollback.json',json.dumps({'oldApplicationRestored':True,'databaseRestored':False,
              'downMigrationExecuted':False,'candidateMigrationCompleted':migrated,'candidateActivated':activated}).encode())
        raise observe.target.Refused('UPGRADE_FAILED_APPLICATION_RESTORED_REVIEW_REQUIRED') from None
    report={**plan,'readOnly':False,'deployed':True,'serverLocalHttpsVerified':True,
            'productionValidated':False,'commerceEnabled':False,'maintenanceEnabled':True,
            'databaseReplaced':False,'databaseRestored':False,'credentialsRotated':False,'networkChanged':False,
            'approvalReference':approval,'reviewReference':q['reviewReference']}
    store(state/'deployed.json',(json.dumps(report,indent=2)+'\n').encode());return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['preflight','apply']);parser.add_argument('--release',required=True)
    parser.add_argument('--candidate-env',required=True);parser.add_argument('--qualification');parser.add_argument('--approval-ref')
    args=parser.parse_args()
    try:
        if args.action=='apply':
            require(args.qualification,'REVIEWED_QUALIFICATION_FILE_REQUIRED')
            result=apply(args.release,args.candidate_env,args.qualification,args.approval_ref)
        else:result=preflight(args.release,args.candidate_env)
        print(json.dumps(result,sort_keys=True));return 0
    except observe.target.Refused as error:print(json.dumps({'ok':False,'code':str(error)}))
    except Exception:print('{"ok":false,"code":"PRODUCTION_UPGRADE_FAILED_REVIEW_REQUIRED"}')
    return 1


if __name__=='__main__':raise SystemExit(main())
