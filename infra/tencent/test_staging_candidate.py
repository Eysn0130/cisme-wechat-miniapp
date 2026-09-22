"""Offline deployment refusal tests; never connects to a database or server."""
import importlib.util
import io
import pathlib
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('candidate', pathlib.Path(__file__).with_name('staging-candidate.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class DeploymentGuards(unittest.TestCase):
    def config(self):
        return {'APP_ENV': 'staging', 'DATABASE_URL': 'postgres://cisme_staging:placeholder@127.0.0.1/cisme_staging',
                'OBJECT_STORAGE_DRIVER': 'api_gateway'}

    def test_production_with_legacy_staging_label_is_refused(self):
        with self.assertRaisesRegex(candidate.Refused, 'STAGING_HOST_REQUIRED'):
            candidate.assert_target('VM-0-10-ubuntu', self.config(), candidate.OLD_API_SHA)

    def test_production_database_and_release_drift_are_refused(self):
        wrong = {**self.config(), 'DATABASE_URL': 'postgres://cisme@127.0.0.1/cisme'}
        with self.assertRaisesRegex(candidate.Refused, 'IDENTITY_REQUIRED'):
            candidate.assert_target('VM-4-15-ubuntu', wrong, candidate.OLD_API_SHA)
        with self.assertRaisesRegex(candidate.Refused, 'RELEASE_DRIFT'):
            candidate.assert_target('VM-4-15-ubuntu', self.config(), 'unrecognized')

    def test_exact_staging_identity_is_accepted(self):
        candidate.assert_target('VM-4-15-ubuntu', self.config(), candidate.OLD_API_SHA)

    def archive(self, names, symlink=False):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for name in names:
                member = tarfile.TarInfo(name)
                if symlink:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/etc/passwd'
                archive.addfile(member)
        buffer.seek(0)
        return tarfile.open(fileobj=buffer)

    def test_tar_traversal_absolute_duplicate_and_symlink_are_refused(self):
        for bad in ['../outside', '/etc/passwd']:
            with self.subTest(bad=bad), self.archive(['release-manifest.json', bad]) as archive:
                with self.assertRaises(candidate.Refused):
                    candidate.safe_members(archive, {'hashes': {bad: 'abc'}})
        with self.archive(['release-manifest.json', 'release-manifest.json']) as archive:
            with self.assertRaises(candidate.Refused):
                candidate.safe_members(archive, {'hashes': {'index.js': 'abc'}})
        with self.archive(['release-manifest.json', 'index.js'], True) as archive:
            with self.assertRaises(candidate.Refused):
                candidate.safe_members(archive, {'hashes': {'index.js': 'abc'}})

    def test_non_staging_policy_is_refused(self):
        with self.assertRaisesRegex(candidate.Refused, 'VERSION_MISMATCH'):
            candidate.validate_policy([{'type': 'terms', 'version': 'production'}, {'type': 'privacy', 'version': 'production'}])

    def test_candidate_cannot_use_old_database_or_money_channel(self):
        database = 'cisme_accept_rc20260922_1234abcd'
        config = {**self.config(), 'DATABASE_URL': 'postgres://cisme_staging:placeholder@127.0.0.1/' + database,
                  'COMMERCE_ORDER_FLOW_ENABLED': 'false', 'ALLOW_DEV_ADAPTERS': 'false', 'API_LISTEN_HOST': '127.0.0.1'}
        candidate.assert_candidate(config, database)
        for key, value in [('COMMERCE_ORDER_FLOW_ENABLED', 'true'), ('DATABASE_URL', self.config()['DATABASE_URL'])]:
            with self.subTest(key=key), self.assertRaises(candidate.Refused):
                candidate.assert_candidate({**config, key: value}, database)

    def test_env_quotes_round_trip_without_execution(self):
        parsed = candidate.parse_env('VALUE="literal$() `value` with spaces"\n')
        self.assertEqual(parsed['VALUE'], 'literal$() `value` with spaces')


if __name__ == '__main__':
    unittest.main()
