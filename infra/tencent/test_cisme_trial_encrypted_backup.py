import contextlib
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from cryptography.exceptions import InvalidTag

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('trial_backup', HERE / 'cisme-trial-encrypted-backup.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def item(at, number=0):
    return {'Key': m.PREFIX + f'cisme-trial-{at:%Y%m%dT%H%M%SZ}-{number:032x}.dump.aesgcm',
            'sha256': 'a' * 64, 'bytes': 1234}


class TrialBackupTests(unittest.TestCase):
    def config(self):
        config = {key: 'false' for key in ('COMMERCE_ORDER_FLOW_ENABLED', 'COMMERCE_SIMULATED_PAYMENT_ENABLED',
                  'COMMERCE_FULFILLMENT_ENABLED', 'POINTS_REDEMPTION_ENABLED', 'POINTS_RULES_ENABLED',
                  'UGC_GO_LIVE_GATE', 'COS_DIRECT_UPLOAD_ENABLED')}
        return {**config, 'DATABASE_URL': 'postgresql://cisme_trial:' + 'a' * 64 + '@127.0.0.1:5432/cisme_trial',
                'APP_ENV': 'staging', 'PRIVACY_SUPPRESSION_DIR': '/opt/cisme-trial/privacy-suppression',
                'OBJECT_STORAGE_DRIVER': 'api_gateway'}

    def test_database_target_and_environment_are_fixed(self):
        with patch.dict(os.environ, {'PGDATABASE': 'cisme', 'PGHOST': 'prod', 'PGOPTIONS': 'evil'}):
            env = m.pg_environment(self.config())
        self.assertEqual((env['PGDATABASE'], env['PGUSER'], env['PGHOST']), ('cisme_trial', 'cisme_trial', '127.0.0.1'))
        self.assertEqual(env['PGOPTIONS'], '-c default_transaction_read_only=on')
        for replacement in ('postgresql://cisme:' + 'a' * 64 + '@127.0.0.1:5432/cisme',
                            'postgresql://postgres:' + 'a' * 64 + '@127.0.0.1:5432/cisme_trial',
                            self.config()['DATABASE_URL'].replace('127.0.0.1', '124.223.74.198')):
            config = {**self.config(), 'DATABASE_URL': replacement}
            with self.assertRaisesRegex(m.Refused, 'TRIAL_BACKUP_RUNTIME_REQUIRED'):
                m.pg_environment(config)

    def test_production_object_and_suppression_paths_are_refused(self):
        for key, value in (('PRIVACY_SUPPRESSION_DIR', '/var/lib/cisme/privacy-suppression'),
                           ('OBJECT_STORAGE_DRIVER', 'cos_gateway'), ('APP_ENV', 'production'),
                           ('UGC_GO_LIVE_GATE', 'true')):
            with self.assertRaises(m.Refused):
                m.pg_environment({**self.config(), key: value})

    def test_database_role_cannot_have_production_target_or_privileges(self):
        facts = {'database': 'cisme_trial', 'role': 'cisme_trial', 'owner': 'cisme_trial',
                 'superuser': False, 'createdb': False, 'createrole': False, 'replication': False,
                 'bypassrls': False, 'memberships': 0}
        with patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(facts).encode())) as run:
            m.check_database(m.pg_environment(self.config()))
            self.assertNotIn('runuser', run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs['env']['PGDATABASE'], 'cisme_trial')
            for key, value in (('database', 'cisme'), ('owner', 'postgres'), ('role', 'postgres'),
                               ('superuser', True), ('memberships', 1)):
                run.return_value.stdout = json.dumps({**facts, key: value}).encode()
                with self.assertRaisesRegex(m.Refused, 'ISOLATION_REQUIRED'):
                    m.check_database(m.pg_environment(self.config()))

    def test_root_and_extra_group_refused_before_any_path_or_network_access(self):
        account = SimpleNamespace(pw_uid=996, pw_gid=987)
        for uid, groups in ((0, [987]), (996, [987, 999])):
            with patch.object(m.pwd, 'getpwnam', return_value=account), patch.object(m.os, 'geteuid', return_value=uid), \
                    patch.object(m.os, 'getegid', return_value=987), patch.object(m.os, 'getgroups', return_value=groups), \
                    patch.object(m, 'check_directory') as directory, patch.object(m, 'make_client') as client:
                with self.assertRaisesRegex(m.Refused, 'DEDICATED_IDENTITY_REQUIRED'):
                    m.preflight()
                directory.assert_not_called()
                client.assert_not_called()

    def test_preflight_calls_only_read_operations(self):
        account = SimpleNamespace(pw_uid=996, pw_gid=987)
        inputs = {m.KEY_FILE: b'k' * 32, m.RUNTIME: ''.join(f'{key}={value}\n' for key, value in self.config().items()).encode(),
                  m.COS_FILE: b'{"accessKeyId":"synthetic-only","secretAccessKey":"synthetic-only"}'}
        client = Mock()
        with patch.object(m.pwd, 'getpwnam', return_value=account), patch.object(m.os, 'geteuid', return_value=996), \
                patch.object(m.os, 'getegid', return_value=987), patch.object(m.os, 'getgroups', return_value=[987]), \
                patch.object(m, 'check_directory'), patch.object(m, 'protected_file', side_effect=lambda path, *args: inputs[path]), \
                patch.object(m, 'check_database'), patch.object(m, 'make_client', return_value=client), \
                patch.object(m, 'read_manifest', return_value=[]), patch.object(m, 'backup') as backup:
            self.assertEqual(m.preflight()[3], [])
            self.assertEqual(client.mock_calls, [])
            backup.assert_not_called()

    def test_round_trip_content_authentication_and_wrong_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'trial.aesgcm'
            plain = b'synthetic-only database archive\n' * 50000
            m.encrypt_stream(io.BytesIO(plain), b'k' * 32, path)
            output = io.BytesIO()
            m.decrypt_to_stream(path, b'k' * 32, output)
            self.assertEqual(output.getvalue(), plain)
            self.assertNotIn(plain[:128], path.read_bytes())
            for offset in (len(m.MAGIC) + 12, -1):
                original = path.read_bytes()
                changed = bytearray(original)
                changed[offset] ^= 1
                path.write_bytes(changed)
                with self.assertRaises(InvalidTag):
                    m.decrypt_to_stream(path, b'k' * 32, io.BytesIO())
                path.write_bytes(original)
            with self.assertRaises(InvalidTag):
                m.decrypt_to_stream(path, b'x' * 32, io.BytesIO())

    def test_production_magic_truncation_and_existing_destination_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive'
            for data in (b'CISMEBK1' + b'x' * 100, m.MAGIC + b'x' * 27):
                path.write_bytes(data)
                with self.assertRaises(m.Refused):
                    m.decrypt_to_stream(path, b'k' * 32, io.BytesIO())
            path.write_bytes(b'existing')
            with self.assertRaises(FileExistsError):
                m.encrypt_stream(io.BytesIO(b'synthetic'), b'k' * 32, path)
            self.assertEqual(path.read_bytes(), b'existing')

    def test_parser_early_exit_still_authenticates_the_entire_archive(self):
        real_popen = subprocess.Popen
        children = []
        def parser(*args, **kwargs):
            self.assertEqual(args[0], ['/usr/bin/pg_restore', '--list'])
            self.assertNotIn('PGPASSWORD', kwargs['env'])
            child = real_popen([sys.executable, '-c', 'import sys; sys.stdin.buffer.read(64)'], **kwargs)
            children.append(child)
            return child
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive'
            m.encrypt_stream(io.BytesIO(b'synthetic-only' * 300000), b'k' * 32, path)
            with patch.object(m.subprocess, 'Popen', side_effect=parser):
                m.verify_archive(path, b'k' * 32)
                data = bytearray(path.read_bytes())
                data[-1] ^= 1
                path.write_bytes(data)
                with self.assertRaises(InvalidTag):
                    m.verify_archive(path, b'k' * 32)
            self.assertEqual(len(children), 1, 'authentication failure must not start the PostgreSQL parser')
            self.assertTrue(all(child.poll() is not None for child in children))

    def test_real_dump_subprocess_success_creates_only_authenticated_ciphertext(self):
        real_popen = subprocess.Popen
        plain = b'synthetic-only postgres dump\n' * 50000
        children = []
        def dump(args, **kwargs):
            self.assertEqual(args, ['/usr/bin/pg_dump', '--format=custom', '--no-owner', '--no-acl'])
            self.assertEqual(kwargs['env']['PGDATABASE'], 'cisme_trial')
            child = real_popen([sys.executable, '-c',
                               "import sys; sys.stdout.buffer.write(b'synthetic-only postgres dump\\n' * 50000)"], **kwargs)
            self.assertIsNone(child.stdin)
            children.append(child)
            return child
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'encrypted'
            with patch.object(m.subprocess, 'Popen', side_effect=dump):
                m.encrypted_dump(b'k' * 32, m.pg_environment(self.config()), path)
            output = io.BytesIO()
            m.decrypt_to_stream(path, b'k' * 32, output)
            self.assertEqual(output.getvalue(), plain)
            self.assertEqual(list(Path(directory).iterdir()), [path])
            self.assertEqual(children[0].returncode, 0)

    def test_real_dump_subprocess_failure_removes_failed_local_archive(self):
        real_popen = subprocess.Popen
        children = []
        def dump(*args, **kwargs):
            child = real_popen([sys.executable, '-c',
                               "import sys; sys.stdout.buffer.write(b'synthetic failed dump'); sys.exit(13)"], **kwargs)
            children.append(child)
            return child
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'encrypted'
            with patch.object(m.subprocess, 'Popen', side_effect=dump):
                with self.assertRaisesRegex(m.Refused, 'TRIAL_BACKUP_DUMP_FAILED'):
                    m.encrypted_dump(b'k' * 32, m.pg_environment(self.config()), path)
            self.assertFalse(path.exists())
            self.assertEqual(children[0].returncode, 13)

    def test_remote_denial_never_becomes_first_use_and_leaks_no_sdk_error(self):
        class CosError(Exception):
            def __init__(self, status, code=None):
                super().__init__('secret response body https://example.invalid/?secret=synthetic')
                self.status = status
                self.code = code
            def get_status_code(self):
                return self.status
            def get_error_code(self):
                return self.code
        client = Mock()
        client.get_object.side_effect = CosError(403)
        with self.assertRaisesRegex(m.Refused, '^TRIAL_BACKUP_REMOTE_MANIFEST_READ_DENIED$'):
            m.read_manifest(client)
        for code in ('NoSuchBucket', None, 'UnknownError'):
            client.get_object.side_effect = CosError(404, code)
            with self.assertRaisesRegex(m.Refused, '^TRIAL_BACKUP_REMOTE_MANIFEST_READ_DENIED$'):
                m.read_manifest(client)
        client.get_object.side_effect = CosError(404, 'NoSuchKey')
        self.assertEqual(m.read_manifest(client), [])
        with patch.object(sys, 'argv', ['backup']), patch.object(m, 'preflight', side_effect=CosError(403)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {'ok': False, 'code': 'TRIAL_BACKUP_OPERATION_FAILED'})

    def test_retention_keeps_seven_and_thirty_days(self):
        now = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)
        rows = [item(now - timedelta(days=days), days) for days in range(40)]
        retained, removed = m.retention_plan(rows, now)
        self.assertEqual(len(retained), 31)
        self.assertEqual(len(removed), 9)
        old = [item(now - timedelta(days=60 + days), days) for days in range(9)]
        retained, removed = m.retention_plan(old, now)
        self.assertEqual((len(retained), len(removed)), (7, 2))

    def test_manifest_production_path_traversal_duplicates_and_future_refused(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        valid = item(now)
        for key in ('backups/postgres/cisme-20261013T120000Z-' + 'a' * 32 + '.dump.aesgcm',
                    m.PREFIX + '../cisme.dump.aesgcm', m.PREFIX + '/cisme-trial.dump.aesgcm'):
            with self.assertRaisesRegex(m.Refused, 'FOREIGN_OBJECT_REFUSED'):
                m.retention_plan([{**valid, 'Key': key}], now)
        with self.assertRaises(m.Refused):
            m.retention_plan([valid, valid], now)
        with self.assertRaisesRegex(m.Refused, 'FUTURE_DATE'):
            m.retention_plan([item(now + timedelta(seconds=1))], now)

    def test_systemd_identity_and_production_paths_are_isolated(self):
        unit = (HERE / 'cisme-trial-encrypted-backup.service').read_text()
        self.assertIn('User=cisme-trial\nGroup=cisme-trial', unit)
        self.assertIn('ReadWritePaths=/var/backups/cisme-trial-encrypted\n', unit)
        self.assertIn('InaccessiblePaths=/opt/cisme /etc/cisme /var/lib/cisme ', unit)
        self.assertIn('NoNewPrivileges=true', unit)
        self.assertNotIn('User=root', unit)
        timer = (HERE / 'cisme-trial-encrypted-backup.timer').read_text()
        self.assertIn('Unit=cisme-trial-encrypted-backup.service', timer)


if __name__ == '__main__':
    unittest.main()
