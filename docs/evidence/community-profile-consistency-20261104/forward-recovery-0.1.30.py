from pathlib import Path
import datetime,fcntl,hashlib,json,os,pwd,stat,time,types

ROOT=Path('/opt/cisme-trial')
RUNNER=ROOT/'community-profile-runners/93681d520c14'
GUARD_SHA='67d25a9698a8f87b5d73c62c0bad12bc23726c6425229fca66bc6e500a32d8b6'
BINDING_SHA='c7bd6844ec2295c5c86b946ac2612abcf89e2e6f0eb3ded062da47e5cb096a51'
TRANSPORT_SHA='5192e0eaa1b4d06f26349303cd2ae3e58f5c562852a1a515c82760fe28944610'

def main():
    assert os.geteuid()==0
    path=RUNNER/'trial-community-profile-update.py';raw=path.read_bytes()
    assert hashlib.sha256(raw).hexdigest()==GUARD_SHA
    n=types.ModuleType('preserved_profile108_guard');n.__file__=str(path)
    exec(compile(raw,str(path),'exec'),n.__dict__);n.load()
    b=n.binding(RUNNER/'application-binding.json',BINDING_SHA)
    fd=os.open('/run/lock/cisme-production-trial.lock',os.O_RDWR|os.O_NOFOLLOW)
    info=os.fstat(fd)
    assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    started=False
    try:
        assert not n.ACTIVE.exists()
        states=list(n.STATES.glob('commit-93681d520c14-*'));assert len(states)==1
        state=states[0]
        assert json.loads(n.M.protected(state/'forward-recovery-required.json'))=={'forwardRecoveryRequired':True,'databaseRestored':False}
        saved=n.M.protected(state/'protected-plan.json');plan=n.C.decode_private(json.loads(saved))
        assert plan['binding']==b and plan['operationReference']=='CISME-COMMUNITY-PROFILE-20261104'
        for label in ('old','candidate'):plan[label]=n.D.artifact(plan[label]['directory'],ROOT)
        backup_raw=n.M.protected(state/'predeploy-database/snapshot-private.json')
        assert n.sha(backup_raw)==plan['snapshotReceiptSha256']
        n.H.S.validate_snapshot(json.loads(backup_raw),state,plan['operationReference'])
        n.verify(plan,True);n.D.stopped(plan['profile'])
        n.journal(plan,[plan['candidate']['manifest']['migrations']],True)
        assert n.facts(plan['profile'],True)==plan['drainedFacts']
        assert not n.D.closed_context(plan['profile'],plan['config'])
        assert plan['config']==plan['openConfig'] and plan['config']['UGC_GO_LIVE_GATE']=='true'
        transport_raw=n.M.protected(RUNNER/'immutable-source-transport.py',128*1024)
        assert n.sha(transport_raw)==TRANSPORT_SHA
        transport=types.ModuleType('verified_immutable_transport')
        exec(compile(transport_raw,str(RUNNER/'immutable-source-transport.py'),'exec'),transport.__dict__)
        facade=types.SimpleNamespace(protected=n.M.protected,H=n.H)
        restore,proof=transport.install(facade,RUNNER/'immutable-source-cache',b['sourceHead'],b['sourceTree'])
        try:n.source_permit(b,plan['candidate'])
        finally:restore()
        assert proof['treeReconstructed'] and proof['requests']['liveReads']>=4 and proof['requests']['immutableCacheReads']>=3
        n.verify(plan,True)
        start=time.time();n.D.command(['systemctl','start',*plan['profile']['units']],timeout=60);started=True
        # This is the existing public-UGC-aware process check. The legacy
        # dependency-only check additionally requires all gates closed.
        for attempt in range(40):
            try:
                n.M.running(plan);n.M.public_contract(plan)
                heartbeat=ROOT/'tmp/cisme-worker-heartbeat.json';s=heartbeat.lstat()
                assert stat.S_ISREG(s.st_mode) and s.st_uid==pwd.getpwnam(plan['profile']['user']).pw_uid and s.st_mode&0o077==0
                at=datetime.datetime.fromisoformat(json.loads(heartbeat.read_bytes())['completedAtUtc'].replace('Z','+00:00')).timestamp()
                assert start<=at<=time.time() and time.time()-at<=120
                break
            except Exception:
                if attempt==39:raise
                time.sleep(.5)
        n.D.native_smoke(plan['profile'],plan['candidate']['directory'],True)
        n.verify(plan,True);n.journal(plan,[plan['candidate']['manifest']['migrations']])
        correction={'cause':'legacy closed_context rejects authorized open-UGC configuration','replacement':'existing pinned open-UGC-aware running(plan)','applicationCodeChanged':False,'configurationChanged':False,'sqlReapplied':False,'databaseRestored':False,'snapshotVerified':True,'originalFactsEqualBeforeRecoveryStart':True,'freshWorkerHeartbeatVerified':True,'liveSourcePermit':proof,'recoveryCodeSha256':n.sha(Path(__file__).read_bytes())}
        report={'kind':'trial-community-profile-active','sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'upgradeState':str(state),
          'privatePlanSha256':n.sha(saved),'migrationCount':108,'configurationChanged':False,'publicUgcEnabled':True,'provider':'wechat_v1_sync',
          'ordinaryPostsStillDirect':True,'memberConsentCreated':False,'authorityGranted':False,'productionChanged':False,'databaseRestored':False,
          'originalFactsPreservedAtMigration':True,'snapshotCryptoAadUsesHistoricalPrimitiveLabel':True,'ciRunId':b['ciRunId'],'ciVerifyJobId':b['ciVerifyJobId'],'privateValuesExported':False,'runningGuardCorrection':correction}
        raw=(json.dumps(report,sort_keys=True)+'\n').encode()
        n.D.atomic_bytes(n.ACTIVE,raw);n.verify(plan,True,raw)
        n.D.general.store(state/'deployed-after-running-check-correction.json',raw)
        print(json.dumps(n.active(b),sort_keys=True))
    except Exception:
        if started and not n.ACTIVE.exists():n.D.command(['systemctl','stop',*plan['profile']['units']],timeout=90)
        raise
    finally:os.close(fd)

if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error)
        if not code or not all(c.isupper() or c.isdigit() or c=='_' for c in code):code='PROFILE_FORWARD_RECOVERY_REVIEW_REQUIRED'
        print(json.dumps({'ok':False,'code':code,'privateValuesExported':False}));raise SystemExit(1)
