import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('production-security-audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditRedaction(unittest.TestCase):
    def test_quoted_url_is_unquoted_before_parsing(self):
        env = audit.environment('DATABASE_URL="postgres://app:synthetic%40secret@127.0.0.1:5432/cisme"')
        safe, private = audit.database(env['DATABASE_URL'])
        self.assertEqual(safe['databaseName'], 'cisme')
        self.assertEqual(private['PGPASSWORD'], 'synthetic@secret')
        self.assertNotIn('secret', str(safe))

    def test_raw_quoted_url_never_becomes_a_database_name(self):
        with self.assertRaisesRegex(ValueError, '^DATABASE_URL_INVALID$'):
            audit.database('"postgres://app:synthetic-secret@127.0.0.1/cisme"')

    def test_invalid_path_and_options_fail_without_echoing_input(self):
        for value in ['postgres://app:secret@127.0.0.1/a/b', 'postgres://app:secret@127.0.0.1/cisme?options=secret', 'postgres://app:secret@example.invalid/cisme']:
            with self.assertRaises(ValueError) as caught:
                audit.database(value)
            self.assertNotIn('secret', str(caught.exception))

    def test_duplicate_env_is_refused(self):
        with self.assertRaisesRegex(ValueError, '^ENV_FORMAT_INVALID$'):
            audit.environment('DATABASE_URL=first\nDATABASE_URL=second')


if __name__ == '__main__':
    unittest.main()
