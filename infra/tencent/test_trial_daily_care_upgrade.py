"""Offline schema100 permit/rollback/crypto tests; no host or database calls."""
import ast
import base64
import copy
from contextlib import ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
spec=importlib.util.spec_from_file_location('daily_care_upgrade',HERE/'trial-daily-care-upgrade.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
PROFILE={'root':'/opt/cisme-trial','user':'cisme-trial','database':'cisme_trial','domain':'staging-api.cisme.cn',
 'units':('cisme-trial-api.service','cisme-trial-worker.service'),'lock':'/run/lock/cisme-production-trial.lock','name':'trial'}

def fixtures():
    sql=sorted(p.name for p in (REPO/'db/migrations').glob('*.sql') if p.name<M.MIGRATION)
    assert len(sql)==99
    files={name:('synthetic:'+name).encode() for name in ('index.js','worker.js','worker-once.js')}
    files.update({'package.json':(REPO/'package.json').read_bytes(),'package-lock.json':(REPO/'package-lock.json').read_bytes(),
                  'migrate.mjs':(REPO/'scripts/release-migrate.mjs').read_bytes()})
    files.update({'db/migrations/'+name:(REPO/'db/migrations'/name).read_bytes() for name in sql})
    manifest={'schemaVersion':1,'sourceHead':M.BASELINE_HEAD,'sourceTree':M.BASELINE_TREE,'sourceLockSha256':M.SOURCE_LOCK,
      'node':'v24.14.0','buildPlatform':{'os':'linux','arch':'x64','libc':'glibc'},'configurationIncluded':False,'deployed':False,'releaseReady':False,
      'migrations':sql,'hashes':{name:M.sha(raw) for name,raw in files.items()}}
    manifest['hashes']['index.js']=M.BASELINE_INDEX
    old={'directory':str(M.ROOT/'releases'/('tencent-release-'+M.BASELINE_HEAD[:12])), 'manifest':manifest,
      'manifestSha256':M.BASELINE_MANIFEST,'dependenciesSha256':M.DEPENDENCIES,'files':files}
    b={'schemaVersion':1,'kind':'trial-daily-care-upgrade','baselineHead':M.BASELINE_HEAD,'baselineTree':M.BASELINE_TREE,
      'sourceHead':'1'*40,'sourceTree':'2'*40,'ciRunId':123,'helperSha256':'a'*64,'manifestSha256':'b'*64,'archiveSha256':'c'*64,
      'archiveBytes':123,'stageReceiptSha256':'d'*64,'dependenciesSha256':M.DEPENDENCIES,'migrations':100,'migrationSha256':M.MIGRATION_SHA,
      'stageReceipt':str(M.STAGES/('daily100-'+'1'*12+'-abcdefgh')/'stage-receipt.json'),'compatibilitySha256':'e'*64}
    b['compatibilityReceipt']=str(Path(b['stageReceipt']).parent/'rollback-compatibility.json')
    new=copy.deepcopy(old);new.update(directory=str(M.ROOT/'releases'/('tencent-release-'+b['sourceHead'][:12])),manifestSha256=b['manifestSha256'])
    new['manifest'].update(sourceHead=b['sourceHead'],sourceTree=b['sourceTree'],migrations=sql+[M.MIGRATION])
    new['files']['db/migrations/'+M.MIGRATION]=(REPO/'db/migrations'/M.MIGRATION).read_bytes()
    return old,new,b

def receipt():
    return {'schemaVersion':1,'kind':'trial-f8-schema100-compatibility','baselineHead':M.BASELINE_HEAD,'baselineTree':M.BASELINE_TREE,
      'baselineManifestSha256':M.BASELINE_MANIFEST,'baselineArchiveSha256':M.BASELINE_ARCHIVE,'indexSha256':M.BASELINE_INDEX,
      'dependenciesSha256':M.DEPENDENCIES,'migrationSha256':M.MIGRATION_SHA,'node':'v24.14.0',
      'platform':{'os':'linux','arch':'x64','libc':'glibc'},'harnessSha256':'f'*64,
      'actualLinuxArtifactExecuted':True,'disposableDatabase':True,'passed':True,
      'checks':{k:True for k in ('healthReady','currentLegal','articles','imageMedia','videoMedia','existingReactions')}}

class PermitTests(unittest.TestCase):
    def test_only_new100_while_all_old99_package_migrator_and_dependencies_match(self):M.artifact_contract(*fixtures())
    def test_every_original_102_input_refuses_byte_drift(self):
        old,new,b=fixtures()
        for name in ['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+x for x in old['manifest']['migrations']]:
            with self.subTest(name=name),self.assertRaisesRegex(M.Refused,'OLD_SQL_MIGRATOR_OR_PACKAGE'):
                changed=copy.deepcopy(new);changed['files'][name]+=b'changed';M.artifact_contract(old,changed,b)
    def test_missing_added_reordered_or_other100_schema_refused(self):
        old,new,b=fixtures()
        for names in [new['manifest']['migrations'][:-1],new['manifest']['migrations']+['20990101_extra.sql'],list(reversed(new['manifest']['migrations']))]:
            changed=copy.deepcopy(new);changed['manifest']['migrations']=names
            with self.assertRaisesRegex(M.Refused,'ONLY_ONE_MIGRATION'):M.artifact_contract(old,changed,b)
        new['files']['db/migrations/'+M.MIGRATION]+=b'changed'
        with self.assertRaisesRegex(M.Refused,'PINNED_SQL'):M.artifact_contract(old,new,b)
    def test_baseline_platform_and_native_dependencies_must_be_exact(self):
        old,new,b=fixtures()
        for changed in [dict(new,dependenciesSha256='0'*64),dict(old,manifestSha256='0'*64)]:
            with self.assertRaises(M.Refused):M.artifact_contract(old,changed,b)
        new['manifest']['buildPlatform']['arch']='arm64'
        with self.assertRaisesRegex(M.Refused,'EXACT_LINUX'):M.artifact_contract(old,new,b)
    def test_binding_rejects_placeholders_counts_and_migration_drift(self):
        _,_,b=fixtures();raw=b'synthetic-helper';b['helperSha256']=M.sha(raw)
        with patch.object(M,'read',return_value=raw):
            self.assertEqual(M.validate_binding(b),b)
            for key,value in [('sourceHead','0'*40),('ciRunId',True),('archiveBytes',True),('migrations',99),('migrations',True),('migrationSha256','0'*64)]:
                with self.subTest(key=key),self.assertRaises(M.Refused):M.validate_binding({**b,key:value})
    def test_compatibility_pure_facts_require_every_real_success_and_exact_digest(self):
        value=receipt()
        with patch.object(M,'COMPAT_HARNESS_SHA','f'*64):
            self.assertEqual(M.validate_compatibility_facts(value),value)
            for key in ('baselineHead','baselineTree','baselineManifestSha256','baselineArchiveSha256','indexSha256','dependenciesSha256','migrationSha256','harnessSha256','node','kind'):
                with self.subTest(key=key),self.assertRaises(M.Refused):M.validate_compatibility_facts({**value,key:'wrong'})
            for key in ('actualLinuxArtifactExecuted','disposableDatabase','passed'):
                with self.assertRaises(M.Refused):M.validate_compatibility_facts({**value,key:False})
            for key in value['checks']:
                changed=copy.deepcopy(value);changed['checks'][key]=False
                with self.subTest(check=key),self.assertRaises(M.Refused):M.validate_compatibility_facts(changed)
        with patch.object(M,'COMPAT_HARNESS_SHA',None),self.assertRaises(M.Refused):M.validate_compatibility_facts(value)
    def test_compatibility_file_path_and_bytes_are_bound(self):
        _,_,b=fixtures();raw=json.dumps(receipt()).encode();b['compatibilitySha256']=M.sha(raw)
        with patch.object(M,'read',return_value=raw),patch.object(M,'COMPAT_HARNESS_SHA','f'*64):
            self.assertEqual(M.validate_compatibility(b),receipt())
            with self.assertRaisesRegex(M.Refused,'HASH'):M.validate_compatibility({**b,'compatibilitySha256':'0'*64})
            for path in ['/tmp/rollback-compatibility.json',str(Path(b['stageReceipt']).parent/'other.json')]:
                with self.assertRaisesRegex(M.Refused,'PATH'):M.validate_compatibility({**b,'compatibilityReceipt':path})
    def test_new_source_path_and_exact_ref_refuse_before_any_network(self):
        for name,head in [('evil.py','1'*40),(M.HELPER_SOURCE,'main'),(M.HELPER_SOURCE,'0'*40)]:
            with patch.object(M.urllib.request,'build_opener')as opened,self.assertRaises(M.Refused):M.github_new_source(name,head)
            opened.assert_not_called()
    def test_source_permit_still_requires_latest_push_ci_and_complete100_verify(self):
        _,candidate,b=fixtures();helper=b'synthetic-helper';b['helperSha256']=M.sha(helper)
        def github(name,head):return candidate['files'][{'scripts/release-migrate.mjs':'migrate.mjs'}.get(name,name)]
        c=types.SimpleNamespace(github_source=github)
        d=types.SimpleNamespace(command=lambda *a,**k:json.dumps({'verified':True,'sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'migrations':100}).encode())
        main={'sha':b['sourceHead'],'tree':b['sourceTree'],'ciRunId':b['ciRunId']}
        with patch.object(M,'C',c),patch.object(M,'D',d),patch.object(M,'github_new_source',side_effect=lambda n,h:helper if n==M.HELPER_SOURCE else candidate['files'][n]):
            M.source_permit(b,candidate,main)
            with self.assertRaisesRegex(M.Refused,'LATEST_MAIN'):M.source_permit(b,candidate,{**main,'ciRunId':999})
            d.command=lambda *a,**k:b'{"verified":true,"migrations":99}'
            with self.assertRaisesRegex(M.Refused,'COMPLETE_ARTIFACT'):M.source_permit(b,candidate,main)
    def test_wrong_host_refuses_before_any_write_or_lock(self):
        _,_,b=fixtures();d=types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(identity=lambda:{'instanceId':'other','publicIpv4':'192.0.2.1'})))
        with patch.object(M,'D',d),patch.object(M,'load_baseline'),patch.object(M.os,'geteuid',return_value=0),patch.object(M.os,'open')as opened,self.assertRaisesRegex(M.Refused,'EXACT_INSTANCE'):M.apply(b,'SYNTHETIC-APPROVAL')
        opened.assert_not_called()
    def test_stage_receipt_cannot_claim_service_database_or_production_mutation(self):
        _,candidate,b=fixtures();archive=b'synthetic-archive';b.update(archiveSha256=M.sha(archive),archiveBytes=len(archive))
        value={'kind':'trial-daily-care-stage','staged':True,'deployed':False,'instanceId':'lhins-61ikz4mi','publicIpv4':'124.223.74.198',
          'baselineHead':M.BASELINE_HEAD,'sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'archiveSha256':b['archiveSha256'],
          'archiveSize':len(archive),'manifestSha256':b['manifestSha256'],'dependenciesSha256':M.DEPENDENCIES,'migrations':100,
          'helperSha256':b['helperSha256'],'migrationSha256':M.MIGRATION_SHA,'privateStage':str(Path(b['stageReceipt']).parent),
          'candidateDirectories':[candidate['directory']],**{k:False for k in ('servicesChanged','databaseChanged','configurationChanged','productionChanged','peerFilesChanged')}}
        def run(v):
            raw=json.dumps(v).encode();local={**b,'stageReceiptSha256':M.sha(raw)}
            with patch.object(M,'read',side_effect=lambda p,*a:raw if p.name=='stage-receipt.json' else archive):return M.stage_binding(local,candidate)
        self.assertEqual(run(value),b['stageReceipt'])
        for key in ('servicesChanged','databaseChanged','configurationChanged','productionChanged','peerFilesChanged'):
            with self.assertRaisesRegex(M.Refused,'BINDING_MISMATCH'):run({**value,key:True})
    def test_snapshot_primitives_are_exact_reviewed_code_with_new_f8_globals(self):
        original=ast.parse((HERE/'trial-editorial-comments-upgrade.py').read_text());current=ast.parse((HERE/'trial-daily-care-upgrade.py').read_text())
        for name in ('crypto_args','private_hash','snapshot','validate_snapshot'):
            a=next(n for n in original.body if isinstance(n,ast.FunctionDef)and n.name==name)
            b=next(n for n in current.body if isinstance(n,ast.FunctionDef)and n.name==name)
            self.assertEqual(ast.dump(a,include_attributes=False),ast.dump(b,include_attributes=False))
        self.assertEqual(M.BASELINE_HEAD,'f8dbc55df6c002289005c65969ef68966d206968')
        self.assertEqual(M.SNAPSHOT_JS,load_old().SNAPSHOT_JS)


    def test_pinned_baseline_code_mismatch_is_not_executed(self):
        with patch.object(M.os,'geteuid',return_value=0),patch.object(M,'read',return_value=b'raise AssertionError("untrusted")'),self.assertRaisesRegex(M.Refused,'PINNED_F8'):
            M.load_baseline(True)

    def test_journal_uses_new100_schema_not_old_active_guard(self):
        old,new,b=fixtures();events=[]
        c=types.SimpleNamespace(database_guard=lambda *a:new['manifest']['migrations'],schema99=lambda p:events.append('schema99'))
        with patch.object(M,'C',c),patch.object(M,'schema100',side_effect=lambda p:events.append('schema100')):
            self.assertEqual(M.journal({'profile':PROFILE,'config':{},'ownership':{}},[new['manifest']['migrations']]),new['manifest']['migrations'])
        self.assertEqual(events,['schema99','schema100'])

    def test_schema99_journal_rejects_rogue_daily_table(self):
        old,_,_=fixtures();c=types.SimpleNamespace(database_guard=lambda *a:old['manifest']['migrations'],schema99=lambda p:None)
        with patch.object(M,'C',c),patch.object(M,'D',types.SimpleNamespace(query=lambda *a:{'absent':False})),self.assertRaisesRegex(M.Refused,'PREEXISTING_SCHEMA100'):
            M.journal({'profile':PROFILE,'config':{},'ownership':{}},[old['manifest']['migrations']])

    def test_migrate_never_runs_up_before_authenticated_snapshot(self):
        _,_,b=fixtures();d=types.SimpleNamespace(command=lambda *a,**k:self.fail('migration must not execute'))
        with patch.object(M,'D',d),patch.object(M,'validate_snapshot',side_effect=M.Refused('APPLICATION_REAL_SNAPSHOT_REQUIRED')),self.assertRaises(M.Refused):
            M.migrate({},None,Path('/synthetic'),'SYNTHETIC-APPROVAL')

    def test_historical_f8_active_bytes_are_not_rewritten_or_ignored(self):
        plan={'historicalActive':{'dependency-active-release.json':b'original'},'baselineUpdateActive':b'baseline'}
        path=Path('/opt/cisme-trial/schema99-application-updates/active-release.json')
        def reader(p,*a,**k):return b'wrong' if p==path else b'original'
        with patch.object(M,'B',types.SimpleNamespace(ACTIVE=path)),patch.object(M,'read',side_effect=reader),patch.object(M,'optional_active',return_value=None),self.assertRaisesRegex(M.Refused,'F8_ACTIVE_HISTORY_DRIFT'):
            M.verify_history(plan)

    def test_comment_facts_are_bound_during_cutover_but_allow_later_user_mutation(self):
        old,new,b=fixtures();raw=b'fixed-stage';b['stageReceiptSha256']=M.sha(raw)
        plan={'profile':PROFILE,'config':{},'production':{'config':{}},'binding':b,'old':old,'stageReceipt':'/synthetic-stage',
          'articleFence':{'publishedCount':20},'commentsFence':{'editorial_comment':'original'}}
        c=types.SimpleNamespace(fixed_profile=lambda p:None,production_preserved=lambda *a:None,six_keys=lambda *a:None,
          article_fence=lambda p:{'publishedCount':20})
        with patch.object(M,'C',c),patch.object(M,'D',types.SimpleNamespace(verify_context=lambda *a,**k:None)),patch.object(M,'verify_history'),patch.object(M,'read',return_value=raw),patch.object(M,'compatibility'),patch.object(M,'comments_fence',return_value={'editorial_comment':'changed'}):
            with self.assertRaisesRegex(M.Refused,'EXISTING_COMMENTS_DRIFT'):M.verify_context(plan)
            M.verify_context(plan,preserve_comments=False)

    def test_all_foreign_profile_shapes_are_refused(self):
        for key,value in [('user','root'),('database','cisme'),('domain','other.invalid'),('units',('cisme-api.service',)),('lock','/tmp/unsafe')]:
            with self.subTest(key=key),self.assertRaises(M.Refused):M.fixed_profile({**PROFILE,key:value})

    def test_official_contents_requires_actual_blob_sha_and_exact_path(self):
        content=b'public-source';blob=hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()
        value={'type':'file','path':M.HELPER_SOURCE,'encoding':'base64','size':len(content),'sha':blob,'content':base64.b64encode(content).decode()}
        d=types.SimpleNamespace(general=types.SimpleNamespace(REPO='Eysn0130/cisme-wechat-miniapp',observe=types.SimpleNamespace(NoRedirect=M.urllib.request.HTTPRedirectHandler)))
        c=types.SimpleNamespace(source_response=lambda *a:json.dumps(value).encode())
        with patch.object(M,'C',c),patch.object(M,'D',d),patch.object(M.urllib.request,'build_opener',return_value=object()):
            self.assertEqual(M.github_new_source(M.HELPER_SOURCE,'1'*40),content)
            for key,bad in [('path','other.py'),('sha','0'*40),('size',len(content)+1),('encoding','raw')]:
                good=value[key];value[key]=bad
                with self.subTest(key=key),self.assertRaises(M.Refused):M.github_new_source(M.HELPER_SOURCE,'1'*40)
                value[key]=good


    def test_active_rehydrates_verified_artifact_bytes_without_old99_active_guard(self):
        old,new,b=fixtures();state=M.STATE_PARENT/('main-'+b['sourceHead'][:12]+'-123')
        plan={'binding':b,'old':{k:v for k,v in old.items()if k!='files'},'candidate':{k:v for k,v in new.items()if k!='files'},
          'profile':PROFILE,'config':{},'ownership':{'ownershipId':'synthetic'}}
        saved=b'{}';raw=M.active_record(plan,state,M.sha(saved),new,new['manifest']['migrations'])
        c=types.SimpleNamespace(decode_private=lambda value:plan,fixed_profile=lambda p:None)
        d=types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(identity=lambda:{'instanceId':'lhins-61ikz4mi','publicIpv4':'124.223.74.198'})),
          artifact=lambda path,root:old if path==old['directory']else new,unit_path=lambda u:Path('/synthetic')/u,
          read_owned=lambda p:b'synthetic-unit',unit_entry=lambda *a:Path(new['directory']),running=lambda *a:None)
        def verify(value,**kw):
            self.assertEqual(value['old']['files']['index.js'],old['files']['index.js'])
            self.assertFalse(kw['preserve_comments'])
        with patch.object(M,'validate_binding',return_value=b),patch.object(M,'load_baseline')as loaded,patch.object(M,'C',c),patch.object(M,'D',d),\
             patch.object(M,'read',side_effect=lambda path,*a:raw if path==M.ACTIVE else saved),patch.object(M,'verify_context',side_effect=verify),patch.object(M,'journal')as journal:
            result=M.active_context(b)
        loaded.assert_called_once_with(False);self.assertEqual(result['release'],Path(new['directory']))
        self.assertEqual(journal.call_args.args[1],[new['manifest']['migrations']])


    def test_only_known_safe_cross_module_source_codes_are_public(self):
        class Foreign(RuntimeError):pass
        with patch.object(M,'C',types.SimpleNamespace(Refused=Foreign)):
            self.assertEqual(M.safe_error_code(Foreign('COMMENTS_SOURCE_NETWORK_TIMEOUT')),'COMMENTS_SOURCE_NETWORK_TIMEOUT')
            for value in [Foreign('COMMENTS_SOURCE_token=private'),RuntimeError('COMMENTS_SOURCE_NETWORK_TIMEOUT'),Foreign('PRIVATE_OPENID')]:
                self.assertEqual(M.safe_error_code(value),'DAILY_CARE_APPLICATION_REVIEW_REQUIRED')


def load_old():
    spec=importlib.util.spec_from_file_location('reviewed_comments_test',HERE/'trial-editorial-comments-upgrade.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class CutoverTests(unittest.TestCase):
    def exercise(self,fail=None,unknown=False,compatibility=True,daily_count=0):
        old,new,b=fixtures();events=[];state=Path('/synthetic-private-state');plan={'profile':PROFILE,'old':old,'candidate':new,'binding':b,'main':{'sha':b['sourceHead']},'config':{},'ownership':{'ownershipId':'synthetic-owner'}}
        def step(name):
            events.append(name)
            if fail==name:raise RuntimeError('private material must not be printed')
        def command(argv,**kw):step('stop'if argv[:2]==['systemctl','stop']else'start')
        d=types.SimpleNamespace(query=lambda *a:{'count':daily_count},command=command,stopped=lambda p:step('stopped'),switch=lambda p,v:step('switch-new'if v==new['directory']else'switch-old'),
          verify_units=lambda *a,**k:step('units'),healthy=lambda *a,**k:step('healthy'),atomic_bytes=lambda *a:step('active'),general=types.SimpleNamespace(store=lambda p,v:step('store-'+p.name)))
        c=types.SimpleNamespace(fixed_profile=lambda p:None,public_contract=lambda *a:step('public'))
        journal_calls=[]
        def journal(p,allowed,drain=False):
            journal_calls.append((allowed,drain));step('drain'if drain else'journal');return new['manifest']['migrations']if fail else allowed[0]
        def verify(*a,**k):
            step('verify')
            if unknown and k.get('candidate_allowed'):raise RuntimeError('unknown drift')
        with patch.object(M,'C',c),patch.object(M,'D',d),patch.object(M,'save_plan',return_value='a'*64),patch.object(M,'verify_context',side_effect=verify),\
             patch.object(M,'journal',side_effect=journal),patch.object(M,'verify_history',side_effect=lambda *a,**k:step('history')),patch.object(M,'snapshot',side_effect=lambda *a:(step('snapshot')or{})),patch.object(M,'validate_snapshot',side_effect=lambda *a:step('authenticate')),\
             patch.object(M,'migrate',side_effect=lambda *a:step('migrate')),patch.object(M,'schema100',side_effect=lambda *a:step('schema100')),\
             patch.object(M,'compatibility',side_effect=lambda *a:step('compat')if compatibility else (_ for _ in()).throw(M.Refused('NO_ACTUAL_COMPAT'))):
            try:result=M.cutover(plan,state,'SYNTHETIC-APPROVAL')
            except M.Refused as e:result=str(e)
        return events,result
    def test_stop_drain_authenticated_f8_snapshot_before_migration_and_switch(self):
        events,result=self.exercise();self.assertTrue(result['deployed'])
        self.assertLess(events.index('stop'),events.index('drain'));self.assertLess(events.index('drain'),events.index('snapshot'))
        self.assertLess(events.index('authenticate'),events.index('migrate'));self.assertLess(events.index('migrate'),events.index('switch-new'))
    def test_migration_failure_only_rolls_application_back_never_data(self):
        events,result=self.exercise(fail='migrate');self.assertIn('switch-old',events);self.assertIn('SCHEMA_RETAINED',result)
        self.assertNotIn('restore',events);self.assertNotIn('down',events)
    def test_unknown_drift_stays_stopped_without_switching_over_it(self):
        events,result=self.exercise(fail='migrate',unknown=True);self.assertNotIn('switch-old',events);self.assertIn('FENCED',result)
    def test_new_daily_facts_or_unknown_count_fence_old_app_rollback(self):
        for count in (1, None, False):
            events,result=self.exercise(fail='healthy',daily_count=count)
            self.assertNotIn('switch-old',events);self.assertIn('FENCED',result)

    def test_missing_actual_compatibility_fences_rollback(self):
        events,result=self.exercise(fail='migrate',compatibility=False);self.assertNotIn('switch-old',events);self.assertIn('FENCED',result)


class RealNodeCryptoTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.root.chmod(0o700)
        self.file=self.root/'snapshot.aesgcm';self.key=self.root/'snapshot.key';self.aad='trial+f8+operation-fixture'
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

    def test_authenticated_actual_pipe_binds_f8_aad_and_has_no_plaintext_archive(self):
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

if __name__=='__main__':unittest.main()
