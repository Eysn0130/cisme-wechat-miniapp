"""Offline health classification: no network or systemd mutation."""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('health', pathlib.Path(__file__).with_name('staging-health.py'))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class MonitorGuards(unittest.TestCase):
    def test_missing_probe_cannot_be_healthy(self):
        self.assertFalse(health.healthy({}))

    def test_environment_version_endpoint_services_and_capacity_are_independent(self):
        good = {'host': 'VM-4-15-ubuntu', 'sourceHead': health.SOURCE,
                'httpsReady': 200, 'api': 'active', 'worker': 'active', 'freeBytes': 3 * 1024**3}
        self.assertTrue(health.healthy(good))
        for key, value in [('host', 'VM-0-10-ubuntu'), ('sourceHead', 'unknown'),
                           ('httpsReady', 503), ('api', 'failed'), ('worker', 'inactive'),
                           ('freeBytes', 2 * 1024**3 - 1)]:
            with self.subTest(key=key):
                self.assertFalse(health.healthy({**good, key: value}))


if __name__ == '__main__':
    unittest.main()
