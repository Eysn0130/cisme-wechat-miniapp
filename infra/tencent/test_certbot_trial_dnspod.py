"""Offline ACME hook scope/ownership tests. No DNS, SDK or credentials used."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('certbot_trial', Path(__file__).with_name('certbot-trial-dnspod.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
VALIDATION = 'A' * 43
DIGEST = hashlib.sha256(VALIDATION.encode()).hexdigest()


class Request:
    def from_json_string(self, value):
        self.value = json.loads(value)


class TrialDnsHookGuards(unittest.TestCase):
    def fixture(self, root, client):
        stack = contextlib.ExitStack()
        stack.enter_context(patch.dict(os.environ, {'CERTBOT_DOMAIN': m.CERTIFICATE_DOMAIN,
                                                   'CERTBOT_VALIDATION': VALIDATION}))
        stack.enter_context(patch.object(m.os, 'geteuid', return_value=0))
        stack.enter_context(patch.object(m, 'STATE_DIR', root))
        stack.enter_context(patch.object(m, 'ensure_state_directory', return_value=True))
        stack.enter_context(patch.object(m, 'protected_bytes', side_effect=lambda path, *args: Path(path).read_bytes()))
        actual_fstat = os.fstat
        stack.enter_context(patch.object(m.os, 'fstat', side_effect=lambda fd: SimpleNamespace(
            st_uid=0, st_mode=actual_fstat(fd).st_mode, st_size=actual_fstat(fd).st_size)))
        stack.enter_context(patch.object(m, 'cloud_client', return_value=(client, SimpleNamespace(
            CreateRecordRequest=Request, DeleteRecordRequest=Request))))
        stack.enter_context(patch.object(m, 'propagated', return_value=True))
        return stack

    def test_wrong_domain_or_validation_is_refused_before_credentials(self):
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m, 'cloud_client') as client:
            for domain in ('api.cisme.cn', 'cisme.cn', '*.staging-api.cisme.cn', 'other.example'):
                with patch.dict(os.environ, {'CERTBOT_DOMAIN': domain, 'CERTBOT_VALIDATION': VALIDATION}), \
                     self.assertRaisesRegex(m.HookError, 'TRIAL_ACME_DOMAIN_REFUSED'):
                    m.run_hook('auth')
            for token in ('', 'x', 'x' * 43 + '\n', 'a/' * 22):
                with patch.dict(os.environ, {'CERTBOT_DOMAIN': m.CERTIFICATE_DOMAIN, 'CERTBOT_VALIDATION': token}), \
                     self.assertRaisesRegex(m.HookError, 'TRIAL_ACME_VALIDATION_INVALID'):
                    m.run_hook('auth')
            client.assert_not_called()

    def test_auth_is_idempotent_and_cleanup_only_deletes_stored_id(self):
        client = Mock()
        client.CreateRecord.return_value.RecordId = 12345
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.fixture(root, client):
                m.run_hook('auth')
                m.run_hook('auth')
                client.CreateRecord.assert_called_once()
                created = client.CreateRecord.call_args.args[0].value
                self.assertEqual(created, {'Domain': 'cisme.cn', 'DomainId': 99932402,
                                          'SubDomain': '_acme-challenge.staging-api', 'RecordType': 'TXT',
                                          'RecordLine': '默认', 'Value': VALIDATION, 'TTL': 600})
                state = root / (DIGEST + '.json')
                self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o600)
                self.assertNotIn(VALIDATION, state.read_text())
                m.run_hook('cleanup')
                client.DeleteRecord.assert_called_once()
                self.assertEqual(client.DeleteRecord.call_args.args[0].value,
                                 {'Domain': 'cisme.cn', 'DomainId': 99932402, 'RecordId': 12345})
                self.assertFalse(state.exists())

    def test_cleanup_without_state_never_loads_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            client = Mock()
            with self.fixture(Path(temporary), client), patch.object(m, 'cloud_client') as credentials:
                m.run_hook('cleanup')
                credentials.assert_not_called()

    def test_foreign_or_tampered_state_never_deletes(self):
        client = Mock()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.fixture(root, client):
                state = root / (DIGEST + '.json')
                m.write_created_state(state, DIGEST, 123)
                original = json.loads(state.read_text())
                for key, value in [('certificateDomain', 'api.cisme.cn'), ('subdomain', '_acme-challenge.api'),
                                   ('domainId', 1), ('validationSha256', 'f' * 64), ('recordId', True), ('recordId', -1)]:
                    state.write_text(json.dumps(original | {key: value}))
                    with self.subTest(key=key), self.assertRaisesRegex(m.HookError, 'TRIAL_ACME_STATE_BINDING_REQUIRED'):
                        m.run_hook('cleanup')
                client.DeleteRecord.assert_not_called()

    def test_delete_failure_keeps_state_for_exact_id_retry(self):
        client = Mock()
        client.DeleteRecord.side_effect = RuntimeError('SYNTHETIC private SDK details')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.fixture(root, client):
                state = root / (DIGEST + '.json')
                m.write_created_state(state, DIGEST, 100)
                with self.assertRaises(RuntimeError):
                    m.run_hook('cleanup')
                self.assertTrue(state.exists())
                self.assertEqual(json.loads(state.read_text())['recordId'], 100)

    def test_propagation_timeout_cleans_only_own_persisted_id(self):
        client = Mock()
        client.CreateRecord.return_value.RecordId = 456
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.fixture(root, client), patch.object(m, 'propagated', return_value=False), \
                 patch.object(m, 'POLL_ATTEMPTS', 1):
                with self.assertRaisesRegex(m.HookError, 'TRIAL_ACME_DNS_PROPAGATION_TIMEOUT'):
                    m.run_hook('auth')
                self.assertEqual(client.DeleteRecord.call_args.args[0].value['RecordId'], 456)
                self.assertFalse((root / (DIGEST + '.json')).exists())

    def test_root_only_file_modes_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, 'root_parents'):
            path = Path(temporary) / 'state.json'
            path.write_text('{}')
            path.chmod(0o644)
            actual_fstat = os.fstat
            with patch.object(m.os, 'fstat', side_effect=lambda fd: SimpleNamespace(
                    st_uid=0, st_mode=actual_fstat(fd).st_mode, st_size=actual_fstat(fd).st_size)):
                with self.assertRaisesRegex(m.HookError, 'TRIAL_ACME_FILE_UNSAFE'):
                    m.protected_bytes(path)
                path.chmod(0o600)
                self.assertEqual(m.protected_bytes(path), b'{}')
                linked = Path(temporary) / 'link'
                linked.symlink_to(path)
                with self.assertRaises(OSError):
                    m.protected_bytes(linked)

    def test_sdk_failures_do_not_print_credentials_or_token(self):
        private = 'SYNTHETIC_SECRET_PRIVATE_ERROR ' + VALIDATION
        error = RuntimeError(private)
        error.get_code = lambda: 'UnauthorizedOperation'
        stderr = io.StringIO()
        with patch.object(m.sys, 'argv', ['hook', 'auth']), patch.object(m, 'run_hook', side_effect=error), \
             contextlib.redirect_stderr(stderr):
            self.assertEqual(m.main(), 1)
        self.assertEqual(stderr.getvalue().strip(), 'TRIAL_ACME_EXISTING_CREDENTIAL_PERMISSION_DENIED')
        self.assertNotIn(private, stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
