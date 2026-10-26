import base64
from contextlib import ExitStack, redirect_stdout
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = next(parent for parent in HERE.parents if (parent/'infra/tencent/dependency-only-upgrade.py').is_file())
spec = importlib.util.spec_from_file_location('trial_application_candidate',HERE/'trial-application-upgrade.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
spec = importlib.util.spec_from_file_location('shared_dependency_tests',ROOT/'infra/tencent/test_production_dependency_upgrade.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
D = base.m
m.D = D


def before_sql(capabilities):
    return ('ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_capability_check CHECK (capability IN ('
            + ','.join("'" + value + "'" for value in capabilities) + '));').encode()


def artifacts():
    names = [f'20260101{i:04}_old.sql' for i in range(97)]
    files = {'migrate.mjs':b'original migrator','package.json':b'original package','package-lock.json':b'original lock'}
    files.update({'db/migrations/' + name:b'CREATE TABLE historical_fixture(id int);' for name in names})
    files['db/migrations/' + names[-1]] = before_sql(['support.read','privacy.request.manage'])
    old = {'manifest':{'migrations':names},'files':files}
    new = copy.deepcopy(old)
    new['manifest']['migrations'] = names + [m.MIGRATION]
    new['files']['db/migrations/' + m.MIGRATION] = before_sql(['support.read','privacy.request.manage','editorial.manage'])
    return old,new


class MigrationBoundaryTests(unittest.TestCase):
    def test_exact_97_prefix_plus_single_additive_editorial_capability(self):
        old,new = artifacts()
        self.assertEqual(m.migration_contract(old,new),{'before':['privacy.request.manage','support.read'],
                                                     'after':['editorial.manage','privacy.request.manage','support.read']})

    def test_old_sql_migrator_package_or_lock_byte_changes_rejected(self):
        for name in ('migrate.mjs','package.json','package-lock.json','db/migrations/202601010000_old.sql'):
            old,new = artifacts()
            new['files'][name] += b'changed'
            with self.subTest(name=name), self.assertRaisesRegex(m.Refused,'BASELINE_SQL_OR_DEPENDENCIES_CHANGED'):
                m.migration_contract(old,new)

    def test_missing_or_extra_sql_file_or_prefix_reordering_rejected(self):
        for mode in ('missing','extra','reorder'):
            old,new = artifacts()
            if mode == 'missing':new['manifest']['migrations'].pop(2)
            elif mode == 'extra':new['manifest']['migrations'].append('202610270001_extra.sql')
            else:new['manifest']['migrations'][0:2] = reversed(new['manifest']['migrations'][0:2])
            with self.subTest(mode=mode),self.assertRaisesRegex(m.Refused,'ONLY_EDITORIAL_MIGRATION'):
                m.migration_contract(old,new)

    def test_capability_removal_or_additional_privilege_rejected(self):
        for capabilities in (['editorial.manage'],['support.read','privacy.request.manage','editorial.manage','privacy.root']):
            old,new = artifacts()
            new['files']['db/migrations/' + m.MIGRATION] = before_sql(capabilities)
            with self.subTest(capabilities=capabilities),self.assertRaisesRegex(m.Refused,'MUST_ONLY_ADD_EDITORIAL'):
                m.migration_contract(old,new)

    def test_current_working_editorial_sql_preserves_real_dbd_capability_allowlist(self):
        names = subprocess.check_output(['git','ls-tree','-r','--name-only',m.BASELINE_HEAD,'db/migrations'],cwd=ROOT,text=True).splitlines()
        self.assertEqual(len(names),97)
        files = {name:subprocess.check_output(['git','show',m.BASELINE_HEAD + ':' + name],cwd=ROOT) for name in names}
        old = {'manifest':{'migrations':[Path(name).name for name in names]},
               'files':{**files,'migrate.mjs':b'migrator','package.json':b'package','package-lock.json':b'lock'}}
        new = copy.deepcopy(old)
        new['manifest']['migrations'].append(m.MIGRATION)
        new['files']['db/migrations/' + m.MIGRATION] = (ROOT/'db/migrations'/m.MIGRATION).read_bytes()
        result = m.migration_contract(old,new)
        self.assertEqual(set(result['after']) - set(result['before']),{'editorial.manage'})

    def test_old_b7_baseline_has_no_reusable_preflight_or_equal_runtime_call(self):
        import ast
        tree=ast.parse((HERE/'trial-application-upgrade.py').read_text())
        called=[ast.unparse(node.func) for node in ast.walk(tree) if isinstance(node,ast.Call)]
        self.assertFalse(any(name in called for name in ('D.preflight','D.equal_runtime','D.permit','D.apply','D.cutover')))

    def test_production_release_and_unknown_stage_paths_rejected_before_file_access(self):
        with self.assertRaises(D.Refused):
            D.artifact('/opt/cisme/releases/production-candidate',Path('/opt/cisme-trial'))
        with self.assertRaisesRegex(m.Refused,'STAGE_RECEIPT_REQUIRED'):
            m.archive_binding(SimpleNamespace(stage_receipt='/opt/cisme/releases/candidate/stage-receipt.json'),{})

    def test_production_database_env_rejected_before_artifact_or_command(self):
        config=b'APP_ENV=staging\nDATABASE_URL=postgresql://cisme:synthetic@127.0.0.1:5432/cisme\nALLOW_DEV_ADAPTERS=false\n'
        with patch.object(m.os,'geteuid',return_value=0),patch.object(D.general.observe,'identity',return_value={'instanceId':'lhins-61ikz4mi'}), \
             patch.object(D,'owned_directory'),patch.object(D,'environment_metadata'), \
             patch.object(D,'read_owned',return_value=config),patch.object(D,'artifact') as artifact,patch.object(D,'command') as command:
            with self.assertRaisesRegex(m.Refused,'TRIAL_DATABASE_AND_CLOSED_CONTEXT'):
                m.preflight(SimpleNamespace())
            artifact.assert_not_called();command.assert_not_called()

    def test_stage_receipt_binds_only_trial_and_reuses_validated_receipt_bytes(self):
        archive=b'fixture archive bytes'
        directory='/opt/cisme-trial/releases/candidate-application'
        path=m.STAGES/'fixture-stage/stage-receipt.json'
        args=SimpleNamespace(stage_receipt=str(path),head='a'*40,tree='b'*40,manifest_sha256='c'*64,
                             archive_sha256=m.sha(archive),archive_bytes=len(archive))
        candidate={'directory':directory,'manifestSha256':'c'*64,'dependenciesSha256':'d'*64}
        receipt={'staged':True,'deployed':False,'instanceId':'lhins-61ikz4mi','publicIpv4':'124.223.74.198',
                 'privateStage':str(path.parent),'sourceHead':args.head,'sourceTree':args.tree,
                 'archiveSha256':args.archive_sha256,'archiveSize':len(archive),'manifestSha256':'c'*64,
                 'dependenciesSha256':'d'*64,'migrations':98,'candidateDirectories':[directory],
                 'servicesChanged':False,'databaseChanged':False,'configurationChanged':False,
                 'productionChanged':False,'peerFilesChanged':False}
        for include_production in (False,True):
            value=copy.deepcopy(receipt)
            if include_production:value['candidateDirectories'].append('/opt/cisme/releases/candidate-application')
            raw=json.dumps(value).encode()
            with patch.object(m,'parents'),patch.object(m,'read',side_effect=lambda p,*a,**k: raw if p==path else archive) as read:
                if include_production:
                    with self.assertRaisesRegex(m.Refused,'STAGE_BINDING_MISMATCH'):m.archive_binding(args,candidate)
                else:
                    binding=m.archive_binding(args,candidate)
                    self.assertEqual(binding['receiptSha256'],m.sha(raw));self.assertEqual(read.call_count,2)


class SourceTransportTests(unittest.TestCase):
    def response(self,document,extra=0):
        raw=json.dumps(document).encode()
        class Response:
            status=200
            headers={'Content-Length':str(len(raw)+extra)}
            def __enter__(self):return self
            def __exit__(self,*args):return False
            def read(self,n):
                value=self.data[:min(17,n)];self.data=self.data[len(value):];return value
        value=Response();value.data=raw;return value

    def document(self,data=b'root-owned package source'):
        return {'type':'file','path':'package.json','encoding':'base64','size':len(data),
                'sha':hashlib.sha1(('blob '+str(len(data))+'\0').encode()+data).hexdigest(),
                'content':base64.b64encode(data).decode()}

    def test_contents_api_complete_loop_and_git_blob_sha(self):
        document=self.document()
        opener=SimpleNamespace(open=lambda request,timeout:self.response(document))
        with patch.object(m.urllib.request,'build_opener',return_value=opener):
            self.assertEqual(m.github_source('package.json','a'*40),b'root-owned package source')

    def test_truncation_and_wrong_git_blob_sha_fail_closed(self):
        document=self.document()
        with patch.object(m.urllib.request,'build_opener',return_value=SimpleNamespace(open=lambda *a,**k:self.response(document,1))):
            with self.assertRaisesRegex(m.Refused,'SOURCE_TRUNCATED'):m.github_source('package.json','a'*40)
        document['sha']='b'*40
        with patch.object(m.urllib.request,'build_opener',return_value=SimpleNamespace(open=lambda *a,**k:self.response(document))):
            with self.assertRaisesRegex(m.Refused,'SOURCE_BLOB_MISMATCH'):m.github_source('package.json','a'*40)

    def test_unapproved_paths_refuse_before_network(self):
        with patch.object(m.urllib.request,'build_opener') as opener:
            for name in ('runtime.env','db/migrations/other.sql','../../runtime.env'):
                with self.subTest(name=name),self.assertRaisesRegex(m.Refused,'RESOURCE_REFUSED'):
                    m.github_source(name,'a'*40)
            opener.assert_not_called()

    def test_public_cli_does_not_export_exception_secret_value(self):
        args=['tool','--release','/opt/cisme-trial/releases/candidate','--head','a'*40,'--tree','b'*40,
              '--ci-run-id','123','--manifest-sha256','c'*64,'--archive-sha256','d'*64,
              '--archive-bytes','100','--stage-receipt','/private/stage-receipt.json']
        out=io.StringIO()
        with patch.object(sys,'argv',args),patch.object(m,'configure_shared',side_effect=ValueError('synthetic-private-password-and-url')),redirect_stdout(out):
            self.assertEqual(m.main(),1)
        self.assertNotIn('synthetic-private',out.getvalue())
        self.assertEqual(json.loads(out.getvalue())['privateValuesExported'],False)


class RealNodeCryptoTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.root.chmod(0o700)
        self.file=self.root/'snapshot.aesgcm';self.key=self.root/'snapshot.key';self.aad='trial+dbd+operation-fixture'
        self.data=b'PGDMP'+os.urandom(130000)
        self.node=shutil.which('node')
        self.assertTrue(self.node)
        self.patch=patch.object(m,'NODE',self.node);self.patch.start();self.addCleanup(self.patch.stop)
        p=self.run_crypto('encrypt',input=self.data)
        self.assertEqual(p.returncode,0,p.stderr.decode())
        self.expected=json.loads(p.stdout)

    def run_crypto(self,mode,input=None,aad=None,key=None):
        return subprocess.run(m.crypto_args(mode,self.file,key or self.key,aad or self.aad),input=input,capture_output=True,timeout=20)

    def test_aes_gcm_authenticated_plain_hash_and_decrypted_bytes(self):
        self.assertEqual(self.expected['plainSha256'],hashlib.sha256(self.data).hexdigest())
        self.assertEqual(self.expected['plainBytes'],len(self.data))
        p=self.run_crypto('verify');self.assertEqual(p.returncode,0)
        self.assertTrue(json.loads(p.stdout)['authenticated'])
        self.assertEqual(json.loads(p.stdout)['plainSha256'],self.expected['plainSha256'])
        self.assertEqual(self.run_crypto('decrypt').stdout,self.data)
        self.assertEqual(self.file.stat().st_mode&0o777,0o600)
        self.assertEqual(self.key.stat().st_mode&0o777,0o600)

    def test_ciphertext_content_tampering_fails_authentication(self):
        raw=bytearray(self.file.read_bytes());raw[100]^=1;self.file.write_bytes(raw)
        p=self.run_crypto('verify');self.assertNotEqual(p.returncode,0)
        self.assertNotIn(b'plainSha256',p.stdout)

    def test_wrong_key_or_operation_aad_fails_authentication(self):
        other=self.root/'other.key';other.write_bytes(os.urandom(32));other.chmod(0o600)
        for key,aad in ((other,self.aad),(self.key,'another-operation')):
            with self.subTest(key=key.name,aad=aad):
                p=self.run_crypto('verify',key=key,aad=aad);self.assertNotEqual(p.returncode,0)
                self.assertEqual(p.stdout,b'')

    def test_existing_output_not_overwritten_and_symlink_key_refused(self):
        before=self.file.read_bytes();key_before=self.key.read_bytes()
        self.assertNotEqual(self.run_crypto('encrypt',input=self.data).returncode,0)
        self.assertEqual(self.file.read_bytes(),before);self.assertEqual(self.key.read_bytes(),key_before)
        link=self.root/'link.key';link.symlink_to(self.key)
        self.assertNotEqual(self.run_crypto('verify',key=link).returncode,0)

    def test_group_readable_key_refused(self):
        self.key.chmod(0o640)
        self.assertNotEqual(self.run_crypto('verify').returncode,0)


class SnapshotPipelineTests(unittest.TestCase):
    """Real Node crypto/pipes; synthetic pg_dump and pg_restore, no database."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.state=self.root/'operation-fixture';self.state.mkdir(mode=0o700)
        self.plan={'profile':{**D.PROFILES['trial'],'name':'trial'},
                   'config':{'DATABASE_URL':'postgresql://cisme_trial:synthetic-private@127.0.0.1:5432/cisme_trial'}}
        self.dump_data=b'PGDMP'+os.urandom(140000)
        self.dump_status=0
        self.toc='; dbname: cisme_trial\n1; 0 0 TABLE DATA public schema_migration cisme_trial\n'
        self.calls=[]
        real_popen=subprocess.Popen
        def popen(args,**kwargs):
            if args[0]=='/usr/sbin/runuser' and '/usr/bin/pg_dump'in args:
                self.calls.append((args,kwargs))
                code='import sys,base64;sys.stdout.buffer.write(base64.b64decode('+repr(base64.b64encode(self.dump_data).decode())+'));sys.exit('+str(self.dump_status)+')'
                return real_popen([sys.executable,'-c',code],**kwargs)
            if args[:2]==['/usr/bin/pg_restore','--list']:
                self.calls.append((args,kwargs))
                return real_popen([sys.executable,'-c','import sys;sys.stdin.buffer.read();sys.stdout.write('+repr(self.toc)+')'],**kwargs)
            return real_popen(args,**kwargs)
        def checked_parents(path,private=False):
            self.assertTrue(path.is_relative_to(self.root))
            self.assertEqual(path.parent.stat().st_mode&0o777,0o700)
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.object(m,'OWNER',os.getuid()))
        stack.enter_context(patch.object(D,'OWNER',os.getuid()))
        stack.enter_context(patch.object(m,'NODE',shutil.which('node')))
        stack.enter_context(patch.object(m,'parents',side_effect=checked_parents))
        stack.enter_context(patch.object(m.subprocess,'Popen',side_effect=popen))

    def test_snapshot_pipe_and_private_receipt_are_revalidated_before_migration(self):
        record=m.snapshot(self.plan,self.state,'fixture-approval')
        self.assertEqual(record['plainSha256'],hashlib.sha256(self.dump_data).hexdigest())
        self.assertTrue(record['authenticated']);self.assertTrue(record['pgRestoreListVerified'])
        self.assertFalse(record['restorePerformed']);self.assertFalse(record['fullRecoveryQualified'])
        m.validate_snapshot(record,self.state,'fixture-approval')
        dump_args,dump_kwargs=self.calls[0]
        self.assertIn('--dbname=cisme_trial',dump_args);self.assertIn('--username=cisme_trial',dump_args)
        self.assertIn('default_transaction_read_only=on',dump_kwargs['env']['PGOPTIONS'])
        self.assertNotIn('DATABASE_URL',dump_kwargs['env'])
        self.assertEqual(self.calls[1][0],['/usr/bin/pg_restore','--list'])
        self.assertFalse(any(p.suffix=='.dump'for p in self.state.rglob('*')))
        self.assertEqual(Path(record['keyFile']).stat().st_mode&0o777,0o600)

    def test_dump_nonzero_refuses_even_if_encryption_received_valid_prefix(self):
        self.dump_status=1
        with self.assertRaisesRegex(m.Refused,'SNAPSHOT_DUMP_FAILED'):
            m.snapshot(self.plan,self.state,'fixture-approval')
        self.assertFalse((self.state/'predeploy-database/snapshot-private.json').exists())

    def test_wrong_database_toc_does_not_create_success_receipt(self):
        self.toc='; dbname: cisme\nTABLE DATA public schema_migration cisme\n'
        with self.assertRaisesRegex(m.Refused,'SNAPSHOT_STRUCTURE_FAILED'):
            m.snapshot(self.plan,self.state,'fixture-approval')
        self.assertFalse((self.state/'predeploy-database/snapshot-private.json').exists())

    def test_snapshot_receipt_or_cipher_tamper_blocks_migration(self):
        record=m.snapshot(self.plan,self.state,'fixture-approval')
        path=Path(record['encryptedFile']);raw=bytearray(path.read_bytes());raw[100]^=1;path.write_bytes(raw)
        with self.assertRaisesRegex(m.Refused,'SNAPSHOT_CHANGED'):
            m.validate_snapshot(record,self.state,'fixture-approval')

    def test_production_dump_context_refused_before_directory_or_subprocess(self):
        self.plan['config']['DATABASE_URL']='postgresql://cisme:synthetic@127.0.0.1:5432/cisme'
        with self.assertRaisesRegex(m.Refused,'SNAPSHOT_TRIAL_DATABASE_REQUIRED'):
            m.snapshot(self.plan,self.state,'fixture-approval')
        self.assertEqual(list(self.state.iterdir()),[]);self.assertEqual(self.calls,[])


class CutoverTests(base.DependencyUpgradeTests):
    # Reuse only the reviewed unit/drop-in fixture, not its inherited test cases.
    def setUp(self):
        super().setUp()
        m.D=D
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(m,'ROOT',self.root))
        self.stack.enter_context(patch.object(D,'PROFILES',{'trial':{k:v for k,v in self.profile.items() if k!='name'}}))
        self.stack.enter_context(patch.object(D.general.observe,'identity',return_value={'instanceId':'lhins-61ikz4mi'}))
        self.stack.enter_context(patch.object(D.general,'reviewed_main',return_value=self.main))
        self.stack.enter_context(patch.object(D,'artifact',side_effect=lambda path,root:self.old if str(path)==self.old['directory'] else self.new))
        self.stack.enter_context(patch.object(D,'command',side_effect=self.command))
        self.stack.enter_context(patch.object(D,'stopped',return_value=None))
        self.old['manifest']['sourceHead']=m.BASELINE_HEAD;self.old['manifest']['sourceTree']=m.BASELINE_TREE
        self.new['manifest']['sourceHead']=self.main['sha'];self.new['manifest']['sourceTree']=self.main['tree']
        self.plan['capabilities']={'before':['support.read'],'after':['support.read','editorial.manage']}
        self.journal_state=list(self.old['manifest']['migrations'])
        active=b'{"baseline":"dbd-only-historical-fixture"}\n'
        (self.root/'dependency-active-release.json').write_bytes(active)
        (self.root/'dependency-active-release.json').chmod(0o600)
        self.plan.update({'dependencyActiveBytes':active,'applicationActiveBytes':None})
        receipt=self.root/'receipt.json';receipt.write_bytes(b'{"fixture":true}');receipt.chmod(0o600)
        self.plan['archiveBinding']={'receipt':str(receipt),'receiptSha256':m.sha(receipt.read_bytes())}
        self.stack.enter_context(patch.object(m,'OWNER',os.getuid()))
        self.stack.enter_context(patch.object(m,'journal',side_effect=self.check_journal))
        self.snapshot= self.stack.enter_context(patch.object(m,'snapshot',return_value={'authenticated':True,'fixtureOnly':True}))
        self.migration=self.stack.enter_context(patch.object(m,'migrate',side_effect=self.migration_up))
        self.health=self.stack.enter_context(patch.object(D,'healthy',return_value={'fastify':'5.12.6','sharp':'0.35.5'}))
        self.state=self.root/'state';self.state.mkdir(mode=0o700)

    def command(self,args,**kwargs):
        self.calls.append(tuple(args))
        return b''

    def check_journal(self,plan,allowed):
        m.need(self.journal_state in allowed,'APPLICATION_DATABASE_OR_DRAIN_DRIFT')
        return self.journal_state

    def migration_up(self,plan,backup,approval,state):
        self.journal_state=list(self.new['manifest']['migrations'])

    def test_application_success_preserves_initial_and_dependency_history(self):
        before={name:(self.root/name).read_bytes() for name in self.initial}
        dep=(self.root/'dependency-active-release.json').read_bytes()
        report=m.cutover(self.plan,self.state,'fixture-approval')
        self.assertTrue(report['deployed']);self.assertFalse(report['databaseRestored']);self.assertFalse(report['productionChanged'])
        self.assertEqual((self.root/'dependency-active-release.json').read_bytes(),dep)
        self.assertEqual({name:(self.root/name).read_bytes() for name in self.initial},before)
        active=json.loads((self.root/'application-active-release.json').read_bytes())
        self.assertEqual(active['kind'],'trial-application-active-release')
        self.assertEqual(active['sourceHead'],self.main['sha'])
        self.assertEqual(next(call for call in self.calls if call[0]=='systemctl'),('systemctl','stop',*self.profile['units']))
        self.assertTrue(all('cisme-api.service'not in call and 'cisme-worker.service'not in call for call in self.calls))

    def test_migration_failure_recovers_old_application_without_down_or_restore(self):
        self.migration.side_effect=RuntimeError('private driver failure')
        with self.assertRaisesRegex(m.Refused,'FAILED_OLD_APPLICATION_RESTORED'):
            m.cutover(self.plan,self.state,'fixture-approval')
        self.health.assert_called_once()
        self.assertEqual(self.health.call_args.args[1],self.old['directory'])
        self.assertTrue(json.loads((self.root/'application-active-release.json').read_bytes())['applicationRollback'])
        self.assertFalse(any('down'in call or 'pg_restore'in call for call in self.calls))

    def test_health_failure_preserves_committed_additive_schema_when_old_app_returns(self):
        self.new['manifest']['migrations']=self.old['manifest']['migrations']+[m.MIGRATION]
        self.health.side_effect=[RuntimeError('new API fails'),{'fastify':'5.12.6','sharp':'0.35.5'}]
        with self.assertRaisesRegex(m.Refused,'FAILED_OLD_APPLICATION_RESTORED'):
            m.cutover(self.plan,self.state,'fixture-approval')
        self.assertEqual(self.journal_state,self.new['manifest']['migrations'])
        active=json.loads((self.root/'application-active-release.json').read_bytes())
        self.assertEqual(active['sourceHead'],m.BASELINE_HEAD)
        self.assertTrue(active['databaseMayIncludeAdditiveEditorialMigration'])

    def test_unknown_active_drift_fences_before_old_app_restart(self):
        def fail_with_drift(*args):
            (self.root/'application-active-release.json').write_bytes(b'{"unknown":true}')
            (self.root/'application-active-release.json').chmod(0o600)
            raise RuntimeError('candidate failed')
        self.health.side_effect=fail_with_drift
        with self.assertRaisesRegex(m.Refused,'FAILED_FENCED_REVIEW_REQUIRED'):
            m.cutover(self.plan,self.state,'fixture-approval')
        starts=[call for call in self.calls if call[:2]==('systemctl','start')]
        self.assertEqual(len(starts),1)
        self.assertEqual((self.root/'application-active-release.json').read_bytes(),b'{"unknown":true}')

    def test_unknown_unit_or_env_drift_fences_before_old_app_restart(self):
        for kind in ('unit','env'):
            with self.subTest(kind=kind):
                # Each fixture execution needs new exclusive state files.
                if kind=='env':
                    self.tearDown();self.doCleanups();self.setUp()
                def fail_with_drift(*args):
                    path=self.units/self.profile['units'][0] if kind=='unit' else self.root/'runtime.env'
                    path.write_bytes(path.read_bytes()+b'\n# unknown root edit\n')
                    raise RuntimeError('candidate failed')
                self.health.side_effect=fail_with_drift
                with self.assertRaisesRegex(m.Refused,'FAILED_FENCED_REVIEW_REQUIRED'):
                    m.cutover(self.plan,self.state,'fixture-approval')
                self.assertEqual(len([c for c in self.calls if c[:2]==('systemctl','start')]),1)

    def test_production_profile_refused_before_any_state_or_service_write(self):
        plan=copy.deepcopy(self.plan);plan['profile']['name']='production';plan['profile']['root']='/opt/cisme'
        with self.assertRaisesRegex(m.Refused,'TRIAL_ONLY'):m.cutover(plan,self.state,'fixture-approval')
        self.assertEqual(list(self.state.iterdir()),[]);self.assertEqual(self.calls,[])

    def test_missing_real_snapshot_files_prevent_migration_command(self):
        backup={'authenticated':True,'pgRestoreListVerified':True,'database':'cisme_trial','baseline':m.BASELINE_HEAD,
                'scope':'same-host-database-only','restorePerformed':False,'backupReference':'TRIAL-EMPTY-old'}
        with self.assertRaisesRegex(m.Refused,'REAL_SNAPSHOT_REQUIRED'):
            m.validate_snapshot(backup,self.state,'fixture-approval')


# Avoid inheriting the old dependency helper's entire existing suite. Only this
# new class's declared tests target the new application upgrade entry.
for _name in dir(base.DependencyUpgradeTests):
    if _name.startswith('test_') and _name not in CutoverTests.__dict__:
        setattr(CutoverTests,_name,None)

if __name__=='__main__':unittest.main()
