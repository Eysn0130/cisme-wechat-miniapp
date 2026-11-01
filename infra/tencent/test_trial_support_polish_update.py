"""Offline de9/schema103 support-polish application cutover tests. No SSH, network or DB."""
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from contextlib import ExitStack, redirect_stdout
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SPEC = importlib.util.spec_from_file_location('support_polish_update', HERE / 'trial-support-polish-update.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
BASELINE_SPEC = importlib.util.spec_from_file_location('support_polish_pinned_de9', HERE / 'trial-comment-access-update.py')
BASELINE = importlib.util.module_from_spec(BASELINE_SPEC)
BASELINE_SPEC.loader.exec_module(BASELINE)
PROFILE = {'name': 'trial', 'root': str(M.ROOT), 'units': ('cisme-trial-api.service', 'cisme-trial-worker.service'),
           'domain': 'trial.synthetic.invalid', 'database': 'cisme_trial', 'user': 'cisme-trial'}
RUNNER = M.RUNNERS / ('1' * 12) / 'trial-support-polish-update.py'


def fixtures():
    names = sorted(path.name for path in (REPO / 'db/migrations').glob('*.sql')
                   if path.name <= '202610300003_support_explicit_ai_resume.sql')
    assert len(names) == 103
    files = {name: (REPO / source).read_bytes() for name, source in (
        ('migrate.mjs', 'scripts/release-migrate.mjs'), ('package.json', 'package.json'), ('package-lock.json', 'package-lock.json'))}
    files.update({'db/migrations/' + name: (REPO / 'db/migrations' / name).read_bytes() for name in names})
    old = {'directory': str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])),
        'files': files, 'dependenciesSha256': M.DEPENDENCIES, 'manifestSha256': M.BASELINE_MANIFEST,
        'manifest': {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'migrations': names}}
    candidate = copy.deepcopy(old)
    candidate.update(directory=str(M.ROOT / 'releases' / ('tencent-release-' + '1' * 12)), manifestSha256='a' * 64)
    candidate['manifest'].update(sourceHead='1' * 40, sourceTree='2' * 40, sourceLockSha256=M.SOURCE_LOCK,
        node='v24.14.0', buildPlatform={'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
        configurationIncluded=False, deployed=False, releaseReady=False)
    helper = b'synthetic-reviewed-helper'
    archive = b'synthetic-private-archive'
    b = {'schemaVersion': 1, 'kind': 'trial-support-polish-update', 'baselineHead': M.BASELINE_HEAD,
        'baselineTree': M.BASELINE_TREE, 'sourceHead': '1' * 40, 'sourceTree': '2' * 40,
        'helperSha256': M.sha(helper), 'manifestSha256': 'a' * 64, 'archiveSha256': M.sha(archive),
        'archiveBytes': len(archive), 'archivePath': str(M.STAGES / ('support-polish-' + '1' * 12 + '-synthetic123') / 'archive.tar.gz'),
        'dependenciesSha256': M.DEPENDENCIES, 'migrations': 103, 'applicationRollbackAllowed': False,
        'migrationSha256': {name: M.sha(files['db/migrations/' + name]) for name in names}}
    return old, candidate, b, helper, archive


def baseline_inputs_fixture():
    old_binding = {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE}
    active_path = M.ROOT / 'comment-access-updates' / 'active-release.json'
    state = active_path.parent / ('commit-' + M.BASELINE_HEAD[:12] + '-123')
    support_runner = M.ROOT / 'comment-support-runners' / ('0ca' + '0' * 9)
    key_path = '/root/private/custom-support-ai-input'
    private_files = {
        key_path: b'synthetic-original-ai-key',
        str(support_runner / 'trial-comment-support-upgrade.py'): b'synthetic-old-support-helper',
        str(support_runner / 'binding.json'): b'synthetic-old-support-binding',
        str(M.ROOT / 'comment-support-upgrades' / 'commit-0ca-synthetic-123' / 'protected-plan.json'): b'synthetic-original-plan',
    }
    inherited = {path: {'sha256': M.sha(raw), 'limit': 256 if path == key_path else 8 * 1024 ** 2}
                 for path, raw in private_files.items()}
    original_history = {str(M.ROOT / 'ownership.json'): b'original-history',
                        str(M.ROOT / 'comment-support-upgrades' / 'active-release.json'): b'original-old-active'}
    prior = {'binding': old_binding, 'candidate': {'directory': str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12]))},
             'protectedBaselineInputs': inherited, 'history': original_history}
    saved = b'{"synthetic":"protected-old-plan"}'
    history = {**original_history, str(active_path): json.dumps({'upgradeState': str(state), 'privatePlanSha256': M.sha(saved)}).encode()}
    helper, binding = b'synthetic-pinned-de9-helper', b'synthetic-pinned-de9-binding'
    private_files.update({str(state / 'protected-plan.json'): saved,
                          str(M.BASELINE_RUNNER / 'trial-comment-access-update.py'): helper,
                          str(M.BASELINE_RUNNER / 'application-binding.json'): binding})
    baseline = types.SimpleNamespace(ACTIVE=active_path, STATE_PARENT=active_path.parent,
        BASELINE_RUNNER=support_runner, BASELINE_BINDING_SHA='b' * 64,
        B=types.SimpleNamespace(binding=Mock(return_value={'deepseekKeyFile': key_path})))
    return old_binding, history, prior, baseline, private_files, helper, binding


class BindingAndArtifactTests(unittest.TestCase):
    def test_only_current103_baseline_and_new_distinct_linux103_release_are_permitted(self):
        old, candidate, b, helper, _ = fixtures()
        with patch.object(M, '__file__', str(RUNNER)), patch.object(M, 'read', return_value=helper):
            self.assertEqual(M.validate_binding(b), b)
        M.artifact_contract(old, candidate, b)
        self.assertEqual(M.BASELINE_HELPER_SHA, M.sha((HERE / 'trial-comment-access-update.py').read_bytes()))

    def test_every_sql_migrator_package_and_lock_byte_is_immutable(self):
        old, candidate, b, _, _ = fixtures()
        self.assertEqual(len(old['files']), 106)
        for name in old['files']:
            changed = copy.deepcopy(candidate)
            changed['files'][name] += b'changed'
            with self.subTest(name=name), self.assertRaisesRegex(M.Refused, 'SQL_MIGRATOR_OR_PACKAGE'):
                M.artifact_contract(old, changed, b)

    def test_no_101_to103_migration_no_dependency_or_sql_binding_drift(self):
        old, candidate, b, _, _ = fixtures()
        for change in ('101', 'order', 'extra', 'missing', 'sql-binding', 'dependencies'):
            before, after, binding = copy.deepcopy(old), copy.deepcopy(candidate), copy.deepcopy(b)
            if change == '101': before['manifest']['migrations'] = before['manifest']['migrations'][:-2]
            elif change == 'order': after['manifest']['migrations'].reverse()
            elif change == 'extra': after['manifest']['migrations'].append('209901010001_unrequested.sql')
            elif change == 'missing': after['manifest']['migrations'].pop()
            elif change == 'sql-binding': binding['migrationSha256'][old['manifest']['migrations'][0]] = 'f' * 64
            else: after['dependenciesSha256'] = '0' * 64
            with self.subTest(change=change), self.assertRaises(M.Refused): M.artifact_contract(before, after, binding)

    def test_wrong_node_arch_manifest_or_production_path_is_rejected(self):
        old, candidate, b, _, _ = fixtures()
        for key, value in [('node', 'v24.15.0'), ('buildPlatform', {'os': 'darwin', 'arch': 'arm64', 'libc': 'glibc'}), ('sourceLockSha256', 'f' * 64)]:
            changed = copy.deepcopy(candidate); changed['manifest'][key] = value
            with self.subTest(key=key), self.assertRaises(M.Refused): M.artifact_contract(old, changed, b)
        for path in (old['directory'], '/opt/cisme/releases/tencent-release-' + '1' * 12):
            with self.subTest(path=path), self.assertRaises(M.Refused): M.artifact_contract(old, {**candidate, 'directory': path}, b)

    def test_binding_refuses_automatic_rollback_stale_head_archive_escape_or_nonexact_helper(self):
        _, _, b, helper, _ = fixtures()
        changes = [{'applicationRollbackAllowed': True}, {'migrations': 101}, {'sourceHead': M.BASELINE_HEAD},
                   {'archivePath': '/tmp/archive.tar.gz'}, {'archiveBytes': True}, {'migrationSha256': {}}, {'helperSha256': '0' * 64}]
        for change in changes:
            with self.subTest(change=change), patch.object(M, '__file__', str(RUNNER)), \
                 patch.object(M, 'read', return_value=helper), self.assertRaises(M.Refused):
                M.validate_binding({**b, **change})

    def test_only_own_exact_runner_and_application_binding_paths_are_permitted(self):
        _, _, b, helper, _ = fixtures()
        raw = json.dumps(b).encode()
        exact = RUNNER.parent / 'application-binding.json'
        def reader(path, limit):
            return helper if path.name == RUNNER.name else raw
        with patch.object(M, '__file__', str(RUNNER)), patch.object(M, 'read', side_effect=reader):
            self.assertEqual(M.binding(exact, M.sha(raw)), b)
            for path in (exact.with_name('binding.json'), M.ROOT / 'application-binding.json',
                         M.ROOT / 'comment-access-runners' / ('1' * 12) / 'application-binding.json'):
                with self.subTest(path=path), self.assertRaisesRegex(M.Refused, 'EXACT_BINDING_PATH'):
                    M.binding(path, M.sha(raw))
        for path in (str(HERE / 'trial-support-polish-update.py'),
                     str(RUNNER.with_name('renamed.py')), str(RUNNER.parent.parent / 'renamed' / RUNNER.name)):
            with self.subTest(path=path), patch.object(M, '__file__', path), \
                 patch.object(M, 'read', return_value=helper), self.assertRaisesRegex(M.Refused, 'EXACT_RUNNER_PATH'):
                M.validate_binding(b)


class SourceTests(unittest.TestCase):
    def test_complete_exact_commit_tree_pins_all103_sql_and_helper_before_verify_only(self):
        _, candidate, b, helper, _ = fixtures()
        sources = {M.HELPER_SOURCE: helper, 'scripts/release-migrate.mjs': candidate['files']['migrate.mjs']}
        sources.update({name: raw for name, raw in candidate['files'].items() if name.startswith('db/migrations/')})
        tree = {'sha': b['sourceTree'], 'truncated': False, 'tree': [{'path': name, 'type': 'blob', 'mode': '100644', 'sha': M.git_blob(raw)} for name, raw in sources.items()]}
        commit = {'sha': b['sourceHead'], 'tree': {'sha': b['sourceTree']}}
        command = Mock(return_value=json.dumps({'verified': True, 'sourceHead': b['sourceHead'], 'sourceTree': b['sourceTree'], 'migrations': 103}).encode())
        def run(value):
            with patch.object(M, 'response', side_effect=[json.dumps(commit).encode(), json.dumps(value).encode()]), \
                 patch.object(M, 'read', return_value=helper), patch.object(M, 'D', types.SimpleNamespace(command=command)), \
                 patch.object(M, 'source_bytes', side_effect=lambda name, head: (REPO / name).read_bytes()):
                M.source_permit(b, candidate)
        run(tree)
        command.assert_called_once_with([M.NODE, candidate['directory'] + '/migrate.mjs', 'verify'])
        command.reset_mock()
        for change in ('truncated', 'missing-helper', 'sql-blob', 'symlink'):
            changed = copy.deepcopy(tree)
            if change == 'truncated': changed['truncated'] = True
            elif change == 'missing-helper': changed['tree'] = changed['tree'][1:]
            elif change == 'sql-blob': changed['tree'][-1]['sha'] = '0' * 40
            else: changed['tree'][0]['mode'] = '120000'
            with self.subTest(change=change), self.assertRaises(M.Refused): run(changed)
        command.assert_not_called()

    def test_source_metadata_decodes_real_large_lock_and_refuses_secret_paths(self):
        raw = (REPO / 'package-lock.json').read_bytes()
        value = {'type': 'file', 'path': 'package-lock.json', 'encoding': 'base64', 'size': len(raw), 'sha': M.git_blob(raw), 'content': base64.b64encode(raw).decode()}
        with patch.object(M, 'response', return_value=json.dumps(value).encode()) as request:
            self.assertEqual(M.source_bytes('package-lock.json', '1' * 40), raw)
            self.assertEqual(request.call_args.args[1], 2 * 1024 ** 2)
        with patch.object(M, 'response') as request, self.assertRaises(M.Refused): M.source_bytes('../runtime.env', '1' * 40)
        request.assert_not_called()
        for change in ({'sha': '0' * 40}, {'path': 'runtime.env'}, {'content': 'invalid!'}, {'size': len(raw) - 1}):
            with self.subTest(change=change), patch.object(M, 'response', return_value=json.dumps({**value, **change}).encode()), self.assertRaises(Exception):
                M.source_bytes('package-lock.json', '1' * 40)

    def test_imds_requires_three_pinned_instance_facts(self):
        for name in M.IMDS:
            actual = {**M.IMDS, name: 'foreign'}
            with self.subTest(name=name), patch.object(M.os, 'geteuid', return_value=0), patch.object(M, 'D', None), \
                 patch.object(M, 'response', side_effect=lambda url, limit: actual[url.rsplit('/', 1)[-1]].encode()), self.assertRaises(M.Refused): M.target()


class GuardTests(unittest.TestCase):
    def test_current103_loader_uses_active_guard_only_before_cutover(self):
        raw = ("from pathlib import Path\nC=object()\nD=object()\ncalled=[]\n"
               "def binding(path, expected):\n called.append(('binding',str(path),expected))\n return " + repr({'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'manifestSha256': M.BASELINE_MANIFEST, 'migrations': 103}) + "\n"
               "def active_context(value):\n called.append('active103')\n return {'release':Path('" + str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])) + "')}\n"
               "def load_baseline(value):\n called.append(('primitives',value))\n").encode()
        with patch.object(M, 'target'), patch.object(M, 'read', return_value=raw), patch.object(M, 'BASELINE_HELPER_SHA', M.sha(raw)):
            expected = ('binding', str(M.BASELINE_RUNNER / 'application-binding.json'), M.BASELINE_BINDING_SHA)
            current, old_binding = M.load_baseline(True)
            self.assertEqual(M.A.called, [expected, 'active103'])
            self.assertIs(M.C, M.A.C); self.assertIs(M.D, M.A.D)
            self.assertEqual(current['release'], Path(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])))
            self.assertEqual(old_binding['sourceHead'], M.BASELINE_HEAD)
            M.load_baseline(False); self.assertEqual(M.A.called, [expected, ('primitives', False)])
            self.assertIs(M.C, M.A.C); self.assertIs(M.D, M.A.D)

    def test_all_inherited_inputs_keep_original_hashes_and_actual_key_path_from_0ca_binding(self):
        old_binding, history, prior, baseline, private_files, helper, binding = baseline_inputs_fixture()
        original = copy.deepcopy(prior)
        with patch.object(M, 'A', baseline), patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda value: prior)), \
             patch.object(M, 'BASELINE_HELPER_SHA', M.sha(helper)), patch.object(M, 'BASELINE_BINDING_SHA', M.sha(binding)), \
             patch.object(M, 'read', side_effect=lambda path, limit: private_files[str(path)]):
            inputs = M.protected_baseline_inputs(old_binding, history)
        self.assertEqual(prior, original)
        for path, value in prior['protectedBaselineInputs'].items():
            self.assertEqual(inputs[path], value)
        self.assertEqual(len(inputs), len(prior['protectedBaselineInputs']) + 3)
        self.assertIn(str(M.BASELINE_RUNNER / 'application-binding.json'), inputs)
        self.assertNotIn(str(M.BASELINE_RUNNER / 'binding.json'), inputs)
        baseline.B.binding.assert_called_once_with(baseline.BASELINE_RUNNER / 'binding.json', baseline.BASELINE_BINDING_SHA)

    def test_inherited_ai_key_private_plan_binding_or_capture_drift_is_refused(self):
        for change in ('key-bytes', 'inherited-hash', 'private-plan-hash', 'wrong-state', 'binding', 'missing-key',
                       'invalid-limit', 'helper-recapture', 'binding-recapture', 'active-history'):
            old_binding, history, prior, baseline, private_files, helper, binding = baseline_inputs_fixture()
            key_path = baseline.B.binding.return_value['deepseekKeyFile']
            if change == 'key-bytes': private_files[key_path] += b'rotated'
            elif change == 'inherited-hash': prior['protectedBaselineInputs'][key_path]['sha256'] = '0' * 64
            elif change == 'private-plan-hash':
                active = json.loads(history[str(baseline.ACTIVE)]); active['privatePlanSha256'] = '0' * 64
                history[str(baseline.ACTIVE)] = json.dumps(active).encode()
            elif change == 'wrong-state':
                active = json.loads(history[str(baseline.ACTIVE)]); active['upgradeState'] = '/opt/cisme/comment-access-updates/commit-synthetic-123'
                history[str(baseline.ACTIVE)] = json.dumps(active).encode()
            elif change == 'binding': prior['binding'] = {'sourceHead': '0' * 40}
            elif change == 'missing-key': del prior['protectedBaselineInputs'][key_path]
            elif change == 'invalid-limit': prior['protectedBaselineInputs'][key_path]['limit'] = True
            elif change == 'helper-recapture': private_files[str(M.BASELINE_RUNNER / 'trial-comment-access-update.py')] += b'changed'
            elif change == 'binding-recapture': private_files[str(M.BASELINE_RUNNER / 'application-binding.json')] += b'changed'
            elif change == 'active-history': history[str(M.ROOT / 'ownership.json')] = b'newly-recaptured-history'
            with self.subTest(change=change), patch.object(M, 'A', baseline), \
                 patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda value: prior)), \
                 patch.object(M, 'BASELINE_HELPER_SHA', M.sha(helper)), patch.object(M, 'BASELINE_BINDING_SHA', M.sha(binding)), \
                 patch.object(M, 'read', side_effect=lambda path, limit: private_files[str(path)]), self.assertRaises(M.Refused):
                M.protected_baseline_inputs(old_binding, history)

    def test_history_capture_inherits_every_prior_active_and_adds_de9_without_rewriting(self):
        prior = {str(M.ROOT / 'comment-support-upgrades' / 'active-release.json'): b'old-support-active',
                 str(M.ROOT / 'schema99-application-updates' / 'active-release.json'): b'old-schema99-active',
                 str(M.ROOT / 'daily-care-upgrades' / 'active-release.json'): b'old-care-active',
                 str(M.ROOT / 'daily-day-upgrades' / 'active-release.json'): b'old-day-active'}
        active_path = M.ROOT / 'comment-access-updates' / 'active-release.json'
        baseline = types.SimpleNamespace(capture_history=lambda: dict(prior), ACTIVE=active_path)
        with patch.object(M, 'A', baseline), patch.object(M, 'read', return_value=b'de9-active') as reader:
            value = M.capture_history()
        self.assertEqual(value, {**prior, str(active_path): b'de9-active'})
        reader.assert_called_once_with(active_path, 65536)

    def test_history_and_private_deepseek_inputs_cannot_drift(self):
        plan = {'history': {'/synthetic/active.json': b'original'}, 'protectedBaselineInputs': {'/synthetic/deepseek.key': {'limit': 256, 'sha256': M.sha(b'original-key')}}}
        for changed in ('history', 'key', 'active'):
            def reader(path, limit):
                if path.name == 'active.json': return b'changed' if changed == 'history' else b'original'
                return b'changed-key' if changed == 'key' else b'original-key'
            with self.subTest(changed=changed), patch.object(M, 'read', side_effect=reader), patch.object(M, 'optional_active', return_value=b'unknown' if changed == 'active' else None), self.assertRaises(M.Refused):
                M.verify_history(plan)

    def test_journal_only_reads_existing103_and_never_invokes_101_guard(self):
        old, _, _, _, _ = fixtures()
        c = types.SimpleNamespace(database_guard=Mock(return_value=old['manifest']['migrations']))
        baseline = types.SimpleNamespace(schema103=Mock(), schema101=Mock(side_effect=AssertionError('old101 guard')))
        plan = {'profile': PROFILE, 'config': {'secret': 'synthetic-private'}, 'ownership': {'ownershipId': 'synthetic'}, 'old': old}
        with patch.object(M, 'A', BASELINE), patch.object(BASELINE, 'C', c), patch.object(BASELINE, 'B', baseline):
            self.assertEqual(M.journal(plan, True), old['manifest']['migrations'])
        c.database_guard.assert_called_once_with(PROFILE, plan['config'], plan['ownership'], [old['manifest']['migrations']], True)
        baseline.schema103.assert_called_once_with(PROFILE); baseline.schema101.assert_not_called()

    def test_preflight_keeps_full_ai_environment_and_creates_no_files_or_service_operations(self):
        old, candidate, b, _, archive = fixtures()
        config = {'APP_ENV': 'staging', 'WECHAT_APP_ID': 'synthetic-app', 'SUPPORT_AI_ENABLED': 'true',
                  'DEEPSEEK_API_KEY': 'synthetic-private-key', 'DEEPSEEK_MODEL': 'deepseek-flash', 'SUPPORT_AI_TIMEOUT_MS': '4000',
                  'APP_SESSION_SECRET': 'synthetic-existing-session'}
        env = b'# exact existing bytes\r\nDEEPSEEK_API_KEY=synthetic-private-key\r\nSUPPORT_AI_ENABLED=true\r\n'
        history = {str(M.ROOT / name): b'{"ownershipId":"synthetic-owned"}' for name in M.HISTORY_ROOT}
        original = copy.deepcopy(config)
        d = types.SimpleNamespace(artifact=lambda directory, root: old if directory == old['directory'] else candidate,
            closed_context=lambda *a: True, read_owned=lambda path, **kwargs: env if path.name == 'runtime.env' else b'existing-unit',
            unit_path=lambda unit: Path('/etc/systemd/system') / unit, dropin_inputs=lambda unit: {'files': {}},
            unit_definition=lambda *a: {'existing': True}, native_smoke=lambda *a: {'sharp': '0.35.5'},
            environment_metadata=lambda p: {'uid': 0, 'mode': 0o640}, private_inputs=lambda *a: [{'unchanged': True}],
            command=Mock(side_effect=AssertionError('preflight service/DB mutation command')), general=types.SimpleNamespace(store=Mock()))
        c = types.SimpleNamespace(APP_ID='synthetic-app', fixed_profile=Mock(), production_capture=lambda: {'config': {}}, six_keys=Mock())
        with patch.object(M, 'D', d), patch.object(M, 'C', c), \
             patch.object(M, 'load_baseline', return_value=({'profile': PROFILE, 'config': config, 'release': Path(old['directory'])}, {})) as loader, \
             patch.object(M, 'optional_active', return_value=None), patch.object(M, 'read', return_value=archive), \
             patch.object(M, 'source_permit'), patch.object(M, 'capture_history', return_value=history), \
             patch.object(M, 'protected_baseline_inputs', return_value={}), patch.object(M, 'verify_context'), patch.object(M, 'journal'), \
             patch.object(Path, 'mkdir', side_effect=AssertionError('preflight mkdir forbidden')):
            result = M.preflight(b)
        loader.assert_called_once_with(True)
        self.assertEqual(result['env'], env); self.assertEqual(result['config'], original); self.assertEqual(config, original)
        d.command.assert_not_called(); d.general.store.assert_not_called()

    def test_new_active_check_loads_primitives_only_and_enforces_new_units_and_guest401(self):
        old, candidate, b, _, _ = fixtures()
        state = M.STATE_PARENT / ('commit-' + b['sourceHead'][:12] + '-123')
        saved = b'{}'; raw = json.dumps({'upgradeState': str(state), 'privatePlanSha256': M.sha(saved)}).encode()
        plan = {'binding': b, 'old': old, 'candidate': candidate, 'profile': PROFILE, 'config': {'synthetic': 'private'}}
        d = types.SimpleNamespace(artifact=lambda directory, root: old if directory == old['directory'] else candidate,
            unit_path=lambda unit: Path('/synthetic') / unit, read_owned=lambda *a: b'unit',
            unit_entry=lambda *a: Path(candidate['directory']), running=Mock())
        c = types.SimpleNamespace(decode_private=lambda value: plan)
        with patch.object(M, 'D', d), patch.object(M, 'C', c), patch.object(M, 'validate_binding'), \
             patch.object(M, 'load_baseline') as loader, patch.object(M, 'target'), \
             patch.object(M, 'read', side_effect=lambda path, *args: raw if path == M.ACTIVE else saved), \
             patch.object(M, 'artifact_contract'), patch.object(M, 'active_record', return_value=raw), \
             patch.object(M, 'verify_context') as context, patch.object(M, 'journal') as journal, patch.object(M, 'public_contract') as public:
            result = M.active_context(b)
        loader.assert_called_once_with(False)
        context.assert_called_once_with(plan, candidate_allowed=True, allowed=(raw,), exact_pids=False)
        d.running.assert_called_once_with(PROFILE, candidate['directory'], plan['config'])
        journal.assert_called_once_with(plan); public.assert_called_once_with(plan)
        self.assertTrue(result['commentLoginEnforced']); self.assertEqual(result['release'], Path(candidate['directory']))

    def test_private_reader_rejects_symlinks_hardlinks_and_group_readable_files(self):
        with tempfile.TemporaryDirectory(dir=REPO / 'tmp') as directory, patch.object(M, 'OWNER', os.getuid()):
            root = Path(directory); root.chmod(0o700); path = root / 'fixture'; path.write_bytes(b'synthetic-private'); path.chmod(0o600)
            original = Path.lstat
            def protected_parents(value):
                info = original(value)
                if value in path.parents:
                    fields = list(info); fields[4] = os.getuid(); return os.stat_result(fields)
                return info
            with patch.object(Path, 'lstat', protected_parents):
                self.assertEqual(M.read(path), b'synthetic-private')
                path.chmod(0o640)
                with self.assertRaises(M.Refused): M.read(path)
                path.chmod(0o600); link = root / 'link'; link.symlink_to(path)
                with self.assertRaises(OSError): M.read(link)
                os.link(path, root / 'hardlink')
                with self.assertRaises(M.Refused): M.read(path)


class PublicContractTests(unittest.TestCase):
    def test_public_article_stays_readable_but_guest_comments_are_401_without_data(self):
        article_id = '11111111-1111-4111-8111-111111111111'
        c = types.SimpleNamespace(public_contract=Mock())
        good = [(200, {'items': [{'id': article_id}]}), (200, {'id': article_id}), (401, {'status': 401, 'code': 'AUTH_REQUIRED'})]
        with patch.object(M, 'A', BASELINE), patch.object(BASELINE, 'C', c), patch.object(BASELINE, 'public_get', side_effect=good):
            M.public_contract({'profile': PROFILE})
        c.public_contract.assert_called_once_with({'profile': PROFILE}, False)
        for response in [(200, {'comments': [], 'authors': {}}), (401, {'status': 401, 'code': 'AUTH_REQUIRED', 'body': 'private'}),
                         (401, {'status': 401, 'code': 'AUTH_REQUIRED', 'nested': {'authors': {}}}), (401, {'code': 'AUTH_REQUIRED'}),
                         (403, {'status': 403, 'code': 'AUTH_REQUIRED'})]:
            with self.subTest(response=response), patch.object(M, 'A', BASELINE), patch.object(BASELINE, 'C', c), \
                 patch.object(BASELINE, 'public_get', side_effect=[*good[:2], response]), self.assertRaises(BASELINE.Refused):
                M.public_contract({'profile': PROFILE})

    def test_https_probe_is_get_only_local_tls_no_auth_redirect_or_insecure_flags(self):
        command = Mock(return_value=b'{"status":401,"code":"AUTH_REQUIRED"}\n401')
        with patch.object(BASELINE, 'D', types.SimpleNamespace(command=command)):
            self.assertEqual(BASELINE.public_get({'profile': PROFILE}, '/v1/editorial/articles/test/comments?limit=1')[0], 401)
        args = command.call_args.args[0]
        self.assertIn('--request', args); self.assertEqual(args[args.index('--request') + 1], 'GET')
        self.assertIn(PROFILE['domain'] + ':443:127.0.0.1', args)
        self.assertFalse(any(value in args for value in ('--insecure', '-k', '--location', '-L', '--header', '-H', '--cookie', '-b')))

    def test_de9_public_contract_delegation_passes_no_auth_session_or_write_action(self):
        plan = {'profile': PROFILE}
        check = Mock()
        with patch.object(M, 'A', types.SimpleNamespace(public_contract=check)):
            M.public_contract(plan)
        check.assert_called_once_with(plan)


class CutoverTests(unittest.TestCase):
    def exercise(self, failure=None):
        old, candidate, b, _, _ = fixtures()
        plan = {'profile': PROFILE, 'old': old, 'candidate': candidate, 'binding': b, 'ownership': {'ownershipId': 'synthetic'},
                'env': b'SUPPORT_AI_ENABLED=true\nDEEPSEEK_API_KEY=synthetic-private\n', 'config': {'secret': 'synthetic-private'}}
        original = copy.deepcopy(plan); events, records = [], {}; switched = False
        def hit(name):
            events.append(name)
            if failure == name: raise RuntimeError('synthetic-private-error')
        def command(args, **kwargs):
            self.assertEqual(args[0], 'systemctl'); self.assertEqual(tuple(args[2:]), PROFILE['units']); hit(args[1]); return b''
        def switch(value, directory):
            nonlocal switched
            self.assertEqual(directory, candidate['directory'], 'AUTOMATIC OLD APP ROLLBACK FORBIDDEN'); switched = True; hit('switch-new')
        def context(*args, **kwargs): hit('context-new' if switched else 'context-old')
        def healthy(value, directory, started, patched):
            self.assertEqual(directory, candidate['directory']); hit('healthy-new'); return {'sharp': '0.35.5'}
        def store(path, raw):
            hit('deployed' if path.name == 'deployed.json' else 'record'); records[str(path)] = raw
        d = types.SimpleNamespace(command=command, stopped=lambda p: hit('stopped'), switch=switch,
            verify_units=lambda *args, **kwargs: hit('units'), healthy=healthy,
            atomic_bytes=lambda path, raw: (hit('active-publish'), records.__setitem__(str(path), raw)), general=types.SimpleNamespace(store=store))
        def protect(*args): hit('protect'); return 'b' * 64
        with patch.object(M, 'D', d), patch.object(M, 'save_plan', side_effect=protect), patch.object(M, 'backup_inputs', side_effect=lambda *a: hit('backup')), \
             patch.object(M, 'verify_context', side_effect=context), patch.object(M, 'verify_history', side_effect=lambda *a: hit('history')), \
             patch.object(M, 'journal', side_effect=lambda *a: hit('drain' if len(a) > 1 and a[1] else 'journal')), \
             patch.object(M, 'public_contract', side_effect=lambda *a: hit('public')):
            try: result = M.cutover(plan, M.STATE_PARENT / 'commit-synthetic-123', 'SYNTHETIC-ONLY')
            except M.Refused as error: result = str(error)
        self.assertEqual(plan, original)
        self.assertTrue(all('runtime.env' not in path and 'comment-support-upgrades' not in path for path in records))
        return events, records, result

    def test_stop_drain_only_new_unit_switch_and_private_independent_active_record(self):
        events, records, result = self.exercise()
        self.assertTrue(result['deployed']); self.assertEqual(result['guestCommentStatus'], 401)
        self.assertLess(events.index('stop'), events.index('drain')); self.assertLess(events.index('drain'), events.index('switch-new'))
        active = json.loads(records[str(M.ACTIVE)])
        self.assertEqual(active['migrationCount'], 103); self.assertTrue(active['commentLoginEnforced'])
        self.assertFalse(active['applicationRollbackAllowed']); self.assertFalse(active['databaseRestored'])
        self.assertEqual(active['kind'], 'trial-support-polish-active-release')
        self.assertEqual(active['baselineHead'], M.BASELINE_HEAD)
        self.assertEqual(active['humanHandoffPolicy'], 'user-request-only')
        self.assertEqual(result['humanHandoffPolicy'], 'user-request-only')
        self.assertFalse(result['liveChatProbePerformed'])
        for flag in ('schemaChanged', 'configurationChanged', 'credentialsChanged', 'authorityGranted',
                     'businessDataSeeded', 'databaseRestored', 'databaseSnapshotCreated',
                     'applicationRollbackExecuted', 'productionChanged'):
            self.assertIs(result[flag], False)
        self.assertEqual(events.count('start'), 1)

    def test_all_cutover_failures_stop_for_forward_review_without_old_restart_or_database_restore(self):
        for failure in ('protect', 'backup', 'context-old', 'journal', 'drain', 'switch-new', 'units', 'history', 'start', 'healthy-new', 'public', 'context-new', 'active-publish', 'deployed'):
            with self.subTest(failure=failure):
                events, records, result = self.exercise(failure)
                self.assertEqual(result, 'SUPPORT_POLISH_FAILED_FENCED_FORWARD_REVIEW_REQUIRED')
                self.assertEqual(events[-3:-1] if events[-1] == 'record' else events[-2:], ['stop', 'stopped'])
                recovery = next(json.loads(raw) for path, raw in records.items() if path.endswith('manual-recovery-required.json'))
                self.assertTrue(recovery['servicesStopped']); self.assertTrue(recovery['forwardRecoveryRequired'])
                self.assertFalse(recovery['applicationRollbackExecuted']); self.assertFalse(recovery['databaseRestored'])
                self.assertTrue(recovery['priorAutomaticHumanQueuePolicyPreventsRollback'])
                self.assertNotIn('synthetic-private', json.dumps(recovery))

    def test_safe_errors_and_default_cli_never_export_imported_secret_text(self):
        for error in (RuntimeError('postgresql://synthetic-private@host/db'), M.Refused('SUPPORT_POLISH_BAD synthetic-private')):
            self.assertEqual(M.safe_error_code(error), 'SUPPORT_POLISH_REVIEW_REQUIRED')
        self.assertEqual(M.safe_error_code(M.Refused('SUPPORT_POLISH_EXPECTED')), 'SUPPORT_POLISH_EXPECTED')
        with patch.object(M.sys, 'argv', ['helper', '--binding', '/synthetic/binding.json', '--binding-sha256', 'f' * 64]), \
             patch.object(M, 'binding', return_value={}), patch.object(M, 'preflight', side_effect=RuntimeError('synthetic-private')) as check, \
             patch.object(M, 'apply') as apply, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(M.main(), 1)
        check.assert_called_once(); apply.assert_not_called(); self.assertNotIn('synthetic-private', output.getvalue())


if __name__ == '__main__':
    unittest.main()
