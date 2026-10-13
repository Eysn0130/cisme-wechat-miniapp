import contextlib
import copy
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dependency_upgrade', HERE / 'dependency-only-upgrade.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DependencyUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'trial'
        self.root.mkdir()
        (self.root / 'releases').mkdir()
        self.profile = {**m.PROFILES['trial'], 'name': 'trial', 'root': str(self.root)}
        self.main = {'sha': 'b' * 40, 'tree': 'c' * 40, 'ciRunId': 123}
        self.package = {'name': 'cisme-tencent-release', 'version': '0.1.0', 'private': True,
                        'type': 'module', 'engines': {'node': '>=24.14 <25'},
                        'dependencies': {'fastify': '5.12.3', 'sharp': '0.35.4', 'pg': '8.23.0'}}
        self.source_package = {**self.package, 'name': 'cisme-source', 'dependencies':
                               {**self.package['dependencies'], 'fastify': '5.12.5', 'sharp': '0.35.5'}}
        self.source_package_bytes = json.dumps(self.source_package).encode()
        self.source_lock = {'name': 'cisme-source', 'packages': {'': {'name': 'cisme-source'},
                            'node_modules/sharp': {'version': '0.35.5'},
                            'node_modules/fastify': {'version': '5.12.5'},
                            'node_modules/@cisme/fixture': {'link': True}, 'packages/fixture': {'version': '1.0.0'}}}
        self.source_lock_bytes = json.dumps(self.source_lock).encode()
        self.migrations = ['202601010001_synthetic.sql']
        self.old = self.release('previous-release', False)
        self.new = self.release('candidate-release', True)
        self.units = self.root / 'units'
        self.units.mkdir()
        self.old_units = {}
        for unit, entry in zip(self.profile['units'], ('index.js', 'worker.js')):
            data = (f'[Service]\nUser=cisme-trial\nGroup=cisme-trial\nWorkingDirectory={self.root}\n'
                    f'EnvironmentFile={self.root}/runtime.env\nEnvironment=TMPDIR={self.root}/tmp\n'
                    f'# comment ExecStart={m.NODE} {self.old["directory"]}/{entry}\n'
                    f'ExecStart={m.NODE} {self.old["directory"]}/{entry}\nRestart=on-failure\n').encode()
            self.old_units[unit] = data
            (self.units / unit).write_bytes(data)
        self.env = (b'APP_ENV=staging\nDATABASE_URL=postgresql://cisme_trial:synthetic-private@127.0.0.1:5432/cisme_trial\n'
                    b'ALLOW_DEV_ADAPTERS=false\nCOMMERCE_ORDER_FLOW_ENABLED=false\nUGC_GO_LIVE_GATE=false\n')
        (self.root / 'runtime.env').write_bytes(self.env)
        (self.root / 'runtime.env').chmod(0o640)
        self.ownership = {'kind': 'cisme-isolated-trial', 'instanceId': 'lhins-61ikz4mi', 'root': str(self.root),
                          'database': 'cisme_trial', 'role': 'cisme_trial', 'user': 'cisme-trial',
                          'ownershipId': 'a' * 32, 'source': {'sourceHead': 'a' * 40, 'sourceTree': 'd' * 40,
                                                           'dependenciesSha256': 'old-tree'}}
        initial = {'ownership.json': self.ownership, 'empty-database.json': {'synthetic': True, 'tablesBefore': 0},
                   'migration-complete.json': {'ownershipId': 'a' * 32, 'source': self.ownership['source'], 'migrations': 1}}
        self.initial = {}
        for name, value in initial.items():
            data = json.dumps(value).encode()
            self.initial[name] = data
            (self.root / name).write_bytes(data)
            (self.root / name).chmod(0o600)
        self.calls = []
        self.facts = {'database': 'cisme_trial', 'owner': 'cisme_trial', 'journal': self.migrations, 'otherClients': 0}
        self.plan = {'profile': self.profile, 'main': self.main, 'old': self.old, 'candidate': self.new,
                     'env': self.env, 'units': self.old_units, 'config': {}, 'privateInputs': [],
                     'ownership': self.ownership, 'initialRecords': self.initial, 'activeBytes': None,
                     'pids': {'api': '100', 'worker': '101'}, 'versions': {'sharp': '0.35.5', 'fastify': '5.12.5'},
                     'oldVersions': {'sharp': '0.35.4', 'fastify': '5.12.3'},
                     'environmentMetadata': {'uid': os.getuid(), 'gid': os.getgid(), 'mode': 0o640}}
        self.patches = [patch.object(m, 'OWNER', os.getuid()), patch.object(m, 'unit_path', side_effect=lambda unit: self.units / unit),
                        patch.object(m, 'private_inputs', return_value=[]),
                        patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())),
                        patch.object(m, 'property_value', side_effect=self.property),
                        patch.object(m, 'owned_directory', side_effect=self.owned_test_directory)]
        for mocked in self.patches:
            mocked.start()
            self.addCleanup(mocked.stop)
        self.plan['unitDefinitions'] = self.definitions(self.profile)
        self.plan['dropIns'] = {unit: m.dropin_inputs(unit) for unit in self.profile['units']}

    def owned_test_directory(self, path, private=False):
        # The temporary fixture substitutes its own UID for root. Its system
        # ancestors are outside the fixture; exercise real modes within it.
        if path.is_relative_to(self.root):
            info = path.lstat()
            m.require(stat.S_ISDIR(info.st_mode) and info.st_uid == m.OWNER
                      and info.st_mode & (0o077 if private else 0o022) == 0, 'DEPENDENCY_DIRECTORY_UNSAFE')

    def property(self, unit, name):
        data = (self.units / unit).read_text()
        lines = data.splitlines()
        raw = dict(line.split('=', 1) for line in lines if '=' in line and not line.startswith('#'))
        values = {key: '' for key in m.UNIT_PROPERTIES}
        values.update({'FragmentPath': str(self.units / unit), 'DropInPaths': '', 'LoadState': 'loaded',
                       'NeedDaemonReload': 'no', 'User': raw['User'], 'Group': raw['Group'],
                       'WorkingDirectory': raw['WorkingDirectory'],
                       'EnvironmentFiles': raw['EnvironmentFile'] + ' (ignore_errors=no)',
                       'Environment': raw['Environment'], 'ProtectSystem': 'strict', 'NoNewPrivileges': 'yes'})
        directory = self.units / (unit + '.d')
        if directory.exists():
            dropins = sorted(directory.glob('*.conf'))
            values['DropInPaths'] = ' '.join(str(path) for path in dropins)
            # Mimic an effective existing sandbox addition, independently of
            # the original fragment's bytes.
            for dropin in dropins:
                for line in dropin.read_text().splitlines():
                    if line.startswith('ReadWritePaths='):
                        values['ReadWritePaths'] += ' ' + line.split('=', 1)[1]
            values['ReadWritePaths'] = values['ReadWritePaths'].strip()
        values['ExecStart'] = '{ path=' + m.NODE + ' ; argv[]=' + raw['ExecStart'] + ' ; ignore_errors=no ; start_time=n/a ; }'
        return values[name]

    def definitions(self, profile):
        return {unit: m.unit_definition(unit, (self.units / unit).read_bytes(), entry, profile)
                for unit, entry in zip(profile['units'], ('index.js', 'worker.js'))}

    def production_plan(self):
        profile = {**m.PROFILES['production'], 'name': 'production', 'root': str(self.root)}
        current = self.root / 'current'
        if not current.exists():
            current.symlink_to(self.old['directory'])
        units = {}
        for unit, entry in zip(profile['units'], ('index.js', 'worker.js')):
            data = (f'[Service]\nUser=cisme\nGroup=cisme\nWorkingDirectory={self.root}/current\n'
                    f'EnvironmentFile={self.root}/runtime.env\nEnvironment=TMPDIR={self.root}/tmp\n'
                    f'ExecStart={m.NODE} {entry}\nRestart=on-failure\n').encode()
            units[unit] = data
            (self.units / unit).write_bytes(data)
        self.facts.update({'database': 'cisme', 'owner': 'cisme'})
        return {**self.plan, 'profile': profile, 'units': units, 'unitDefinitions': self.definitions(profile),
                'dropIns': {unit: m.dropin_inputs(unit) for unit in profile['units']},
                'ownership': None, 'initialRecords': {}}

    def existing_dropin_plan(self, production=True):
        plan = self.production_plan() if production else self.plan
        for unit in plan['profile']['units']:
            directory = self.units / (unit + '.d')
            directory.mkdir(mode=0o755, exist_ok=True)
            (directory / '10-privacy-suppression.conf').write_bytes(
                b'[Service]\nReadWritePaths=' + str(self.root / 'privacy-suppression').encode() + b'\n')
        plan['dropIns'] = {unit: m.dropin_inputs(unit) for unit in plan['profile']['units']}
        plan['unitDefinitions'] = self.definitions(plan['profile'])
        return plan

    def release(self, name, patched):
        directory = self.root / 'releases' / name
        directory.mkdir()
        (directory / 'node_modules').mkdir()
        (directory / 'db/migrations').mkdir(parents=True)
        package = copy.deepcopy(self.package)
        if patched:
            package['dependencies'].update({'sharp': '0.35.5', 'fastify': '5.12.5'})
        lock = copy.deepcopy(self.source_lock)
        lock['name'] = package['name']
        lock['packages'][''] = {key: value for key, value in package.items() if key not in ('private', 'type')}
        lock['packages'] = {key: value for key, value in lock['packages'].items()
                            if not key or (key.startswith('node_modules/') and not value.get('link'))}
        files = {name: ('// synthetic ' + name + '\n').encode() for name in m.ENTRIES}
        files.update({'package.json': json.dumps(package).encode(), 'package-lock.json': json.dumps(lock).encode(),
                      'db/migrations/' + self.migrations[0]: b'-- synthetic SQL; never executed\n'})
        for relative, data in files.items():
            (directory / relative).write_bytes(data)
        manifest = {'schemaVersion': 1, 'configurationIncluded': False, 'migrations': self.migrations,
                    'sourceHead': self.main['sha'] if patched else 'a' * 40,
                    'sourceTree': self.main['tree'] if patched else 'd' * 40,
                    'sourceLockSha256': m.digest(self.source_lock_bytes),
                    'buildPlatform': {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
                    'hashes': {relative: m.digest(data) for relative, data in files.items()}}
        manifest_bytes = json.dumps(manifest).encode()
        (directory / 'release-manifest.json').write_bytes(manifest_bytes)
        return {'directory': str(directory), 'manifest': manifest, 'manifestSha256': m.digest(manifest_bytes),
                'dependenciesSha256': 'new-tree' if patched else 'old-tree', 'files': files}

    def state(self):
        directory = self.root / ('state-' + str(len(list(self.root.glob('state-*')))))
        directory.mkdir(mode=0o700)
        return directory

    def command(self, args, **kwargs):
        self.calls.append(args)
        self.assertNotIn('up', args)
        self.assertFalse(any('pg_restore' in value or 'createdb' in value or 'npm' == value for value in args))
        return b''

    def cutover_patches(self, healthy=None, context=None):
        return [patch.object(m, 'command', side_effect=self.command), patch.object(m, 'verify_context', side_effect=context),
                patch.object(m, 'stopped'), patch.object(m, 'database_facts', return_value=self.facts),
                patch.object(m, 'healthy', side_effect=healthy, return_value=self.plan['versions'])]

    def test_exact_runtime_and_full_sql_set_only_accepts_the_two_direct_patches(self):
        m.equal_runtime(self.old, self.new)
        for name in (*m.ENTRIES, 'db/migrations/' + self.migrations[0]):
            modified = copy.deepcopy(self.new)
            modified['files'][name] += b'changed'
            with self.assertRaisesRegex(m.Refused, 'RUNTIME_OR_SQL_CHANGED'):
                m.equal_runtime(self.old, modified)
        modified = copy.deepcopy(self.new)
        modified['manifest']['migrations'] += ['202601010002_unapproved.sql']
        with self.assertRaisesRegex(m.Refused, 'SQL_SET_CHANGED'):
            m.equal_runtime(self.old, modified)
        modified = copy.deepcopy(self.new)
        value = json.loads(modified['files']['package.json'])
        value['dependencies']['pg'] = '8.24.0'
        modified['files']['package.json'] = json.dumps(value).encode()
        with self.assertRaisesRegex(m.Refused, 'DIRECT_CHANGE_NOT_PERMITTED'):
            m.equal_runtime(self.old, modified)

    def test_source_permit_binds_actual_main_files_and_transformed_release_lock(self):
        def source(name, head):
            self.assertEqual(head, self.main['sha'])
            return {'package.json': self.source_package_bytes, 'package-lock.json': self.source_lock_bytes,
                    'scripts/release-migrate.mjs': self.new['files']['migrate.mjs']}[name]
        with patch.object(m, 'PACKAGE_PERMIT', m.digest(self.source_package_bytes)), \
                patch.object(m, 'LOCK_PERMIT', m.digest(self.source_lock_bytes)), patch.object(m, 'github_source', side_effect=source), \
                patch.object(m, 'command', return_value=json.dumps({'verified': True, 'sourceHead': self.main['sha'],
                                                                  'sourceTree': self.main['tree']}).encode()) as command:
            m.permit(self.new, self.main)
            self.assertEqual(command.call_args.args[0][-1], 'verify')
            with self.assertRaisesRegex(m.Refused, 'SOURCE_PERMIT_MISMATCH'), patch.object(m, 'LOCK_PERMIT', 'f' * 64):
                modified = copy.deepcopy(self.new)
                modified['manifest']['sourceLockSha256'] = 'f' * 64
                m.permit(modified, self.main)
            modified = copy.deepcopy(self.new)
            modified['files']['package-lock.json'] = b'{"packages":{}}'
            with self.assertRaisesRegex(m.Refused, 'LOCK_NOT_REVIEWED_SOURCE'):
                m.permit(modified, self.main)

    def test_wrong_head_tree_platform_or_manifest_permit_refused_before_network(self):
        for key, value in (('sourceHead', 'e' * 40), ('sourceTree', 'e' * 40),
                           ('buildPlatform', {'os': 'darwin', 'arch': 'arm64', 'libc': 'glibc'}),
                           ('sourceLockSha256', 'e' * 64)):
            modified = copy.deepcopy(self.new)
            modified['manifest'][key] = value
            with patch.object(m, 'github_source') as source:
                with self.assertRaisesRegex(m.Refused, 'REVIEWED_CANDIDATE_REQUIRED'):
                    m.permit(modified, self.main)
                source.assert_not_called()

    def test_artifact_rejects_modified_bytes_extra_sql_and_external_link(self):
        with patch.object(m, 'owned_directory'), patch.object(m.trial, 'dependency_digest', return_value='new-tree'):
            loaded = m.artifact(self.new['directory'], self.root)
            self.assertEqual(loaded['files'], self.new['files'])
            sql = Path(self.new['directory']) / 'db/migrations' / self.migrations[0]
            sql.write_bytes(b'modified SQL')
            with self.assertRaisesRegex(m.Refused, 'ARTIFACT_HASH_MISMATCH'):
                m.artifact(self.new['directory'], self.root)
            sql.write_bytes(self.new['files']['db/migrations/' + self.migrations[0]])
            extra = sql.parent / '202601010002_unapproved.sql'
            extra.write_text('unexpected')
            with self.assertRaisesRegex(m.Refused, 'SQL_SET_CHANGED'):
                m.artifact(self.new['directory'], self.root)
            extra.unlink()
            sql.unlink()
            sql.symlink_to(self.root / 'runtime.env')
            with self.assertRaises(OSError):
                m.artifact(self.new['directory'], self.root)

    def test_unit_replacement_changes_only_actual_execstart_and_preserves_comment_and_all_other_bytes(self):
        data = self.old_units[self.profile['units'][0]]
        new = m.replacement_unit(data, self.old['directory'], self.new['directory'], 'index.js', self.profile)
        self.assertIn(b'# comment ExecStart=' + m.NODE.encode() + b' ' + self.old['directory'].encode(), new)
        self.assertEqual(new.replace(('ExecStart=' + m.NODE + ' ' + self.new['directory'] + '/index.js\n').encode(),
                                     ('ExecStart=' + m.NODE + ' ' + self.old['directory'] + '/index.js\n').encode()), data)
        with self.assertRaises(m.Refused):
            m.replacement_unit(data + b'ExecStart=/bin/false\n', self.old['directory'], self.new['directory'], 'index.js', self.profile)

    def test_native_resolution_versions_linux_runtime_and_patched_librsvg(self):
        result = {'smoke': True, 'node': 'v24.14.0', 'platform': 'linux', 'arch': 'x64', 'glibc': '2.39',
                  'fastify': '5.12.5', 'sharp': '0.35.5', 'rsvg': '2.63.2', 'vips': '8.18.7',
                  'fastifyPath': self.new['directory'] + '/node_modules/fastify/index.js',
                  'sharpPath': self.new['directory'] + '/node_modules/sharp/index.js'}
        with patch.object(m, 'command', return_value=json.dumps(result).encode()) as command:
            m.native_smoke(self.profile, self.new['directory'])
            self.assertEqual(len(command.call_args_list), 2)
            for key, value in (('sharp', '0.35.4'), ('rsvg', '2.62.91'), ('arch', 'arm64'),
                               ('sharpPath', '/opt/cisme/node_modules/sharp/index.js'), ('node', 'v24.18.0')):
                command.return_value = json.dumps({**result, key: value}).encode()
                with self.assertRaises(m.Refused):
                    m.native_smoke(self.profile, self.new['directory'])
            command.return_value = json.dumps({**result, 'fastify': '5.12.3', 'sharp': '0.35.4',
                                              'rsvg': '2.62.91',
                                              'fastifyPath': self.old['directory'] + '/node_modules/fastify/index.js',
                                              'sharpPath': self.old['directory'] + '/node_modules/sharp/index.js'}).encode()
            self.assertEqual(m.native_smoke(self.profile, self.old['directory'], False)['sharp'], '0.35.4')
            with self.assertRaises(m.Refused):
                m.native_smoke(self.profile, self.old['directory'], True)

    def test_trial_success_preserves_environment_ownership_initial_migration_and_existing_data(self):
        data = self.root / 'new-fact.json'
        data.write_text('new test-only business fact')
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches():
                stack.enter_context(mocked)
            report = m.cutover(self.plan, self.state(), 'synthetic-test-only')
        self.assertTrue(report['deployed'])
        self.assertFalse(report['databaseRestored'])
        self.assertEqual((self.root / 'runtime.env').read_bytes(), self.env)
        self.assertTrue(all((self.root / name).read_bytes() == value for name, value in self.initial.items()))
        self.assertEqual(data.read_text(), 'new test-only business fact')
        active = json.loads((self.root / 'dependency-active-release.json').read_text())
        self.assertEqual(active['ownershipId'], self.ownership['ownershipId'])
        self.assertEqual(active['sourceHead'], self.main['sha'])
        for unit, entry in zip(self.profile['units'], ('index.js', 'worker.js')):
            self.assertEqual(m.unit_entry((self.units / unit).read_bytes(), entry, self.profile), Path(self.new['directory']))

    def test_health_failure_rolls_back_only_application_and_preserves_post_activation_facts(self):
        fact = self.root / 'post-activation-fact'
        def health(plan, directory, started, patched):
            if patched:
                fact.write_text('preserve this synthetic new fact')
                raise m.Refused('DEPENDENCY_ACTIVATION_FAILED')
            return {}
        state = self.state()
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches(health):
                stack.enter_context(mocked)
            with self.assertRaisesRegex(m.Refused, 'APPLICATION_RESTORED'):
                m.cutover(self.plan, state, 'synthetic-test-only')
        self.assertEqual(fact.read_text(), 'preserve this synthetic new fact')
        self.assertTrue(all((self.units / unit).read_bytes() == data for unit, data in self.old_units.items()))
        self.assertEqual((self.root / 'runtime.env').read_bytes(), self.env)
        self.assertTrue(all((self.root / name).read_bytes() == value for name, value in self.initial.items()))
        self.assertFalse((self.root / 'dependency-active-release.json').exists())
        self.assertTrue((state / 'application-rollback.json').exists())

    def test_unresolved_database_client_refuses_cutover_and_keeps_original_units(self):
        self.facts['otherClients'] = 1
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches():
                stack.enter_context(mocked)
            with self.assertRaisesRegex(m.Refused, 'APPLICATION_RESTORED'):
                m.cutover(self.plan, self.state(), 'synthetic-test-only')
        self.assertTrue(all((self.units / unit).read_bytes() == data for unit, data in self.old_units.items()))

    def test_unknown_unit_drift_on_failure_remains_stopped_without_overwriting(self):
        unit = self.units / self.profile['units'][0]
        def health(*args):
            unit.write_bytes(b'[Service]\nExecStart=/unknown/operator-change\n')
            raise m.Refused('DEPENDENCY_ACTIVATION_FAILED')
        state = self.state()
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches(health):
                stack.enter_context(mocked)
            with self.assertRaisesRegex(m.Refused, 'FENCED_REVIEW_REQUIRED'):
                m.cutover(self.plan, state, 'synthetic-test-only')
        self.assertEqual(unit.read_bytes(), b'[Service]\nExecStart=/unknown/operator-change\n')
        self.assertEqual(self.calls[-1], ['systemctl', 'stop', *self.profile['units']])
        self.assertTrue((state / 'manual-recovery-required.json').exists())

    def test_production_switch_uses_existing_symlink_and_never_rewrites_units(self):
        plan = self.production_plan()
        with patch.object(m, 'command', side_effect=self.command):
            m.switch(plan, self.new['directory'])
            self.assertEqual((self.root / 'current').resolve(), Path(self.new['directory']))
            m.switch(plan, self.old['directory'])
        self.assertTrue(all((self.units / unit).read_bytes() == data for unit, data in plan['units'].items()))
        self.assertEqual(self.calls, [])

    def test_existing_protected_dropins_are_bound_preserved_and_snapshotted_privately(self):
        plan = self.existing_dropin_plan()
        original = {path: data for inputs in plan['dropIns'].values() for path, data in inputs['files'].items()}
        m.verify_units(plan)
        state = self.state()
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches():
                stack.enter_context(mocked)
            self.assertTrue(m.cutover(plan, state, 'synthetic-test-only')['deployed'])
        self.assertTrue(all(Path(path).read_bytes() == data for path, data in original.items()))
        for unit, inputs in plan['dropIns'].items():
            for path, data in inputs['files'].items():
                snapshot = state / 'drop-ins' / unit / Path(path).name
                self.assertEqual(snapshot.read_bytes(), data)
                self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(snapshot.parent.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(snapshot.parent.parent.stat().st_mode), 0o700)
            definition = plan['unitDefinitions'][unit]
            self.assertEqual(definition['ReadWritePaths'], str(self.root / 'privacy-suppression'))
            self.assertEqual(definition['DropInBinding'], inputs['binding'])
        with patch('sys.argv', ['upgrade', '--environment', 'production', '--release', self.new['directory']]), \
                patch.object(m, 'preflight', return_value=plan), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(), 0)
        self.assertNotIn('DropInBinding', output.getvalue())
        self.assertNotIn('ReadWritePaths', output.getvalue())
        self.assertTrue(all(m.digest(data) not in output.getvalue() for data in original.values()))

    def test_dropin_addition_deletion_content_and_metadata_drift_are_refused(self):
        plan = self.existing_dropin_plan()
        unit = plan['profile']['units'][0]
        directory = self.units / (unit + '.d')
        path = directory / '10-privacy-suppression.conf'
        original = path.read_bytes()
        added = directory / '20-unknown.conf'
        added.write_bytes(b'[Service]\nReadWritePaths=/unknown\n')
        with self.assertRaisesRegex(m.Refused, 'UNKNOWN_DROPIN_DRIFT'):
            m.verify_units(plan)
        # Newly created files may not yet appear in systemd's loaded set.
        with patch.object(m, 'property_value', side_effect=lambda u, key:
                          plan['unitDefinitions'][u]['DropInPaths'] if key == 'DropInPaths' else self.property(u, key)):
            with self.assertRaisesRegex(m.Refused, 'DROPIN_SET_REQUIRED'):
                m.verify_units(plan)
        added.unlink()
        path.unlink()
        with self.assertRaisesRegex(m.Refused, 'UNKNOWN_DROPIN_DRIFT'):
            m.verify_units(plan)
        path.write_bytes(original + b'# protected but changed\n')
        with self.assertRaisesRegex(m.Refused, 'UNKNOWN_DROPIN_DRIFT'):
            m.verify_units(plan)
        path.write_bytes(original)
        path.chmod(0o600)
        with self.assertRaisesRegex(m.Refused, 'UNKNOWN_DROPIN_DRIFT'):
            m.verify_units(plan)

    def test_dropin_unknown_paths_links_writable_files_and_directories_are_refused(self):
        plan = self.existing_dropin_plan()
        unit = plan['profile']['units'][0]
        directory = self.units / (unit + '.d')
        path = directory / '10-privacy-suppression.conf'
        for foreign in ('/usr/lib/systemd/system/' + unit + '.d/override.conf',
                        str(directory / '..' / 'foreign.conf'), str(directory / 'bad name.conf')):
            with self.subTest(path=foreign), self.assertRaisesRegex(m.Refused, 'DROPIN_PATH_REQUIRED'):
                m.dropin_inputs(unit, foreign)
        path.chmod(0o666)
        with self.assertRaisesRegex(m.Refused, 'FILE_UNSAFE'):
            m.dropin_inputs(unit)
        path.chmod(0o644)
        directory.chmod(0o777)
        with self.assertRaisesRegex(m.Refused, 'DIRECTORY_UNSAFE'):
            m.dropin_inputs(unit)
        directory.chmod(0o755)
        with patch.object(m, 'OWNER', os.getuid() + 1):
            with self.assertRaisesRegex(m.Refused, 'DIRECTORY_UNSAFE'):
                m.dropin_inputs(unit)
        data = path.read_bytes()
        path.unlink()
        path.symlink_to(self.root / 'runtime.env')
        with self.assertRaisesRegex(m.Refused, 'DROPIN_FILE_UNSAFE'):
            m.dropin_inputs(unit)
        path.unlink()
        path.write_bytes(data)
        alias = directory / '20-hardlink.conf'
        os.link(path, alias)
        with self.assertRaisesRegex(m.Refused, 'DROPIN_FILE_UNSAFE'):
            m.dropin_inputs(unit)

    def test_dropin_drift_after_candidate_failure_fences_before_old_application_start(self):
        plan = self.existing_dropin_plan()
        unit = plan['profile']['units'][0]
        path = self.units / (unit + '.d') / '10-privacy-suppression.conf'
        def health(*args):
            path.write_bytes(b'[Service]\nReadWritePaths=/unknown\n')
            raise m.Refused('DEPENDENCY_ACTIVATION_FAILED')
        state = self.state()
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches(health):
                stack.enter_context(mocked)
            with self.assertRaisesRegex(m.Refused, 'FENCED_REVIEW_REQUIRED'):
                m.cutover(plan, state, 'synthetic-test-only')
        self.assertEqual(sum(args[:2] == ['systemctl', 'start'] for args in self.calls), 1)
        self.assertEqual(path.read_bytes(), b'[Service]\nReadWritePaths=/unknown\n')
        self.assertEqual((self.root / 'current').resolve(), Path(self.new['directory']))
        self.assertTrue(json.loads((state / 'manual-recovery-required.json').read_text())['servicesStopped'])

    def test_trial_existing_dropins_survive_execstart_replacement_and_rollback(self):
        plan = self.existing_dropin_plan(production=False)
        original = {path: data for inputs in plan['dropIns'].values() for path, data in inputs['files'].items()}
        with patch.object(m, 'command', side_effect=self.command):
            m.switch(plan, self.new['directory'])
            m.verify_units(plan, allow_candidate=True)
            m.switch(plan, self.old['directory'])
            m.verify_units(plan)
        self.assertTrue(all(Path(path).read_bytes() == data for path, data in original.items()))

    def test_running_rejects_service_write_access_to_dropin_directory(self):
        def prop(unit, name):
            return {'User': 'cisme-trial', 'ProtectSystem': 'strict',
                    'ReadWritePaths': str(self.units / (unit + '.d')), 'DropInPaths': ''}[name]
        with patch.object(m, 'property_value', side_effect=prop):
            with self.assertRaisesRegex(m.Refused, 'SERVICE_WRITE_ACCESS_REFUSED'):
                m.running(self.profile, self.old['directory'], {})

    def test_effective_execstart_ignores_only_dynamic_systemd_execution_fields(self):
        plan = self.production_plan()
        def prop(unit, name):
            if name == 'ExecStart':
                entry = 'index.js' if unit == plan['profile']['units'][0] else 'worker.js'
                return ('{ path=' + m.NODE + ' ; argv[]=' + m.NODE + ' ' + entry +
                        ' ; ignore_errors=no ; start_time=[Tue 2026-10-13 12:00:00 UTC] ; '
                        'stop_time=[Tue 2026-10-13 12:00:45 UTC] ; pid=53216 ; code=exited ; status=0 }')
            return self.property(unit, name)
        with patch.object(m, 'property_value', side_effect=prop):
            m.verify_units(plan)
            with patch.object(m, 'property_value', side_effect=lambda unit, name:
                              prop(unit, name).replace('ignore_errors=no', 'ignore_errors=yes') if name == 'ExecStart'
                              else prop(unit, name)):
                with self.assertRaisesRegex(m.Refused, 'EFFECTIVE_EXECSTART_REQUIRED'):
                    m.verify_units(plan)

    def test_production_health_failure_restores_symlink_only_and_keeps_new_data(self):
        plan = self.production_plan()
        fact = self.root / 'new-production-fact'
        def health(plan, directory, started, patched):
            if patched:
                fact.write_text('synthetic new fact; retain on rollback')
                raise m.Refused('DEPENDENCY_ACTIVATION_FAILED')
            return plan['oldVersions']
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches(health):
                stack.enter_context(mocked)
            with self.assertRaisesRegex(m.Refused, 'APPLICATION_RESTORED'):
                m.cutover(plan, self.state(), 'synthetic-test-only')
        self.assertEqual((self.root / 'current').resolve(), Path(self.old['directory']))
        self.assertTrue(all((self.units / unit).read_bytes() == data for unit, data in plan['units'].items()))
        self.assertEqual(fact.read_text(), 'synthetic new fact; retain on rollback')
        self.assertFalse(any(args[:2] == ['systemctl', 'daemon-reload'] for args in self.calls))

    def test_partial_stop_failure_attempts_verified_old_application_recovery(self):
        plan = self.production_plan()
        failed = False
        def command(args, **kwargs):
            nonlocal failed
            self.command(args, **kwargs)
            if args[:2] == ['systemctl', 'stop'] and not failed:
                failed = True
                raise RuntimeError('synthetic stop returned nonzero after first unit stopped')
            return b''
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches():
                stack.enter_context(mocked)
            stack.enter_context(patch.object(m, 'command', side_effect=command))
            with self.assertRaisesRegex(m.Refused, 'APPLICATION_RESTORED'):
                m.cutover(plan, self.state(), 'synthetic-test-only')
        self.assertEqual((self.root / 'current').resolve(), Path(self.old['directory']))
        self.assertEqual(sum(args[:2] == ['systemctl', 'start'] for args in self.calls), 1)

    def test_failed_stop_cannot_claim_services_are_fenced(self):
        plan = self.production_plan()
        state = self.state()
        def command(args, **kwargs):
            self.command(args, **kwargs)
            if args[:2] == ['systemctl', 'stop']:
                raise RuntimeError('synthetic repeated stop error')
            return b''
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches():
                stack.enter_context(mocked)
            stack.enter_context(patch.object(m, 'command', side_effect=command))
            with self.assertRaisesRegex(m.Refused, 'FENCED_REVIEW_REQUIRED'):
                m.cutover(plan, state, 'synthetic-test-only')
        self.assertFalse(json.loads((state / 'manual-recovery-required.json').read_text())['servicesStopped'])
        self.assertFalse(any(args[:2] == ['systemctl', 'start'] for args in self.calls))

    def test_production_unknown_base_unit_after_stop_fences_before_any_start(self):
        plan = self.production_plan()
        unit = self.units / plan['profile']['units'][0]
        def command(args, **kwargs):
            if args[:2] == ['systemctl', 'stop']:
                unit.write_bytes(b'[Service]\nExecStart=/unknown/operator-change\n')
            return self.command(args, **kwargs)
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches():
                stack.enter_context(mocked)
            stack.enter_context(patch.object(m, 'command', side_effect=command))
            with self.assertRaisesRegex(m.Refused, 'FENCED_REVIEW_REQUIRED'):
                m.cutover(plan, self.state(), 'synthetic-test-only')
        self.assertFalse(any(args[:2] == ['systemctl', 'start'] for args in self.calls))
        self.assertEqual((self.root / 'current').resolve(), Path(self.old['directory']))
        self.assertEqual(unit.read_bytes(), b'[Service]\nExecStart=/unknown/operator-change\n')

    def test_production_effective_dropin_or_definition_drift_fences_before_start(self):
        for name, value in (('DropInPaths', '/etc/systemd/system/cisme-api.service.d/unknown.conf'),
                            ('ReadWritePaths', '/opt/cisme'), ('NeedDaemonReload', 'yes'),
                            ('ExecStart', '{ path=/bin/false ; argv[]=/bin/false ; ignore_errors=no ; }')):
            with self.subTest(property=name):
                self.calls.clear()
                plan = self.production_plan()
                halted = False
                def command(args, **kwargs):
                    nonlocal halted
                    if args[:2] == ['systemctl', 'stop']:
                        halted = True
                    return self.command(args, **kwargs)
                def prop(unit, key):
                    return value if halted and key == name else self.property(unit, key)
                with contextlib.ExitStack() as stack:
                    for mocked in self.cutover_patches():
                        stack.enter_context(mocked)
                    stack.enter_context(patch.object(m, 'command', side_effect=command))
                    stack.enter_context(patch.object(m, 'property_value', side_effect=prop))
                    with self.assertRaisesRegex(m.Refused, 'FENCED_REVIEW_REQUIRED'):
                        m.cutover(plan, self.state(), 'synthetic-test-only')
                self.assertFalse(any(args[:2] == ['systemctl', 'start'] for args in self.calls))

    def test_production_unit_drift_on_health_failure_never_starts_unknown_fallback(self):
        plan = self.production_plan()
        unit = self.units / plan['profile']['units'][0]
        def health(*args):
            unit.write_bytes(b'[Service]\nExecStart=/unknown/operator-change\n')
            raise m.Refused('DEPENDENCY_ACTIVATION_FAILED')
        with contextlib.ExitStack() as stack:
            for mocked in self.cutover_patches(health):
                stack.enter_context(mocked)
            with self.assertRaisesRegex(m.Refused, 'FENCED_REVIEW_REQUIRED'):
                m.cutover(plan, self.state(), 'synthetic-test-only')
        self.assertEqual(sum(args[:2] == ['systemctl', 'start'] for args in self.calls), 1)
        self.assertEqual((self.root / 'current').resolve(), Path(self.new['directory']))

    def test_unknown_active_record_fences_before_rollback_switch_and_start_in_both_profiles(self):
        for environment in ('trial', 'production'):
            with self.subTest(environment=environment):
                plan = self.plan if environment == 'trial' else self.production_plan()
                self.calls.clear()
                active = self.root / 'dependency-active-release.json'
                def health(*args):
                    active.write_bytes(b'{"unknown":"operator-change"}')
                    active.chmod(0o600)
                    raise m.Refused('DEPENDENCY_ACTIVATION_FAILED')
                with contextlib.ExitStack() as stack:
                    for mocked in self.cutover_patches(health):
                        stack.enter_context(mocked)
                    with self.assertRaisesRegex(m.Refused, 'FENCED_REVIEW_REQUIRED'):
                        m.cutover(plan, self.state(), 'synthetic-test-only')
                self.assertEqual(sum(args[:2] == ['systemctl', 'start'] for args in self.calls), 1)
                self.assertEqual(active.read_bytes(), b'{"unknown":"operator-change"}')
                if environment == 'production':
                    self.assertEqual((self.root / 'current').resolve(), Path(self.new['directory']))
                else:
                    self.assertEqual(m.unit_entry((self.units / plan['profile']['units'][0]).read_bytes(),
                                                   'index.js', self.profile), Path(self.new['directory']))
                active.unlink()

    def test_environment_requires_original_root_group_0640_and_actual_service_readability(self):
        path = self.root / 'runtime.env'
        with patch.object(m, 'command', side_effect=self.command):
            self.assertEqual(m.environment_metadata(self.profile), self.plan['environmentMetadata'])
        path.chmod(0o644)
        with self.assertRaisesRegex(m.Refused, 'ENV_PERMISSION_REQUIRED'):
            m.environment_metadata(self.profile)
        path.chmod(0o640)
        with patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_gid=os.getgid() + 1)):
            with self.assertRaisesRegex(m.Refused, 'ENV_PERMISSION_REQUIRED'):
                m.environment_metadata(self.profile)
        with patch.object(m, 'command', side_effect=RuntimeError('private test-r stderr')):
            with self.assertRaises(RuntimeError):
                m.environment_metadata(self.profile)

    def test_private_file_binding_uses_its_own_profile_service_uid(self):
        # Temporarily disable only the setUp mock so the real binding adapter runs.
        self.patches[2].stop()
        for profile, uid in ((self.profile, 996), ({**self.profile, 'name': 'production', 'user': 'cisme'}, 1000)):
            with self.subTest(profile=profile['name']), \
                    patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=uid)), \
                    patch.object(m.general, 'private_file', return_value=(b'synthetic bytes',
                                                                          {'path': '/private/synthetic', 'sha256': 'private'})) as private_file, \
                    patch.object(m, 'command', side_effect=self.command):
                result = m.private_inputs(profile, {'COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE': '/private/synthetic'})
                self.assertEqual(private_file.call_args.args, ('/private/synthetic', uid))
                self.assertEqual(result[0]['key'], 'COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE')
                self.assertEqual(self.calls[-1][2], profile['user'])
        self.patches[2].start()

    def test_actual_process_binding_rejects_foreign_release_and_inherited_open_flags(self):
        proc_root = self.root / 'proc'
        proc_root.mkdir()
        executable = self.root / 'synthetic-node'
        executable.write_bytes(b'not executed')
        config = {'ALLOW_DEV_ADAPTERS': 'false'}
        for pid, entry in (('100', 'index.js'), ('101', 'worker.js')):
            proc = proc_root / pid
            proc.mkdir()
            (proc / 'cwd').symlink_to(self.root)
            (proc / 'exe').symlink_to(executable)
            (proc / 'cmdline').write_bytes((str(executable) + '\0' + self.old['directory'] + '/' + entry + '\0').encode())
            (proc / 'environ').write_bytes(b'ALLOW_DEV_ADAPTERS=false\0')
        def prop(unit, name):
            return {'User': 'cisme-trial', 'ProtectSystem': 'strict', 'ReadWritePaths': str(self.root / 'tmp'),
                    'ActiveState': 'active', 'MainPID': '100' if unit == self.profile['units'][0] else '101'}.get(name, '')
        with patch.object(m, 'NODE', str(executable)), \
                patch.object(m, 'Path', side_effect=lambda value: proc_root if value == '/proc' else Path(value)), \
                patch.object(m, 'property_value', side_effect=prop):
            self.assertEqual(len(m.running(self.profile, self.old['directory'], config)), 2)
            env = proc_root / '100/environ'
            for key in (*m.CLOSED_FLAGS, *m.PREPARATION_FLAGS, 'ALLOW_DEV_ADAPTERS'):
                env.write_bytes((('ALLOW_DEV_ADAPTERS=false\0' if key != 'ALLOW_DEV_ADAPTERS' else '') + key + '=true\0').encode())
                with self.assertRaisesRegex(m.Refused, 'RUNNING_ENV_DRIFT'):
                    m.running(self.profile, self.old['directory'], config)
                if key in m.PREPARATION_FLAGS:
                    with self.assertRaisesRegex(m.Refused, 'RUNNING_ENV_DRIFT'):
                        m.running(self.profile, self.old['directory'], {**config, key: 'true'})
            env.write_bytes(b'ALLOW_DEV_ADAPTERS=false\0')
            args = proc_root / '100/cmdline'
            args.write_bytes((str(executable) + '\0' + self.new['directory'] + '/index.js\0').encode())
            with self.assertRaisesRegex(m.Refused, 'PROCESS_BINDING_REQUIRED'):
                m.running(self.profile, self.old['directory'], config)
            args.write_bytes((str(executable) + '\0' + self.old['directory'] + '/index.js\0').encode())
            production = {**m.PROFILES['production'], 'name': 'production', 'root': str(self.root)}
            prepared = {**config, **{key: 'true' for key in m.PREPARATION_FLAGS}}
            environment = '\0'.join(key + '=' + value for key, value in prepared.items()).encode() + b'\0'
            for pid in ('100', '101'):
                cwd = proc_root / pid / 'cwd'
                cwd.unlink()
                cwd.symlink_to(self.old['directory'])
                (proc_root / pid / 'environ').write_bytes(environment)
            def production_prop(unit, name):
                return {'User': 'cisme', 'ProtectSystem': 'strict', 'ReadWritePaths': str(self.root / 'tmp'),
                        'ActiveState': 'active', 'MainPID': '100' if unit == production['units'][0] else '101'}.get(name, '')
            with patch.object(m, 'property_value', side_effect=production_prop):
                self.assertEqual(len(m.running(production, self.old['directory'], prepared)), 2)
                for key in m.PREPARATION_FLAGS:
                    env.write_bytes(environment.replace((key + '=true').encode(), (key + '=false').encode()))
                    with self.assertRaisesRegex(m.Refused, 'RUNNING_ENV_DRIFT'):
                        m.running(production, self.old['directory'], prepared)
                    env.write_bytes(environment)
                    with self.assertRaisesRegex(m.Refused, 'RUNNING_ENV_DRIFT'):
                        m.running(production, self.old['directory'], config)

    def test_production_preflight_preserves_preparation_flags_and_binds_them_without_admitting_orders(self):
        production = self.production_plan()['profile']
        env = (self.env.replace(b'APP_ENV=staging', b'APP_ENV=production')
               .replace(b'cisme_trial', b'cisme') +
               b'COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED=true\nCOMMERCE_FULFILLMENT_ENABLED=true\n')
        path = self.root / 'runtime.env'
        path.write_bytes(env)
        with patch.dict(m.PROFILES, {'production': production}), patch.object(m.os, 'geteuid', return_value=0), \
                patch.object(m.general.observe, 'identity', return_value={'instanceId': 'lhins-61ikz4mi'}), \
                patch.object(m, 'owned_directory'), patch.object(m, 'artifact', side_effect=lambda directory, root:
                    self.old if str(directory) == self.old['directory'] else self.new), \
                patch.object(m.general, 'reviewed_main', return_value=self.main), patch.object(m, 'permit'), \
                patch.object(m, 'database_facts', return_value=self.facts), patch.object(m.general.observe, 'runtime'), \
                patch.object(m, 'running', return_value=self.plan['pids']), \
                patch.object(m, 'native_smoke', return_value=self.plan['versions']), patch.object(m, 'command'):
            plan = m.preflight('production', self.new['directory'])
            self.assertEqual(plan['env'], env)
            self.assertTrue(all(plan['config'][key] == 'true' for key in m.PREPARATION_FLAGS))
            m.verify_context(plan)
            for key in m.PREPARATION_FLAGS:
                path.write_bytes(env.replace((key + '=true').encode(), (key + '=false').encode()))
                with self.assertRaisesRegex(m.Refused, 'ENV_OR_SECRET_DRIFT'):
                    m.verify_context(plan)
                path.write_bytes(env)
            path.write_bytes(env.replace(b'COMMERCE_ORDER_FLOW_ENABLED=false', b'COMMERCE_ORDER_FLOW_ENABLED=true'))
            with self.assertRaisesRegex(m.Refused, 'CLOSED_CONTEXT_REQUIRED'):
                m.preflight('production', self.new['directory'])

    def test_trial_preflight_refuses_each_production_preparation_flag(self):
        with patch.dict(m.PROFILES, {'trial': self.profile}), patch.object(m.os, 'geteuid', return_value=0), \
                patch.object(m.general.observe, 'identity', return_value={'instanceId': 'lhins-61ikz4mi'}), \
                patch.object(m, 'owned_directory'), patch.object(m, 'command'):
            for key in m.PREPARATION_FLAGS:
                (self.root / 'runtime.env').write_bytes(self.env + (key + '=true\n').encode())
                with self.assertRaisesRegex(m.Refused, 'CLOSED_CONTEXT_REQUIRED'):
                    m.preflight('trial', self.new['directory'])

    def test_context_rejects_env_secret_initial_history_and_effective_unit_drift(self):
        patches = [patch.object(m, 'command', side_effect=self.command),
                   patch.object(m.general.observe, 'identity'),
                   patch.object(m.general, 'reviewed_main', return_value=self.main),
                   patch.object(m, 'artifact', side_effect=lambda directory, root:
                                self.old if directory == self.old['directory'] else self.new)]
        with contextlib.ExitStack() as stack:
            for mocked in patches:
                stack.enter_context(mocked)
            m.verify_context(self.plan)
            env = self.root / 'runtime.env'
            env.write_bytes(self.env + b'NEW_UNKNOWN_SETTING=true\n')
            with self.assertRaisesRegex(m.Refused, 'ENV_OR_SECRET_DRIFT'):
                m.verify_context(self.plan)
            env.write_bytes(self.env)
            with patch.object(m, 'private_inputs', return_value=[{'path': 'private', 'sha256': 'private'}]):
                with self.assertRaisesRegex(m.Refused, 'ENV_OR_SECRET_DRIFT'):
                    m.verify_context(self.plan)
            initial = self.root / 'migration-complete.json'
            initial.write_bytes(b'{"fakeReinitialization":true}')
            with self.assertRaisesRegex(m.Refused, 'INITIAL_MIGRATION_DRIFT'):
                m.verify_context(self.plan)
            initial.write_bytes(self.initial['migration-complete.json'])
            def prop(unit, name):
                return '/unknown/write-path' if name == 'ReadWritePaths' else self.property(unit, name)
            with patch.object(m, 'property_value', side_effect=prop):
                with self.assertRaisesRegex(m.Refused, 'EFFECTIVE_UNIT_DRIFT'):
                    m.verify_context(self.plan)

    def test_heartbeat_must_be_fresh_after_activation_private_regular_and_owned(self):
        (self.root / 'tmp').mkdir()
        heartbeat = self.root / 'tmp/cisme-worker-heartbeat.json'
        now = 1791880000.0
        def beat(at):
            heartbeat.write_text(json.dumps({'completedAtUtc': datetime.fromtimestamp(at, timezone.utc).isoformat()}))
            heartbeat.chmod(0o600)
        with patch.object(m, 'running'), patch.object(m, 'command', return_value=b'200'), \
                patch.object(m, 'native_smoke', return_value=self.plan['versions']), \
                patch.object(m.time, 'time', return_value=now), patch.object(m.time, 'sleep'):
            beat(now - 1)
            self.assertEqual(m.healthy(self.plan, self.new['directory'], now - 2, True), self.plan['versions'])
            for at in (now - 3, now + 1, now - 121):
                beat(at)
                with self.assertRaisesRegex(m.Refused, 'ACTIVATION_FAILED'):
                    m.healthy(self.plan, self.new['directory'], now - 2, True)
            beat(now - 1)
            heartbeat.chmod(0o644)
            with self.assertRaises(m.Refused):
                m.healthy(self.plan, self.new['directory'], now - 2, True)
            heartbeat.chmod(0o600)
            with patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid() + 1)):
                with self.assertRaises(m.Refused):
                    m.healthy(self.plan, self.new['directory'], now - 2, True)
            heartbeat.unlink()
            heartbeat.symlink_to(self.root / 'runtime.env')
            with self.assertRaises(m.Refused):
                m.healthy(self.plan, self.new['directory'], now - 2, True)

    def test_latest_exact_main_ci_is_required_not_an_older_green_run(self):
        base = {'head_sha': self.main['sha'], 'head_branch': 'main', 'event': 'push',
                'path': '.github/workflows/ci.yml', 'repository': {'full_name': m.general.REPO}, 'status': 'completed'}
        def fetch(path):
            if path == 'git/ref/heads/main':
                return {'object': {'sha': self.main['sha']}}
            if path.startswith('git/commits/'):
                return {'sha': self.main['sha'], 'tree': {'sha': self.main['tree']}}
            return {'workflow_runs': [{**base, 'id': 1, 'conclusion': 'success'}, {**base, 'id': 2, 'conclusion': 'failure'}]}
        with self.assertRaisesRegex(m.general.observe.target.Refused, 'LATEST_MAIN_CI_NOT_SUCCESSFUL'):
            m.general.reviewed_main(fetch)

    def test_preflight_has_no_writes_or_service_commands_and_refuses_wrong_trial_database(self):
        with patch.dict(m.PROFILES, {'trial': self.profile}), patch.object(m.os, 'geteuid', return_value=0), \
                patch.object(m.general.observe, 'identity', return_value={'instanceId': 'lhins-61ikz4mi'}), \
                patch.object(m, 'owned_directory'), patch.object(m, 'artifact', side_effect=[self.old, self.new]), \
                patch.object(m.general, 'reviewed_main', return_value=self.main), patch.object(m, 'permit'), \
                patch.object(m, 'database_facts', return_value=self.facts), patch.object(m.trial, 'db_owned'), \
                patch.object(m, 'running', return_value=self.plan['pids']), patch.object(m, 'native_smoke', return_value=self.plan['versions']), \
                patch.object(m, 'command') as command, patch.object(m.general, 'store') as store:
            m.preflight('trial', self.new['directory'])
            self.assertEqual(command.call_args.args[0], ['/usr/sbin/runuser', '-u', 'cisme-trial', '--',
                                                        '/usr/bin/test', '-r', str(self.root / 'runtime.env')])
            store.assert_not_called()
        (self.root / 'runtime.env').write_bytes(self.env.replace(b'postgresql://cisme_trial:', b'postgresql://cisme:'))
        with patch.dict(m.PROFILES, {'trial': self.profile}), patch.object(m.os, 'geteuid', return_value=0), \
                patch.object(m.general.observe, 'identity', return_value={'instanceId': 'lhins-61ikz4mi'}), \
                patch.object(m, 'owned_directory'), patch.object(m, 'command'):
            with self.assertRaisesRegex(m.Refused, 'DATABASE_CONTEXT_REQUIRED'):
                m.preflight('trial', self.new['directory'])

    def test_raw_error_and_private_environment_never_reach_stdout(self):
        with patch('sys.argv', ['upgrade', '--environment', 'trial', '--release', self.new['directory']]), \
                patch.object(m, 'preflight', side_effect=RuntimeError('https://private.invalid/?key=synthetic-secret')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {'ok': False, 'code': 'DEPENDENCY_UPGRADE_REVIEW_REQUIRED'})
        self.assertNotIn('synthetic-secret', output.getvalue())


if __name__ == '__main__':
    unittest.main()
