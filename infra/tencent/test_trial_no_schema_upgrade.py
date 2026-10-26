import ast
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('no_schema_draft',HERE/'trial-no-schema-upgrade.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
ROOT=HERE.parents[1]
HELPER=HERE/'trial-no-schema-upgrade.py'


def artifact_fixture():
    # Synthetic public fixture: no production receipt, credentials, tmp files or network.
    migrations=sorted(path.name for path in (ROOT/'db/migrations').glob('*.sql'))
    assert len(migrations)==98 and migrations[-1]=='202610260001_owned_editorial.sql'
    names=['index.js','worker.js','worker-once.js','migrate.mjs','package.json','package-lock.json']
    names+=['db/migrations/'+name for name in migrations]
    before={'schemaVersion':1,'sourceHead':M.BASELINE_HEAD,'sourceTree':M.BASELINE_TREE,
            'sourceLockSha256':M.SOURCE_LOCK,'node':'v24.14.0',
            'buildPlatform':{'os':'linux','arch':'x64','libc':'glibc'},
            'configurationIncluded':False,'deployed':False,'releaseReady':False,
            'migrations':migrations,'hashes':dict.fromkeys(names,'public-fixture')}
    files={name:('baseline:'+name).encode() for name in before['hashes']}
    old={'directory':str(M.ROOT/'releases'/'tencent-release-0d3ff1c8d2cb'),
        'manifest':before,'manifestSha256':M.BASELINE_MANIFEST,'dependenciesSha256':M.DEPENDENCIES,'files':files}
    b={'sourceHead':'1'*40,'sourceTree':'2'*40,'manifestSha256':'a'*64,'ciRunId':123}
    candidate=copy.deepcopy(old)
    candidate.update({'directory':str(M.ROOT/'releases'/('tencent-release-'+b['sourceHead'][:12])),
                      'manifestSha256':b['manifestSha256']})
    candidate['manifest'].update({'sourceHead':b['sourceHead'],'sourceTree':b['sourceTree']})
    # The three compiled application entries may actually change, unlike SQL/runtime inputs.
    for name in ('index.js','worker.js','worker-once.js'):candidate['files'][name]=b'new:'+name.encode()
    return old,candidate,b


class ContractTests(unittest.TestCase):
    def test_exact_schema98_application_delta_allowed(self):
        old,candidate,b=artifact_fixture();M.artifact_contract(old,candidate,b)

    def test_all_98_sql_files_and_migrator_and_packages_are_immutable(self):
        old,candidate,b=artifact_fixture()
        names=['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+x for x in old['manifest']['migrations']]
        self.assertEqual(len(names),101)
        for name in names:
            with self.subTest(name=name):
                value=copy.deepcopy(candidate);value['files'][name]+=b'changed'
                with self.assertRaisesRegex(M.Refused,'SQL_OR_DEPENDENCY_BYTES'):M.artifact_contract(old,value,b)

    def test_added_removed_or_reordered_sql_refused(self):
        old,candidate,b=artifact_fixture()
        for migrations in [old['manifest']['migrations']+['202610270001_new.sql'],old['manifest']['migrations'][:-1],list(reversed(old['manifest']['migrations']))]:
            value=copy.deepcopy(candidate);value['manifest']['migrations']=migrations
            with self.assertRaisesRegex(M.Refused,'NO_SQL_DELTA'):M.artifact_contract(old,value,b)

    def test_dependency_tree_drift_refused_even_with_same_version_label(self):
        old,candidate,b=artifact_fixture();candidate['dependenciesSha256']='f'*64
        with self.assertRaisesRegex(M.Refused,'FULL_DEPENDENCY_TREE'):M.artifact_contract(old,candidate,b)

    def test_wrong_source_or_platform_refused(self):
        old,candidate,b=artifact_fixture()
        for key,value in [('sourceHead','3'*40),('sourceTree','4'*40),('node','v24.13.0'),('configurationIncluded',True),('sourceLockSha256','e'*64)]:
            changed=copy.deepcopy(candidate);changed['manifest'][key]=value
            with self.assertRaisesRegex(M.Refused,'EXACT_LINUX_ARTIFACT'):M.artifact_contract(old,changed,b)

    def test_old_dbd97_baseline_refused(self):
        old,candidate,b=artifact_fixture();old['manifest']['sourceHead']='dbd2b88a47f622621c2b226b03339677b183fef8'
        with self.assertRaisesRegex(M.Refused,'0D3_BASELINE'):M.artifact_contract(old,candidate,b)

    def test_trial_profile_is_not_parameterized(self):
        good={'root':'/opt/cisme-trial','user':'cisme-trial','database':'cisme_trial','domain':'staging-api.cisme.cn',
            'units':('cisme-trial-api.service','cisme-trial-worker.service'),'lock':'/run/lock/cisme-production-trial.lock','name':'trial'}
        M.fixed_profile(good)
        for k,v in [('root','/opt/cisme'),('database','cisme'),('units',('cisme-api.service','cisme-worker.service')),('name','production')]:
            with self.assertRaisesRegex(M.Refused,'TRIAL_ONLY'):M.fixed_profile({**good,k:v})

    def test_database_passwords_and_five_other_keys_must_differ(self):
        keys=['APP_SESSION_SECRET','UPLOAD_TOKEN_SECRET','CONTACT_ENCRYPTION_KEY','CONTACT_HASH_KEY','PRIVACY_FORMAL_EXPORT_KEY']
        trial={k:'trial-'+k for k in keys};prod={k:'production-'+k for k in keys}
        trial['DATABASE_URL']='postgres://cisme_trial:trial-pass@127.0.0.1:5432/cisme_trial'
        prod['DATABASE_URL']='postgres://cisme:prod-pass@127.0.0.1:5432/cisme'
        M.six_keys(trial,prod)
        for k in keys:
            with self.assertRaisesRegex(M.Refused,'SECRET_ISOLATION'):M.six_keys({**trial,k:prod[k]},prod)
        with self.assertRaisesRegex(M.Refused,'DATABASE_ISOLATION'):
            M.six_keys(trial,{**prod,'DATABASE_URL':'postgres://cisme:trial-pass@127.0.0.1:5432/cisme'})
        with self.assertRaisesRegex(M.Refused,'DATABASE_ISOLATION'):
            M.six_keys({**trial,'DATABASE_URL':trial['DATABASE_URL']+'?options=unsafe'},prod)

    def test_journal_and_editorial_fence_are_checked_without_writes(self):
        old,candidate,b=artifact_fixture();plan={'profile':{},'old':old,'articleFence':{'publishedCount':6,'items':[]}}
        fake=types.SimpleNamespace(database_facts=lambda p:{'database':'cisme_trial','owner':'cisme_trial',
            'journal':old['manifest']['migrations'],'otherClients':0})
        with patch.object(M,'D',fake),patch.object(M,'article_fence',return_value=plan['articleFence']):M.journal(plan,True)
        with patch.object(M,'D',fake),patch.object(M,'article_fence',return_value={'publishedCount':20,'items':[]}):
            with self.assertRaisesRegex(M.Refused,'EDITORIAL_BATCH_CHANGED'):M.journal(plan,True)

    def test_snapshot_primitives_equal_pinned_reviewed_source(self):
        source=(HERE/'trial-application-upgrade.py').read_text()
        def segments(text):
            result={}
            for node in ast.parse(text).body:
                name=node.name if isinstance(node,ast.FunctionDef) else node.targets[0].id if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) else None
                if name in {'SNAPSHOT_JS','crypto_args','private_hash','snapshot','validate_snapshot'}:result[name]=ast.get_source_segment(text,node)
            return result
        self.assertEqual(segments(source),segments((HERE/'trial-no-schema-upgrade.py').read_text()))
        self.assertEqual(M.BASELINE_HEAD,'0d3ff1c8d2cb6e2f53233e2cf6ca1efc62280527')

    def test_no_schema_action_or_business_cli_in_new_helper(self):
        tree=ast.parse((HERE/'trial-no-schema-upgrade.py').read_text())
        names={n.name for n in tree.body if isinstance(n,ast.FunctionDef)}
        self.assertNotIn('migrate',names)
        text=(HERE/'trial-no-schema-upgrade.py').read_text()
        self.assertNotIn("'migrate.mjs'),'up'",text)
        self.assertNotIn("'migrate.mjs'),'down'",text)
        self.assertNotIn('editorial-publish.js',text)
        self.assertNotIn('authority-grants.js',text)
        self.assertNotIn('publish-legal-documents.js',text)


class CutoverTests(unittest.TestCase):
    def exercise(self,failure=None,article_drift=False):
        old,candidate,b=artifact_fixture();events=[];writes={};state=Path('/offline/private/main-'+b['sourceHead'][:12]+'-1')
        profile={'root':'/opt/cisme-trial','user':'cisme-trial','database':'cisme_trial','domain':'staging-api.cisme.cn',
            'units':('cisme-trial-api.service','cisme-trial-worker.service'),'lock':'/run/lock/cisme-production-trial.lock','name':'trial'}
        plan={'profile':profile,'old':old,'candidate':candidate,'main':{'sha':b['sourceHead']},'ownership':{'ownershipId':'private'},
            'applicationActiveBytes':b'original-exact-0d3-active-record','articleFence':{'publishedCount':6,'items':[]}}
        switched=False;failed=False
        def command(args,**kw):
            self.assertEqual(args[:1],['systemctl']);self.assertIn(args[1],('start','stop'))
            self.assertEqual(tuple(args[2:]),profile['units']);events.append(args[1])
        def switch(p,directory):
            nonlocal switched
            switched=directory==candidate['directory'];events.append('switch-new' if switched else 'switch-old')
        def healthy(p,directory,*args):
            nonlocal failed
            events.append('healthy-new' if directory==candidate['directory'] else 'healthy-old')
            if directory==candidate['directory'] and failure=='health':failed=True;raise M.Refused('OFFLINE_HEALTH_FAILURE')
            return {'fastify':'5.12.6','sharp':'0.35.5'}
        def verify(p,**kw):
            if switched and failure=='dropin':raise M.Refused('UNKNOWN_DROPIN')
            events.append('verified')
        def journal(p,drain=False):
            events.append('journal-drained' if drain else 'journal')
            if failed and article_drift:raise M.Refused('NO_SCHEMA_EDITORIAL_BATCH_CHANGED')
        fake=types.SimpleNamespace(command=command,stopped=lambda p:events.append('stopped'),switch=switch,
            verify_units=lambda *a,**k:None,healthy=healthy,atomic_bytes=lambda p,raw:writes.update({str(p):raw}),
            general=types.SimpleNamespace(store=lambda p,raw:writes.update({str(p):raw})))
        def snapshot(*args):events.append('snapshot');return {'authenticated':True}
        with (patch.object(M,'D',fake),patch.object(M,'save_plan',lambda *a:events.append('saved')),
             patch.object(M,'verify_context',verify),patch.object(M,'verify_active',lambda *a:None),
             patch.object(M,'journal',journal),patch.object(M,'snapshot',snapshot),
             patch.object(M,'validate_snapshot',lambda *a:events.append('snapshot-verified'))):
            try:result=M.cutover(plan,state,'ROOT-OFFLINE-TEST')
            except M.Refused as e:result=str(e)
        return events,writes,result

    def test_success_snapshots_before_only_trial_switch_and_records_no_migration(self):
        events,writes,result=self.exercise()
        self.assertLess(events.index('stop'),events.index('snapshot'))
        self.assertLess(events.index('snapshot-verified'),events.index('switch-new'))
        self.assertLess(events.index('healthy-new'),len(events)-1)
        self.assertTrue(result['deployed']);self.assertFalse(result['migrationCommandExecuted'])
        self.assertFalse(result['productionChanged']);self.assertFalse(result['contentPublished'])

    def test_health_failure_restores_exact_old_active_bytes(self):
        events,writes,result=self.exercise('health')
        self.assertEqual(result,'NO_SCHEMA_FAILED_0D3_APPLICATION_RESTORED')
        self.assertIn('switch-old',events);self.assertIn('healthy-old',events)
        self.assertEqual(writes[str(M.ROOT/'application-active-release.json')],b'original-exact-0d3-active-record')

    def test_unknown_dropin_fences_without_overwrite_or_old_restart(self):
        events,writes,result=self.exercise('dropin')
        self.assertEqual(result,'NO_SCHEMA_FAILED_FENCED_REVIEW_REQUIRED')
        self.assertNotIn('switch-old',events);self.assertNotIn('healthy-old',events)
        self.assertNotIn(str(M.ROOT/'application-active-release.json'),writes)
        self.assertTrue(any(p.endswith('/manual-recovery-required.json') for p in writes))

    def test_new_batch_after_failure_prevents_old_api_restart(self):
        events,writes,result=self.exercise('health',True)
        self.assertEqual(result,'NO_SCHEMA_FAILED_FENCED_REVIEW_REQUIRED')
        self.assertNotIn('switch-old',events);self.assertNotIn('healthy-old',events)


if __name__=='__main__':unittest.main()
