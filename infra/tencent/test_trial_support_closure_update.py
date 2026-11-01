"""Offline exact6c/schema104 application-only guards. No network, SSH or database."""
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SPEC = importlib.util.spec_from_file_location('support_closure_update', HERE / 'trial-support-closure-update.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
PROFILE = {'name': 'trial', 'root': str(M.ROOT), 'units': ('cisme-trial-api.service', 'cisme-trial-worker.service'),
           'domain': 'trial.synthetic.invalid', 'database': 'cisme_trial', 'user': 'cisme-trial'}
RUNNER = M.RUNNERS / ('1' * 12) / 'trial-support-closure-update.py'


def fixtures():
    names = sorted(p.name for p in (REPO / 'db/migrations').glob('*.sql'))
    assert len(names) == 104 and names[-1] == '202610310001_support_ai_human_collaboration.sql'
    files = {name: (REPO / path).read_bytes() for name, path in [('migrate.mjs', 'scripts/release-migrate.mjs'),
        ('package.json', 'package.json'), ('package-lock.json', 'package-lock.json')]}
    files.update({'db/migrations/' + name: (REPO / 'db/migrations' / name).read_bytes() for name in names})
    old = {'directory': str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])), 'files': files,
           'dependenciesSha256': M.DEPENDENCIES, 'manifestSha256': M.BASELINE_MANIFEST,
           'manifest': {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'migrations': names}}
    candidate = copy.deepcopy(old)
    candidate.update(directory=str(M.ROOT / 'releases' / ('tencent-release-' + '1' * 12)), manifestSha256='a' * 64)
    candidate['manifest'].update(sourceHead='1' * 40, sourceTree='2' * 40, sourceLockSha256=M.SOURCE_LOCK,
        node='v24.14.0', buildPlatform={'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
        configurationIncluded=False, deployed=False, releaseReady=False)
    helper, archive = b'synthetic-closure-helper', b'synthetic-archive'
    binding = {'schemaVersion': 1, 'kind': 'trial-support-closure-update', 'baselineHead': M.BASELINE_HEAD,
        'baselineTree': M.BASELINE_TREE, 'sourceHead': '1' * 40, 'sourceTree': '2' * 40,
        'helperSha256': M.sha(helper), 'manifestSha256': 'a' * 64, 'archiveSha256': M.sha(archive),
        'archiveBytes': len(archive), 'archivePath': str(M.STAGES / ('support-closure-' + '1' * 12 + '-synthetic123') / 'archive.tar.gz'),
        'dependenciesSha256': M.DEPENDENCIES, 'migrations': 104, 'applicationRollbackAllowed': False,
        'migrationSha256': {name: M.sha(files['db/migrations/' + name]) for name in names}}
    return old, candidate, binding, helper, archive


def inherited_fixture():
    binding = {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE}
    active_path = M.ROOT / 'support-ai-human-collaboration-updates' / 'active-release.json'
    state = active_path.parent / ('commit-' + M.BASELINE_HEAD[:12] + '-123')
    key = '/root/private/synthetic-original-deepseek-key'
    private = {key: b'synthetic-original-key', '/root/private/prior-plan': b'original-immutable-plan'}
    history = {str(M.ROOT / 'ownership.json'): b'original-ownership', '/opt/cisme-trial/older/active-release.json': b'prior-active'}
    prior = {'binding': binding, 'candidate': {'directory': str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12]))},
             'history': dict(history), 'protectedBaselineInputs': {p: {'limit': 256, 'sha256': M.sha(raw)} for p, raw in private.items()}}
    saved = b'{}'
    history[str(active_path)] = json.dumps({'upgradeState': str(state), 'privatePlanSha256': M.sha(saved)}).encode()
    helper, old_binding = b'original6c-helper', b'original6c-binding'
    private.update({str(state / 'protected-plan.json'): saved,
        str(M.BASELINE_RUNNER / 'trial-support-ai-human-collaboration-upgrade.py'): helper,
        str(M.BASELINE_RUNNER / 'application-binding.json'): old_binding})
    original_support = types.SimpleNamespace(BASELINE_RUNNER=M.ROOT / 'comment-support-runners' / 'synthetic', BASELINE_BINDING_SHA='d' * 64)
    h = types.SimpleNamespace(ACTIVE=active_path, STATE_PARENT=active_path.parent,
        B=types.SimpleNamespace(binding=Mock(return_value={'deepseekKeyFile': key})),
        P=types.SimpleNamespace(P=types.SimpleNamespace(P=types.SimpleNamespace(A=original_support))))
    return binding, history, prior, private, h, helper, old_binding


class ArtifactTests(unittest.TestCase):
    def test_pins_the_deployed104_helper_and_only_a_distinct_bound104_candidate(self):
        old, candidate, b, helper, _ = fixtures()
        self.assertEqual(M.BASELINE_HEAD, '6c90079f25cf3d90e3526bf7da609984ba446770')
        self.assertEqual(M.BASELINE_TREE, 'e2fa642ce5155b3bce12d120f81303170a0127f7')
        self.assertEqual(M.BASELINE_HELPER_SHA, M.sha((HERE / 'trial-support-ai-human-collaboration-upgrade.py').read_bytes()))
        with patch.object(M, '__file__', str(RUNNER)), patch.object(M, 'read', return_value=helper):
            self.assertEqual(M.validate_binding(b), b)
        M.artifact_contract(old, candidate, b)
        for change in [{'migrations': 103}, {'migrations': True}, {'sourceHead': M.BASELINE_HEAD}, {'applicationRollbackAllowed': True},
                       {'archivePath': '/tmp/archive.tar.gz'}, {'archiveBytes': True}, {'helperSha256': '0' * 64}]:
            with self.subTest(change=change), patch.object(M, '__file__', str(RUNNER)), patch.object(M, 'read', return_value=helper), self.assertRaises(M.Refused):
                M.validate_binding({**b, **change})

    def test_all104_sql_and_migrator_package_lock_dependency_bytes_stay_exact(self):
        old, candidate, b, _, _ = fixtures()
        self.assertEqual(len(old['files']), 107)
        for name in old['files']:
            changed = copy.deepcopy(candidate); changed['files'][name] += b'drift'
            with self.subTest(name=name), self.assertRaises(M.Refused): M.artifact_contract(old, changed, b)
        for change in ('sql-set', 'sql-binding', 'deps', 'platform', 'production-path'):
            changed, bound = copy.deepcopy(candidate), copy.deepcopy(b)
            if change == 'sql-set': changed['manifest']['migrations'].pop()
            elif change == 'sql-binding': bound['migrationSha256'][old['manifest']['migrations'][-1]] = '0' * 64
            elif change == 'deps': changed['dependenciesSha256'] = '0' * 64
            elif change == 'platform': changed['manifest']['buildPlatform']['os'] = 'darwin'
            else: changed['directory'] = '/opt/cisme/releases/tencent-release-' + '1' * 12
            with self.subTest(change=change), self.assertRaises(M.Refused): M.artifact_contract(old, changed, bound)

    def test_committed_tree_pins_helper_and_all_sql_before_verify_only(self):
        _, candidate, b, helper, _ = fixtures()
        files = {M.HELPER_SOURCE: helper, 'scripts/release-migrate.mjs': candidate['files']['migrate.mjs'],
                 **{p: raw for p, raw in candidate['files'].items() if p.startswith('db/migrations/')}}
        tree = {'sha': b['sourceTree'], 'truncated': False, 'tree': [{'path': p, 'type': 'blob', 'mode': '100644', 'sha': M.git_blob(raw)} for p, raw in files.items()]}
        commit = {'sha': b['sourceHead'], 'tree': {'sha': b['sourceTree']}}
        command = Mock(return_value=json.dumps({'verified': True, 'sourceHead': b['sourceHead'], 'sourceTree': b['sourceTree'], 'migrations': 104}).encode())
        def run(value):
            with patch.object(M, 'response', side_effect=[json.dumps(commit).encode(), json.dumps(value).encode()]), patch.object(M, 'read', return_value=helper), \
                 patch.object(M, 'D', types.SimpleNamespace(command=command)), patch.object(M, 'source_bytes', side_effect=lambda p, head: (REPO / p).read_bytes()):
                M.source_permit(b, candidate)
        run(tree); command.assert_called_once_with([M.NODE, candidate['directory'] + '/migrate.mjs', 'verify']); command.reset_mock()
        for change in ('truncated', 'missing', 'sql', 'symlink'):
            value = copy.deepcopy(tree)
            if change == 'truncated': value['truncated'] = True
            elif change == 'missing': value['tree'].pop(0)
            elif change == 'sql': value['tree'][-1]['sha'] = '0' * 40
            else: value['tree'][0]['mode'] = '120000'
            with self.subTest(change=change), self.assertRaises(M.Refused): run(value)
        command.assert_not_called()

    def test_exact_runner_binding_private_reader_and_no_secret_source_path(self):
        _, _, b, helper, _ = fixtures(); raw = json.dumps(b).encode()
        with patch.object(M, '__file__', str(RUNNER)), patch.object(M, 'read', side_effect=lambda p, limit: helper if p.name == RUNNER.name else raw):
            self.assertEqual(M.binding(RUNNER.parent / 'application-binding.json', M.sha(raw)), b)
            with self.assertRaises(M.Refused): M.binding(M.ROOT / 'application-binding.json', M.sha(raw))
        with patch.object(M, 'response') as request, self.assertRaises(M.Refused): M.source_bytes('runtime.env', '1' * 40)
        request.assert_not_called()
        with tempfile.TemporaryDirectory(dir=REPO / 'tmp') as directory, patch.object(M, 'OWNER', os.getuid()):
            root = Path(directory); root.chmod(0o700); p = root / 'private'; p.write_bytes(b'synthetic'); p.chmod(0o600)
            original = Path.lstat
            def parents(path):
                info = original(path)
                if path in p.parents:
                    fields = list(info); fields[4] = os.getuid(); return os.stat_result(fields)
                return info
            with patch.object(Path, 'lstat', parents):
                self.assertEqual(M.read(p), b'synthetic'); p.chmod(0o640)
                with self.assertRaises(M.Refused): M.read(p)
                p.chmod(0o600); (root / 'link').symlink_to(p)
                with self.assertRaises(OSError): M.read(root / 'link')
                os.link(p, root / 'hard')
                with self.assertRaises(M.Refused): M.read(p)


class BaselineTests(unittest.TestCase):
    def test_preflight_is_read_only_and_uses_the_exact_current_profile_env_and_both_native_gates(self):
        old, candidate, b, _, archive = fixtures()
        config = {'APP_ENV': 'staging', 'WECHAT_APP_ID': 'synthetic-app', 'SUPPORT_AI_ENABLED': 'true',
            'DEEPSEEK_API_KEY': 'synthetic-private-key', 'DEEPSEEK_MODEL': 'deepseek-flash', 'SUPPORT_AI_TIMEOUT_MS': '4000'}
        env = b'# unchanged private bytes\r\nSUPPORT_AI_ENABLED=true\r\n'
        history = {str(M.ROOT / name): b'{"ownershipId":"synthetic"}' for name in M.HISTORY_ROOT}
        d = types.SimpleNamespace(artifact=lambda p, root: old if p == old['directory'] else candidate,
            closed_context=lambda *a: True, read_owned=lambda p, **kw: env if p.name == 'runtime.env' else b'existing-unit',
            unit_path=lambda u: Path('/etc/systemd/system') / u, dropin_inputs=lambda u: {'files': {}}, unit_definition=lambda *a: {'original': True},
            native_smoke=Mock(return_value={'native': 'exact'}), environment_metadata=lambda p: {'mode': 0o640}, private_inputs=lambda *a: {'original': True},
            command=Mock(side_effect=AssertionError('preflight mutation command')), general=types.SimpleNamespace(store=Mock()))
        c = types.SimpleNamespace(APP_ID='synthetic-app', fixed_profile=Mock(), production_capture=lambda: {'config': {}}, six_keys=Mock())
        with patch.object(M, 'D', d), patch.object(M, 'C', c), patch.object(M, 'load_baseline', return_value=({'profile': PROFILE, 'config': config, 'release': Path(old['directory'])}, {})) as loader, \
             patch.object(M, 'optional_active', return_value=None), patch.object(M, 'read', return_value=archive), patch.object(M, 'source_permit'), \
             patch.object(M, 'capture_history', return_value=history), patch.object(M, 'protected_baseline_inputs', return_value={}), \
             patch.object(M, 'verify_context'), patch.object(M, 'journal'), patch.object(Path, 'mkdir', side_effect=AssertionError('preflight mkdir')):
            value = M.preflight(b)
        loader.assert_called_once_with(True); self.assertEqual(value['profile'], PROFILE); self.assertEqual(value['config'], config); self.assertEqual(value['env'], env)
        self.assertEqual(d.native_smoke.call_args_list[0].args, (PROFILE, candidate['directory'], True))
        self.assertEqual(d.native_smoke.call_args_list[1].args, (PROFILE, old['directory'], True))
        d.command.assert_not_called(); d.general.store.assert_not_called()

    def test_active_recheck_binds_saved_full_fence_and_allows_later_production_restart_only(self):
        old, candidate, b, _, _ = fixtures(); state = M.STATE_PARENT / ('commit-' + b['sourceHead'][:12] + '-123')
        facts = {'schema_migration': {'count': 104, 'sha256': 'e' * 64}}
        plan = {'binding': b, 'old': old, 'candidate': candidate, 'profile': PROFILE, 'config': {}, 'ownership': {'ownershipId': 'synthetic'}, 'drainedBusinessFence': facts}
        saved = b'{}'; raw = M.active_record(plan, state, M.sha(saved)); fence = (json.dumps(facts, sort_keys=True) + '\n').encode()
        d = types.SimpleNamespace(artifact=lambda p, root: old if p == old['directory'] else candidate, unit_path=lambda u: Path('/synthetic') / u,
            read_owned=lambda *a: b'unit', unit_entry=lambda *a: Path(candidate['directory']), running=Mock())
        def run(fence_bytes):
            def reader(p, limit): return raw if p == M.ACTIVE else fence_bytes if p.name == 'drained-business-fence.json' else saved
            with patch.object(M, 'D', d), patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda p: plan)), patch.object(M, 'validate_binding'), \
                 patch.object(M, 'load_baseline') as loader, patch.object(M, 'target'), patch.object(M, 'read', side_effect=reader), \
                 patch.object(M, 'verify_context') as context, patch.object(M, 'journal') as journal, patch.object(M, 'public_contract') as public:
                result = M.active_context(b)
            loader.assert_called_once_with(False); context.assert_called_once_with(plan, candidate_allowed=True, allowed=(raw,), exact_pids=False)
            journal.assert_called_once_with(plan); public.assert_called_once_with(plan); return result
        self.assertEqual(run(fence)['release'], Path(candidate['directory']))
        with self.assertRaisesRegex(M.Refused, 'ACTIVE_DRAINED_FACT_FENCE_DRIFT'): run(b'{}')

    def test_public_contract_only_delegates_the_pinned_reviewed_get_probe(self):
        check = Mock(); plan = {'profile': PROFILE}
        with patch.object(M, 'H', types.SimpleNamespace(public_contract=check)): M.public_contract(plan)
        check.assert_called_once_with(plan)

    def test_target_refuses_any_changed_instance_fact_or_non_root_without_accessing_a_server(self):
        for name in M.IMDS:
            actual = {**M.IMDS, name: 'foreign'}
            with self.subTest(name=name), patch.object(M.os, 'geteuid', return_value=0), patch.object(M, 'D', None), \
                 patch.object(M, 'response', side_effect=lambda url, limit: actual[url.rsplit('/', 1)[-1]].encode()), self.assertRaises(M.Refused): M.target()
        with patch.object(M.os, 'geteuid', return_value=1), patch.object(M, 'response') as request, self.assertRaises(M.Refused): M.target()
        request.assert_not_called()

    def test_active104_guard_before_cutover_primitives_only_afterwards(self):
        values = {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'manifestSha256': M.BASELINE_MANIFEST, 'migrations': 104}
        raw = ("from pathlib import Path\nC=object()\nD=object()\ncalled=[]\ndef binding(path, expected):\n called.append('binding')\n return " + repr(values) +
            "\ndef active_context(b):\n called.append('active104')\n return {'release':Path('" + str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])) +
            "')}\ndef load_baseline(value):\n called.append(('primitives',value))\n").encode()
        with patch.object(M, 'target'), patch.object(M, 'read', return_value=raw), patch.object(M, 'BASELINE_HELPER_SHA', M.sha(raw)):
            M.load_baseline(True); self.assertEqual(M.H.called, ['binding', 'active104']); self.assertIs(M.C, M.H.C); self.assertIs(M.D, M.H.D)
            M.load_baseline(False); self.assertEqual(M.H.called, ['binding', ('primitives', False)])

    def test_full_original_private_key_chain_is_preserved_and_current_layer_added(self):
        b, history, prior, private, h, helper, binding = inherited_fixture(); before = copy.deepcopy(prior)
        with patch.object(M, 'H', h), patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda p: prior)), \
             patch.object(M, 'BASELINE_HELPER_SHA', M.sha(helper)), patch.object(M, 'BASELINE_BINDING_SHA', M.sha(binding)), \
             patch.object(M, 'read', side_effect=lambda p, limit: private[str(p)]):
            result = M.protected_baseline_inputs(b, history)
        self.assertEqual(prior, before); self.assertEqual(len(result), len(prior['protectedBaselineInputs']) + 3)
        for p, value in prior['protectedBaselineInputs'].items(): self.assertEqual(result[p], value)
        a = h.P.P.P.A; h.B.binding.assert_called_once_with(a.BASELINE_RUNNER / 'binding.json', a.BASELINE_BINDING_SHA)

    def test_key_plan_binding_history_and_recaptured_helper_drift_fail_closed(self):
        for change in ('key', 'plan', 'binding', 'history', 'missing-key', 'helper', 'invalid-limit'):
            b, history, prior, private, h, helper, binding = inherited_fixture(); key = h.B.binding.return_value['deepseekKeyFile']
            if change == 'key': private[key] += b'drift'
            elif change == 'plan': history[str(h.ACTIVE)] = json.dumps({'upgradeState': '/tmp/foreign', 'privatePlanSha256': '0' * 64}).encode()
            elif change == 'binding': prior['binding'] = {}
            elif change == 'history': history[str(M.ROOT / 'ownership.json')] = b'drift'
            elif change == 'missing-key': del prior['protectedBaselineInputs'][key]
            elif change == 'helper': private[str(M.BASELINE_RUNNER / 'trial-support-ai-human-collaboration-upgrade.py')] += b'drift'
            else: prior['protectedBaselineInputs'][key]['limit'] = True
            with self.subTest(change=change), patch.object(M, 'H', h), patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda p: prior)), \
                 patch.object(M, 'BASELINE_HELPER_SHA', M.sha(helper)), patch.object(M, 'BASELINE_BINDING_SHA', M.sha(binding)), \
                 patch.object(M, 'read', side_effect=lambda p, limit: private[str(p)]), self.assertRaises(M.Refused):
                M.protected_baseline_inputs(b, history)

    def test_journal_delegates_the_entire104_chain_and_drain(self):
        old, _, _, _, _ = fixtures(); plan = {'old': old}; journal = Mock(return_value=old['manifest']['migrations'])
        with patch.object(M, 'H', types.SimpleNamespace(journal=journal)):
            self.assertEqual(M.journal(plan, True), old['manifest']['migrations'])
        journal.assert_called_once_with(plan, [old['manifest']['migrations']], True)

    def test_stopped_fence_contains_every104_column_and_entire_migration_journal(self):
        names = ['schema_migration', 'support_conversation', 'support_message']
        facts = {p: {'count': 1, 'sha256': 'a' * 64} for p in names}; query = Mock(side_effect=[names, facts])
        with patch.object(M, 'D', types.SimpleNamespace(query=query)): self.assertEqual(M.business_fence(PROFILE), facts)
        sql = query.call_args.args[1]; self.assertIn('to_jsonb(t)', sql); self.assertIn('schema_migration t', sql)
        self.assertNotIn('-ARRAY', sql); self.assertNotIn("-'reply_to_message_id'", sql)
        for bad in ([], ['support_message'], ['schema_migration', 'bad;select']):
            with patch.object(M, 'D', types.SimpleNamespace(query=Mock(return_value=bad))), self.assertRaises(M.Refused): M.business_fence(PROFILE)

    def test_exact_context_requires_original_production_pids_six_keys_archive_and_closed_trial(self):
        old, candidate, b, _, archive = fixtures()
        plan = {'profile': PROFILE, 'production': {'config': {}}, 'config': {'APP_ENV': 'staging'}, 'old': old, 'candidate': candidate, 'binding': b}
        c = types.SimpleNamespace(fixed_profile=Mock(), production_preserved=Mock(), six_keys=Mock())
        d = types.SimpleNamespace(verify_context=Mock(), closed_context=Mock(return_value=True), artifact=lambda p, root: old if p == old['directory'] else candidate)
        with patch.object(M, 'C', c), patch.object(M, 'D', d), patch.object(M, 'target'), patch.object(M, 'verify_history'), patch.object(M, 'read', return_value=archive): M.verify_context(plan)
        c.production_preserved.assert_called_once_with(plan['production'], True); c.six_keys.assert_called_once_with(plan['config'], plan['production']['config'])
        with patch.object(M, 'C', c), patch.object(M, 'D', d), patch.object(M, 'target'), patch.object(M, 'verify_history'), patch.object(M, 'read', return_value=b'drift'), self.assertRaises(M.Refused): M.verify_context(plan)


class CutoverTests(unittest.TestCase):
    def exercise(self, failure=None):
        old, candidate, b, _, _ = fixtures()
        plan = {'profile': PROFILE, 'old': old, 'candidate': candidate, 'binding': b, 'ownership': {'ownershipId': 'synthetic'}, 'env': b'original-private', 'config': {}}
        original = copy.deepcopy(plan); events, records = [], {}; switched = False
        def hit(name):
            events.append(name)
            if failure == name:
                if name in ('backup', 'context-old', 'journal'): raise M.Refused('SUPPORT_CLOSURE_PRE_STOP_SYNTHETIC')
                raise RuntimeError('synthetic-private-error')
        def command(args, **kw):
            self.assertEqual(args[0], 'systemctl'); self.assertEqual(tuple(args[2:]), PROFILE['units']); hit(args[1]); return b''
        def switch(p, directory):
            nonlocal switched
            self.assertEqual(directory, candidate['directory']); switched = True; hit('switch-new')
        def context(*a, **kw): hit('context-new' if switched else 'context-old')
        def store(path, raw): hit('deployed' if path.name == 'deployed.json' else 'store'); records[str(path)] = raw
        facts = {'schema_migration': {'count': 104, 'sha256': 'f' * 64}}
        def fence(p):
            hit('fence-after' if switched else 'fence-before')
            return {} if failure == 'fact-drift' and switched else facts
        d = types.SimpleNamespace(command=command, stopped=lambda p: hit('stopped'), switch=switch, verify_units=lambda *a, **kw: hit('units'),
            healthy=lambda *a: (hit('healthy'), {'native': 'exact'})[1], atomic_bytes=lambda p, raw: (hit('publish'), records.__setitem__(str(p), raw)), general=types.SimpleNamespace(store=store))
        def protect(value, state):
            self.assertEqual(value['drainedBusinessFence'], facts); hit('protect'); return 'b' * 64
        with patch.object(M, 'D', d), patch.object(M, 'save_plan', side_effect=protect), patch.object(M, 'backup_inputs', side_effect=lambda *a: hit('backup')), \
             patch.object(M, 'verify_context', side_effect=context), patch.object(M, 'verify_history', side_effect=lambda *a: hit('history')), \
             patch.object(M, 'journal', side_effect=lambda p, drain=False: hit('drain' if drain else 'journal')), patch.object(M, 'business_fence', side_effect=fence), \
             patch.object(M, 'public_contract', side_effect=lambda *a: hit('public')):
            try: result = M.cutover(plan, M.STATE_PARENT / 'commit-synthetic-123', 'SYNTHETIC-ONLY')
            except M.Refused as error: result = str(error)
        self.assertEqual(plan, original)
        self.assertFalse(any('runtime.env' in p or 'collaboration-updates' in p for p in records))
        return events, records, result

    def test_only_two_trial_units_switch_after_full_drained_fact_fence(self):
        events, records, result = self.exercise()
        self.assertTrue(result['deployed']); self.assertTrue(result['drainedFull104FactsPreserved'])
        self.assertLess(events.index('stop'), events.index('drain')); self.assertLess(events.index('drain'), events.index('fence-before'))
        self.assertLess(events.index('fence-before'), events.index('switch-new')); self.assertLess(events.index('fence-after'), events.index('start'))
        active = json.loads(records[str(M.ACTIVE)]); self.assertEqual(active['migrationCount'], 104); self.assertFalse(active['schemaChanged'])
        self.assertEqual(active['drainedBusinessFenceSha256'], M.sha(records[str(M.STATE_PARENT / 'commit-synthetic-123' / 'drained-business-fence.json')]))
        for flag in ('databaseRestored', 'databaseSnapshotCreated', 'configurationChanged', 'credentialsChanged', 'authorityGranted', 'businessDataSeeded', 'productionChanged', 'applicationRollbackExecuted'):
            self.assertIs(result[flag], False)
        self.assertEqual(events.count('start'), 1); self.assertEqual(result['liveChatProbePerformed'], False)

    def test_every_cutover_failure_fences_services_and_preserves_for_manual_review(self):
        for failure in ('stop', 'drain', 'fence-before', 'protect', 'switch-new', 'units', 'history', 'fence-after', 'fact-drift', 'start', 'healthy', 'public', 'context-new', 'publish', 'deployed'):
            with self.subTest(failure=failure):
                events, records, result = self.exercise(failure)
                self.assertEqual(result, 'SUPPORT_CLOSURE_FAILED_FENCED_FORWARD_REVIEW_REQUIRED')
                recovery = next(json.loads(raw) for p, raw in records.items() if p.endswith('manual-recovery-required.json'))
                self.assertTrue(recovery['forwardRecoveryRequired']); self.assertFalse(recovery['databaseRestored']); self.assertFalse(recovery['applicationRollbackExecuted'])
                self.assertLessEqual(events.count('start'), 1); self.assertNotIn('synthetic-private', json.dumps(recovery))

    def test_pre_stop_backup_context_and_journal_refusals_leave_running_old_services_alone(self):
        for failure in ('backup', 'context-old', 'journal'):
            with self.subTest(failure=failure):
                events, records, result = self.exercise(failure)
                self.assertEqual(result, 'SUPPORT_CLOSURE_PRE_STOP_SYNTHETIC')
                self.assertNotIn('stop', events); self.assertNotIn('stopped', events); self.assertNotIn('start', events)
                self.assertFalse(any(p.endswith('manual-recovery-required.json') for p in records))

    def test_failed_initial_stop_still_attempts_a_fence_and_records_unconfirmed_shutdown(self):
        events, records, result = self.exercise('stop')
        self.assertEqual(result, 'SUPPORT_CLOSURE_FAILED_FENCED_FORWARD_REVIEW_REQUIRED')
        self.assertEqual(events.count('stop'), 2); self.assertNotIn('start', events)
        recovery = next(json.loads(raw) for p, raw in records.items() if p.endswith('manual-recovery-required.json'))
        self.assertFalse(recovery['servicesStopped']); self.assertTrue(recovery['forwardRecoveryRequired'])

    def test_safe_default_cli_and_errors_never_export_secrets_or_apply(self):
        self.assertEqual(M.safe_error_code(RuntimeError('synthetic-private')), 'SUPPORT_CLOSURE_REVIEW_REQUIRED')
        self.assertEqual(M.safe_error_code(M.Refused('SUPPORT_CLOSURE_EXPECTED')), 'SUPPORT_CLOSURE_EXPECTED')
        with patch.object(M.sys, 'argv', ['helper', '--binding', '/synthetic/binding.json', '--binding-sha256', 'f' * 64]), \
             patch.object(M, 'binding', return_value={}), patch.object(M, 'preflight', side_effect=RuntimeError('synthetic-private')), patch.object(M, 'apply') as apply, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(M.main(), 1)
        apply.assert_not_called(); self.assertNotIn('synthetic-private', output.getvalue())

    def test_source_has_no_schema_application_snapshot_restore_config_rewrite_or_chat_probe(self):
        source = (HERE / 'trial-support-closure-update.py').read_text()
        for forbidden in ('SNAPSHOT_JS', 'neutral_initial_fields(', "'up'", "'down'", 'pg_dump', 'pg_restore', 'psql', 'npm install', 'npm ci', 'authority_grant', 'replaySupport', 'liveChatProbePerformed\': True'):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__': unittest.main()
