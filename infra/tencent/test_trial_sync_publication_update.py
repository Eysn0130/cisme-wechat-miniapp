import importlib.util
import base64
import hashlib
import json
from pathlib import Path
import types
import unittest
from unittest.mock import Mock

p=Path(__file__).with_name('trial-sync-publication-update.py')
spec=importlib.util.spec_from_file_location('sync_update',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class SyncUpdateContract(unittest.TestCase):
    def setUp(self):
        def parse(raw):return dict(line.split('=',1)for line in raw.splitlines()if line and not line.startswith('#'))
        m.D=types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(audit=types.SimpleNamespace(environment=parse))))
    def test_exact_scope_keeps_private_credentials_and_other_features(self):
        cfg={'APP_ENV':'staging','ALLOW_DEV_ADAPTERS':'false','UGC_GO_LIVE_GATE':'false','WECHAT_MESSAGE_TOKEN':'synthetic-retained',
          'WECHAT_MESSAGE_AES_KEY':'synthetic-retained-aes','APP_SESSION_SECRET':'synthetic-retained-session','COMMERCE_ORDER_FLOW_ENABLED':'false'}
        raw=('\n'.join(k+'='+v for k,v in cfg.items())+'\n').encode()
        after,body=m.config_delta(cfg,raw)
        self.assertEqual(after,{**cfg,**m.DELTA})
        self.assertEqual({k:v for k,v in after.items()if k not in m.DELTA},{k:v for k,v in cfg.items()if k not in m.DELTA})
        self.assertNotIn('UGC_MODERATION_READY',m.DELTA)
        self.assertEqual(body.count(b'UGC_GO_LIVE_GATE='),1)
    def test_duplicate_or_already_open_input_is_refused(self):
        with self.assertRaisesRegex(m.Refused,'DUPLICATE_SETTING'):
            m.config_delta({'APP_ENV':'staging'},b'APP_ENV=staging\nUGC_GO_LIVE_GATE=false\nUGC_GO_LIVE_GATE=false\n')
        for cfg in ({'APP_ENV':'production'},{'APP_ENV':'staging','UGC_GO_LIVE_GATE':'true'}):
            with self.assertRaisesRegex(m.Refused,'CLOSED_TRIAL'):m.config_delta(cfg,b'')
    def artifacts(self):
        m.H=types.SimpleNamespace(DEPENDENCIES='deps')
        sql=[f'old-{i:03}.sql'for i in range(106)];names=['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+n for n in sql]
        files={n:n.encode()for n in names};old={'manifest':{'sourceHead':m.BASE,'sourceTree':m.BASE_TREE,'migrations':sql},'files':files,'dependenciesSha256':'deps'}
        files={**files,'db/migrations/'+m.MIGRATION:b'only107'}
        b={'sourceHead':'1'*40,'sourceTree':'2'*40,'manifestSha256':'3'*64,'migrationSha256':{n:m.sha(files['db/migrations/'+n])for n in sql+[m.MIGRATION]}}
        candidate={'manifest':{'sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'migrations':sql+[m.MIGRATION],
          'configurationIncluded':False,'buildPlatform':{'os':'linux','arch':'x64','libc':'glibc'}},'files':files,'dependenciesSha256':'deps','manifestSha256':b['manifestSha256']}
        return old,candidate,b
    def test_only_additive107_and_original_runtime_bytes_are_accepted(self):
        old,new,b=self.artifacts();m.artifact_contract(old,new,b)
        for name in ('package.json','package-lock.json','migrate.mjs','db/migrations/old-001.sql'):
            changed={**new,'files':{**new['files'],name:b'changed'}}
            with self.assertRaisesRegex(m.Refused,'HISTORICAL_FILE_DRIFT'):m.artifact_contract(old,changed,b)
    def test_wrong_schema_platform_or_dependencies_are_rejected(self):
        for field,value in (('migrations',['other.sql']),('buildPlatform',{'os':'darwin','arch':'arm64','libc':'none'}),('configurationIncluded',True)):
            old,new,b=self.artifacts();new['manifest'][field]=value
            with self.assertRaises(m.Refused):m.artifact_contract(old,new,b)
        old,new,b=self.artifacts();new['dependenciesSha256']='changed'
        with self.assertRaisesRegex(m.Refused,'DEPENDENCY_DRIFT'):m.artifact_contract(old,new,b)
    def test_business_fence_never_excludes_member_post_media_or_consent_facts(self):
        statements=[]
        def query(profile,sql):
            statements.append(sql)
            return ['audit_log','consent_acceptance','legal_document','member','schema_migration','ugc_go_live_approval','ugc_media_asset','ugc_post']if len(statements)==1 else {}
        m.D=types.SimpleNamespace(query=query);m.facts({},True,'12345678-1234-1234-1234-123456789012')
        sql=statements[-1]
        for table in ('member','ugc_post','ugc_media_asset','consent_acceptance'):
            self.assertRegex(sql,'FROM '+table+r' t(?: UNION|\) s)')
        self.assertIn("WHERE trace_id IS DISTINCT FROM '12345678-1234-1234-1234-123456789012'",sql)
        self.assertNotIn('WHERE true',sql)
    def test_closed_public_readback_is_rejected(self):
        m.D=types.SimpleNamespace(command=lambda args:b'{"ready":true,"publicEnabled":false,"draftsEnabled":true}')
        with self.assertRaisesRegex(m.Refused,'PUBLIC_READBACK_REQUIRED'):m.public_contract({'profile':{'domain':'synthetic.invalid'}})
    def test_real_health_response_schema_and_open_status_are_accepted(self):
        for module in (m,module_health_fix()):
            command=lambda args:b'{"status":"ready"}'if args[-1].endswith('/health/ready')else b'{"publicEnabled":true,"draftsEnabled":true}'
            if module is m:
                module.D=types.SimpleNamespace(command=command);call=lambda:module.public_contract({'profile':{'domain':'synthetic.invalid'}})
            else:
                module._runtime=types.SimpleNamespace(D=types.SimpleNamespace(command=command),need=m.need)
                call=lambda:module.public_contract({'profile':{'domain':'synthetic.invalid'}})
            call()
    def test_both_checks_refuse_unready_missing_or_closed_responses(self):
        for health,status in ((b'{"ready":true}',b'{"publicEnabled":true,"draftsEnabled":true}'),
          (b'{"status":"unready"}',b'{"publicEnabled":true,"draftsEnabled":true}'),
          (b'{"status":"ready"}',b'{"publicEnabled":false,"draftsEnabled":true}'),
          (b'{"status":"ready"}',b'{"publicEnabled":true}')):
            for module in (m,module_health_fix()):
                command=lambda args:health if args[-1].endswith('/health/ready')else status
                if module is m:
                    module.D=types.SimpleNamespace(command=command)
                else:module._runtime=types.SimpleNamespace(D=types.SimpleNamespace(command=command),need=m.need)
                with self.assertRaisesRegex(m.Refused,'PUBLIC_READBACK_REQUIRED'):
                    module.public_contract({'profile':{'domain':'synthetic.invalid'}})
    def source_fixture(self):
        module=module_health_fix();raw=b'committed correction code'
        blob=lambda v:hashlib.sha1(b'blob '+str(len(v)).encode()+b'\0'+v).hexdigest()
        value={'path':module.SOURCE,'type':'file','encoding':'base64','content':base64.b64encode(raw).decode(),'size':len(raw),'sha':blob(raw)}
        commit={'tree':{'sha':'2'*40}}
        delta={'status':'ahead','merge_base_commit':{'sha':module.APP},'files':[{'filename':p,'status':'added'if p==module.SOURCE else'modified','sha':blob(raw)}for p in module.ALLOWED]}
        def response(url,limit):return json.dumps(value if '/contents/'in url else commit if '/git/commits/'in url else delta).encode()
        h=types.SimpleNamespace(candidate_ci=Mock(),source_bytes=Mock(side_effect=AssertionError('package-only reader must not be widened')),
          response=response,parse=json.loads,git_blob=blob)
        runtime=types.SimpleNamespace(H=h,need=m.need,protected=lambda *a:raw)
        return module,runtime,{'sourceHead':'1'*40,'sourceTree':'2'*40},value,delta
    def test_correction_reads_only_its_fixed_github_path_and_preserves_package_reader_restrictions(self):
        module,runtime,fix,value,delta=self.source_fixture();module.permit(runtime,fix)
        runtime.H.candidate_ci.assert_called_once_with(fix);runtime.H.source_bytes.assert_not_called()
    def test_wrong_code_or_application_diff_cannot_be_accepted(self):
        for mutation in ('path','sha','size','app'):
            module,runtime,fix,value,delta=self.source_fixture()
            if mutation=='app':delta['files'][0]['filename']='services/api/src/server.ts'
            elif mutation=='path':value['path']='other.py'
            elif mutation=='sha':value['sha']='0'*40
            else:value['size']+=1
            with self.assertRaises(m.Refused):module.permit(runtime,fix)

def module_health_fix():
    path=Path(__file__).with_name('trial-sync-publication-health-fix.py')
    spec=importlib.util.spec_from_file_location('health_fix',path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value

if __name__=='__main__':unittest.main()
