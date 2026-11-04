import importlib.util
from pathlib import Path
import types
import unittest

path=Path(__file__).with_name('trial-community-profile-update.py')
spec=importlib.util.spec_from_file_location('profile_update',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ProfileUpdateContract(unittest.TestCase):
    def artifacts(self):
        m.H=types.SimpleNamespace(DEPENDENCIES='deps')
        sql=[f'old-{i:03}.sql'for i in range(107)];names=['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+n for n in sql]
        files={n:n.encode()for n in names};old={'manifest':{'sourceHead':m.BASE,'sourceTree':m.BASE_TREE,'migrations':sql},'manifestSha256':m.BASE_MANIFEST,'files':files,'dependenciesSha256':'deps'}
        files={**files,'db/migrations/'+m.MIGRATION:b'new bio columns'}
        binding={'sourceHead':'1'*40,'sourceTree':'2'*40,'manifestSha256':'3'*64,'migrationSha256':{n:m.sha(files['db/migrations/'+n])for n in sql+[m.MIGRATION]}}
        new={'manifest':{'sourceHead':binding['sourceHead'],'sourceTree':binding['sourceTree'],'migrations':sql+[m.MIGRATION],
          'configurationIncluded':False,'buildPlatform':{'os':'linux','arch':'x64','libc':'glibc'}},'manifestSha256':binding['manifestSha256'],'files':files,'dependenciesSha256':'deps'}
        return old,new,binding
    def test_only108_with_the_exact_old_dependencies_packages_migrator_and107_sql(self):
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
    def test_fence_retains_all_existing_user_facts_and_strips_only_the_two_new_default_columns(self):
        calls=[]
        def query(profile,sql):
            calls.append(sql);return ['member_profile','member','schema_migration','ugc_post','consent_acceptance','legal_document','audit_log']if len(calls)==1 else {}
        m.D=types.SimpleNamespace(query=query);m.facts({},True);sql=calls[-1]
        self.assertIn("to_jsonb(t)-'community_bio'-'community_bio_revision'",sql)
        self.assertIn("ORDER BY (to_jsonb(t)-'community_bio'-'community_bio_revision')::text",sql)
        self.assertIn("WHERE version<>'"+m.MIGRATION+"'",sql)
        for table in ['member','ugc_post','consent_acceptance','legal_document','audit_log']:
            self.assertRegex(sql,'FROM '+table+r' t(?: UNION|\) s)')
        calls.clear();m.facts({},False);self.assertNotIn("-'community_bio'",calls[-1])
    def test_release_source_never_changes_gate_credentials_or_restores_a_database(self):
        source=path.read_text()
        self.assertNotIn("os.replace(temporary,ROOT/'runtime.env')",source)
        self.assertNotIn("'restore'",source)
        self.assertNotIn("'activate-trial-community.mjs'",source)
        self.assertIn("'NEW_BIO_DEFAULTS_REQUIRED'",source)
        self.assertIn("need(facts(plan['profile'],True)==fence",source)
        self.assertIn("'publicUgcEnabled':True",source)

if __name__=='__main__':unittest.main()
