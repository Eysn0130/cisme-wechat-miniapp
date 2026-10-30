"""Offline schema101 contracts and cutover failure tests; no network/DB/host calls."""
import copy
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SPEC = importlib.util.spec_from_file_location('reviewed_daily_day_upgrade', HERE / 'trial-daily-day-upgrade.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def fixtures():
    names = sorted(p.name for p in (REPO / 'db/migrations').glob('*.sql') if p.name < M.MIGRATION)
    assert len(names) == 100
    files = {name: ('synthetic-' + name).encode() for name in ('index.js', 'worker.js', 'worker-once.js')}
    files.update({name: (REPO / source).read_bytes() for name, source in
                  [('package.json', 'package.json'), ('package-lock.json', 'package-lock.json'), ('migrate.mjs', 'scripts/release-migrate.mjs')]})
    files.update({'db/migrations/' + name: (REPO / 'db/migrations' / name).read_bytes() for name in names})
    before = {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'migrations': names,
              'hashes': {**{name: M.sha(raw) for name, raw in files.items()}, 'index.js': M.BASELINE_INDEX}}
    old = {'directory': '/synthetic/old', 'manifest': before, 'manifestSha256': M.BASELINE_MANIFEST,
           'dependenciesSha256': M.DEPENDENCIES, 'files': files}
    b = {'sourceHead': '1' * 40, 'sourceTree': '2' * 40, 'ciRunId': 123,
         'manifestSha256': 'a' * 64, 'helperSha256': 'b' * 64, 'applicationRollbackAllowed': False}
    candidate = copy.deepcopy(old)
    candidate.update(directory='/synthetic/new', manifestSha256=b['manifestSha256'])
    candidate['manifest'].update(sourceHead=b['sourceHead'], sourceTree=b['sourceTree'],
                                sourceLockSha256=M.SOURCE_LOCK, node='v24.14.0',
                                buildPlatform={'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
                                configurationIncluded=False, deployed=False, releaseReady=False,
                                migrations=names + [M.MIGRATION])
    candidate['files']['db/migrations/' + M.MIGRATION] = (REPO / 'db/migrations' / M.MIGRATION).read_bytes()
    return old, candidate, b


class PermitTests(unittest.TestCase):
    def test_exact_old100_and_one_new101_are_accepted(self):
        M.artifact_contract(*fixtures())

    def test_all_103_original_sql_package_lock_and_migrator_bytes_are_immutable(self):
        old, candidate, b = fixtures()
        names = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + x for x in old['manifest']['migrations']]
        self.assertEqual(len(names), 103)
        for name in names:
            with self.subTest(name=name), self.assertRaisesRegex(M.Refused, 'OLD_SQL_MIGRATOR_OR_PACKAGE'):
                changed = copy.deepcopy(candidate)
                changed['files'][name] += b'changed'
                M.artifact_contract(old, changed, b)

    def test_sql_order_set_and_exact101_bytes_are_bound(self):
        old, candidate, b = fixtures()
        for names in [candidate['manifest']['migrations'][:-1], list(reversed(candidate['manifest']['migrations'])),
                      candidate['manifest']['migrations'] + ['209901010001_extra.sql']]:
            with self.subTest(names=names[-1:]), self.assertRaisesRegex(M.Refused, 'ONLY_ONE_MIGRATION'):
                changed = copy.deepcopy(candidate)
                changed['manifest']['migrations'] = names
                M.artifact_contract(old, changed, b)
        candidate['files']['db/migrations/' + M.MIGRATION] += b'changed'
        with self.assertRaisesRegex(M.Refused, 'PINNED_SQL'):
            M.artifact_contract(old, candidate, b)

    def test_full_dependencies_and_linux_platform_are_bound(self):
        old, candidate, b = fixtures()
        candidate['dependenciesSha256'] = '0' * 64
        with self.assertRaisesRegex(M.Refused, 'FULL_DEPENDENCY'):
            M.artifact_contract(old, candidate, b)
        candidate['dependenciesSha256'] = M.DEPENDENCIES
        candidate['manifest']['buildPlatform']['arch'] = 'arm64'
        with self.assertRaisesRegex(M.Refused, 'EXACT_LINUX'):
            M.artifact_contract(old, candidate, b)

    def test_old_application_rollback_is_never_permitted(self):
        self.assertEqual(M.validate_compatibility({'applicationRollbackAllowed': False}), {'applicationRollbackAllowed': False})
        for value in [None, True, 0, 'false']:
            with self.subTest(value=value), self.assertRaisesRegex(M.Refused, 'ROLLBACK_FORBIDDEN'):
                M.validate_compatibility({'applicationRollbackAllowed': value})

    def test_source_permit_checks_latest_main_before_any_source_or_command(self):
        _, candidate, b = fixtures()
        c = types.SimpleNamespace(github_source=Mock())
        d = types.SimpleNamespace(command=Mock())
        with patch.object(M, 'C', c), patch.object(M, 'D', d):
            for main in [{'sha': '0' * 40, 'tree': b['sourceTree'], 'ciRunId': 123},
                         {'sha': b['sourceHead'], 'tree': b['sourceTree'], 'ciRunId': 124}]:
                with self.assertRaisesRegex(M.Refused, 'LATEST_MAIN_PUSH_CI'):
                    M.source_permit(b, candidate, main)
        c.github_source.assert_not_called()
        d.command.assert_not_called()

    def test_original100_fence_includes_suppression_but_not_new_projection_columns(self):
        d = types.SimpleNamespace(query=Mock(return_value={'count': 3, 'sha256': 'synthetic-private-hash'}))
        with patch.object(M, 'D', d):
            M.daily_fence({'name': 'trial'})
        sql = d.query.call_args.args[1]
        for name in ('id', 'member_id', 'operation_id', 'request_sha256', 'completed_at', 'timezone',
                     'protocol_version', 'step_codes', 'self_assessment', 'suppressed_at'):
            self.assertIn("'" + name + "'," + name, sql)
        self.assertNotIn('WHERE suppressed_at', sql)
        self.assertNotIn('superseded_by', sql)

    def test_migration_rejects_changed_original_facts_after_up_and_never_runs_down_or_restore(self):
        old, candidate, b = fixtures()
        plan = {'old': old, 'candidate': candidate, 'profile': {}, 'config': {}, 'dailyFence': {'count': 3, 'sha256': 'original-including-suppressed'}}
        command = Mock()
        with patch.object(M, 'D', types.SimpleNamespace(command=command)), patch.object(M, 'validate_snapshot'), \
             patch.object(M, 'journal') as journal, patch.object(M, 'daily_fence', return_value={'count': 3, 'sha256': 'changed'}):
            with self.assertRaisesRegex(M.Refused, 'ORIGINAL100_FACTS_CHANGED'):
                M.migrate(plan, {'backupReference': 'synthetic-snapshot'}, Path('/synthetic/state'), 'synthetic-operation')
        self.assertEqual(journal.call_count, 2)
        self.assertEqual(command.call_args.args[0][-1], 'up')
        self.assertEqual(command.call_count, 1)


class BaselineTests(unittest.TestCase):
    def test_active101_loads_only_old_primitives_and_checks_its_own_active_journal(self):
        old, candidate, b = fixtures()
        state = M.STATE_PARENT / ('main-' + b['sourceHead'][:12] + '-123')
        saved = b'{}'
        raw = json.dumps({'upgradeState': str(state), 'privatePlanSha256': M.sha(saved)}).encode()
        profile = {'units': ('trial-api', 'trial-worker')}
        plan = {'binding': b, 'profile': profile, 'config': {}, 'old': old, 'candidate': candidate}
        c = types.SimpleNamespace(decode_private=lambda value: plan, fixed_profile=Mock())
        d = types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(identity=lambda: {'instanceId': 'lhins-61ikz4mi', 'publicIpv4': '124.223.74.198'})),
            artifact=lambda directory, root: old if directory == old['directory'] else candidate,
            unit_path=lambda unit: Path('/synthetic/' + unit), read_owned=lambda path: b'synthetic-unit',
            unit_entry=lambda *args: Path(candidate['directory']), running=Mock())
        with patch.object(M, 'C', c), patch.object(M, 'D', d), patch.object(M, 'validate_binding'), \
             patch.object(M, 'load_baseline') as loader, patch.object(M, 'artifact_contract'), \
             patch.object(M, 'read', side_effect=lambda path, *args: raw if path == M.ACTIVE else saved), \
             patch.object(M, 'active_record', return_value=raw), patch.object(M, 'verify_context') as context, \
             patch.object(M, 'journal') as journal:
            result = M.active_context(b)
        loader.assert_called_once_with(False)
        context.assert_called_once_with(plan, provenance=False, candidate_allowed=True, active_allowed=(raw,), exact_production_pids=False, preserve_comments=False)
        journal.assert_called_once_with(plan, [candidate['manifest']['migrations']])
        self.assertEqual(result['release'], Path(candidate['directory']))

    def test_loading_primitives_does_not_run_old100_active_guard(self):
        source = b'''from types import SimpleNamespace
C=D=None
def binding(path,expected): return VALUE
def load_baseline(active=False):
 global C,D
 assert active is False
 C=SimpleNamespace(marker='comments-primitives'); D=SimpleNamespace(marker='dependency-primitives')
def active_context(value): raise RuntimeError('OLD100_ACTIVE_GUARD_CALLED')
'''
        value = {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'manifestSha256': M.BASELINE_MANIFEST,
                 'archiveSha256': M.BASELINE_ARCHIVE, 'archiveBytes': M.BASELINE_ARCHIVE_BYTES}
        original_compile = compile
        def compiled(raw, filename, mode):
            return original_compile(raw.replace(b'VALUE', repr(value).encode()), filename, mode)
        with patch.object(M.os, 'geteuid', return_value=0), patch.object(M, 'read', return_value=source), \
             patch.object(M, 'BASELINE_HELPER_SHA', M.sha(source)), patch('builtins.compile', side_effect=compiled):
            M.load_baseline(False)
        self.assertEqual(M.C.marker, 'comments-primitives')
        self.assertEqual(M.D.marker, 'dependency-primitives')

    def test_journal101_uses_own_schema_guard_and_never_old100_column_guard(self):
        c = types.SimpleNamespace(database_guard=Mock(return_value=list(range(101))))
        b = types.SimpleNamespace(schema100=Mock(side_effect=AssertionError('OLD100_SCHEMA_GUARD')))
        with patch.object(M, 'C', c), patch.object(M, 'B', b), patch.object(M, 'schema101') as current:
            M.journal({'profile': {}, 'config': {}, 'ownership': {}}, [list(range(101))])
        current.assert_called_once()
        b.schema100.assert_not_called()

    def test_journal100_verifies_original100_and_absence_of101(self):
        c = types.SimpleNamespace(database_guard=Mock(return_value=list(range(100))))
        b = types.SimpleNamespace(schema100=Mock())
        with patch.object(M, 'C', c), patch.object(M, 'B', b), patch.object(M, 'schema101_absent') as absent:
            M.journal({'profile': {}, 'config': {}, 'ownership': {}}, [list(range(100))], True)
        b.schema100.assert_called_once()
        absent.assert_called_once()


class CutoverTests(unittest.TestCase):
    def exercise(self, fail_at=None):
        old, candidate, binding = fixtures()
        plan = {'profile': {'units': ('trial-api', 'trial-worker')}, 'old': old, 'candidate': candidate,
                'binding': binding, 'main': {'sha': binding['sourceHead']}, 'dailyFence': {'old': True}}
        events = []
        records = {}
        def command(args, **kwargs):
            events.append(tuple(args))
        def phase(name, value=None):
            def call(*args, **kwargs):
                events.append(name)
                if name == fail_at:
                    raise RuntimeError('synthetic-private-error')
                return value
            return call
        d = types.SimpleNamespace(command=command, stopped=phase('stopped'), switch=phase('switch'),
             verify_units=phase('verify_units'), healthy=phase('healthy', {'fastify': '5.12.6'}),
             atomic_bytes=phase('publish'), general=types.SimpleNamespace(store=lambda path, raw: records.update({path.name: json.loads(raw)})))
        c = types.SimpleNamespace(fixed_profile=Mock(), public_contract=phase('public'))
        saved = []
        def save(p, state):
            saved.append(copy.deepcopy(p['dailyFence']))
            return 'a' * 64
        with patch.object(M, 'D', d), patch.object(M, 'C', c), \
             patch.object(M, 'verify_context', side_effect=phase('context')), patch.object(M, 'journal', side_effect=phase('journal')), \
             patch.object(M, 'daily_fence', side_effect=phase('daily_fence', {'drained': True})), \
             patch.object(M, 'save_plan', side_effect=save), patch.object(M, 'snapshot', side_effect=phase('snapshot', {})), \
             patch.object(M, 'validate_snapshot'), patch.object(M, 'migrate', side_effect=phase('migrate')), \
             patch.object(M, 'verify_history'), patch.object(M, 'schema101'), patch.object(M, 'active_record', return_value=b'synthetic-active'):
            if fail_at:
                with self.assertRaises(M.Refused):
                    M.cutover(plan, Path('/synthetic/state'), 'synthetic-operation')
            else:
                result = M.cutover(plan, Path('/synthetic/state'), 'synthetic-operation')
                self.assertTrue(result['deployed'])
        return events, records, saved

    def test_writers_drain_before_recapturing_and_saving_complete_original100_fence(self):
        events, _, saved = self.exercise()
        self.assertLess(events.index('stopped'), events.index('daily_fence'))
        self.assertLess(events.index('daily_fence'), events.index('snapshot'))
        self.assertLess(events.index('snapshot'), events.index('migrate'))
        self.assertEqual(saved, [{'drained': True}])

    def test_failed_migration_and_failed_health_keep_services_stopped_without_old_app_rollback(self):
        for phase in ('migrate', 'healthy', 'public'):
            with self.subTest(phase=phase):
                events, records, _ = self.exercise(phase)
                self.assertEqual(events[-2:], [('systemctl', 'stop', 'trial-api', 'trial-worker'), 'stopped'])
                report = records['manual-recovery-required.json']
                self.assertEqual(report, {'servicesStopped': True, 'unknownInputsOverwritten': False,
                                         'databaseRestored': False, 'applicationRollbackExecuted': False})
                self.assertFalse(any('down' in event or 'restore' in event for event in events if isinstance(event, tuple)))
                self.assertLessEqual(events.count('switch'), 1)

    def test_unknown_errors_never_export_exception_text(self):
        self.assertEqual(M.safe_error_code(RuntimeError('postgresql://synthetic-password@example/private')), 'DAILY_CARE_APPLICATION_REVIEW_REQUIRED')


if __name__ == '__main__':
    unittest.main()
