import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('journal',Path(__file__).with_name('production-migration-audit.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class JournalTests(unittest.TestCase):
    def test_prefix_comparison_never_claims_historical_integrity_or_permission(self):
        result=m.compare(['20260101_first.sql'],['20260101_first.sql','20260102_next.sql'])
        self.assertEqual(result['pending'],['20260102_next.sql'])
        self.assertFalse(result['historicalSqlIntegrityVerified']);self.assertFalse(result['migrationApproved'])

    def test_unknown_reordered_missing_duplicate_or_path_versions_refuse(self):
        for value in [[],['../secret'],['20260102_b.sql','20260101_a.sql'],['20260101_a.sql']*2]:
            with self.subTest(value=value),self.assertRaises(m.observation.target.Refused):m.versions(value)
        with self.assertRaises(m.observation.target.Refused):m.compare(['20260101_old.sql'],['20260101_rewritten.sql'])

    def test_wrong_host_refuses_before_database_read(self):
        with patch.object(m.observation,'identity',side_effect=m.observation.target.Refused('WRONG_HOST')),patch.object(m,'query') as read:
            with self.assertRaises(m.observation.target.Refused):m.inspect(read)
            read.assert_not_called()

    def test_fixed_peer_target_and_read_only_session(self):
        class Result:returncode=0;stdout=b'{"synthetic":true}';stderr=b''
        with patch.object(m.subprocess,'run',return_value=Result()) as run:
            self.assertEqual(m.query('SELECT true'),{'synthetic':True})
            args,kwargs=run.call_args
            # Sanitized PATH intentionally excludes sbin: peer-auth command must
            # use an absolute trusted executable instead of failing to resolve.
            self.assertEqual(args[0][0],'/usr/sbin/runuser')
            self.assertEqual(args[0][4],'/usr/bin/psql')
            self.assertEqual(args[0][args[0].index('-d')+1],'cisme')
            self.assertIn('default_transaction_read_only=on',kwargs['env']['PGOPTIONS'])
            self.assertNotIn('PGPASSWORD',kwargs['env'])

    def test_driver_failure_never_exports_raw_error(self):
        class Result:returncode=1;stdout=b'';stderr=b'SYNTHETIC_PRIVATE_CONNECTION'
        with patch.object(m.subprocess,'run',return_value=Result()):
            with self.assertRaisesRegex(m.observation.target.Refused,'^PRODUCTION_JOURNAL_READ_FAILED$'):m.query('SELECT true')

    def test_absent_journal_is_not_created(self):
        with patch.object(m.observation,'identity',return_value={}),patch.object(m.observation,'protected_environment',return_value={}),patch.object(m.observation,'runtime',return_value={}):
            calls=[]
            def read(sql):
                calls.append(sql);return {'database':'cisme','readOnly':'on','journalPresent':False}
            with self.assertRaisesRegex(m.observation.target.Refused,'EXISTING_PRODUCTION_JOURNAL_REQUIRED'):m.inspect(read)
            self.assertEqual(len(calls),1);self.assertNotIn('CREATE',calls[0])


if __name__=='__main__':unittest.main()
