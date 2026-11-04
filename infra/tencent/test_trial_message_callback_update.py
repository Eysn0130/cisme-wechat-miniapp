"""Offline invariants for the callback-only trial preparation."""
import copy
import contextlib
import io
import sys
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).parent

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    obj = importlib.util.module_from_spec(spec); spec.loader.exec_module(obj)
    return obj

M = module('callback_update', HERE / 'trial-message-callback-update.py')
A = module('callback_env_parser', HERE / 'production-security-audit.py')
BASE = module('callback_pinned_baseline', HERE / 'trial-community-direct-publication-update.py')
D = types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(audit=A)))

class ConfigTests(unittest.TestCase):
    def test_only_three_callback_settings_are_added_and_quoted_private_values_remain_exact(self):
        raw = b"APP_ENV=staging\nUGC_GO_LIVE_GATE=false\nCOMMERCE_ORDER_FLOW_ENABLED=false\nDEEPSEEK_API_KEY='synthetic key with spaces'\n"
        original = A.environment(raw.decode())
        with patch.object(M, 'D', D):
            config, updated = M.callback_config(original, raw, 'a'*32, 'B'*43)
        self.assertTrue(updated.startswith(raw))
        self.assertEqual(set(config)-set(original), set(M.KEYS))
        self.assertEqual({k:v for k,v in config.items() if k not in M.KEYS}, original)
        self.assertEqual(A.environment(updated.decode()), config)
        self.assertEqual(config['UGC_GO_LIVE_GATE'], 'false')
        self.assertEqual(config['COMMERCE_ORDER_FLOW_ENABLED'], 'false')

    def test_existing_settings_are_never_rotated_or_overwritten(self):
        for key in M.KEYS:
            with self.subTest(key=key), self.assertRaisesRegex(M.Refused, 'EXISTING_CALLBACK_CONFIG'):
                M.callback_config({key:'existing'}, b'', 'a'*32, 'B'*43)

    def test_invalid_platform_key_lengths_are_rejected_before_config_is_used(self):
        for token, aes in [('a'*33,'B'*43),('a','B'*43),('a'*32,'B'*42),('a'*32,'-'*43)]:
            with self.subTest(token_length=len(token)), self.assertRaisesRegex(M.Refused, 'KEY_FORMAT'):
                M.callback_config({}, b'', token, aes)

    def test_phase_selection_does_not_modify_the_saved_original(self):
        p={'env':b'original','config':{'UGC_GO_LIVE_GATE':'false'},
           'callbackEnv':b'prepared','callbackConfig':{'UGC_GO_LIVE_GATE':'false',M.KEYS[0]:'synthetic'}}
        original=copy.deepcopy(p)
        self.assertIs(M.effective(p,False), p)
        self.assertEqual(M.effective(p,True)['env'], b'prepared')
        self.assertEqual(p, original)

    def test_private_handoff_describes_the_same_keys_and_encrypted_json_mode(self):
        raw=M.callback_document({M.KEYS[0]:'synthetic-token',M.KEYS[1]:'B'*43}).decode()
        self.assertIn(M.CALLBACK_URL, raw)
        self.assertIn('synthetic-token', raw)
        self.assertIn('安全模式', raw)
        self.assertIn('JSON', raw)
        self.assertNotIn('AppSecret', raw)

class ArtifactTests(unittest.TestCase):
    def fixture(self):
        sql=[f'{i:012d}_synthetic.sql' for i in range(106)]
        files={name:b'synthetic' for name in ['migrate.mjs','package.json','package-lock.json']+['db/migrations/'+s for s in sql]}
        old={'manifest':{'sourceHead':M.BASELINE_HEAD,'sourceTree':M.BASELINE_TREE,'migrations':sql},
             'manifestSha256':M.BASELINE_MANIFEST,'files':files,'dependenciesSha256':BASE.DEPENDENCIES}
        b={'sourceHead':'1'*40,'sourceTree':'2'*40,'manifestSha256':'3'*64,
           'migrationSha256':{s:M.sha(files['db/migrations/'+s]) for s in sql}}
        new={'manifest':{'sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'migrations':sql,
                        'configurationIncluded':False,'buildPlatform':{'os':'linux','arch':'x64','libc':'glibc'}},
             'manifestSha256':b['manifestSha256'],'files':copy.deepcopy(files),'dependenciesSha256':BASE.DEPENDENCIES}
        return old,new,b

    def test_exact_106_schema_and_dependency_tree_are_preserved(self):
        old,new,b=self.fixture()
        with patch.object(M,'H',BASE): M.artifact_contract(old,new,b)

    def test_sql_migrator_package_and_dependency_changes_are_rejected(self):
        old,new,b=self.fixture()
        for path in new['files']:
            altered=copy.deepcopy(new);altered['files'][path]=b'changed'
            with self.subTest(path=path),patch.object(M,'H',BASE),self.assertRaises(M.Refused):
                M.artifact_contract(old,altered,b)
        for change in ['sql','dependencies','platform']:
            altered=copy.deepcopy(new)
            if change=='sql':altered['manifest']['migrations']=altered['manifest']['migrations'][:-1]
            if change=='dependencies':altered['dependenciesSha256']='0'*64
            if change=='platform':altered['manifest']['buildPlatform']['arch']='arm64'
            with self.subTest(change=change),patch.object(M,'H',BASE),self.assertRaises(M.Refused):
                M.artifact_contract(old,altered,b)

    def test_original_guard_and_binding_constants_are_not_rewritten(self):
        self.assertEqual(M.BASELINE_HELPER_SHA,M.sha((HERE/'trial-community-direct-publication-update.py').read_bytes()))
        self.assertEqual(M.BASELINE_HEAD,'97acb0028aad7b9c832c01b80ad3d4e7da1ffdac')
        self.assertNotEqual(M.STATES,BASE.STATE_PARENT)
        self.assertNotEqual(M.ACTIVE,BASE.ACTIVE)

class VerificationTests(unittest.TestCase):
    def test_prepared_context_rejects_an_unrelated_feature_flag_change(self):
        plan={'profile':{},'config':{'APP_ENV':'staging','UGC_GO_LIVE_GATE':'false'},
              'callbackConfig':{'APP_ENV':'staging','UGC_GO_LIVE_GATE':'true',M.KEYS[2]:M.SCAN_ORIGIN},
              'callbackEnv':b'private','env':b'original'}
        h=types.SimpleNamespace(target=Mock())
        c=types.SimpleNamespace(fixed_profile=Mock())
        d=types.SimpleNamespace(verify_context=Mock(),closed_context=Mock(return_value=True))
        with patch.object(M,'H',h),patch.object(M,'C',c),patch.object(M,'D',d),self.assertRaisesRegex(M.Refused,'UNRELATED_CONFIG'):
            M.verify(plan,prepared=True)

    def test_cli_defaults_to_read_only_preflight_and_never_calls_apply(self):
        b={'sourceHead':'1'*40}
        out=io.StringIO()
        args=['callback-update','--binding','/private/binding.json','--binding-sha256','a'*64]
        with patch.object(sys,'argv',args),patch.object(M,'binding',return_value=b), \
             patch.object(M,'preflight',return_value={'binding':b}) as preflight, \
             patch.object(M,'apply') as apply,patch.object(M,'active') as active,contextlib.redirect_stdout(out):
            self.assertEqual(M.main(),0)
        preflight.assert_called_once_with(b);apply.assert_not_called();active.assert_not_called()
        self.assertTrue(json.loads(out.getvalue())['readOnly'])

if __name__=='__main__':unittest.main()
