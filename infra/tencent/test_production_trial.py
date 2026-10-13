"""Offline trial deployment guards. No host, database, credentials or network."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('production_trial', Path(__file__).with_name('production-trial.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class TrialGuards(unittest.TestCase):
    def setUp(self):
        self.wechat = {'WECHAT_APP_ID': 'wx4eac2d4fb11d299b', 'WECHAT_APP_SECRET': 'SYNTHETIC_APP_SECRET_ONLY'}
        self.source = {'release': '/opt/cisme/releases/SYNTHETIC', 'sourceHead': m.SOURCE_HEAD,
                       'sourceTree': m.SOURCE_TREE, 'manifestSha256': 'a' * 64, 'dependenciesSha256': 'b' * 64}

    def test_source_is_the_actual_deployed_git_tree(self):
        # Fixed identity from the already reviewed main merge, not a fabricated SHA.
        self.assertEqual(m.SOURCE_HEAD, '751f7407af4e525c5b6c09c6997800acfb4048fc')
        self.assertEqual(m.SOURCE_TREE, 'd23e42b55843000ac5e97af108f404e7a12e92e8')

    def test_config_only_reuses_wechat_and_generates_independent_secrets(self):
        config = m.candidate_config(self.wechat)
        m.validate_config(config, self.wechat)
        self.assertTrue(all(config[key] != self.wechat['WECHAT_APP_SECRET'] for key in m.SECRET_KEYS))
        self.assertEqual(len({config[key] for key in m.SECRET_KEYS}), len(m.SECRET_KEYS))
        self.assertEqual(config['APP_ENV'], 'staging')
        self.assertEqual(config['ALLOW_DEV_ADAPTERS'], 'false')
        self.assertNotIn('S3_SECRET_ACCESS_KEY', config)
        self.assertNotIn('COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE', config)
        self.assertNotIn('DEV_CLOCK', config)
        self.assertEqual(config['PRIVACY_SUPPRESSION_DIR'], '/opt/cisme-trial/privacy-suppression')

    def test_production_database_money_grants_and_open_capabilities_are_refused(self):
        config = m.candidate_config(self.wechat)
        changes = [('DATABASE_URL', 'postgresql://cisme:synthetic@127.0.0.1/cisme'),
                   ('COMMERCE_ORDER_FLOW_ENABLED', 'true'), ('UGC_GO_LIVE_GATE', 'true'),
                   ('ALLOW_DEV_ADAPTERS', 'true'), ('WECHAT_PHONE_BINDING_ENABLED', 'true'),
                   ('PRIVACY_FORMAL_EXPORT_KEY', 'short'), ('S3_SECRET_ACCESS_KEY', 'synthetic'),
                   ('COMMERCE_FORMAL_RECOVERY_AUTHORIZATION_FILE', '/synthetic/grant')]
        for key, value in changes:
            with self.subTest(key=key), self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_CONFIGURATION_REQUIRED'):
                m.validate_config(config | {key: value}, self.wechat)
        with self.assertRaises(m.observation.target.Refused):
            m.validate_config(config | {'UPLOAD_TOKEN_SECRET': config['APP_SESSION_SECRET']}, self.wechat)

    def test_systemd_has_isolated_user_storage_heartbeat_and_readonly_code(self):
        for kind in ('api', 'worker'):
            unit = m.unit_text(kind, '/opt/cisme-trial/releases/' + m.SOURCE_HEAD)
            self.assertIn('User=cisme-trial\nGroup=cisme-trial', unit)
            self.assertIn('WorkingDirectory=/opt/cisme-trial', unit)
            self.assertIn('Environment=TMPDIR=/opt/cisme-trial/tmp', unit)
            self.assertIn('ProtectSystem=strict', unit)
            self.assertIn('ReadWritePaths=/opt/cisme-trial/tmp /opt/cisme-trial/privacy-suppression', unit)
            self.assertNotIn('SupplementaryGroups', unit)
            self.assertNotIn('production-cutover.complete', unit)
            self.assertIn('MemoryMax=384M', unit)
        template = m.nginx_template()
        self.assertIn('proxy_pass http://127.0.0.1:3101;', template)
        self.assertIn('server_name staging-api.cisme.cn;', template)

    def test_query_refuses_production_database_before_any_command(self):
        with patch.object(m, 'command') as command:
            with self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_DATABASE_REFUSED'):
                m.query('SELECT true', 'cisme')
            command.assert_not_called()

    def test_new_preflight_is_readonly_and_refuses_unknown_existing_resources(self):
        absent = {'user': False, 'role': False, 'database': False, 'units': False}
        with patch.object(m.os, 'geteuid', return_value=0), \
             patch.object(m.observation, 'identity', return_value={'instanceId': 'lhins-61ikz4mi'}), \
             patch.object(m, 'verified_source', return_value=self.source), \
             patch.object(m, 'production_wechat', return_value=self.wechat), \
             patch.object(m, 'marker', return_value=None), \
             patch.object(m, 'hba_observation', return_value=(Path('/synthetic/hba'), b'local all postgres peer\n', None)), \
             patch.object(m, 'resources', return_value=absent) as resources, \
             patch.object(m.socket, 'socket') as socket, \
             patch.object(m, 'existing_file') as write, patch.object(m, 'command') as mutate:
            socket.return_value.__enter__.return_value.connect_ex.return_value = 111
            result = m.preflight('/synthetic/release')
            self.assertTrue(result['readOnly'])
            self.assertFalse(result['deployed'])
            write.assert_not_called()
            mutate.assert_not_called()
            for key in ('user', 'role', 'database', 'units'):
                resources.return_value = absent | {key: True}
                with self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_UNKNOWN_TARGET_EXISTS'):
                    m.preflight('/synthetic/release')

    def test_wrong_host_is_rejected_before_resource_or_secret_reads(self):
        with patch.object(m.os, 'geteuid', return_value=0), \
             patch.object(m.observation, 'identity', side_effect=m.observation.target.Refused('LIVE_PRODUCTION_HOST_MISMATCH')), \
             patch.object(m, 'production_wechat') as secret, patch.object(m, 'resources') as resources:
            with self.assertRaises(m.observation.target.Refused):
                m.preflight('/synthetic/release')
            secret.assert_not_called()
            resources.assert_not_called()

    def test_hba_first_rule_allows_only_trial_db_loopback_and_preserves_original(self):
        original = b'local all postgres peer\nhost all all 127.0.0.1/32 scram-sha-256\n'
        content = m.hba_content(original)
        self.assertTrue(content.endswith(original))
        rules = [line for line in content.decode().splitlines() if line and not line.startswith('#')]
        self.assertEqual(rules[:4], ['host cisme_trial cisme_trial 127.0.0.1/32 scram-sha-256',
                                     'local all cisme_trial reject', 'host all cisme_trial 0.0.0.0/0 reject',
                                     'host all cisme_trial ::/0 reject'])
        for data in (m.HBA_BLOCK, b'host all cisme_trial all trust\n'):
            with self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_UNKNOWN_HBA_RULE_EXISTS'):
                m.hba_content(data)

    def test_hba_drift_refused_before_writing_or_reload(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, 'ROOT', Path(temporary)), \
             patch.object(m, 'protected', return_value=b'original\n'), \
             patch.object(m, 'hba_observation', return_value=(Path('/synthetic/hba'), b'unrelated edit\n', None)), \
             patch.object(m, 'query') as reload:
            (Path(temporary) / 'original-pg-hba.conf').touch()
            with self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_HBA_DRIFT'):
                m.install_hba()
            reload.assert_not_called()

    def test_database_negative_connection_requires_hba_rejection_not_arbitrary_error(self):
        config = m.candidate_config(self.wechat)
        with patch.object(m, 'command', return_value=b'cisme_trial\n'), patch.object(m.subprocess, 'run') as run:
            run.return_value = Mock(returncode=2, stderr=b'pg_hba.conf rejects connection for host synthetic')
            m.connection_isolation(config)
            self.assertNotIn(config['DATABASE_URL'], repr(run.call_args.args))
            for response in (Mock(returncode=0, stderr=b''), Mock(returncode=2, stderr=b'connection timeout')):
                run.return_value = response
                with self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_PRODUCTION_DATABASE_ISOLATION_FAILED'):
                    m.connection_isolation(config)

    def test_dependency_digest_binds_bytes_and_rejects_outside_links(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, 'checked_directory'):
            root = Path(temporary) / 'node_modules'
            root.mkdir()
            (root / 'module.js').write_bytes(b'first')
            first = m.dependency_digest(root, os.getuid())
            (root / 'module.js').write_bytes(b'second')
            self.assertNotEqual(first, m.dependency_digest(root, os.getuid()))
            (root / 'escape').symlink_to('../../outside')
            with self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_DEPENDENCY_LINK_UNSAFE'):
                m.dependency_digest(root, os.getuid())

    def test_existing_file_never_overwrites_unknown_bytes(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(m, 'protected', return_value=b'unknown'):
            path = Path(temporary) / 'owned'
            path.write_bytes(b'unknown')
            with self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_EXISTING_FILE_DRIFT'):
                m.existing_file(path, b'new')
            self.assertEqual(path.read_bytes(), b'unknown')

    def test_artifact_copy_is_idempotent_and_excludes_production_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / 'production'
            source.mkdir()
            (source / 'index.js').write_bytes(b'approved code')
            (source / 'node_modules').mkdir()
            (source / 'node_modules/module.js').write_bytes(b'approved dependency')
            (source / 'runtime.env').write_bytes(b'SYNTHETIC_PRODUCTION_SECRET=never-copy')
            manifest = {'hashes': {'index.js': hashlib.sha256(b'approved code').hexdigest()}}
            (source / 'release-manifest.json').write_text(json.dumps(manifest))
            root = base / 'trial'
            root.mkdir()
            descriptor = self.source | {'release': str(source),
                                       'manifestSha256': m.sha((source / 'release-manifest.json').read_bytes())}
            with patch.object(m, 'ROOT', root), patch.object(m, 'checked_directory'), \
                 patch.object(m, 'protected', side_effect=lambda path, *args, **kwargs: Path(path).read_bytes()), \
                 patch.object(m, 'dependency_digest', return_value=descriptor['dependenciesSha256']), \
                 patch.object(m, 'command', return_value=json.dumps({'verified': True, 'sourceHead': m.SOURCE_HEAD}).encode()):
                copied = m.copied_release(descriptor)
                self.assertEqual((copied / 'index.js').read_bytes(), b'approved code')
                self.assertFalse((copied / 'runtime.env').exists())
                self.assertEqual(m.copied_release(descriptor), copied)
                (copied / 'unknown-secret').write_bytes(b'unknown')
                with self.assertRaisesRegex(m.observation.target.Refused, 'TRIAL_UNKNOWN_RELEASE_FILE'):
                    m.copied_release(descriptor)

    def test_repeated_hba_install_does_not_replace_or_duplicate_rules(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'original-pg-hba.conf').write_bytes(b'original\n')
            with patch.object(m, 'ROOT', root), patch.object(m, 'protected', return_value=b'original\n'), \
                 patch.object(m, 'hba_observation', return_value=(Path('/synthetic/hba'), m.hba_content(b'original\n'), None)), \
                 patch.object(m, 'query', side_effect=['0', 't', '0', 't']), \
                 patch.object(m.os, 'replace') as replace:
                m.install_hba()
                m.install_hba()
                replace.assert_not_called()


if __name__ == '__main__':
    unittest.main()
