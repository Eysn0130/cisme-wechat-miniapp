"""Offline only; all host, DNS and environment inputs are synthetic fixtures."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('observation', Path(__file__).with_name('production-observation.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ObservationTests(unittest.TestCase):
    def observe(self, values=None, host='VM-0-10-ubuntu', ips=('124.223.74.198',)):
        return m.identity(lambda key: (values or m.HOST_BINDING)[key],
                          lambda *args: [(None, None, None, None, (ip, 443)) for ip in ips], lambda: host)

    def config(self):
        return {'DATABASE_URL': 'postgresql://cisme:synthetic-only@127.0.0.1:5432/cisme',
                'APP_ENV': 'production', 'OBJECT_STORAGE_DRIVER': 'cos_gateway',
                'S3_BUCKET': 'lhcos-81ddf-1257392443', 'S3_ACCESS_KEY_ID': 'synthetic',
                'S3_SECRET_ACCESS_KEY': 'synthetic-only'}

    def test_observed_host_maps_to_verified_lighthouse_identity(self):
        result = self.observe()
        self.assertEqual(result['metadataInstanceId'], 'ins-l9utqwxv')
        self.assertEqual(result['instanceId'], 'lhins-61ikz4mi')
        self.assertTrue(result['observedAtUtc'].endswith('Z'))

    def test_every_host_binding_field_is_checked(self):
        for key in m.HOST_BINDING:
            with self.subTest(key=key), self.assertRaises(m.target.Refused):
                self.observe({**m.HOST_BINDING, key: 'different-host'})

    def test_staging_hostname_is_rejected(self):
        with self.assertRaises(m.target.Refused): self.observe(host='VM-4-15-ubuntu')

    def test_dns_other_or_additional_target_is_rejected(self):
        for ips in [(), ('150.158.39.74',), ('124.223.74.198', '150.158.39.74')]:
            with self.subTest(ips=ips), self.assertRaises(m.target.Refused): self.observe(ips=ips)

    def test_legacy_label_is_reported_without_rewriting(self):
        result = m.runtime({**self.config(), 'APP_ENV': 'staging'})
        self.assertEqual(result['appEnv'], 'staging')
        self.assertNotIn('synthetic-only', str(result))

    def test_test_database_other_role_or_port_is_rejected(self):
        for url in ['postgresql://cisme:x@127.0.0.1/cisme_test',
                    'postgresql://other:x@127.0.0.1/cisme', 'postgresql://cisme:x@127.0.0.1:5433/cisme']:
            with self.subTest(url=url), self.assertRaises(m.target.Refused): m.runtime({**self.config(), 'DATABASE_URL': url})

    def test_unapproved_storage_rebinding_is_rejected(self):
        with self.assertRaises(m.target.Refused): m.runtime({**self.config(), 'S3_BUCKET': 'test-bucket'})

    def test_quoted_environment_is_parsed_without_exporting_password(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)/'runtime.env'
            p.write_text('DATABASE_URL="postgresql://cisme:synthetic-only@127.0.0.1/cisme"\nAPP_ENV=production\n')
            p.chmod(0o600)
            self.assertTrue(m.protected_environment(p)['DATABASE_URL'].startswith('postgresql://'))

    def test_world_readable_and_group_writable_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)/'runtime.env'; p.write_text('APP_ENV=production\n')
            for mode in [0o644, 0o620]:
                p.chmod(mode)
                with self.subTest(mode=mode), self.assertRaises(m.target.Refused): m.protected_environment(p)

    def test_symlink_fifo_and_oversized_environment_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)/'runtime.env'; p.write_text('X='+'a'*65536);p.chmod(0o600)
            with self.assertRaises(m.target.Refused):m.protected_environment(p)
            link = Path(directory)/'link';link.symlink_to(p)
            with self.assertRaises(OSError):m.protected_environment(link)
            fifo=Path(directory)/'fifo';os.mkfifo(fifo,0o600)
            with self.assertRaises(m.target.Refused):m.protected_environment(fifo)

    def guard(self, live=None, candidate=None, main='a'*40):
        with patch.object(m,'identity',return_value=self.observe()), patch.object(m,'protected_environment',side_effect=[live or self.config(),candidate or self.config()]):
            return m.guard_for_upgrade('/synthetic/candidate.env',{'schemaVersion':1,'sourceHead':'a'*40,
                'sourceTree':'b'*40,'configurationIncluded':False},main,'b'*40)

    def test_actual_guard_is_invoked_and_never_grants_permission(self):
        result=self.guard(live={**self.config(),'APP_ENV':'staging'})
        self.assertTrue(result['targetVerified']);self.assertFalse(result['permissionGranted']);self.assertFalse(result['deployed'])

    def test_candidate_must_correct_legacy_label_and_match_main(self):
        with self.assertRaises(m.target.Refused):self.guard(candidate={**self.config(),'APP_ENV':'staging'})
        with self.assertRaises(m.target.Refused):self.guard(main='c'*40)

    def test_credential_rotation_is_not_silently_part_of_upgrade(self):
        with self.assertRaises(m.target.Refused):self.guard(candidate={**self.config(),'DATABASE_URL':self.config()['DATABASE_URL'].replace('synthetic-only','changed')})
        with self.assertRaises(m.target.Refused):self.guard(candidate={**self.config(),'S3_SECRET_ACCESS_KEY':'changed'})


if __name__ == '__main__':unittest.main()
