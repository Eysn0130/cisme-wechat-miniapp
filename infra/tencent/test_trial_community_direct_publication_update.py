"""Offline105 -> sole106 trial migration guards. No network, SSH or database."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import types

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
spec = importlib.util.spec_from_file_location('direct_update', HERE / 'trial-community-direct-publication-update.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def fixture():
    names = sorted(p.name for p in (REPO / 'db/migrations').glob('*.sql') if p.name < M.MIGRATION)
    assert len(names) == 105
    files = {name: (REPO / path).read_bytes() for name, path in [('migrate.mjs', 'scripts/release-migrate.mjs'),
        ('package.json', 'package.json'), ('package-lock.json', 'package-lock.json')]}
    files.update({'db/migrations/' + name: (REPO / 'db/migrations' / name).read_bytes() for name in names})
    old = {'directory': str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])), 'files': files,
        'dependenciesSha256': M.DEPENDENCIES, 'manifestSha256': M.BASELINE_MANIFEST,
        'manifest': {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'migrations': names}}
    new = copy.deepcopy(old)
    new.update(directory=str(M.ROOT / 'releases' / ('tencent-release-' + '1' * 12)), manifestSha256='a' * 64)
    new['manifest'].update(sourceHead='1' * 40, sourceTree='2' * 40, sourceLockSha256=M.SOURCE_LOCK,
        migrations=names + [M.MIGRATION], node='v24.14.0', buildPlatform={'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
        configurationIncluded=False, deployed=False, releaseReady=False)
    new['files']['db/migrations/' + M.MIGRATION] = (REPO / 'db/migrations' / M.MIGRATION).read_bytes()
    helper, archive = b'synthetic-helper', b'synthetic-archive'
    binding = {'schemaVersion': 1, 'kind': 'trial-community-direct-publication-update',
        'baselineHead': M.BASELINE_HEAD, 'baselineTree': M.BASELINE_TREE, 'sourceHead': '1' * 40, 'sourceTree': '2' * 40,
        'ciRunId': 123, 'ciVerifyJobId': 456, 'helperSha256': M.sha(helper), 'manifestSha256': 'a' * 64,
        'archiveSha256': M.sha(archive), 'archiveBytes': len(archive),
        'archivePath': str(M.STAGES / ('community-direct-publication-' + '1' * 12 + '-synthetic123') / 'archive.tar.gz'),
        'dependenciesSha256': M.DEPENDENCIES, 'migrations': 106, 'applicationRollbackAllowed': False,
        'migrationSha256': {name: M.sha(new['files']['db/migrations/' + name]) for name in names + [M.MIGRATION]}}
    return old, new, binding, helper


class Guards(unittest.TestCase):
    def test_exact_artifact(self):
        old, new, binding, _ = fixture()
        M.artifact_contract(old, new, binding)
        for path in old['files']:
            with self.subTest(path=path):
                changed = copy.deepcopy(new)
                changed['files'][path] += b'drift'
                with self.assertRaises(M.Refused):
                    M.artifact_contract(old, changed, binding)

    def test_wrong_runtime_manifest_or_dependencies_refused(self):
        old, new, binding, _ = fixture()
        for key, val in [('sourceHead', '3' * 40), ('sourceTree', '3' * 40), ('node', 'v24.18.0'),
            ('buildPlatform', {'os': 'darwin', 'arch': 'arm64', 'libc': None}), ('configurationIncluded', True),
            ('deployed', True), ('releaseReady', True), ('migrations', old['manifest']['migrations'])]:
            with self.subTest(key=key):
                changed = copy.deepcopy(new)
                changed['manifest'][key] = val
                with self.assertRaises(M.Refused): M.artifact_contract(old, changed, binding)
        new['dependenciesSha256'] = 'a' * 64
        with self.assertRaises(M.Refused): M.artifact_contract(old, new, binding)

    def test_binding_must_be_exact_new_private_runner_and106(self):
        _, _, binding, helper = fixture()
        runner = M.RUNNERS / ('1' * 12) / 'trial-community-direct-publication-update.py'
        with patch.object(M, '__file__', str(runner)), patch.object(M, 'read', return_value=helper):
            self.assertEqual(M.validate_binding(binding), binding)
            for key, value in [('kind', 'trial-community-compose-update'), ('baselineHead', '3' * 40),
                ('sourceHead', M.BASELINE_HEAD), ('sourceTree', '0' * 40), ('migrations', 105), ('ciRunId', True),
                ('ciVerifyJobId', 0), ('archiveBytes', 0), ('archivePath', '/tmp/archive.tar.gz'),
                ('applicationRollbackAllowed', True), ('helperSha256', 'f' * 64)]:
                with self.subTest(key=key):
                    changed = copy.deepcopy(binding)
                    changed[key] = value
                    with self.assertRaises(M.Refused): M.validate_binding(changed)
        with patch.object(M, '__file__', '/tmp/helper.py'), patch.object(M, 'read', return_value=helper):
            with self.assertRaises(M.Refused): M.validate_binding(binding)

    def test_index_catalog_verified_and_cannot_preexist(self):
        query = Mock(return_value=None)
        with patch.object(M, 'D', types.SimpleNamespace(query=query)):
            M.direct_index({}, False)
            with self.assertRaises(M.Refused): M.direct_index({}, True)
            expected = {'owner': 'cisme_trial', 'table': 'audit_log', 'method': 'btree', 'valid': True, 'ready': True,
                'unique': False, 'primary': False, 'keys': 2, 'attributes': 2,
                'definition': "CREATE INDEX ugc_direct_publication_intent_idx ON public.audit_log USING btree (object_id, ((after_state ->> 'newRevision'::text))) WHERE ((object_type = 'ugc_post'::text) AND (action = 'ugc.post_submitted'::text) AND ((after_state ->> 'directPublication'::text) = 'true'::text))"}
            query.return_value = expected
            M.direct_index({}, True)
            with self.assertRaises(M.Refused): M.direct_index({}, False)
            for key in expected:
                with self.subTest(key=key):
                    query.return_value = {**expected, key: None}
                    with self.assertRaises(M.Refused): M.direct_index({}, True)

    def test_journal_keeps_all_previous_schema_and_guard_checks(self):
        old, new, _, _ = fixture()
        plan = {'old': old, 'candidate': new, 'profile': {}, 'config': {}, 'ownership': {}, 'ugcGuardBaseline': {'original': True}}
        old_sql, new_sql = old['manifest']['migrations'], new['manifest']['migrations']
        db = Mock(return_value=old_sql)
        k = types.SimpleNamespace(B=types.SimpleNamespace(schema103=Mock()), schema104=Mock())
        snap = types.SimpleNamespace(schema101=Mock())
        with patch.object(M, 'C', types.SimpleNamespace(database_guard=db)), patch.object(M, 'K', k), patch.object(M, 'S', snap), patch.object(M, 'ugc_guards') as guards, patch.object(M, 'direct_index') as index:
            self.assertEqual(M.journal(plan, [old_sql], True), old_sql)
            index.assert_called_with({}, False)
            guards.assert_called_with({}, {'original': True})
            k.schema104.assert_called_with({}, True)
            k.B.schema103.assert_called_once_with({})
            snap.schema101.assert_called_once_with({})
            db.return_value = new_sql
            M.journal(plan, [new_sql], True)
            index.assert_called_with({}, True)
            db.return_value = ['unexpected.sql']
            with self.assertRaises(M.Refused): M.journal(plan, [old_sql, new_sql])

    def test_safe_error_never_exports_arbitrary_remote_values(self):
        self.assertEqual(M.safe_error_code(Exception('secret')), 'COMMUNITY_DIRECT_REVIEW_REQUIRED')
        self.assertEqual(M.safe_error_code(M.Refused('COMMUNITY_DIRECT_INDEX_CATALOG_DRIFT')), 'COMMUNITY_DIRECT_INDEX_CATALOG_DRIFT')


if __name__ == '__main__': unittest.main()
