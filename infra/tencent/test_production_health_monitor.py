"""Offline tests for the independent alert state machine; no live channel used."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('production_health', Path(__file__).with_name('production-health-monitor.py'))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class ProductionMonitorTests(unittest.TestCase):
    def test_active_worker_with_stale_cycle_is_unhealthy(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'worker.json'
            heartbeat.write_text(json.dumps({'completedAtUtc': '2026-09-23T00:00:00Z'}))
            class Ready:
                status = 200
                def geturl(self): return health.READY_URL
                def __enter__(self): return self
                def __exit__(self, *_): return False
            class Opener:
                def open(self, *_args, **_kwargs): return Ready()
            with patch.object(health, 'HEARTBEAT', heartbeat), \
                 patch.object(health, 'unit_active', return_value=True), \
                 patch.object(health.urllib.request, 'build_opener', return_value=Opener()):
                result = health.observe(1780099200)
            self.assertTrue(result['apiReadyAndDatabaseQuery'])
            self.assertTrue(result['worker'])
            self.assertFalse(result['workerCycleRecent'])

    def test_external_channel_requires_https_and_no_local_target(self):
        for url in ['', 'http://alerts.example.com/hook', 'https://localhost/hook',
                    'https://user:password@alerts.example.com/hook',
                    'https://alerts.example.com/hook#fragment']:
            self.assertFalse(health.valid_webhook_url(url))
        self.assertTrue(health.valid_webhook_url('https://alerts.example.com/hook'))

    def test_database_api_and_worker_failure_alert_without_application_process(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state.json'
            good = {name: True for name in [*health.UNITS, 'apiReadyAndDatabaseQuery', 'workerCycleRecent']}
            outage = {**good, 'apiReadyAndDatabaseQuery': False,
                      'database': False, 'workerCycleRecent': False}
            sent = []
            with patch.object(health, 'deliver', side_effect=lambda url, kind, failed, now: sent.append((kind, failed))):
                self.assertEqual(health.run(1000, outage, 'https://alerts.example.com/hook', state), 0)
                self.assertEqual(sent, [])
                self.assertEqual(health.run(1060, outage, 'https://alerts.example.com/hook', state), 0)
                self.assertEqual(sent, [('failure', ['apiReadyAndDatabaseQuery', 'database', 'workerCycleRecent'])])
                health.run(1120, outage, 'https://alerts.example.com/hook', state)
                self.assertEqual(len(sent), 1)
                self.assertEqual(health.run(1180, good, 'https://alerts.example.com/hook', state), 0)
                self.assertEqual(sent[-1], ('recovery', []))

    def test_missing_or_failed_channel_never_claims_delivery_and_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state.json'
            failed = {'api': False, 'worker': True, 'database': True,
                      'apiReadyAndDatabaseQuery': False, 'workerCycleRecent': True}
            health.run(1000, failed, '', state)
            health.run(1060, failed, '', state)
            self.assertEqual(__import__('json').loads(state.read_text())['lastDeliveredAt'], 0)
            with patch.object(health, 'deliver', side_effect=OSError('offline')) as delivery:
                health.run(1120, failed, 'https://alerts.example.com/hook', state)
                health.run(1180, failed, 'https://alerts.example.com/hook', state)
                self.assertEqual(delivery.call_count, 1)
            with patch.object(health, 'deliver') as delivery:
                health.run(1420, failed, 'https://alerts.example.com/hook', state)
                self.assertEqual(delivery.call_count, 1)


if __name__ == '__main__':
    unittest.main()
