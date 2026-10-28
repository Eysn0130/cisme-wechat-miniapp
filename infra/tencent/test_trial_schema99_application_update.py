"""Offline refusal and application-only rollback tests; never contacts a host."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
spec = importlib.util.spec_from_file_location('schema99_application_update', HERE / 'trial-schema99-application-update.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
PROFILE = {'root': '/opt/cisme-trial', 'user': 'cisme-trial', 'database': 'cisme_trial', 'domain': 'staging-api.cisme.cn',
           'units': ('cisme-trial-api.service', 'cisme-trial-worker.service'), 'lock': '/run/lock/cisme-production-trial.lock', 'name': 'trial'}


def fixtures():
    migrations = sorted(p.name for p in (REPO / 'db/migrations').glob('*.sql') if p.name <= M.MIGRATION)
    assert len(migrations) == 99
    files = {name: ('synthetic:' + name).encode() for name in
             ['index.js', 'worker.js', 'worker-once.js', 'migrate.mjs', 'package.json', 'package-lock.json']}
    files.update({'db/migrations/' + name: (REPO / 'db/migrations' / name).read_bytes() for name in migrations})
    manifest = {'schemaVersion': 1, 'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE,
        'sourceLockSha256': M.SOURCE_LOCK, 'node': 'v24.14.0', 'buildPlatform': {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
        'configurationIncluded': False, 'deployed': False, 'releaseReady': False, 'migrations': migrations,
        'hashes': {name: M.sha(raw) for name, raw in files.items()}}
    old = {'directory': str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])), 'manifest': manifest,
           'manifestSha256': M.BASELINE_MANIFEST, 'dependenciesSha256': M.DEPENDENCIES, 'files': files}
    b = {'schemaVersion': 1, 'kind': 'trial-schema99-application-update', 'baselineHead': M.BASELINE_HEAD,
        'baselineTree': M.BASELINE_TREE, 'sourceHead': '1' * 40, 'sourceTree': '2' * 40, 'ciRunId': 123,
        'helperSha256': 'a' * 64, 'manifestSha256': 'b' * 64, 'archiveSha256': 'c' * 64,
        'archiveBytes': 123, 'stageReceiptSha256': 'd' * 64, 'dependenciesSha256': M.DEPENDENCIES, 'migrations': 99,
        'stageReceipt': str(M.STAGES / ('schema99-' + '1' * 12 + '-abcdefgh') / 'stage-receipt.json')}
    new = copy.deepcopy(old)
    new.update(directory=str(M.ROOT / 'releases' / ('tencent-release-' + b['sourceHead'][:12])), manifestSha256=b['manifestSha256'])
    new['manifest'].update(sourceHead=b['sourceHead'], sourceTree=b['sourceTree'])
    for name in ('index.js', 'worker.js', 'worker-once.js'):
        new['files'][name] = b'new-synthetic:' + name.encode()
    return old, new, b


class ArtifactTests(unittest.TestCase):
    def test_wrong_host_refused_before_lock_or_other_writes(self):
        _, _, b = fixtures()
        d = types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(identity=lambda: {
            'instanceId': 'other', 'publicIpv4': '192.0.2.1'})))
        with patch.object(M, 'D', d), patch.object(M, 'load_baseline'), patch.object(M.os, 'geteuid', return_value=0),\
             patch.object(M.os, 'open') as opened, self.assertRaisesRegex(M.Refused, 'EXACT_INSTANCE'):
            M.apply(b, 'SYNTHETIC-APPROVAL')
        opened.assert_not_called()

    def test_unreviewed_baseline_helper_is_refused_before_execution(self):
        with patch.object(M, 'read', return_value=b'raise AssertionError("must not execute")'),\
             patch.object(M.os, 'geteuid', return_value=0), self.assertRaisesRegex(M.Refused, 'PINNED_DA7_GUARD'):
            M.load_baseline(True)

    def test_only_application_entries_can_change(self):
        M.artifact_contract(*fixtures())

    def test_all_102_preserved_files_must_match(self):
        old, new, b = fixtures()
        names = ['migrate.mjs', 'package.json', 'package-lock.json'] + ['db/migrations/' + n for n in old['manifest']['migrations']]
        self.assertEqual(len(names), 102)
        for name in names:
            with self.subTest(name=name):
                changed = copy.deepcopy(new)
                changed['files'][name] += b'unapproved'
                with self.assertRaisesRegex(M.Refused, 'SQL_MIGRATOR_OR_PACKAGE_CHANGED'):
                    M.artifact_contract(old, changed, b)

    def test_missing_extra_reordered_schema_and_98_baseline_refused(self):
        old, new, b = fixtures()
        for sql in [new['manifest']['migrations'][:-1], new['manifest']['migrations'] + ['20990101_more.sql'],
                    list(reversed(new['manifest']['migrations']))]:
            changed = copy.deepcopy(new)
            changed['manifest']['migrations'] = sql
            with self.assertRaisesRegex(M.Refused, 'NO_SQL_DELTA'):
                M.artifact_contract(old, changed, b)
        old['manifest']['migrations'].pop()
        with self.assertRaisesRegex(M.Refused, 'NO_SQL_DELTA'):
            M.artifact_contract(old, new, b)

    def test_baseline_platform_manifest_and_dependency_drift_refused(self):
        old, new, b = fixtures()
        changed = copy.deepcopy(old)
        changed['manifest']['sourceHead'] = 'f' * 40
        with self.assertRaisesRegex(M.Refused, 'DA7_ARTIFACT'):
            M.artifact_contract(changed, new, b)
        for key, value in [('sourceTree', 'f' * 40), ('buildPlatform', {'os': 'darwin', 'arch': 'arm64'}), ('releaseReady', True)]:
            changed = copy.deepcopy(new)
            changed['manifest'][key] = value
            with self.assertRaisesRegex(M.Refused, 'EXACT_LINUX'):
                M.artifact_contract(old, changed, b)
        new['dependenciesSha256'] = '0' * 64
        with self.assertRaisesRegex(M.Refused, 'FULL_DEPENDENCY'):
            M.artifact_contract(old, new, b)

    def test_binding_refuses_placeholders_wrong_baseline_and_boolean_counts(self):
        _, _, b = fixtures()
        raw = b'synthetic-helper'
        b['helperSha256'] = M.sha(raw)
        with patch.object(M, 'read', return_value=raw):
            self.assertEqual(M.validate_binding(b), b)
            for key, value in [('sourceHead', None), ('sourceHead', '0' * 40), ('ciRunId', True),
                               ('archiveBytes', True), ('migrations', True), ('migrations', 98), ('baselineHead', 'f' * 40)]:
                with self.subTest(key=key, value=value), self.assertRaises(M.Refused):
                    M.validate_binding({**b, key: value})

    def test_binding_duplicates_and_hash_mismatch_fail_closed(self):
        with self.assertRaisesRegex(M.Refused, 'DUPLICATE_JSON'):
            M.parse(b'{"sourceHead":"a","sourceHead":"b"}')
        with patch.object(M, 'read', return_value=b'changed'), self.assertRaisesRegex(M.Refused, 'BINDING_HASH'):
            M.binding(Path('/private/binding.json'), 'a' * 64)


class SourceTests(unittest.TestCase):
    def response(self, **change):
        raw = b'synthetic-committed-helper'
        value = {'type': 'file', 'path': M.HELPER_SOURCE, 'encoding': 'base64', 'size': len(raw),
                 'sha': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest(),
                 'content': base64.b64encode(raw).decode()}
        return raw, {**value, **change}

    def test_helper_contents_exact_ref_path_blob_and_no_credentials(self):
        raw, response = self.response()
        fake = types.SimpleNamespace(source_response=lambda *args: json.dumps(response).encode())
        d = types.SimpleNamespace(general=types.SimpleNamespace(REPO='Eysn0130/cisme-wechat-miniapp',
            observe=types.SimpleNamespace(NoRedirect=object)))
        with patch.object(M, 'C', fake), patch.object(M, 'D', d), patch.object(M.urllib.request, 'build_opener') as opener:
            self.assertEqual(M.github_helper_source('1' * 40), raw)
            self.assertEqual(opener.call_count, 1)
        for change in [{'path': 'elsewhere'}, {'size': len(raw) - 1}, {'sha': 'f' * 40}, {'content': 'invalid!'}]:
            _, response = self.response(**change)
            with patch.object(M, 'C', fake), patch.object(M, 'D', d), patch.object(M.urllib.request, 'build_opener'), self.assertRaises(M.Refused):
                M.github_helper_source('1' * 40)

    def test_source_permit_keeps_original_main_ci_and_requires_committed_helper(self):
        _, new, b = fixtures()
        c = types.SimpleNamespace(source_permit=unittest.mock.Mock())
        with patch.object(M, 'C', c), patch.object(M, 'github_helper_source', return_value=b'wrong'):
            with self.assertRaisesRegex(M.Refused, 'NOT_COMMITTED_MAIN'):
                M.source_permit(b, new, {'sha': b['sourceHead']})
        c.source_permit.assert_called_once_with(b, new, {'sha': b['sourceHead']})


class StageTests(unittest.TestCase):
    def stage(self, **change):
        old, new, b = fixtures()
        archive = b'synthetic-archive'
        b.update(archiveSha256=M.sha(archive), archiveBytes=len(archive))
        receipt = {'kind': 'trial-schema99-application-stage', 'staged': True, 'deployed': False,
            'instanceId': 'lhins-61ikz4mi', 'publicIpv4': '124.223.74.198', 'baselineHead': M.BASELINE_HEAD,
            'sourceHead': b['sourceHead'], 'sourceTree': b['sourceTree'], 'archiveSha256': b['archiveSha256'],
            'archiveSize': b['archiveBytes'], 'manifestSha256': b['manifestSha256'], 'dependenciesSha256': M.DEPENDENCIES,
            'migrations': 99, 'helperSha256': b['helperSha256'], 'privateStage': str(Path(b['stageReceipt']).parent),
            'candidateDirectories': [new['directory']], **dict.fromkeys(
                ['servicesChanged', 'databaseChanged', 'configurationChanged', 'productionChanged', 'peerFilesChanged'], False)}
        receipt.update(change)
        raw = json.dumps(receipt).encode()
        b['stageReceiptSha256'] = M.sha(raw)
        return b, new, raw, archive

    def test_exact_trial_only_stage_archive_and_receipt(self):
        b, new, raw, archive = self.stage()
        with patch.object(M, 'read', side_effect=lambda p, *a: archive if p.name == 'archive.tar.gz' else raw):
            self.assertEqual(M.stage_binding(b, new), b['stageReceipt'])

    def test_production_candidate_stage_content_hash_or_wrong_kind_refused(self):
        for change in [{'candidateDirectories': ['/opt/cisme/releases/foreign']}, {'databaseChanged': True},
                       {'kind': 'trial-editorial-comments-stage'}, {'baselineHead': 'f' * 40}, {'migrations': 98}]:
            b, new, raw, archive = self.stage(**change)
            with self.subTest(change=change), patch.object(M, 'read', side_effect=lambda p, *a: archive if p.name == 'archive.tar.gz' else raw):
                with self.assertRaisesRegex(M.Refused, 'STAGE_BINDING'):
                    M.stage_binding(b, new)
        b, new, raw, archive = self.stage()
        with patch.object(M, 'read', side_effect=lambda p, *a: b'truncated' if p.name == 'archive.tar.gz' else raw):
            with self.assertRaisesRegex(M.Refused, 'ARCHIVE_MISMATCH'):
                M.stage_binding(b, new)

    def test_stage_outside_private_namespace_refused(self):
        b, new, _, _ = self.stage()
        for path in ['/tmp/schema99-anything/stage-receipt.json', str(M.STAGES / 'wrong' / 'stage-receipt.json')]:
            with self.subTest(path=path), self.assertRaisesRegex(M.Refused, 'STAGE_PATH'):
                M.stage_binding({**b, 'stageReceipt': path}, new)


class CutoverTests(unittest.TestCase):
    def run_flow(self, failure=None):
        old, new, b = fixtures()
        plan = {'profile': PROFILE, 'old': old, 'candidate': new, 'main': {'sha': b['sourceHead']},
                'binding': b, 'ownership': {'ownershipId': 'synthetic-owned'}}
        events, writes = [], {}
        switched = {'value': 'old'}
        comments = [{'id': 'synthetic-existing-comment', 'version': 3, 'body': 'retained synthetic body'}]
        def command(args, **kwargs):
            self.assertEqual(args[0], 'systemctl')
            self.assertEqual(tuple(args[2:]), PROFILE['units'])
            events.append(args[1] + '-' + switched['value'])
            return b''
        def switch(plan, directory):
            switched['value'] = 'new' if directory == new['directory'] else 'old'
            events.append('switch-' + switched['value'])
        def healthy(*args):
            events.append('healthy-' + switched['value'])
            if failure in ('health', 'unknown-active', 'unknown-unit') and switched['value'] == 'new':
                raise RuntimeError('synthetic unhealthy')
            return {'fastify': '5.12.6', 'sharp': '0.35.5'}
        def verify(*args, **kwargs):
            events.append('verify')
            if failure in ('unknown-active', 'unknown-unit') and switched['value'] == 'new' and events.count('stop-new'):
                raise M.Refused('SCHEMA99_UNKNOWN_ACTIVE_DRIFT' if failure == 'unknown-active' else 'SCHEMA99_UNKNOWN_UNIT_DRIFT')
        def journal(plan, drain=False):
            events.append('drain' if drain else 'journal')
            if failure == 'drain' and drain and 'switch-new' not in events:
                raise M.Refused('SCHEMA99_DRAIN_FAILED')
            return old['manifest']['migrations']
        d = types.SimpleNamespace(command=command, stopped=lambda p: events.append('stopped'), switch=switch,
            verify_units=lambda *a, **k: events.append('units'), healthy=healthy,
            atomic_bytes=lambda p, raw: writes.__setitem__(str(p), raw),
            general=types.SimpleNamespace(store=lambda p, raw: writes.__setitem__(str(p), raw)))
        c = types.SimpleNamespace(fixed_profile=lambda p: self.assertEqual(p, PROFILE), public_contract=lambda *a: events.append('public-comments'))
        with patch.object(M, 'D', d), patch.object(M, 'C', c), patch.object(M, 'save_plan', return_value='e' * 64),\
             patch.object(M, 'verify_context', side_effect=verify), patch.object(M, 'verify_history', side_effect=lambda *a: events.append('history')),\
             patch.object(M, 'journal', side_effect=journal):
            try:
                result = M.cutover(plan, M.STATE_PARENT / ('main-' + b['sourceHead'][:12] + '-123'), 'SYNTHETIC-APPROVAL')
            except M.Refused as error:
                result = str(error)
        self.assertEqual(comments, [{'id': 'synthetic-existing-comment', 'version': 3, 'body': 'retained synthetic body'}])
        return events, writes, result

    def test_stop_drain_switch_and_independent_active_without_migration(self):
        events, writes, result = self.run_flow()
        self.assertTrue(result['deployed'])
        self.assertFalse(result['schemaChanged'])
        self.assertLess(events.index('stop-old'), events.index('drain'))
        self.assertLess(events.index('drain'), events.index('switch-new'))
        active = json.loads(writes[str(M.ACTIVE)])
        self.assertEqual(active['kind'], 'trial-schema99-application-active-release')
        self.assertEqual(active['migrationCount'], 99)
        self.assertFalse(active['schemaChanged'])
        self.assertTrue(all('editorial-comments-active-release.json' not in name for name in writes))

    def test_health_failure_restores_only_da7_app_and_keeps_schema99(self):
        events, writes, result = self.run_flow('health')
        self.assertIn('DA7_APPLICATION_RESTORED_DATABASE_RETAINED', result)
        self.assertIn('healthy-old', events)
        active = json.loads(writes[str(M.ACTIVE)])
        self.assertEqual(active['sourceHead'], M.BASELINE_HEAD)
        self.assertFalse(active['databaseRestored'])
        self.assertTrue(active['applicationRollback'])

    def test_unknown_active_or_unit_drift_never_restarts_old_app(self):
        for failure in ('unknown-active', 'unknown-unit'):
            with self.subTest(failure=failure):
                events, writes, result = self.run_flow(failure)
                self.assertIn('FENCED_REVIEW_REQUIRED', result)
                self.assertNotIn('switch-old', events)
                self.assertNotIn('healthy-old', events)
                self.assertNotIn(str(M.ACTIVE), writes)
                self.assertTrue(any('manual-recovery-required.json' in name for name in writes))

    def test_drain_failure_never_activates_candidate(self):
        events, _, result = self.run_flow('drain')
        self.assertNotIn('switch-new', events)
        self.assertIn('FENCED_REVIEW_REQUIRED', result)

    def test_historical_active_or_unknown_new_active_refused(self):
        plan = {'historicalActive': {'editorial-comments-active-release.json': b'original'}}
        with patch.object(M, 'read', return_value=b'changed'), self.assertRaisesRegex(M.Refused, 'HISTORICAL_ACTIVE'):
            M.verify_history(plan)
        with patch.object(M, 'read', return_value=b'original'), patch.object(M, 'optional_active', return_value=b'unknown'):
            with self.assertRaisesRegex(M.Refused, 'UNKNOWN_ACTIVE'):
                M.verify_history(plan, (b'known',))

    def test_post_switch_active_never_calls_old_da7_active_guard(self):
        old, new, b = fixtures()
        state = M.STATE_PARENT / ('main-' + b['sourceHead'][:12] + '-123')
        plan = {'profile': PROFILE, 'config': {}, 'old': old, 'candidate': new,
                'ownership': {'ownershipId': 'synthetic'}, 'binding': b}
        c = types.SimpleNamespace(decode_private=lambda value: plan, fixed_profile=lambda p: None,
            active_context=lambda *a: self.fail('OLD DA7 ACTIVE GUARD CALLED'))
        d = types.SimpleNamespace(general=types.SimpleNamespace(observe=types.SimpleNamespace(identity=lambda: {
            'instanceId': 'lhins-61ikz4mi', 'publicIpv4': '124.223.74.198'})),
            artifact=lambda directory, root: old if directory == old['directory'] else new,
            unit_path=lambda unit: Path('/etc/systemd/system') / unit,
            unit_entry=lambda *a: Path(new['directory']), read_owned=lambda *a: b'unit', running=lambda *a: {'api': 1, 'worker': 2})
        def read(path, *a):
            return active if path == M.ACTIVE else b'{}'
        # The real digest comparison still binds the exact private plan bytes.
        saved = b'{}'
        active = M.active_record(plan, state, M.sha(saved), new)
        with patch.object(M, 'C', c), patch.object(M, 'D', d), patch.object(M, 'validate_binding', return_value=b),\
             patch.object(M, 'load_baseline') as loaded, patch.object(M, 'read', side_effect=read),\
             patch.object(M, 'verify_context') as verified, patch.object(M, 'journal'):
            self.assertEqual(M.active_context(b)['release'], Path(new['directory']))
            loaded.assert_called_once_with(False)
            self.assertFalse(verified.call_args.kwargs['provenance'])


class FileBoundaryTests(unittest.TestCase):
    def test_existing_service_readable0640_env_and_group_writable_rejection(self):
        spec = importlib.util.spec_from_file_location('real_dependency_env_reader', HERE / 'dependency-only-upgrade.py')
        reader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reader)
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'runtime.env'
            path.write_bytes(b'SYNTHETIC_NO_SECRET=true\n')
            path.chmod(0o640)
            profile = {'root': name, 'user': 'synthetic-service'}
            with patch.object(reader, 'OWNER', os.geteuid()),\
                 patch.object(reader.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_gid=os.getegid())),\
                 patch.object(reader, 'command', return_value=b'') as service_read:
                self.assertEqual(reader.read_owned(path, private=True), path.read_bytes())
                self.assertEqual(reader.environment_metadata(profile)['mode'], 0o640)
                self.assertEqual(service_read.call_args.args[0],
                    ['/usr/sbin/runuser', '-u', 'synthetic-service', '--', '/usr/bin/test', '-r', str(path)])
                path.chmod(0o660)
                with self.assertRaisesRegex(reader.Refused, 'FILE_UNSAFE'):
                    reader.read_owned(path, private=True)
                with self.assertRaisesRegex(reader.Refused, 'ENV_PERMISSION'):
                    reader.environment_metadata(profile)

    def test_actual_private_file_rejects_group_read_symlink_hardlink(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            file = folder / 'private.json'
            file.write_bytes(b'private synthetic bytes')
            file.chmod(0o600)
            with patch.object(M, 'OWNER', os.geteuid()), patch.object(M, 'parents'):
                self.assertEqual(M.read(file, private=True), b'private synthetic bytes')
                file.chmod(0o640)
                with self.assertRaisesRegex(M.Refused, 'PROTECTED_FILE'):
                    M.read(file, private=True)
                file.chmod(0o600)
                link = folder / 'link'
                link.symlink_to(file)
                with self.assertRaises(OSError):
                    M.read(link, private=True)
                os.link(file, folder / 'hardlink')
                with self.assertRaisesRegex(M.Refused, 'PROTECTED_FILE'):
                    M.read(file, private=True)

    def test_exact_root_private_metadata_exception_only_and_writable_ancestor_refused(self):
        def safe(path):
            return types.SimpleNamespace(st_mode=stat.S_IFDIR | (0o755 if path == M.ROOT else 0o700), st_uid=0)
        with patch.object(Path, 'lstat', safe):
            M.parents(M.ROOT / 'editorial-comments-active-release.json', True)
            with self.assertRaisesRegex(M.Refused, 'PRIVATE_PARENT'):
                M.parents(M.ROOT / 'unknown.json', True)
        def unsafe(path):
            return types.SimpleNamespace(st_mode=stat.S_IFDIR | (0o777 if path == Path('/opt') else 0o700), st_uid=0)
        with patch.object(Path, 'lstat', unsafe), self.assertRaisesRegex(M.Refused, 'PROTECTED_PARENT'):
            M.parents(M.STATE_PARENT / 'active-release.json', True)


if __name__ == '__main__':
    unittest.main()
