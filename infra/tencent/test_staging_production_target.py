"""Synthetic, offline production-target refusal tests; never access a server."""
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('production_target', Path(__file__).with_name('production-target.py'))
target = importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)


class ProductionTarget(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)
        self.identity = {**target.TARGET, 'schemaVersion': 1, 'observedAtUtc': '2026-09-22T11:59:00Z'}
        self.runtime = target.RESOURCES.copy()
        self.manifest = {'schemaVersion': 1, 'sourceHead': 'a' * 40,
                         'sourceTree': 'b' * 40, 'configurationIncluded': False}

    def check(self):
        return target.assert_production_target(self.identity, self.runtime, self.manifest,
                                               'a' * 40, 'b' * 40, self.now)

    def test_exact_target_and_reviewed_main(self):
        result = self.check()
        self.assertTrue(result['targetVerified'])
        for key in ['permissionGranted', 'deployed', 'releaseReady']:
            self.assertIs(result[key], False)

    def test_staging_cannot_be_renamed_to_production(self):
        self.identity['instanceId'] = 'lhins-ei4hz4fi'
        with self.assertRaisesRegex(target.Refused, 'EXACT_PRODUCTION_TARGET_REQUIRED'):
            self.check()

    def test_ip_dns_and_domain_drift_are_refused(self):
        for key in ['publicIpv4', 'dnsA', 'domain']:
            with self.subTest(key=key):
                original = self.identity[key]
                self.identity[key] = 'staging-api.cisme.cn'
                with self.assertRaises(target.Refused):
                    self.check()
                self.identity[key] = original

    def test_historical_or_future_observation_is_refused(self):
        for stamp in ['2026-09-22T10:32:09Z', '2026-09-22T12:00:01Z']:
            with self.subTest(stamp=stamp):
                self.identity['observedAtUtc'] = stamp
                with self.assertRaisesRegex(target.Refused, 'FRESH_TARGET_OBSERVATION_REQUIRED'):
                    self.check()

    def test_missing_naive_or_invalid_timestamp_is_refused(self):
        for stamp in [None, '', True, '2026-09-22T11:59:00', 'not-a-timeZ']:
            with self.subTest(stamp=stamp):
                self.identity['observedAtUtc'] = stamp
                with self.assertRaises(target.Refused):
                    self.check()

    def test_candidate_cannot_keep_legacy_staging_label(self):
        self.runtime['appEnv'] = 'staging'
        with self.assertRaisesRegex(target.Refused, 'PRODUCTION_RESOURCE_BINDING_REQUIRED'):
            self.check()

    def test_test_database_local_storage_or_other_bucket_is_refused(self):
        for key, value in [('databaseName', 'cisme_accept_rc20260922_example'),
                           ('databaseHost', '150.158.39.74'), ('objectStorageDriver', 'api_gateway'),
                           ('objectBucket', 'synthetic-not-production')]:
            with self.subTest(key=key):
                original = self.runtime[key]
                self.runtime[key] = value
                with self.assertRaises(target.Refused):
                    self.check()
                self.runtime[key] = original

    def test_branch_candidate_cannot_pass_as_main(self):
        self.manifest['sourceHead'] = 'c' * 40
        with self.assertRaisesRegex(target.Refused, 'CANDIDATE_NOT_REVIEWED_MAIN'):
            self.check()

    def test_source_tree_mismatch_is_refused(self):
        self.manifest['sourceTree'] = 'c' * 40
        with self.assertRaises(target.Refused):
            self.check()

    def test_bundled_or_unknown_configuration_is_refused(self):
        for value in [True, None, 0, 'false']:
            with self.subTest(value=value):
                self.manifest['configurationIncluded'] = value
                with self.assertRaises(target.Refused):
                    self.check()

    def test_duplicate_json_keys_are_refused(self):
        with self.assertRaisesRegex(target.Refused, 'DUPLICATE_JSON_KEY'):
            json.loads('{"instanceId":"first","instanceId":"second"}', object_pairs_hook=target.unique_keys)

    def test_bounded_json_read(self):
        with tempfile.TemporaryDirectory(prefix='cisme-target-') as directory:
            path = Path(directory) / 'oversize.json'
            path.write_text(' ' * 65537)
            with self.assertRaisesRegex(target.Refused, 'INPUT_TOO_LARGE'):
                target.read_json(path)

    def test_sha_types_and_zeros_are_refused(self):
        for value in [None, True, '', 'a' * 7, '0' * 40, ['a' * 40]]:
            with self.subTest(value=value):
                self.assertFalse(target.git_sha(value))

    def test_boolean_schema_version_is_not_integer_version(self):
        self.identity['schemaVersion'] = True
        with self.assertRaises(target.Refused):
            self.check()


if __name__ == '__main__':
    unittest.main()
