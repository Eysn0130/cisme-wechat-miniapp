"""Offline candidate-integrity regression tests. No DB, network, or real secrets.

Runs the real shipped migration entrypoint against disposable synthetic files.
The pg stub is only a tripwire: this suite does not test PostgreSQL migrations.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts' / 'release-migrate.mjs'


class ReleaseIntegrity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cisme-release-integrity-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.migrations = ['202601010001_first.sql', '202601010002_second.sql']
        (self.root / 'db/migrations').mkdir(parents=True)
        for name in self.migrations:
            (self.root / 'db/migrations' / name).write_text('SELECT 1;\n-- migrate:down\nSELECT 2;\n')
        for name in ['index.js', 'worker.js', 'worker-once.js']:
            (self.root / name).write_text('export const synthetic = true;\n')
        (self.root / 'package.json').write_text('{"type":"module"}\n')
        (self.root / 'package-lock.json').write_text('{"lockfileVersion":3}\n')
        shutil.copyfile(SCRIPT, self.root / 'migrate.mjs')
        files = ['index.js', 'worker.js', 'worker-once.js', 'package.json', 'package-lock.json', 'migrate.mjs']
        files += ['db/migrations/' + name for name in self.migrations]
        self.manifest = {'schemaVersion': 1, 'sourceHead': 'a' * 40, 'sourceTree': 'b' * 40,
                         'migrations': self.migrations.copy(),
                         'hashes': {name: self.digest(name) for name in files}}
        self.save()
        pg = self.root / 'node_modules/pg'
        pg.mkdir(parents=True)
        (pg / 'package.json').write_text('{"type":"module","main":"index.js"}')
        (pg / 'index.js').write_text(
            'import {writeFileSync} from "node:fs";\n'
            'writeFileSync("pg-imported", "stub");\n'
            'export default {Pool: class {constructor(){'
            'writeFileSync("pool-created","stub");throw Error("DB_TRIPWIRE");}}};\n')
        self.env = {**os.environ}
        for key in list(self.env):
            if key.startswith(('DATABASE_', 'PG', 'CISME_')):
                self.env.pop(key)

    def digest(self, name):
        return hashlib.sha256((self.root / name).read_bytes()).hexdigest()

    def save(self):
        (self.root / 'release-manifest.json').write_text(json.dumps(self.manifest))

    def call(self, action='verify'):
        return subprocess.run(['node', str(self.root / 'migrate.mjs'), action],
                              cwd=self.root, env=self.env, text=True,
                              capture_output=True, timeout=10)

    def rejected(self, action='verify'):
        result = self.call(action)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stdout, '')
        self.assertRegex(result.stderr.strip(), r'^[A-Z_]+$')
        self.assertFalse((self.root / 'pool-created').exists())
        return result

    def test_valid_candidate_is_verified_without_applying(self):
        result = self.call()
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertTrue(value['verified'])
        self.assertFalse(value['applied'])
        self.assertEqual(value['sourceHead'], 'a' * 40)
        self.assertEqual(value['migrations'], 2)
        self.assertFalse((self.root / 'pool-created').exists())

    def test_verify_does_not_import_database_driver(self):
        self.assertEqual(self.call().returncode, 0)
        self.assertFalse((self.root / 'pg-imported').exists())

    def test_verify_works_before_dependency_installation(self):
        shutil.rmtree(self.root / 'node_modules')
        result = self.call()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_tampered_runtime_and_lock_files_are_refused(self):
        for name in ['index.js', 'worker.js', 'worker-once.js', 'package.json', 'package-lock.json']:
            with self.subTest(name=name):
                original = (self.root / name).read_bytes()
                (self.root / name).write_bytes(original + b'\n')
                self.rejected()
                (self.root / name).write_bytes(original)

    def test_missing_runtime_file_is_refused(self):
        (self.root / 'worker-once.js').unlink()
        self.rejected()

    def test_tampered_migration_is_refused(self):
        (self.root / 'db/migrations' / self.migrations[0]).write_text('SELECT 9;')
        self.rejected()

    def test_up_rejects_tampering_before_pg_import(self):
        self.env.update(DATABASE_URL='postgres://synthetic@127.0.0.1/synthetic',
                        CISME_MIGRATION_APPROVAL_REF='synthetic-test-approval',
                        CISME_PREDEPLOY_BACKUP_REF='synthetic-test-backup')
        (self.root / 'index.js').write_text('altered artifact')
        self.rejected('up')
        self.assertFalse((self.root / 'pg-imported').exists())

    def test_up_still_requires_both_operator_references(self):
        self.env['DATABASE_URL'] = 'postgres://synthetic@127.0.0.1/synthetic'
        for key in [None, 'CISME_MIGRATION_APPROVAL_REF', 'CISME_PREDEPLOY_BACKUP_REF']:
            with self.subTest(key=key):
                if key:
                    self.env[key] = 'synthetic-reference'
                result = self.rejected('up')
                self.assertIn('EXPLICIT_TARGET_UP_APPROVAL_AND_BACKUP_REFERENCES_REQUIRED', result.stderr)
                if key:
                    del self.env[key]

    def test_duplicate_migrations_are_refused(self):
        self.manifest['migrations'].append(self.migrations[0])
        self.save()
        self.rejected()

    def test_unsorted_migrations_are_refused(self):
        self.manifest['migrations'].reverse()
        self.save()
        self.rejected()

    def test_unlisted_sql_file_is_refused(self):
        (self.root / 'db/migrations/202601010003_hidden.sql').write_text('SELECT 3;')
        self.rejected()

    def test_invalid_source_binding_is_refused(self):
        for key in ['sourceHead', 'sourceTree']:
            for value in [None, '', 'abc123', 'z' * 40, '0' * 40, True, ['a' * 40], {}]:
                with self.subTest(key=key, value=value):
                    old = self.manifest[key]
                    self.manifest[key] = value
                    self.save()
                    self.rejected()
                    self.manifest[key] = old
        self.save()

    def test_hashes_must_cover_exact_candidate_members(self):
        for name in ['../outside', '/etc/passwd', 'runtime.env', 'extra.js']:
            with self.subTest(name=name):
                self.manifest['hashes'][name] = 'c' * 64
                self.save()
                self.rejected()
                del self.manifest['hashes'][name]
        del self.manifest['hashes']['index.js']
        self.save()
        self.rejected()

    def test_hash_container_and_digest_types_are_checked(self):
        good = self.manifest['hashes']
        for invalid in [None, [], {}, 'bad']:
            with self.subTest(value=invalid):
                self.manifest['hashes'] = invalid
                self.save()
                self.rejected()
        self.manifest['hashes'] = good
        self.manifest['hashes']['index.js'] = True
        self.save()
        self.rejected()

    def test_runtime_symlink_even_to_matching_bytes_is_refused(self):
        source = self.root / 'same-bytes'
        source.write_bytes((self.root / 'index.js').read_bytes())
        (self.root / 'index.js').unlink()
        (self.root / 'index.js').symlink_to(source)
        self.rejected()

    def test_migration_directory_symlink_is_refused(self):
        (self.root / 'db/migrations').rename(self.root / 'real-migrations')
        (self.root / 'db/migrations').symlink_to(self.root / 'real-migrations')
        self.rejected()

    def test_malformed_json_errors_are_sanitized(self):
        (self.root / 'release-manifest.json').write_text('{"do-not-echo-this":')
        result = self.rejected()
        self.assertNotIn('do-not-echo-this', result.stderr)
        self.assertNotIn(str(self.root), result.stderr)

    def test_empty_migration_list_is_refused(self):
        self.manifest['migrations'] = []
        self.save()
        self.rejected()

    def test_non_utf8_migration_is_refused_even_with_matching_hash(self):
        name = 'db/migrations/' + self.migrations[0]
        (self.root / name).write_bytes(b'SELECT 1;\xff')
        self.manifest['hashes'][name] = self.digest(name)
        self.save()
        self.rejected()

    def test_migration_path_is_validated_before_reading(self):
        self.manifest['migrations'] = ['../do-not-read.sql']
        self.save()
        self.rejected()


if __name__ == '__main__':
    unittest.main()
