import importlib.util
from datetime import datetime,timezone
import os
from pathlib import Path
import pwd
import tempfile
import time
import types
import unittest
from unittest.mock import patch

path=Path(__file__).with_name('trial-community-story-update.py')
spec=importlib.util.spec_from_file_location('profile_update',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class CommunityStoryUpdateContract(unittest.TestCase):
    def artifacts(self):
        m.H=types.SimpleNamespace(DEPENDENCIES='deps')
        sql=[f'old-{i:03}.sql'for i in range(109)];names=['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+n for n in sql]
        files={n:n.encode()for n in names};old={'manifest':{'sourceHead':m.BASE,'sourceTree':m.BASE_TREE,'migrations':sql},'manifestSha256':m.BASE_MANIFEST,'files':files,'dependenciesSha256':'deps'}
        files={**files,'db/migrations/'+m.MIGRATION:b'new comment likes'}
        binding={'sourceHead':'1'*40,'sourceTree':'2'*40,'manifestSha256':'3'*64,'migrationSha256':{n:m.sha(files['db/migrations/'+n])for n in sql+[m.MIGRATION]}}
        new={'manifest':{'sourceHead':binding['sourceHead'],'sourceTree':binding['sourceTree'],'migrations':sql+[m.MIGRATION],
          'configurationIncluded':False,'buildPlatform':{'os':'linux','arch':'x64','libc':'glibc'}},'manifestSha256':binding['manifestSha256'],'files':files,'dependenciesSha256':'deps'}
        return old,new,binding
    def test_only110_with_the_exact_old_dependencies_packages_migrator_and109_sql(self):
        old,new,b=self.artifacts();m.artifact_contract(old,new,b)
        for name in ['package.json','package-lock.json','migrate.mjs','db/migrations/old-001.sql']:
            changed={**new,'files':{**new['files'],name:b'changed'}}
            with self.assertRaisesRegex(m.Refused,'HISTORICAL_FILE_DRIFT'):m.artifact_contract(old,changed,b)
    def test_wrong_schema_platform_configuration_or_dependencies_are_refused(self):
        for field,value in [('migrations',['unexpected.sql']),('buildPlatform',{'os':'darwin','arch':'arm64','libc':'none'}),('configurationIncluded',True)]:
            old,new,b=self.artifacts();new['manifest'][field]=value
            with self.assertRaises(m.Refused):m.artifact_contract(old,new,b)
        old,new,b=self.artifacts();new['dependenciesSha256']='changed'
        with self.assertRaisesRegex(m.Refused,'DEPENDENCY_DRIFT'):m.artifact_contract(old,new,b)
    def test_another_baseline_or_candidate_manifest_is_refused(self):
        old,new,b=self.artifacts();old['manifestSha256']='wrong'
        with self.assertRaisesRegex(m.Refused,'EXACT_BASELINE_REQUIRED'):m.artifact_contract(old,new,b)
        old,new,b=self.artifacts();new['manifestSha256']='wrong'
        with self.assertRaisesRegex(m.Refused,'EXACT_CANDIDATE_REQUIRED'):m.artifact_contract(old,new,b)
    def test_fence_preserves_every_original_table_and_excludes_only_the_new_empty_like_table(self):
        calls=[]
        def query(profile,sql):
            calls.append(sql);return ['editorial_article','editorial_publisher','member_profile','member','schema_migration','ugc_post','consent_acceptance','legal_document','audit_log']if len(calls)==1 else {}
        m.D=types.SimpleNamespace(query=query);m.facts({},True);sql=calls[-1]
        self.assertNotIn("-'publisher_id'",sql)
        self.assertIn("WHERE version<>'"+m.MIGRATION+"'",sql)
        for table in ['editorial_publisher','member','ugc_post','consent_acceptance','legal_document','audit_log']:
            self.assertRegex(sql,'FROM '+table+r' t(?: UNION|\) s)')
        self.assertIn("tablename<>'ugc_comment_like'",calls[0])
        calls.clear();m.facts({},False);self.assertNotIn("tablename<>'ugc_comment_like'",calls[0])
    def test_release_source_never_changes_gate_credentials_or_restores_a_database(self):
        source=path.read_text()
        self.assertNotIn("os.replace(temporary,ROOT/'runtime.env')",source)
        self.assertNotIn("'restore'",source)
        self.assertNotIn("'activate-trial-community.mjs'",source)
        self.assertIn("comment_like_contract(plan['profile'])",source)
        self.assertIn("need(facts(plan['profile'],True)==fence",source)
        self.assertIn("'publicUgcEnabled':True",source)

    def health_fixture(self,root,completed):
        heartbeat=Path(root)/'tmp/cisme-worker-heartbeat.json';heartbeat.parent.mkdir()
        heartbeat.write_text('{"completedAtUtc":"'+completed+'"}');heartbeat.chmod(0o600)
        return {'profile':{'root':root,'user':pwd.getpwuid(os.getuid()).pw_name},
          'candidate':{'directory':'/exact/immutable/release'},'openConfig':{'UGC_GO_LIVE_GATE':'true'}}

    def test_health_uses_open_ugc_process_checks_and_fresh_heartbeat_before_native_smoke(self):
        calls=[]
        def running(plan):
            self.assertEqual(plan['openConfig']['UGC_GO_LIVE_GATE'],'true');calls.append('running')
        with tempfile.TemporaryDirectory()as root:
            plan=self.health_fixture(root,datetime.now(timezone.utc).isoformat())
            runtime=types.SimpleNamespace(running=running,public_contract=lambda plan:calls.append('public'))
            dependency=types.SimpleNamespace(healthy=lambda *args:self.fail('closed-gate health runner used'),
              native_smoke=lambda profile,directory,patched:calls.append((directory,patched)))
            with patch.object(m,'M',runtime),patch.object(m,'D',dependency):m.healthy(plan,time.time()-1)
        self.assertEqual(calls,['running','public',('/exact/immutable/release',True)])

    def test_health_does_not_accept_a_heartbeat_from_before_this_start(self):
        with tempfile.TemporaryDirectory()as root:
            plan=self.health_fixture(root,datetime.fromtimestamp(time.time()-30,timezone.utc).isoformat())
            runtime=types.SimpleNamespace(running=lambda plan:None,public_contract=lambda plan:None)
            dependency=types.SimpleNamespace(native_smoke=lambda *args:self.fail('stale heartbeat accepted'))
            with patch.object(m,'M',runtime),patch.object(m,'D',dependency),patch.object(m.time,'sleep',lambda seconds:None):
                with self.assertRaisesRegex(m.Refused,'NEW_HEARTBEAT_REQUIRED'):m.healthy(plan,time.time())

    def test_new_table_is_empty_and_likes_are_keyed_to_comment_and_actor(self):
        for rows,code in [([0,['comment_id','member_id']],None),([1],'NEW_INTERACTIONS_MUST_START_EMPTY'),([0,['comment_id']],'OWN_INTERACTION_KEY_REQUIRED')]:
            with patch.object(m,'D',types.SimpleNamespace(query=lambda *args:rows.pop(0))):
                if code:
                    with self.assertRaisesRegex(m.Refused,code):m.comment_like_contract({})
                else:m.comment_like_contract({})

if __name__=='__main__':unittest.main()
