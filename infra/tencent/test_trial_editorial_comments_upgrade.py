import ast
import copy
from contextlib import contextmanager,ExitStack,redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
spec=importlib.util.spec_from_file_location('comments_upgrade',HERE/'trial-editorial-comments-upgrade.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
PROFILE={'root':'/opt/cisme-trial','user':'cisme-trial','database':'cisme_trial','domain':'staging-api.cisme.cn',
 'units':('cisme-trial-api.service','cisme-trial-worker.service'),'lock':'/run/lock/cisme-production-trial.lock','name':'trial'}

def artifacts():
    # Explicit historical scope: adding future migrations cannot silently alter
    # this synthetic baseline fixture or the45091 guard contract.
    migrations=sorted(p.name for p in (REPO/'db/migrations').glob('*.sql')if p.name<= '202610260001_owned_editorial.sql')
    assert len(migrations)==98
    files={name:('synthetic-old:'+name).encode()for name in ['index.js','worker.js','worker-once.js','migrate.mjs','package.json','package-lock.json']}
    files.update({'db/migrations/'+name:('synthetic-old:'+name).encode()for name in migrations})
    manifest={'schemaVersion':1,'sourceHead':M.BASELINE_HEAD,'sourceTree':M.BASELINE_TREE,'sourceLockSha256':M.SOURCE_LOCK,
      'node':'v24.14.0','buildPlatform':{'os':'linux','arch':'x64','libc':'glibc'},'configurationIncluded':False,'deployed':False,'releaseReady':False,
      'migrations':migrations,'hashes':{name:hashlib.sha256(raw).hexdigest()for name,raw in files.items()}}
    manifest['hashes']['index.js']=M.BASELINE_INDEX
    old={'directory':str(M.ROOT/'releases'/('tencent-release-'+M.BASELINE_HEAD[:12])),'manifest':manifest,
      'manifestSha256':M.BASELINE_MANIFEST,'dependenciesSha256':M.DEPENDENCIES,'files':files}
    b={'schemaVersion':1,'kind':'trial-editorial-comments-upgrade','baselineHead':M.BASELINE_HEAD,'baselineTree':M.BASELINE_TREE,
      'sourceHead':'1'*40,'sourceTree':'2'*40,'ciRunId':123,'helperSha256':'a'*64,'manifestSha256':'b'*64,
      'archiveSha256':'c'*64,'archiveBytes':123,'stageReceiptSha256':'d'*64,'compatibilitySha256':'e'*64,
      'dependenciesSha256':M.DEPENDENCIES,'migrations':99,'migrationSha256':M.MIGRATION_SHA,
      'stageReceipt':str(M.STAGES/'synthetic-stage/stage-receipt.json'),'compatibilityReceipt':str(M.STAGES/'synthetic-stage/rollback-compatibility.json')}
    candidate=copy.deepcopy(old);candidate.update(directory=str(M.ROOT/'releases'/('tencent-release-'+b['sourceHead'][:12])),manifestSha256=b['manifestSha256'])
    candidate['manifest'].update(sourceHead=b['sourceHead'],sourceTree=b['sourceTree'],migrations=migrations+[M.MIGRATION])
    candidate['files']['db/migrations/'+M.MIGRATION]=(REPO/'db/migrations'/M.MIGRATION).read_bytes()
    for name in ['index.js','worker.js','worker-once.js']:candidate['files'][name]=b'synthetic-new:'+name.encode()
    return old,candidate,b

def compatible(old):
    return {'schemaVersion':1,'kind':'trial-baseline-schema99-compatibility','baselineHead':M.BASELINE_HEAD,'baselineTree':M.BASELINE_TREE,
      'baselineManifestSha256':M.BASELINE_MANIFEST,'baselineArchiveSha256':M.BASELINE_ARCHIVE,'indexSha256':M.BASELINE_INDEX,
      'dependenciesSha256':M.DEPENDENCIES,'migrationSha256':M.MIGRATION_SHA,'node':'v24.14.0',
      'platform':{'os':'linux','arch':'x64','libc':'glibc'},'actualLinuxArtifactExecuted':True,'disposableDatabase':True,'passed':True,
      'checks':dict.fromkeys(['healthReady','currentLegal','articles','imageMedia','videoMedia','existingReactions'],True)}

class PermitTests(unittest.TestCase):
    def test_exact98_plus_only99_application_change_allowed(self):
        M.artifact_contract(*artifacts())

    def test_every_old_sql_migrator_package_and_lock_byte_is_bound(self):
        old,new,b=artifacts()
        names=['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+name for name in old['manifest']['migrations']]
        self.assertEqual(len(names),101)
        for name in names:
            with self.subTest(file=name):
                changed=copy.deepcopy(new);changed['files'][name]+=b'changed'
                with self.assertRaisesRegex(M.Refused,'OLD_SQL_OR_DEPENDENCY'):M.artifact_contract(old,changed,b)

    def test_extra_missing_reordered_sql_or_changed99_refused(self):
        old,new,b=artifacts()
        for changes in [new['manifest']['migrations']+['202610290001_unreviewed.sql'],new['manifest']['migrations'][:-1],list(reversed(new['manifest']['migrations']))]:
            changed=copy.deepcopy(new);changed['manifest']['migrations']=changes
            with self.assertRaisesRegex(M.Refused,'EXACT_98_PLUS_99'):M.artifact_contract(old,changed,b)
        new['files']['db/migrations/'+M.MIGRATION]+=b'-- unreviewed'
        with self.assertRaisesRegex(M.Refused,'SQL99_HASH'):M.artifact_contract(old,new,b)

    def test_wrong_baseline_platform_source_or_full_dependencies_refused(self):
        old,new,b=artifacts()
        changed=copy.deepcopy(old);changed['manifest']['sourceHead']='f'*40
        with self.assertRaisesRegex(M.Refused,'45091_ARTIFACT'):M.artifact_contract(changed,new,b)
        for key,value in [('sourceHead','f'*40),('buildPlatform',{'os':'darwin','arch':'arm64','libc':None}),('releaseReady',True)]:
            changed=copy.deepcopy(new);changed['manifest'][key]=value
            with self.assertRaisesRegex(M.Refused,'EXACT_LINUX'):M.artifact_contract(old,changed,b)
        new['dependenciesSha256']='0'*64
        with self.assertRaisesRegex(M.Refused,'FULL_DEPENDENCY'):M.artifact_contract(old,new,b)

    def test_profile_cannot_be_turned_into_production(self):
        M.fixed_profile(PROFILE)
        for key,value in [('root','/opt/cisme'),('database','cisme'),('user','root'),('units',('cisme-api.service','cisme-worker.service'))]:
            with self.assertRaisesRegex(M.Refused,'TRIAL_ONLY'):M.fixed_profile({**PROFILE,key:value})

    def test_compatibility_requires_actual_old_linux_artifact_and_all_checks(self):
        old,new,b=artifacts();receipt=compatible(old)
        def run(value):
            raw=json.dumps(value).encode();binding={**b,'compatibilitySha256':M.sha(raw)}
            with patch.object(M,'read',return_value=raw):return M.compatibility(binding,old)
        self.assertTrue(run(receipt)['passed'])
        for key,value in [('baselineHead','f'*40),('indexSha256','f'*64),('migrationSha256','f'*64),('actualLinuxArtifactExecuted',False),('disposableDatabase',False),('platform',{'os':'darwin','arch':'arm64','libc':None})]:
            with self.subTest(key=key),self.assertRaisesRegex(M.Refused,'ACTUAL_BASELINE_AT_99'):run({**receipt,key:value})
        receipt['checks']['videoMedia']=False
        with self.assertRaisesRegex(M.Refused,'ACTUAL_BASELINE_AT_99'):run(receipt)
        with patch.object(M,'read',return_value=b'changed'):
            with self.assertRaisesRegex(M.Refused,'COMPATIBILITY_HASH'):M.compatibility(b,old)

    def test_current_main_tree_and_latest_push_ci_must_all_match(self):
        old,new,b=artifacts();main={'sha':b['sourceHead'],'tree':b['sourceTree'],'ciRunId':b['ciRunId']}
        for key in main:
            changed={**main,key:'f'*40 if key!='ciRunId'else 999}
            with patch.object(M,'github_source')as network:
                with self.assertRaisesRegex(M.Refused,'LATEST_MAIN_PUSH_CI'):M.source_permit(b,new,changed)
                network.assert_not_called()

    def test_source_allowlist_refuses_unsafe_paths_before_network(self):
        for name in ['runtime.env','db/migrations/../secret','db/migrations/202610260001_owned_editorial.sql']:
            with patch.object(M.urllib.request,'build_opener')as network:
                with self.assertRaisesRegex(M.Refused,'SOURCE_PATH'):M.github_source(name,'a'*40)
                network.assert_not_called()

    def test_bounded_full_read_rejects_truncation_and_oversize(self):
        class Response:
            status=200
            def __init__(self,body,length):self.body=body;self.headers={'Content-Length':str(length)}
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self,n):chunk,self.body=self.body[:n],self.body[n:];return chunk
        fake=types.SimpleNamespace(general=types.SimpleNamespace(REPO='synthetic/repo',observe=types.SimpleNamespace(NoRedirect=lambda:object())))
        for body,length,code in [(b'short',100,'SOURCE_TRUNCATED'),(b'x',1024*1024+1,'SOURCE_SIZE')]:
            opener=types.SimpleNamespace(open=lambda *a,**k:Response(body,length))
            with patch.object(M,'D',fake),patch.object(M.urllib.request,'build_opener',return_value=opener):
                with self.assertRaisesRegex(M.Refused,code):M.github_source('package.json','a'*40)

    def test_private_codec_roundtrips_bytes_tuples_and_never_executes_data(self):
        value={'env':b'synthetic-private=only-root','units':('one','two'),'nested':[{'bytes':b'abc'}]}
        self.assertEqual(M.decode_private(M.parse(json.dumps(M.encode_private(value)))),value)
        with self.assertRaisesRegex(M.Refused,'RESERVED_KEY'):M.encode_private({'__cisme_bytes_v1':'not-code'})
        with self.assertRaisesRegex(M.Refused,'CODEC_INVALID'):M.decode_private({'__cisme_bytes_v1':'abc','extra':'x'})

    def test_author_and_publisher_facts_cannot_drift_behind_unchanged_content_hash(self):
        baseline={'publishedCount':20,'items':[['synthetic-article',1,'unchanged-content-hash','published',[],
          'synthetic-author','公开作者','synthetic-publisher','wechat_miniprogram:synthetic','active','active',
          [['synthetic-author-identity','wechat_miniprogram','wechat',M.APP_ID]],
          [['synthetic-publisher-identity','wechat_miniprogram','wechat',M.APP_ID]]]]}
        query=unittest.mock.Mock(return_value=baseline)
        fake=types.SimpleNamespace(query=query,verify_context=lambda *a,**kw:None)
        with patch.object(M,'D',fake):
            self.assertEqual(M.article_fence(PROFILE),baseline)
        sql=query.call_args.args[1]
        for field in ['author_member_id','author_display_name','published_by','published_principal_id','author.status','publisher.status','w.provider','w.adapter','w.app_id','w.id']:
            self.assertIn(field,sql)
        self.assertNotIn('openid',sql.lower())
        receipt=b'public synthetic receipt';plan={'profile':PROFILE,'production':{'config':{}},'config':{},'binding':{'stageReceiptSha256':M.sha(receipt)},
          'stageReceipt':'/private/stage-receipt.json','old':{},'articleFence':baseline}
        # Each attribution field changes while the article id/version/hash and
        # media stay identical. The real context comparator must fail closed.
        for index in range(5,13):
            changed=copy.deepcopy(baseline);changed['items'][0][index]='changed-actor-fact'
            fake.query.return_value=changed
            with self.subTest(field=index),patch.object(M,'D',fake),patch.object(M,'read',return_value=receipt),\
              patch.object(M,'verify_history'),patch.object(M,'production_preserved'),patch.object(M,'six_keys'),patch.object(M,'compatibility'):
                with self.assertRaisesRegex(M.Refused,'EXISTING_ARTICLE_FACTS_DRIFT'):M.verify_context(plan)

    def test_snapshot_primitives_exactly_match_reviewed1209_source(self):
        def definitions(path):
            text=path.read_text();values={}
            for node in ast.parse(text).body:
                name=node.targets[0].id if isinstance(node,ast.Assign)and isinstance(node.targets[0],ast.Name)else getattr(node,'name',None)
                if name in {'SNAPSHOT_JS','crypto_args','private_hash','snapshot','validate_snapshot'}:values[name]=ast.get_source_segment(text,node)
            return values
        self.assertEqual(definitions(HERE/'trial-editorial-comments-upgrade.py'),definitions(HERE/'trial-no-schema-upgrade.py'))

    def test_public_cli_sanitizes_driver_errors(self):
        out=io.StringIO();args=['tool','--binding','/private/binding.json','--binding-sha256','a'*64]
        with patch.object(sys,'argv',args),patch.object(M,'binding',side_effect=RuntimeError('synthetic-password-url-credential')),redirect_stdout(out):
            self.assertEqual(M.main(),1)
        self.assertNotIn('synthetic-password',out.getvalue());self.assertFalse(json.loads(out.getvalue())['privateValuesExported'])

class MetadataTests(unittest.TestCase):
    @contextmanager
    def files(self,mode=0o755):
        with tempfile.TemporaryDirectory()as temporary:
            base=Path(temporary).resolve();root=base/'trial';root.mkdir(mode=mode);root.chmod(mode);original=Path.lstat
            def lstat(path,*args,**kwargs):
                value=original(path,*args,**kwargs)
                if path==base or path.is_relative_to(base):return value
                self.assertIn(path,base.parents);fields=list(value);fields[0]=stat.S_IFDIR|0o755;fields[4]=M.OWNER;return os.stat_result(fields)
            with patch.object(M,'ROOT',root),patch.object(M,'OWNER',os.getuid()),patch.object(Path,'lstat',lstat):yield base,root

    def test_only_six_known_private_root_records_allow_traversable_parents(self):
        for mode in (0o700,0o750,0o755):
            with self.files(mode)as(base,root):
                for name in ('application-active-release.json','dependency-active-release.json',M.ACTIVE_NAME,
                  'ownership.json','empty-database.json','migration-complete.json'):
                    path=root/name;path.write_bytes(b'public-fixture');path.chmod(0o600)
                    self.assertEqual(M.read(path,private=True),b'public-fixture')
                path=root/'unknown.json';path.write_bytes(b'unknown');path.chmod(0o600)
                if mode!=0o700:
                    with self.assertRaisesRegex(M.Refused,'PRIVATE_PARENT'):M.read(path,private=True)

    def test_link_hardlink_or_group_readable_record_refused(self):
        with self.files()as(base,root):
            path=root/M.ACTIVE_NAME;path.write_bytes(b'public-fixture');path.chmod(0o640)
            with self.assertRaisesRegex(M.Refused,'PROTECTED_FILE'):M.read(path,private=True)
            path.chmod(0o600);alias=root/'alias.json';os.link(path,alias)
            with self.assertRaisesRegex(M.Refused,'PROTECTED_FILE'):M.read(path,private=True)
            alias.unlink();link=root/'linked.json';link.symlink_to(path)
            with self.assertRaises((M.Refused,OSError)):M.read(link,private=True)
            base.chmod(0o777)
            with self.assertRaisesRegex(M.Refused,'PROTECTED_PARENT'):M.read(path,private=True)

class CutoverTests(unittest.TestCase):
    def exercise(self,failure=None):
        old,new,b=artifacts();events=[];writes={};state=M.STATE_PARENT/('main-'+b['sourceHead'][:12]+'-123')
        actual=list(old['manifest']['migrations']);switched=False;failed=False
        plan={'profile':PROFILE,'old':old,'candidate':new,'main':{'sha':b['sourceHead']},'ownership':{'ownershipId':'synthetic-owner'},'binding':b}
        def command(args,**kw):
            self.assertEqual(args[0],'systemctl');self.assertEqual(tuple(args[2:]),PROFILE['units']);events.append(args[1]);return b''
        def verify(*args,**kw):
            if failure=='before-stop':raise M.Refused('SYNTHETIC_MAIN_DRIFT')
            if switched and failure in ('dropin','active','article','production'):raise M.Refused('UNKNOWN_'+failure.upper())
            events.append('verified')
        def check_journal(plan,allowed,drain=False):
            self.assertIn(actual,allowed);events.append('drain'if drain else'journal');return list(actual)
        def migration(*args):
            nonlocal actual
            events.append('up')
            if failure=='migration-before':raise M.Refused('SYNTHETIC_MIGRATE_FAILED')
            actual=list(new['manifest']['migrations'])
            if failure=='migration-after':raise M.Refused('SYNTHETIC_POSTCOMMIT_FAILED')
        def switch(plan,directory):
            nonlocal switched
            switched=directory==new['directory'];events.append('switch-new'if switched else'switch-old')
        def health(plan,directory,*args):
            events.append('health-new'if directory==new['directory']else'health-old')
            if directory==new['directory']and failure=='health':raise M.Refused('SYNTHETIC_HEALTH_FAILED')
            return {'fastify':'5.12.6','sharp':'0.35.5'}
        fake=types.SimpleNamespace(command=command,stopped=lambda p:events.append('stopped'),switch=switch,verify_units=lambda *a,**k:None,
          healthy=health,atomic_bytes=lambda path,raw:writes.update({str(path):raw}),general=types.SimpleNamespace(store=lambda path,raw:writes.update({str(path):raw})))
        with patch.object(M,'D',fake),patch.object(M,'save_plan',side_effect=lambda *a:events.append('saved')or'a'*64),\
          patch.object(M,'verify_context',side_effect=verify),patch.object(M,'verify_history',return_value=None),\
          patch.object(M,'journal',side_effect=check_journal),patch.object(M,'snapshot',side_effect=lambda *a:events.append('snapshot')or{'authenticated':True}),\
          patch.object(M,'validate_snapshot',side_effect=lambda *a:events.append('snapshot-authenticated')),patch.object(M,'migrate',side_effect=migration),\
          patch.object(M,'schema99',side_effect=lambda p:events.append('schema99')),patch.object(M,'public_contract',side_effect=lambda p,new:events.append('public-new'if new else'public-old')):
            try:result=M.cutover(plan,state,'SYNTHETIC-APPROVAL')
            except M.Refused as error:result=str(error)
        return events,writes,result,actual

    def test_stop_drain_authenticated_snapshot_up_then_switch_and99_record(self):
        events,writes,result,actual=self.exercise()
        self.assertLess(events.index('stop'),events.index('snapshot'));self.assertLess(events.index('snapshot-authenticated'),events.index('up'));self.assertLess(events.index('up'),events.index('switch-new'))
        self.assertTrue(result['deployed']);self.assertFalse(result['databaseRestored']);self.assertFalse(result['productionChanged']);self.assertEqual(len(actual),99)
        record=json.loads(writes[str(M.ROOT/M.ACTIVE_NAME)]);self.assertEqual(record['migrationCount'],99);self.assertTrue(record['schemaChanged'])
        self.assertNotIn(str(M.ROOT/'application-active-release.json'),writes)

    def test_health_failure_rolls_only_app_back_and_records_schema99_retained(self):
        events,writes,result,actual=self.exercise('health');self.assertIn('45091_APP_RESTORED',result);self.assertIn('switch-old',events);self.assertIn('health-old',events)
        record=json.loads(writes[str(M.ROOT/M.ACTIVE_NAME)]);self.assertEqual(record['sourceHead'],M.BASELINE_HEAD);self.assertEqual(record['migrationCount'],99)
        self.assertTrue(record['schemaChanged']);self.assertTrue(record['applicationRollback']);self.assertFalse(record['databaseRestored'])
        self.assertEqual(len(actual),99);self.assertNotIn(str(M.ROOT/'application-active-release.json'),writes)

    def test_migration_failure_before_or_after_commit_keeps_exact_actual_journal(self):
        for failure,count in [('migration-before',98),('migration-after',99)]:
            with self.subTest(failure=failure):
                events,writes,result,actual=self.exercise(failure);self.assertIn('45091_APP_RESTORED',result);self.assertEqual(len(actual),count)
                self.assertEqual(json.loads(writes[str(M.ROOT/M.ACTIVE_NAME)])['migrationCount'],count)

    def test_unknown_dropin_active_article_or_production_drift_fences_before_old_restart(self):
        for failure in ('dropin','active','article','production'):
            with self.subTest(failure=failure):
                events,writes,result,actual=self.exercise(failure);self.assertIn('FENCED_REVIEW',result);self.assertNotIn('switch-old',events);self.assertNotIn('health-old',events)
                self.assertTrue(any(name.endswith('/manual-recovery-required.json')for name in writes));self.assertNotIn(str(M.ROOT/M.ACTIVE_NAME),writes)

    def test_provenance_failure_before_stop_never_changes_services(self):
        events,writes,result,actual=self.exercise('before-stop');self.assertNotIn('stop',events);self.assertNotIn('up',events);self.assertFalse(writes)

    def test_old_history_and_unknown_new_active_marker_are_verified_before_any_overwrite(self):
        plan={'dependencyActiveBytes':b'old-dependency','applicationActiveBytes':b'old45091'}
        def read(path,**kw):return plan['dependencyActiveBytes']if path.name=='dependency-active-release.json'else plan['applicationActiveBytes']
        with patch.object(M,'read',side_effect=read),patch.object(M,'optional_private',return_value=b'unknown'):
            with self.assertRaisesRegex(M.Refused,'UNKNOWN_ACTIVE'):M.verify_history(plan)
        with patch.object(M,'read',side_effect=read),patch.object(M,'optional_private',return_value=None):
            with self.assertRaisesRegex(M.Refused,'UNKNOWN_ACTIVE'):M.verify_history(plan,(b'published',))

    def test_post99_active_guard_never_calls_the_old98_runtime_guard(self):
        old,new,b=artifacts();state=M.STATE_PARENT/('main-'+b['sourceHead'][:12]+'-123');plan={'profile':PROFILE,'old':old,'candidate':new,'binding':b,'config':{},'ownership':{'ownershipId':'synthetic'}}
        raw=json.dumps(M.encode_private(plan),sort_keys=True).encode();active=M.active_record(plan,state,M.sha(raw),new,new['manifest']['migrations'])
        fake=types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(identity=lambda:{'instanceId':'lhins-61ikz4mi','publicIpv4':'124.223.74.198'})),
          artifact=lambda directory,root:old if directory==old['directory']else new,unit_path=lambda unit:Path('/synthetic')/unit,read_owned=lambda path:b'known',
          unit_entry=lambda *a:Path(new['directory']),running=lambda *a:{'api':'123','worker':'456'})
        old_guard=types.SimpleNamespace(active_context=lambda *a:(_ for _ in()).throw(AssertionError('OLD98 GUARD CALLED')))
        def read(path,*args,**kw):return active if path.name==M.ACTIVE_NAME else raw
        with patch.object(M,'D',fake),patch.object(M,'N',old_guard),patch.object(M,'validate_binding',return_value=b),patch.object(M,'load_primitives')as loaded,\
          patch.object(M,'read',side_effect=read),patch.object(M,'verify_context')as verified,patch.object(M,'journal',return_value=new['manifest']['migrations']),patch.object(M,'schema99'):
            result=M.active_context(b);self.assertEqual(result['release'],Path(new['directory']));loaded.assert_called_once_with(False)
            self.assertFalse(verified.call_args.kwargs['provenance'])


class RealNodeCryptoTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.root.chmod(0o700)
        self.file=self.root/'snapshot.aesgcm';self.key=self.root/'snapshot.key';self.aad='trial+45091+operation-fixture'
        self.data=b'PGDMP'+os.urandom(130000)
        self.node=shutil.which('node')
        self.assertTrue(self.node)
        self.patch=patch.object(M,'NODE',self.node);self.patch.start();self.addCleanup(self.patch.stop)
        p=self.run_crypto('encrypt',input=self.data)
        self.assertEqual(p.returncode,0,p.stderr.decode())
        self.expected=json.loads(p.stdout)

    def run_crypto(self,mode,input=None,aad=None,key=None):
        return subprocess.run(M.crypto_args(mode,self.file,key or self.key,aad or self.aad),input=input,capture_output=True,timeout=20)

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

class DatabaseBoundaryTests(unittest.TestCase):
    def exercise(self,url='postgresql://cisme_trial:synthetic@127.0.0.1:5432/cisme_trial',actual=None,denial=None,facts=None,drain=True):
        from urllib.parse import urlsplit
        observed=[];ownership={'ownershipId':'synthetic-only'};history=['synthetic98'];parsed=urlsplit(url)
        audit=types.SimpleNamespace(database=lambda ignored:({'databaseName':parsed.path.lstrip('/'),'role':parsed.username,'host':parsed.hostname,'port':parsed.port or 5432},
          {'PGUSER':parsed.username,'PGHOST':parsed.hostname,'PGPASSWORD':parsed.password,'PGPORT':str(parsed.port or 5432)}))
        fake=types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(audit=audit)),
          trial=types.SimpleNamespace(db_owned=lambda value:observed.append(value)),command=lambda *a,**k:json.dumps(actual or{'database':'cisme_trial','role':'cisme_trial'}).encode(),
          database_facts=lambda profile:facts or{'database':'cisme_trial','owner':'cisme_trial','journal':history,'otherClients':0})
        response=denial or types.SimpleNamespace(returncode=1,stdout=b'',stderr=b'FATAL: pg_hba.conf rejects connection')
        with patch.object(M,'D',fake),patch.object(M.subprocess,'run',return_value=response)as cross:
            result=M.database_guard(PROFILE,{'DATABASE_URL':url},ownership,[history],drain)
            self.assertEqual(cross.call_args.args[0][-3:],['cisme','-c','SELECT true'])
            self.assertIn('default_transaction_read_only=on',cross.call_args.kwargs['env']['PGOPTIONS'])
        self.assertEqual(observed,[ownership]);return result

    def test_actual_trial_role_and_positive_connection_then_explicit_production_denial(self):
        self.assertEqual(self.exercise(),['synthetic98'])

    def test_foreign_database_role_host_or_actual_user_refused(self):
        for url in ['postgresql://cisme:p@127.0.0.1:5432/cisme','postgresql://root:p@127.0.0.1:5432/cisme_trial','postgresql://cisme_trial:p@192.0.2.1:5432/cisme_trial']:
            with self.subTest(url=url),self.assertRaisesRegex(M.Refused,'TRIAL_ROLE_REQUIRED'):self.exercise(url=url)
        with self.assertRaisesRegex(M.Refused,'ACTUAL_DATABASE_ROLE'):self.exercise(actual={'database':'cisme_trial','role':'postgres'})

    def test_connection_failure_is_not_treated_as_database_isolation(self):
        with self.assertRaisesRegex(M.Refused,'CROSS_DATABASE_REJECTION'):
            self.exercise(denial=types.SimpleNamespace(returncode=1,stdout=b'',stderr=b'connection refused'))
        with self.assertRaisesRegex(M.Refused,'CROSS_DATABASE_REJECTION'):
            self.exercise(denial=types.SimpleNamespace(returncode=0,stdout=b't',stderr=b''))

    def test_unknown_schema_or_remaining_client_refuses_drain(self):
        for facts in [{'database':'cisme_trial','owner':'cisme_trial','journal':['unknown99'],'otherClients':0},
          {'database':'cisme_trial','owner':'cisme_trial','journal':['synthetic98'],'otherClients':1}]:
            with self.assertRaisesRegex(M.Refused,'JOURNAL_OR_DRAIN'):self.exercise(facts=facts)

    def test_all_six_secret_categories_must_stay_distinct(self):
        keys=['APP_SESSION_SECRET','UPLOAD_TOKEN_SECRET','CONTACT_ENCRYPTION_KEY','CONTACT_HASH_KEY','PRIVACY_FORMAL_EXPORT_KEY']
        trial={key:'synthetic-trial-'+key for key in keys};production={key:'synthetic-prod-'+key for key in keys}
        trial['DATABASE_URL']='postgresql://cisme_trial:synthetic-trial@127.0.0.1:5432/cisme_trial'
        production['DATABASE_URL']='postgresql://cisme:synthetic-prod@127.0.0.1:5432/cisme'
        M.six_keys(trial,production)
        for key in keys:
            with self.subTest(key=key),self.assertRaisesRegex(M.Refused,'SECRET_ISOLATION'):M.six_keys({**trial,key:production[key]},production)
        with self.assertRaisesRegex(M.Refused,'DATABASE_ISOLATION'):M.six_keys(trial,{**production,'DATABASE_URL':'postgresql://cisme:synthetic-trial@127.0.0.1:5432/cisme'})

class SnapshotPipelineTests(unittest.TestCase):
    """Real Node pipes and authentication, only pg_dump/list are synthetic."""
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);self.root=Path(temporary.name);self.root.chmod(0o700)
        self.state=self.root/'operation-fixture';self.state.mkdir(mode=0o700);self.data=b'PGDMP'+os.urandom(140000);self.status=0
        self.plan={'profile':PROFILE,'config':{'DATABASE_URL':'postgresql://cisme_trial:synthetic-only@127.0.0.1:5432/cisme_trial'}}
        self.toc='; dbname: cisme_trial\n1; 0 0 TABLE DATA public schema_migration cisme_trial\n';self.calls=[]
        real_popen=subprocess.Popen
        def popen(args,**kw):
            if args[0]=='/usr/sbin/runuser'and'/usr/bin/pg_dump'in args:
                self.calls.append((args,kw));fixture=self.root/'synthetic-dump';fixture.write_bytes(self.data);fixture.chmod(0o600)
                return real_popen([sys.executable,'-c','import pathlib,sys;sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes());sys.exit(int(sys.argv[2]))',str(fixture),str(self.status)],**kw)
            if args[:2]==['/usr/bin/pg_restore','--list']:
                self.calls.append((args,kw));return real_popen([sys.executable,'-c','import sys;sys.stdin.buffer.read();sys.stdout.write('+repr(self.toc)+')'],**kw)
            return real_popen(args,**kw)
        def store(path,raw):
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb')as stream:stream.write(raw)
        def command(args,**kw):
            result=subprocess.run(args,capture_output=True,env=M.CLEAN,timeout=20)
            M.need(result.returncode==0,'SYNTHETIC_CRYPTO_COMMAND_FAILED');return result.stdout
        fake=types.SimpleNamespace(json_bytes=M.parse,command=command,owned_directory=lambda *a:None,general=types.SimpleNamespace(store=store))
        def parents(path,private=False):
            self.assertTrue(path.is_relative_to(self.root));self.assertEqual(path.parent.stat().st_mode&0o777,0o700)
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.object(M,'D',fake));stack.enter_context(patch.object(M,'NODE',shutil.which('node')))
        stack.enter_context(patch.object(M,'OWNER',os.getuid()));stack.enter_context(patch.object(M,'parents',side_effect=parents))
        stack.enter_context(patch.object(M.subprocess,'Popen',side_effect=popen))

    def test_authenticated_actual_pipe_binds45091_aad_and_has_no_plaintext_archive(self):
        record=M.snapshot(self.plan,self.state,'SYNTHETIC-APPROVAL');M.validate_snapshot(record,self.state,'SYNTHETIC-APPROVAL')
        self.assertEqual(record['baseline'],M.BASELINE_HEAD);self.assertEqual(json.loads(record['aad'])['baseline'],M.BASELINE_HEAD)
        self.assertEqual(record['plainBytes'],140005);self.assertEqual(record['plainSha256'],hashlib.sha256(self.data).hexdigest())
        self.assertTrue(record['authenticated']);self.assertTrue(record['pgRestoreListVerified']);self.assertFalse(record['restorePerformed']);self.assertFalse(record['fullRecoveryQualified'])
        args,kw=self.calls[0];self.assertIn('--dbname=cisme_trial',args);self.assertIn('--username=cisme_trial',args)
        self.assertIn('default_transaction_read_only=on',kw['env']['PGOPTIONS']);self.assertNotIn('DATABASE_URL',kw['env'])
        self.assertFalse(any(path.suffix=='.dump'for path in self.state.rglob('*')))

    def test_nonzero_dump_or_wrong_database_listing_cannot_create_success_receipt(self):
        self.status=1
        with self.assertRaisesRegex(M.Refused,'DUMP_FAILED'):M.snapshot(self.plan,self.state,'SYNTHETIC-APPROVAL')
        self.assertFalse((self.state/'predeploy-database/snapshot-private.json').exists())

    def test_wrong_database_listing_refused(self):
        self.toc='; dbname: cisme\nTABLE DATA public schema_migration cisme\n'
        with self.assertRaisesRegex(M.Refused,'STRUCTURE_FAILED'):M.snapshot(self.plan,self.state,'SYNTHETIC-APPROVAL')
        self.assertFalse((self.state/'predeploy-database/snapshot-private.json').exists())

    def test_changed_cipher_or_key_is_refused_before_migration(self):
        record=M.snapshot(self.plan,self.state,'SYNTHETIC-APPROVAL');path=Path(record['encryptedFile']);raw=bytearray(path.read_bytes());raw[100]^=1;path.write_bytes(raw)
        with self.assertRaisesRegex(M.Refused,'SNAPSHOT_CHANGED'):M.validate_snapshot(record,self.state,'SYNTHETIC-APPROVAL')

class SourceNetworkTests(unittest.TestCase):
    head='a'*40
    def setUp(self):
        self.requests=[];self.responses=[]
        self.fake=types.SimpleNamespace(general=types.SimpleNamespace(REPO='Eysn0130/cisme-wechat-miniapp',
          observe=types.SimpleNamespace(NoRedirect=lambda:object())))
    class Response:
        status=200
        def __init__(self,body,length=None,error_after_read=None):
            self.body=body;self.headers={}if length is None else{'Content-Length':str(length)}
            self.error_after_read=error_after_read;self.reads=0
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def read(self,n):
            if self.error_after_read and self.reads:raise self.error_after_read
            self.reads+=1;chunk,self.body=self.body[:n],self.body[n:];return chunk
    def open(self,request,timeout):
        self.assertEqual(timeout,12);self.requests.append(request)
        value=self.responses.pop(0)
        if isinstance(value,Exception):raise value
        return value
    def content(self,body=b'approved source',name='package.json',**changes):
        value={'type':'file','path':name,'encoding':'base64','size':len(body),
          'sha':hashlib.sha1(b'blob '+str(len(body)).encode()+b'\0'+body).hexdigest(),
          'content':M.base64.b64encode(body).decode(),'download_url':'http://127.0.0.1/never-follow'}
        return{**value,**changes}
    def run_source(self,name='package.json'):
        opener=types.SimpleNamespace(open=self.open)
        with patch.object(M,'D',self.fake),patch.object(M.urllib.request,'build_opener',return_value=opener)as build:
            result=M.github_source(name,self.head)
            self.assertEqual(build.call_args.args[0].proxies,{})
            return result
    def test_raw_success_does_not_call_another_endpoint_or_supply_credentials(self):
        self.responses=[self.Response(b'raw bytes',9)]
        self.assertEqual(self.run_source(),b'raw bytes');self.assertEqual(len(self.requests),1)
        self.assertEqual(self.requests[0].full_url,'https://raw.githubusercontent.com/Eysn0130/cisme-wechat-miniapp/'+self.head+'/package.json')
        self.assertIsNone(self.requests[0].get_header('Authorization'))
    def test_open_timeout_uses_one_exact_commit_contents_response(self):
        body=b'approved source';self.responses=[TimeoutError(),self.Response(json.dumps(self.content(body)).encode())]
        self.assertEqual(self.run_source(),body);self.assertEqual(len(self.requests),2)
        self.assertEqual(self.requests[1].full_url,'https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/contents/package.json?ref='+self.head)
        self.assertEqual(self.requests[1].get_header('Accept'),'application/vnd.github+json')
        self.assertIsNone(self.requests[1].get_header('Authorization'))
    def test_partial_raw_timeout_discards_partial_body_before_verified_fallback(self):
        self.responses=[self.Response(b'partial',error_after_read=TimeoutError()),self.Response(json.dumps(self.content()).encode())]
        self.assertEqual(self.run_source(),b'approved source')
    def test_wrapped_dns_or_connection_transport_errors_can_fallback(self):
        errors=[M.urllib.error.URLError(M.socket.gaierror(-3,'synthetic DNS failure')),
          M.urllib.error.URLError(ConnectionResetError()),ConnectionResetError(),OSError(M.errno.ENETUNREACH,'synthetic unreachable')]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                self.requests=[];self.responses=[error,self.Response(json.dumps(self.content()).encode())]
                self.assertEqual(self.run_source(),b'approved source');self.assertEqual(len(self.requests),2)
    def test_http_failures_never_trigger_fallback(self):
        for status in(403,404,429,503):
            with self.subTest(status=status):
                self.requests=[];self.responses=[M.urllib.error.HTTPError('https://raw.githubusercontent.com',status,'synthetic',{},None)]
                with self.assertRaisesRegex(M.Refused,'SOURCE_HTTP_UNAVAILABLE'):self.run_source()
                self.assertEqual(len(self.requests),1)
    def test_tls_and_certificate_failures_never_trigger_fallback(self):
        errors=[M.ssl.SSLCertVerificationError(1,'synthetic certificate'),M.ssl.SSLError(1,'synthetic TLS')]
        for error in errors+list(map(M.urllib.error.URLError,errors)):
            with self.subTest(error=type(error).__name__):
                self.requests=[];self.responses=[error]
                with self.assertRaisesRegex(M.Refused,'TLS_VALIDATION_FAILED'):self.run_source()
                self.assertEqual(len(self.requests),1)
    def test_nontransport_os_errors_do_not_trigger_fallback(self):
        self.responses=[OSError(M.errno.EACCES,'synthetic denied')]
        with self.assertRaisesRegex(M.Refused,'SOURCE_NETWORK_UNAVAILABLE'):self.run_source()
        self.assertEqual(len(self.requests),1)
    def test_content_validation_failures_do_not_trigger_fallback(self):
        for response,code in[(self.Response(b'partial',100),'TRUNCATED'),
          (self.Response(b'x',1048577),'SOURCE_SIZE'),(self.Response(b'x','invalid'),'SOURCE_LENGTH')]:
            with self.subTest(code=code):
                self.requests=[];self.responses=[response]
                with self.assertRaisesRegex(M.Refused,code):self.run_source()
                self.assertEqual(len(self.requests),1)
    def test_contents_metadata_must_describe_one_exact_bounded_file(self):
        changes=[{'type':'dir'},{'type':'symlink'},{'path':'other.json'},{'encoding':'none'},
          {'size':True},{'size':0},{'size':1048577},{'sha':'g'*40},{'content':[]}]
        for change in changes:
            with self.subTest(change=change):
                self.requests=[];self.responses=[TimeoutError(),self.Response(json.dumps(self.content(**change)).encode())]
                with self.assertRaisesRegex(M.Refused,'CONTENTS_METADATA_REQUIRED'):self.run_source()
                self.assertEqual(len(self.requests),2)
    def test_contents_encoding_size_blob_and_duplicate_keys_are_verified(self):
        cases=[(self.content(content='not base64!'),'ENCODING_INVALID'),
          (self.content(content=M.base64.b64encode(b'changed bytes').decode()),'SIZE_MISMATCH'),
          (self.content(sha='0'*40),'BLOB_MISMATCH')]
        for value,code in cases:
            with self.subTest(code=code):
                self.responses=[TimeoutError(),self.Response(json.dumps(value).encode())]
                with self.assertRaisesRegex(M.Refused,code):self.run_source()
        self.responses=[TimeoutError(),self.Response(b'{"type":"file","type":"dir"}')]
        with self.assertRaisesRegex(M.Refused,'DUPLICATE_JSON_KEY'):self.run_source()
    def test_only_standard_base64_line_breaks_are_accepted(self):
        value=self.content();value['content']=value['content'][:4]+'\r\n'+value['content'][4:]
        self.responses=[TimeoutError(),self.Response(json.dumps(value).encode())]
        self.assertEqual(self.run_source(),b'approved source')
        value['content']=' '+value['content'];self.responses=[TimeoutError(),self.Response(json.dumps(value).encode())]
        with self.assertRaisesRegex(M.Refused,'ENCODING_INVALID'):self.run_source()
    def test_contents_response_is_bounded_complete_and_never_recursively_retried(self):
        for response,code in[(self.Response(b'{}',100),'TRUNCATED'),
          (self.Response(b'{}',2*1024*1024+1),'SOURCE_SIZE'),(TimeoutError(),'NETWORK_UNAVAILABLE')]:
            with self.subTest(code=code):
                self.requests=[];self.responses=[TimeoutError(),response]
                with self.assertRaisesRegex(M.Refused,code):self.run_source()
                self.assertEqual(len(self.requests),2)
    def test_fallback_retains_all_source_permit_hash_and_candidate_checks(self):
        names=['package.json','package-lock.json','scripts/release-migrate.mjs','db/migrations/'+M.MIGRATION]
        contents={name:(REPO/name).read_bytes()for name in names}
        binding={'sourceHead':self.head,'sourceTree':'b'*40,'ciRunId':123}
        main={'sha':self.head,'tree':'b'*40,'ciRunId':123}
        candidate={'directory':'/synthetic-reviewed-candidate','files':{'migrate.mjs':contents[names[2]],names[3]:contents[names[3]]}}
        def fixture(changes={}):
            self.responses=[]
            for name in names:self.responses.extend([TimeoutError(),self.Response(json.dumps(self.content(changes.get(name,contents[name]),name)).encode())])
            self.fake.command=lambda *a,**k:json.dumps({'verified':True,'sourceHead':self.head,'sourceTree':'b'*40,'migrations':99})
        fixture()
        with patch.object(M,'D',self.fake),patch.object(M.urllib.request,'build_opener',return_value=types.SimpleNamespace(open=self.open)):
            M.source_permit(binding,candidate,main)
        fixture({'package.json':b'self-consistent API metadata cannot replace approved source'})
        with patch.object(M,'D',self.fake),patch.object(M.urllib.request,'build_opener',return_value=types.SimpleNamespace(open=self.open)):
            with self.assertRaisesRegex(M.Refused,'SOURCE_DEPENDENCY_INPUT_CHANGED'):M.source_permit(binding,candidate,main)

if __name__=='__main__':unittest.main()
