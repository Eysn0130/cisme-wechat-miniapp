"""Offline tests for the independent alert state machine; no live channel used."""
import importlib.util
import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('production_health', Path(__file__).with_name('production-health-monitor.py'))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class ProductionMonitorTests(unittest.TestCase):
    def test_grant_renewal_warning_precedes_expiry_and_never_changes_the_grant(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);grant=root/'grant.json';env=root/'runtime.env'
            grant.write_text(json.dumps({'expiresAt':'2026-12-25T15:59:59Z'}));grant.chmod(0o600)
            env.write_text('COMMERCE_FORMAL_COMMERCE_AUTHORIZATION_FILE='+str(grant)+'\n');env.chmod(0o600)
            expires=health.datetime.datetime.fromisoformat('2026-12-25T15:59:59+00:00').timestamp()
            before=grant.read_bytes()
            self.assertEqual(health.authorization_expiry_checks(expires-15*86400,env),{'commerceGrantBeyond14Days':True})
            self.assertEqual(health.authorization_expiry_checks(expires-14*86400,env),{'commerceGrantBeyond14Days':False})
            self.assertEqual(health.authorization_expiry_checks(expires+1,env),{'commerceGrantBeyond14Days':False})
            self.assertEqual(grant.read_bytes(),before)
            for invalid in [None,42,[],{}]:
                grant.write_text(json.dumps({'expiresAt':invalid}))
                self.assertEqual(health.authorization_expiry_checks(expires-15*86400,env),{'commerceGrantBeyond14Days':False})
            grant.unlink();self.assertEqual(health.authorization_expiry_checks(expires-15*86400,env),{'commerceGrantBeyond14Days':False})

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

    def test_worker_heartbeat_uses_time_after_slow_ready_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'worker.json'
            def heartbeat_at(seconds):
                value = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
                heartbeat.write_text(json.dumps({'completedAtUtc': value.isoformat()}))
            class Ready:
                status = 200
                def geturl(self): return health.READY_URL
                def __enter__(self): return self
                def __exit__(self, *_): return False
            class Opener:
                def open(self, *_args, **_kwargs):
                    heartbeat_at(1004)  # The worker finished while readiness was slow.
                    return Ready()
            with patch.object(health, 'HEARTBEAT', heartbeat), \
                 patch.object(health, 'unit_active', return_value=True), \
                 patch.object(health.urllib.request, 'build_opener', return_value=Opener()):
                with patch.object(health.time, 'time', side_effect=[1000, 1006]):
                    self.assertTrue(health.observe()['workerCycleRecent'])
            with patch.object(health, 'HEARTBEAT', heartbeat), \
                 patch.object(health, 'unit_active', return_value=True), \
                 patch.object(health.urllib.request, 'build_opener', return_value=type('Opener', (), {'open': lambda *a, **k: Ready()})()):
                for value in [1007, 800, None]:
                    if value is None: heartbeat.write_text('{invalid')
                    else: heartbeat_at(value)
                    self.assertFalse(health.observe(now=1000, clock=lambda: 1006)['workerCycleRecent'])

    def test_running_monitor_uses_fresh_heartbeat_clock_after_ready_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'worker.json'
            state = Path(directory) / 'state.json'
            class Ready:
                status = 200
                def geturl(self): return health.READY_URL
                def __enter__(self): return self
                def __exit__(self, *_): return False
            class Opener:
                def open(self, *_args, **_kwargs):
                    completed = datetime.datetime.fromtimestamp(1004, datetime.timezone.utc)
                    heartbeat.write_text(json.dumps({'completedAtUtc': completed.isoformat()}))
                    return Ready()
            with patch.object(health, 'HEARTBEAT', heartbeat), \
                 patch.object(health, 'unit_active', return_value=True), \
                 patch.object(health, 'authorization_expiry_checks', return_value={}), \
                 patch.object(health.urllib.request, 'build_opener', return_value=Opener()), \
                 patch.object(health.time, 'time', side_effect=[1000, 1006, 1007]):
                self.assertEqual(health.run(state_path=state, webhook=''), 0)
            self.assertEqual(json.loads(state.read_text())['failureStreak'], 0)

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
