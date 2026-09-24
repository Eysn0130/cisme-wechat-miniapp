"""Offline fixtures only. No production credential, approval, database or network.

Root-protected qualification fixtures exist only behind mocked readers; they are
not files that the real deployment entry can consume as production evidence.
"""
from contextlib import ExitStack,redirect_stdout
import base64
from datetime import datetime,timezone,timedelta
import importlib.util
import io
import json
import stat
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('release',Path(__file__).with_name('production-release.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
HEAD='a'*40;TREE='b'*40


class MainProvenance(unittest.TestCase):
    def run_data(self,**changes):
        return dict(id=10,head_sha=HEAD,head_branch='main',event='push',status='completed',conclusion='success',
                    path='.github/workflows/ci.yml',repository={'full_name':m.REPO},**changes)

    def fetch(self,runs):
        def get(path):
            if path=='git/ref/heads/main':return {'object':{'sha':HEAD}}
            if path=='git/commits/'+HEAD:return {'sha':HEAD,'tree':{'sha':TREE}}
            return {'workflow_runs':runs}
        return get

    def test_exact_main_push_and_tree(self):
        self.assertEqual(m.reviewed_main(self.fetch([self.run_data()])),{'sha':HEAD,'tree':TREE,'ciRunId':10})

    def test_pr_branch_wrong_repo_or_old_sha_cannot_substitute_for_main_ci(self):
        for change in [{'event':'pull_request'},{'head_branch':'feature'},{'repository':{'full_name':'other/repo'}},{'head_sha':'c'*40}]:
            with self.subTest(change=change),self.assertRaises(m.observe.target.Refused):
                m.reviewed_main(self.fetch([{**self.run_data(),**change}]))

    def test_newest_main_run_must_pass_even_when_older_run_passed(self):
        for change in [{'status':'in_progress','conclusion':None},{'status':'completed','conclusion':'failure'}]:
            with self.subTest(change=change),self.assertRaisesRegex(m.observe.target.Refused,'LATEST_MAIN_CI_NOT_SUCCESSFUL'):
                m.reviewed_main(self.fetch([self.run_data(),{**self.run_data(),'id':11,**change}]))

    def test_wrong_host_refuses_before_lock_or_service_action(self):
        with patch.object(m.os,'geteuid',return_value=0),patch.object(m.observe,'identity',side_effect=m.observe.target.Refused('WRONG_TARGET')),patch.object(m.os,'open') as opened,patch.object(m,'command') as cmd:
            with self.assertRaisesRegex(m.observe.target.Refused,'WRONG_TARGET'):m.apply('/fake/release','/fake/env','/fake/qualification','synthetic-only')
            opened.assert_not_called();cmd.assert_not_called()

    def test_cli_does_not_print_driver_or_connection_exception(self):
        output=io.StringIO()
        with patch.object(m,'preflight',side_effect=ValueError('SYNTHETIC_PRIVATE_CONNECTION')),patch('sys.argv',['entry','preflight','--release','/fake','--candidate-env','/fake/env']),redirect_stdout(output):
            self.assertEqual(m.main(),1)
        self.assertNotIn('SYNTHETIC_PRIVATE_CONNECTION',output.getvalue());self.assertIn('PRODUCTION_UPGRADE_FAILED_REVIEW_REQUIRED',output.getvalue())

    def test_local_tls_preserves_certificate_validation_and_does_not_open_a_firewall(self):
        with patch.object(m,'command',return_value=b'200') as command:m.local_https_ready()
        args=command.call_args.args[0]
        self.assertIn('api.cisme.cn:443:127.0.0.1',args)
        self.assertNotIn('-k',args);self.assertNotIn('--insecure',args)
        with patch.object(m,'command',return_value=b'503'):
            with self.assertRaises(m.observe.target.Refused):m.local_https_ready()

    def test_post_stop_check_requires_each_unit_inactive_and_without_a_process(self):
        with patch.object(m,'command',side_effect=[b'inactive\n',b'0\n',b'inactive\n',b'0\n']) as command:
            m.require_services_stopped()
        self.assertEqual(len(command.call_args_list),4)
        for values in ([b'active',b'1'],[b'inactive',b'7'],[b'inactive',b'0',b'activating',b'0']):
            with self.subTest(values=values),patch.object(m,'command',side_effect=values):
                with self.assertRaisesRegex(m.observe.target.Refused,'PRODUCTION_UNITS_NOT_STOPPED'):
                    m.require_services_stopped()


class ReleaseOwnership(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='cisme-immutable-fixture-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.release=self.root/'releases'/'candidate-main';self.release.mkdir(parents=True)
        self.dep=self.release/'node_modules'/'synthetic-package';self.dep.mkdir(parents=True)
        self.file=self.dep/'index.js';self.file.write_text('// synthetic dependency')
        self.links=self.release/'node_modules'/'.bin';self.links.mkdir()
        (self.links/'synthetic').symlink_to('../synthetic-package/index.js')
        for path in [self.root,*self.root.rglob('*')]:
            if not path.is_symlink():path.chmod(0o755 if path.is_dir() else 0o644)
        self.foreign=None

    def check(self):
        original=Path.lstat
        def fixture_stat(path,*args,**kwargs):
            info=original(path,*args,**kwargs)
            # Virtual root ownership only; no chown or production fixture.
            return SimpleNamespace(st_mode=info.st_mode,st_uid=1000 if path==self.foreign else 0)
        with patch.object(m,'ROOT',self.root),patch.object(Path,'lstat',fixture_stat):
            return m.release_directory(self.release)

    def test_immutable_dependency_tree_accepts_only_contained_bin_links(self):
        self.assertEqual(self.check(),self.release)

    def test_nested_writable_or_service_owned_dependency_is_rejected(self):
        for mode,foreign in [(0o666,None),(0o644,self.file)]:
            self.file.chmod(mode);self.foreign=foreign
            with self.subTest(mode=mode,foreign=foreign),self.assertRaises(m.observe.target.Refused):self.check()

    def test_dependency_symlink_cannot_escape_release(self):
        outside=self.root/'outside.js';outside.write_text('// outside')
        self.file.unlink();self.file.symlink_to(outside)
        with self.assertRaises(m.observe.target.Refused):self.check()


class Preflight(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='cisme-preflight-fixture-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.releases=self.root/'releases';self.releases.mkdir()
        self.old=self.releases/'old-release';self.old.mkdir();self.new=self.releases/'new-release';self.new.mkdir()
        self.current=self.root/'current';self.current.symlink_to(self.old)
        for name in ['index.js','worker.js','package-lock.json']:(self.old/name).write_text('synthetic previous')
        self.script=b'// synthetic verify entry; never executed in these tests'
        (self.new/'migrate.mjs').write_bytes(self.script)
        self.manifest={'sourceHead':HEAD,'sourceTree':TREE,'hashes':{'migrate.mjs':m.sha(self.script)},'migrations':['20260101_first.sql']}
        (self.new/'release-manifest.json').write_text(json.dumps(self.manifest))
        self.live=self.root/'runtime.env';self.live.write_text('SYNTHETIC=old')
        self.candidate=self.root/'candidate.env';self.candidate.write_text('SYNTHETIC=new')
        self.candidate_config={**m.CLOSED,'APP_SESSION_SECRET':'synthetic-same',
                               'PRIVACY_SUPPRESSION_DIR':'/var/lib/cisme/privacy-suppression'}
        self.live_config={'APP_ENV':'staging','APP_SESSION_SECRET':'synthetic-same'}
        self.trusted_script=self.script;self.calls=[];self.suppression_mode=stat.S_IFDIR|0o700

    def execute(self,services_stopped=False):
        def fetch(path):return {'type':'file','encoding':'base64','path':'scripts/release-migrate.mjs','content':base64.b64encode(self.trusted_script).decode()}
        def command(*args,**kwargs):
            if args[0][0]=='systemctl':return b'/opt/cisme/tmp /var/lib/cisme/privacy-suppression'
            self.calls.append('verify');return json.dumps({'verified':True,'sourceHead':HEAD,'sourceTree':TREE}).encode()
        with ExitStack() as stack:
            original_lstat=Path.lstat
            def fixture_lstat(path,*args,**kwargs):
                if str(path)=='/var/lib/cisme/privacy-suppression':
                    return SimpleNamespace(st_mode=self.suppression_mode,st_uid=12345)
                return original_lstat(path,*args,**kwargs)
            stack.enter_context(patch.object(Path,'lstat',fixture_lstat))
            stack.enter_context(patch.object(m.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=12345)))
            for name,value in [('ROOT',self.root),('CURRENT',self.current),('LIVE',self.live),('release_directory',lambda p:Path(p)),
                               ('protected',lambda p,*args:Path(p).read_bytes()),('receipt',lambda p:json.loads(Path(p).read_bytes())),
                               ('reviewed_main',lambda fetch:{'sha':HEAD,'tree':TREE,'ciRunId':1}),('command',command)]:stack.enter_context(patch.object(m,name,value))
            stack.enter_context(patch.object(m.observe,'identity',return_value={'instanceId':'lhins-61ikz4mi'}))
            stack.enter_context(patch.object(m.observe,'protected_environment',side_effect=lambda p:self.live_config if Path(p)==self.live else self.candidate_config))
            guard=stack.enter_context(patch.object(m.observe,'guard_for_upgrade',side_effect=lambda *a:self.calls.append('live-target-guard') or {}))
            stack.enter_context(patch.object(m.journal,'inspect',side_effect=lambda:self.calls.append('journal') or {'journal':['20260101_first.sql']}))
            stack.enter_context(patch.object(m,'local_https_ready',side_effect=lambda:self.calls.append('local-https')))
            stack.enter_context(patch.object(m,'require_services_stopped',side_effect=lambda:self.calls.append('units-stopped')))
            result=m.preflight(str(self.new),str(self.candidate),fetch,services_stopped=services_stopped)
            guard.assert_called_once_with(str(self.candidate),self.manifest,HEAD,TREE)
            return result

    def test_live_guard_is_connected_before_reading_production_journal(self):
        result=self.execute();self.assertEqual(self.calls,['verify','live-target-guard','journal','local-https'])
        self.assertFalse(result['deployed']);self.assertFalse(result['permissionGranted'])

    def test_post_stop_recheck_keeps_provenance_target_and_history_checks(self):
        self.execute(services_stopped=True)
        self.assertEqual(self.calls,['verify','live-target-guard','journal','units-stopped'])

    def test_branch_candidate_refused_before_any_candidate_execution(self):
        self.manifest['sourceHead']='c'*40;(self.new/'release-manifest.json').write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(m.observe.target.Refused,'CANDIDATE_NOT_CURRENT_MAIN'):self.execute()
        self.assertEqual(self.calls,[])

    def test_self_consistent_forged_verifier_is_not_treated_as_reviewed_main(self):
        self.trusted_script=b'// different reviewed script'
        with self.assertRaisesRegex(m.observe.target.Refused,'MIGRATION_ENTRY_NOT_REVIEWED_MAIN_SOURCE'):self.execute()
        self.assertEqual(self.calls,[])

    def test_release_cannot_implicitly_rotate_other_application_keys(self):
        self.candidate_config['APP_SESSION_SECRET']='synthetic-changed'
        with self.assertRaisesRegex(m.observe.target.Refused,'IMPLICIT_SECRET_CHANGE_REFUSED'):self.execute()
        self.assertNotIn('journal',self.calls)

    def test_release_cannot_implicitly_enable_traffic_or_mutating_workers(self):
        self.candidate_config['CISME_MIGRATION_READ_ONLY']='false'
        with self.assertRaisesRegex(m.observe.target.Refused,'CLOSED_COMMERCE_MAINTENANCE_CONFIG_REQUIRED'):self.execute()

    def test_child_process_injection_is_refused(self):
        self.candidate_config['NODE_TLS_REJECT_UNAUTHORIZED']='0'
        with self.assertRaisesRegex(m.observe.target.Refused,'PROCESS_INJECTION_CONFIGURATION_REFUSED'):self.execute()

    def test_suppression_directory_is_required_and_private(self):
        del self.candidate_config['PRIVACY_SUPPRESSION_DIR']
        with self.assertRaisesRegex(m.observe.target.Refused,'PRIVACY_SUPPRESSION_TARGET_REQUIRED'):self.execute()
        self.candidate_config['PRIVACY_SUPPRESSION_DIR']='/var/lib/cisme/privacy-suppression'
        self.suppression_mode=stat.S_IFDIR|0o755
        with self.assertRaisesRegex(m.observe.target.Refused,'PRIVACY_SUPPRESSION_DIRECTORY_UNSAFE'):self.execute()


class Qualifications(unittest.TestCase):
    def setUp(self):
        self.plan={'main':{'sha':HEAD,'tree':TREE},'manifestSha256':'c'*64,'previous':{'directory':'/fake/old'},'migrationPlan':{'pending':['20260101_next.sql']}}
        self.q={'schemaVersion':1,'kind':'reviewed-production-upgrade','instanceId':'lhins-61ikz4mi','database':'cisme',
                'candidateHead':HEAD,'candidateTree':TREE,'manifestSha256':'c'*64,'previous':self.plan['previous'],
                'approvedPendingMigrations':self.plan['migrationPlan']['pending'],'reviewReference':'synthetic-fixture-only',
                'backup':{'path':'/var/backups/cisme-predeploy/synthetic.aesgcm','sha256':'d'*64}}
        self.values={}
        for key,kind in [('restore','production-protected-restore'),('rollback','same-data-application-rollback'),('writers','production-writer-inventory-and-drain'),('migrationReview','production-history-and-sql-review')]:
            value={'kind':kind,'instanceId':'lhins-61ikz4mi','candidateHead':HEAD,'previous':self.plan['previous'],
                   'verified':True,'syntheticOnly':False,'observedAtUtc':datetime.now(timezone.utc).isoformat()}
            if key=='restore':value.update(backupSha256='d'*64,globalsAndRolesVerified=True,cosObjectRestoreVerified=True,encryptionKeyRecoveryVerified=True)
            if key=='rollback':value.update(sameDatabase=True,newWritesPreserved=True,coversPartialForwardMigration=True)
            if key=='writers':value.update(externalConsumersDisabled=True,unresolvedConsumers=[])
            if key=='migrationReview':value.update(approvedPendingMigrations=self.plan['migrationPlan']['pending'],historicalSqlIntegrityVerified=True)
            self.values[key]=value

    def check(self):
        data={}
        for key,value in self.values.items():
            b=json.dumps(value).encode();path='/synthetic/'+key;data[path]=b;self.q[key]={'path':path,'sha256':m.sha(b)}
        with patch.object(m,'receipt',return_value=self.q),patch.object(m,'protected',side_effect=lambda p,*args:data[p]),patch.object(m,'protected_digest',return_value='d'*64):
            return m.qualifications('/synthetic/qualification',self.plan)

    def test_all_reviewed_bindings_are_required(self):self.assertEqual(self.check()['database'],'cisme')

    def test_staging_target_and_test_database_refused(self):
        for key,value in [('instanceId','lhins-ei4hz4fi'),('database','cisme_test')]:
            original=self.q[key];self.q[key]=value
            with self.subTest(key=key),self.assertRaises(m.observe.target.Refused):self.check()
            self.q[key]=original

    def test_partial_restore_or_unrelated_backup_refused(self):
        for key,value in [('backupSha256','e'*64),('globalsAndRolesVerified',False),('cosObjectRestoreVerified',False),('encryptionKeyRecoveryVerified',False)]:
            original=self.values['restore'][key];self.values['restore'][key]=value
            with self.subTest(key=key),self.assertRaises(m.observe.target.Refused):self.check()
            self.values['restore'][key]=original

    def test_synthetic_restore_cannot_pass_as_production_restore(self):
        self.values['restore']['syntheticOnly']=True
        with self.assertRaises(m.observe.target.Refused):self.check()

    def test_rollback_that_would_lose_new_writes_is_refused(self):
        self.values['rollback']['newWritesPreserved']=False
        with self.assertRaises(m.observe.target.Refused):self.check()

    def test_unresolved_or_stale_external_writers_are_refused(self):
        self.values['writers']['unresolvedConsumers']=['synthetic-legacy-worker']
        with self.assertRaises(m.observe.target.Refused):self.check()
        self.values['writers']['unresolvedConsumers']=[]
        self.values['writers']['observedAtUtc']=(datetime.now(timezone.utc)-timedelta(minutes=16)).isoformat()
        with self.assertRaises(m.observe.target.Refused):self.check()

    def test_name_prefix_does_not_substitute_for_historical_sql_review(self):
        self.values['migrationReview']['historicalSqlIntegrityVerified']=False
        with self.assertRaises(m.observe.target.Refused):self.check()


class Cutover(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='cisme-synthetic-cutover-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.old=self.root/'old';self.old.mkdir();self.new=self.root/'new';self.new.mkdir();self.state=self.root/'state';self.state.mkdir()
        for name in ['index.js','worker.js','package-lock.json']:(self.old/name).write_text('synthetic previous '+name)
        self.live=self.root/'live.env';self.live.write_text('APP_ENV=staging\nDATABASE_URL=synthetic-original\n')
        self.candidate=self.root/'candidate.env';self.candidate.write_text('APP_ENV=production\nDATABASE_URL=synthetic-original\nCISME_MIGRATION_READ_ONLY=true\n')
        self.old_bytes=self.live.read_bytes();self.new_bytes=self.candidate.read_bytes();self.current=self.old
        self.plan={'main':{'sha':HEAD,'tree':TREE,'ciRunId':1},'previous':{'directory':str(self.old),
          'indexSha256':m.sha((self.old/'index.js').read_bytes()),'workerSha256':m.sha((self.old/'worker.js').read_bytes()),
          'packageLockSha256':m.sha((self.old/'package-lock.json').read_bytes())},
          'migrationPlan':{'pending':['20260101_next.sql']},'liveEnvironmentSha256':m.sha(self.old_bytes),'candidateEnvironmentSha256':m.sha(self.new_bytes)}
        self.q={'backup':{'sha256':'d'*64},'reviewReference':'synthetic-only'};self.commands=[];self.switches=[];self.business=['before-cutover']

    def execute(self,fail_health=False,fail_migration=False,clients=0,changed_env=False,stopped_api=False):
        def command(args,**kwargs):
            self.commands.append(args)
            if args[-1]=='up':
                self.business.append('new-write-after-backup')
                self.assertEqual(kwargs['env']['DATABASE_URL'],'synthetic-original')
                if fail_migration:raise m.observe.target.Refused('SYNTHETIC_PARTIAL_MIGRATION_FAILED')
                return b'{"applied":"20260101_next.sql"}\n'
            return b''
        def recheck(*args,**kwargs):
            if stopped_api and not kwargs.get('services_stopped',False):
                raise m.observe.target.Refused('PRODUCTION_LOCAL_HTTPS_NOT_READY')
            return self.plan
        def switch(directory,env,label):self.switches.append(directory);self.current=directory;self.live.write_bytes(env)
        def health(directory):
            if fail_health and directory==self.new:
                if changed_env:self.live.write_bytes(b'SYNTHETIC_OTHER_OPERATOR_CHANGE')
                raise m.observe.target.Refused('SYNTHETIC_ACTIVATION_FAILED')
        with ExitStack() as stack:
            for name,value in [('LIVE',self.live),('protected',lambda p,*a:Path(p).read_bytes()),('preflight',recheck),('command',command),('switch',switch),('healthy',health),('receipt',lambda *a:{})]:stack.enter_context(patch.object(m,name,value))
            stack.enter_context(patch.object(m.journal,'query',return_value=clients));guard=stack.enter_context(patch.object(m.observe,'guard_for_upgrade',return_value={}))
            result=m.cutover(self.plan,str(self.new),str(self.candidate),self.q,'synthetic-only',self.state)
            self.assertEqual(guard.call_count,1);return result

    def test_cutover_uses_same_database_and_closed_maintenance_mode(self):
        result=self.execute();self.assertTrue(result['deployed']);self.assertFalse(result['productionValidated']);self.assertFalse(result['commerceEnabled'])
        self.assertEqual(self.current,self.new);self.assertEqual(self.live.read_bytes(),self.new_bytes)
        self.assertTrue((self.state/'previous.env').stat().st_mode&0o777==0o600)

    def test_recheck_after_service_stop_does_not_require_an_offline_api_to_serve_https(self):
        result=self.execute(stopped_api=True)
        self.assertTrue(result['deployed'])
        self.assertEqual(self.current,self.new)

    def test_activation_failure_rolls_back_application_without_reverting_new_writes(self):
        with self.assertRaisesRegex(m.observe.target.Refused,'APPLICATION_RESTORED'):self.execute(fail_health=True)
        self.assertEqual(self.current,self.old);self.assertEqual(self.live.read_bytes(),self.old_bytes)
        self.assertIn('new-write-after-backup',self.business)
        self.assertFalse(any('pg_restore' in ' '.join(c) or 'down' in c or 'createdb' in c for c in self.commands))
        self.assertFalse(json.loads((self.state/'application-rollback.json').read_text())['databaseRestored'])

    def test_partial_forward_migration_never_triggers_old_database_restore(self):
        with self.assertRaisesRegex(m.observe.target.Refused,'APPLICATION_RESTORED'):self.execute(fail_migration=True)
        self.assertEqual(self.switches,[self.old]);self.assertIn('new-write-after-backup',self.business)

    def test_undrained_client_prevents_any_migration(self):
        with self.assertRaisesRegex(m.observe.target.Refused,'APPLICATION_RESTORED'):self.execute(clients=1)
        self.assertFalse(any(c[-1]=='up' for c in self.commands));self.assertEqual(self.business,['before-cutover'])

    def test_unknown_concurrent_environment_change_is_not_overwritten_on_rollback(self):
        with self.assertRaisesRegex(m.observe.target.Refused,'ROLLBACK_ENVIRONMENT_DRIFT'):self.execute(fail_health=True,changed_env=True)
        self.assertEqual(self.live.read_bytes(),b'SYNTHETIC_OTHER_OPERATOR_CHANGE');self.assertEqual(self.switches,[self.new])

    def test_candidate_drift_is_refused_before_stopping_services(self):
        self.candidate.write_text('SYNTHETIC_CHANGED=1\n')
        with self.assertRaisesRegex(m.observe.target.Refused,'PREPARED_ENVIRONMENT_CHANGED'):self.execute()
        self.assertEqual(self.commands,[]);self.assertEqual(self.switches,[])


if __name__=='__main__':unittest.main()
