import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
spec = importlib.util.spec_from_file_location('comment_support_upgrade', HERE / 'trial-comment-support-upgrade.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def fixtures():
    names = sorted(path.name for path in (REPO / 'db/migrations').glob('*.sql') if path.name < M.MIGRATIONS[0])
    assert len(names) == 101
    files = {name: (REPO / source).read_bytes() for name, source in (
        ('migrate.mjs', 'scripts/release-migrate.mjs'), ('package.json', 'package.json'), ('package-lock.json', 'package-lock.json'))}
    files.update({'db/migrations/' + name: (REPO / 'db/migrations' / name).read_bytes() for name in names})
    old = {'directory': '/synthetic/old', 'files': files, 'dependenciesSha256': M.DEPENDENCIES,
        'manifestSha256': 'a' * 64, 'manifest': {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'migrations': names}}
    candidate = copy.deepcopy(old)
    candidate.update(directory='/synthetic/new', manifestSha256='b' * 64)
    candidate['manifest'].update(sourceHead='1' * 40, sourceTree='2' * 40, migrations=names + list(M.MIGRATIONS),
        node='v24.14.0', buildPlatform={'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
        configurationIncluded=False, deployed=False, releaseReady=False)
    for name in M.MIGRATIONS:
        candidate['files']['db/migrations/' + name] = (REPO / 'db/migrations' / name).read_bytes()
    b = {'sourceHead': '1' * 40, 'sourceTree': '2' * 40, 'manifestSha256': 'b' * 64,
        'migrationSha256': {name: M.sha(candidate['files']['db/migrations/' + name]) for name in M.MIGRATIONS}}
    return old, candidate, b


class ArtifactTests(unittest.TestCase):
    def test_only_exact_old101_and_new102_103_are_accepted(self):
        M.artifact_contract(*fixtures())

    def test_all_old_sql_package_lock_and_migrator_bytes_are_immutable(self):
        old, candidate, b = fixtures()
        self.assertEqual(len(old['files']), 104)
        for name in old['files']:
            with self.subTest(name=name):
                changed = copy.deepcopy(candidate)
                changed['files'][name] += b'changed'
                with self.assertRaisesRegex(M.Refused, 'OLD_SQL_PACKAGE_OR_MIGRATOR'):
                    M.artifact_contract(old, changed, b)

    def test_sql_order_set_new_bytes_and_dependencies_are_exact(self):
        old, candidate, b = fixtures()
        for key in ('missing', 'reordered', 'extra', 'changed'):
            changed = copy.deepcopy(candidate)
            if key == 'missing':
                changed['manifest']['migrations'].pop()
            elif key == 'reordered':
                changed['manifest']['migrations'].reverse()
            elif key == 'extra':
                changed['manifest']['migrations'].append('209901010001_unrequested.sql')
            else:
                changed['files']['db/migrations/' + M.MIGRATIONS[0]] += b'changed'
            with self.subTest(key=key), self.assertRaises(M.Refused):
                M.artifact_contract(old, changed, b)
        candidate['dependenciesSha256'] = '0' * 64
        with self.assertRaisesRegex(M.Refused, 'FULL_DEPENDENCY'):
            M.artifact_contract(old, candidate, b)

    def test_macos_arm64_and_other_node_versions_are_refused(self):
        old, candidate, b = fixtures()
        for key, value in [('buildPlatform', {'os': 'darwin', 'arch': 'arm64', 'libc': 'glibc'}), ('node', 'v24.15.0')]:
            changed = copy.deepcopy(candidate)
            changed['manifest'][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(M.Refused, 'EXACT_LINUX'):
                M.artifact_contract(old, changed, b)


class SourceTests(unittest.TestCase):
    def source(self, name, raw, **patches):
        value = {'type': 'file', 'path': name, 'encoding': 'base64', 'size': len(raw),
            'sha': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest(),
            'content': base64.b64encode(raw).decode(), **patches}
        return json.dumps(value).encode()

    def test_real331169_byte_lock_file_and_git_blob_parse_with_narrow_large_limit(self):
        raw = (REPO / 'package-lock.json').read_bytes()
        self.assertEqual(len(raw), 331169)
        with patch.object(M, 'response', return_value=self.source('package-lock.json', raw)) as request:
            self.assertEqual(M.source_bytes('package-lock.json', '1' * 40), raw)
        self.assertEqual(request.call_args.args[1], 2 * 1024 ** 2)
        with patch.object(M, 'response', return_value=self.source(M.HELPER_SOURCE, raw)):
            with self.assertRaisesRegex(M.Refused, 'SOURCE_METADATA'):
                M.source_bytes(M.HELPER_SOURCE, '1' * 40)

    def test_source_length_blob_and_allowed_paths_are_verified(self):
        for changes in ({'size': 4}, {'sha': '0' * 40}, {'path': 'arbitrary.py'}, {'encoding': 'none'}):
            with self.subTest(changes=changes), patch.object(M, 'response', return_value=self.source(M.HELPER_SOURCE, b'test!', **changes)):
                with self.assertRaises(M.Refused):
                    M.source_bytes(M.HELPER_SOURCE, '1' * 40)
        with patch.object(M, 'response') as request, self.assertRaisesRegex(M.Refused, 'SOURCE_PATH'):
            M.source_bytes('../secret', '1' * 40)
        request.assert_not_called()

    def test_wrong_commit_tree_never_executes_candidate_or_accepts_main(self):
        old, candidate, b = fixtures()
        with patch.object(M, 'response', return_value=json.dumps({'sha': b['sourceHead'], 'tree': {'sha': '9' * 40}}).encode()), \
             patch.object(M, 'source_bytes') as source, patch.object(M, 'D', types.SimpleNamespace(command=Mock())):
            with self.assertRaisesRegex(M.Refused, 'COMMITTED_TREE'):
                M.source_permit(b, candidate)
        source.assert_not_called()

    def test_imds_requires_all_three_pinned_facts(self):
        for field in M.IMDS:
            values = {**M.IMDS, field: 'wrong-target'}
            with self.subTest(field=field), patch.object(M.os, 'geteuid', return_value=0), patch.object(M, 'D', None), \
                 patch.object(M, 'response', side_effect=lambda url, limit: values[url.rsplit('/', 1)[-1]].encode()):
                with self.assertRaisesRegex(M.Refused, 'EXACT_IMDS'):
                    M.target()


class EnvironmentTests(unittest.TestCase):
    def parser(self, text):
        return dict(line.split('=', 1) for line in text.splitlines() if line and not line.startswith('#'))

    def test_only_four_ai_keys_are_appended_with_all_prior_secret_bytes_exact(self):
        before = b'# old comment\nDATABASE_URL=synthetic-secret\nUGC_GO_LIVE_GATE=false\nAPP_SESSION_SECRET=unchanged\n'
        with patch.object(M, 'D', types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(audit=types.SimpleNamespace(environment=self.parser))))):
            after, config = M.append_ai_environment(before, self.parser(before.decode()), b'sk-synthetic-only-12345678')
            self.assertTrue(after.startswith(before))
            self.assertEqual(len(config), 7)
            self.assertEqual(config['DEEPSEEK_MODEL'], 'deepseek-flash')
            self.assertEqual(config['SUPPORT_AI_TIMEOUT_MS'], '4000')
            self.assertEqual(config['UGC_GO_LIVE_GATE'], 'false')
            for name in M.AI_KEYS:
                with self.subTest(name=name), self.assertRaisesRegex(M.Refused, 'ALREADY_CONFIGURED'):
                    M.append_ai_environment(before + name.encode() + b'=old\n', {**self.parser(before.decode()), name: 'old'}, b'sk-synthetic-only-12345678')

    def test_key_is_read_from_private_file_never_a_command_argument(self):
        b = {'deepseekKeyFile': '/root/private/deepseek.key'}
        for suffix in (b'', b'\n', b'\r\n'):
            with patch.object(M, 'read', return_value=b'sk-synthetic-only-12345678' + suffix):
                self.assertEqual(M.key_bytes(b), b'sk-synthetic-only-12345678')
        for raw in (b'sk-synthetic-only-12345678\n\n', b'sk-synthetic-only-12345678\nINJECT=secret', b'short'):
            with self.subTest(raw=raw), patch.object(M, 'read', return_value=raw), self.assertRaises(M.Refused):
                M.key_bytes(b)

    def test_private_reader_refuses_symlinks_hardlinks_and_non0600(self):
        with tempfile.TemporaryDirectory(dir=REPO / 'tmp') as directory, patch.object(M, 'OWNER', os.getuid()):
            root = Path(directory)
            root.chmod(0o700)
            path = root / 'key'
            path.write_bytes(b'synthetic-private')
            path.chmod(0o600)
            # /Users parents are owned root; retain that production requirement.
            # Patch only protected ancestor UID checks for this isolated fixture.
            real_lstat = Path.lstat
            def lstat(value):
                info = real_lstat(value)
                if value in path.parents and value != root:
                    fields = list(info)
                    fields[4] = os.getuid()
                    return os.stat_result(fields)
                return info
            with patch.object(Path, 'lstat', lstat):
                self.assertEqual(M.read(path), b'synthetic-private')
                path.chmod(0o640)
                with self.assertRaises(M.Refused):
                    M.read(path)
                path.chmod(0o600)
                link = root / 'link'
                link.symlink_to(path)
                with self.assertRaises(OSError):
                    M.read(link)
                os.link(path, root / 'hardlink')
                with self.assertRaises(M.Refused):
                    M.read(path)


class CutoverTests(unittest.TestCase):
    def exercise(self, failure=None):
        old, candidate, b = fixtures()
        plan = {'old': old, 'candidate': candidate, 'binding': b, 'profile': {'units': ('cisme-trial-api.service', 'cisme-trial-worker.service')},
                'config': {'DATABASE_URL': 'synthetic-only'}, 'newConfig': {}, 'newEnv': b'new'}
        events, records = [], {}
        def phase(name, result=None):
            def perform(*args, **kwargs):
                events.append(name)
                if name == failure:
                    raise RuntimeError('synthetic-private-failure-must-not-export')
                return result
            return perform
        def command(args, **kwargs):
            events.append(tuple(args))
            if args[-1] == 'up' and failure == 'migration':
                raise RuntimeError('synthetic database secret')
        d = types.SimpleNamespace(command=command, stopped=phase('drained'), healthy=phase('healthy', {}),
            general=types.SimpleNamespace(store=lambda path, raw: records.__setitem__(path.name, raw)), atomic_bytes=phase('active'))
        baseline = types.SimpleNamespace(snapshot=phase('snapshot', {'backupReference': 'synthetic-backup'}),
            validate_snapshot=phase('validate-snapshot'), BASELINE_HEAD='historical-aad-label')
        with patch.object(M, 'D', d), patch.object(M, 'B', baseline), \
             patch.object(M, 'C', types.SimpleNamespace(public_contract=phase('public'))), \
             patch.object(M, 'verify_context', side_effect=phase('context')), patch.object(M, 'journal', side_effect=phase('journal')), \
             patch.object(M, 'backup_inputs', side_effect=phase('backup-inputs')), patch.object(M, 'save_plan', side_effect=phase('save-plan', 'a' * 64)), \
             patch.object(M, 'business_fence', side_effect=phase('fence', {'unchanged': True})), patch.object(M, 'schema103', side_effect=phase('schema103')), \
             patch.object(M, 'activate', side_effect=phase('activate')), patch.object(M, 'active_record', return_value=b'active'), \
             patch.object(M, 'read', return_value=b'snapshot-receipt'):
            if failure:
                with self.assertRaisesRegex(M.Refused, 'FAILED_FENCED'):
                    M.cutover(plan, Path('/synthetic/state'), 'synthetic-operation')
            else:
                self.assertTrue(M.cutover(plan, Path('/synthetic/state'), 'synthetic-operation')['deployed'])
        return events, records

    def test_backup_then_stop_drain_snapshot_migrate_only_up_activate_and_start(self):
        events, records = self.exercise()
        migration = next(event for event in events if isinstance(event, tuple) and event[-1] == 'up')
        self.assertLess(events.index('backup-inputs'), events.index(('systemctl', 'stop', 'cisme-trial-api.service', 'cisme-trial-worker.service')))
        self.assertLess(events.index('drained'), events.index('snapshot'))
        self.assertLess(events.index('snapshot'), events.index(migration))
        self.assertLess(events.index(migration), events.index('activate'))
        self.assertLess(events.index('activate'), events.index(('systemctl', 'start', 'cisme-trial-api.service', 'cisme-trial-worker.service')))
        receipt = json.loads(records['snapshot-current-release.json'])
        self.assertEqual(receipt['actualBaselineHead'], M.BASELINE_HEAD)
        self.assertEqual(receipt['actualMigrationCount'], 101)
        self.assertFalse(receipt['aadClaimsCurrentBaseline'])

    def test_migration_activation_health_and_public_failures_stop_without_rollback_restore_or_down(self):
        for failure in ('snapshot', 'migration', 'activate', 'healthy', 'public'):
            with self.subTest(failure=failure):
                events, records = self.exercise(failure)
                self.assertEqual(events[-2:], [('systemctl', 'stop', 'cisme-trial-api.service', 'cisme-trial-worker.service'), 'drained'])
                report = json.loads(records['manual-recovery-required.json'])
                self.assertTrue(report['servicesStopped'])
                self.assertFalse(report['databaseRestored'])
                self.assertFalse(report['applicationRollbackExecuted'])
                self.assertFalse(any('restore' in argument or argument == 'down' for event in events if isinstance(event, tuple) for argument in event))
                self.assertNotIn('synthetic-private', records['manual-recovery-required.json'].decode())

    def test_unknown_and_imported_exception_text_is_never_printed(self):
        self.assertEqual(M.safe_error_code(RuntimeError('postgresql://secret@host/db')), 'COMMENT_SUPPORT_REVIEW_REQUIRED')
        self.assertEqual(M.safe_error_code(M.Refused('COMMENT_SUPPORT_EXPECTED_FAILURE')), 'COMMENT_SUPPORT_EXPECTED_FAILURE')
        self.assertEqual(M.safe_error_code(M.Refused('COMMENT_SUPPORT_EXPECTED secret')), 'COMMENT_SUPPORT_REVIEW_REQUIRED')


class ActiveTests(unittest.TestCase):
    def test_new103_active_uses_primitives_only_and_new_environment(self):
        old, candidate, b = fixtures()
        state = M.STATE_PARENT / ('commit-' + b['sourceHead'][:12] + '-123')
        saved = b'{}'
        raw = json.dumps({'upgradeState': str(state), 'privatePlanSha256': M.sha(saved)}).encode()
        plan = {'binding': b, 'profile': {'units': ('trial-api', 'trial-worker')}, 'config': {'old': 'old'},
            'newConfig': {'new': 'new'}, 'old': old, 'candidate': candidate}
        d = types.SimpleNamespace(artifact=lambda directory, root: old if directory == old['directory'] else candidate,
            unit_path=lambda name: Path('/synthetic/' + name), read_owned=lambda path: b'unit',
            unit_entry=lambda *args: Path(candidate['directory']), running=Mock())
        with patch.object(M, 'D', d), patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda value: plan)), \
             patch.object(M, 'validate_binding'), patch.object(M, 'load_baseline') as loader, patch.object(M, 'target'), \
             patch.object(M, 'read', side_effect=lambda path, *args: raw if path == M.ACTIVE else saved), \
             patch.object(M, 'artifact_contract'), patch.object(M, 'active_record', return_value=raw), \
             patch.object(M, 'verify_context') as context, patch.object(M, 'journal') as journal, patch.object(M, 'schema103'):
            result = M.active_context(b)
        loader.assert_called_once_with(False)
        context.assert_called_once_with(plan, activated=True, allowed=(raw,), exact_pids=False)
        d.running.assert_called_once_with(plan['profile'], candidate['directory'], plan['newConfig'])
        journal.assert_called_once_with(plan, [candidate['manifest']['migrations']])
        self.assertEqual(result['config'], {'new': 'new'})


if __name__ == '__main__':
    unittest.main()
