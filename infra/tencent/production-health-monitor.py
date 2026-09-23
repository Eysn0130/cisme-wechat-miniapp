#!/usr/bin/env python3
"""Independent production observer. No application, database or worker imports.

Run from a separate systemd timer with optional CISME_MONITOR_WEBHOOK_URL.
The endpoint receives a minimal JSON alert; a missing URL never counts as delivery.
"""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


READY_URL = 'https://api.cisme.cn/health/ready'
HEARTBEAT = Path('/opt/cisme/tmp/cisme-worker-heartbeat.json')
STATE = Path('/var/lib/cisme-monitor/state.json')
UNITS = {'api': 'cisme-api.service', 'worker': 'cisme-worker.service',
         'database': 'postgresql.service'}
REPEAT_SECONDS = 1800
RETRY_SECONDS = 300
HEARTBEAT_MAX_AGE_SECONDS = 120


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def valid_webhook_url(value):
    if not value:
        return False
    parsed = urllib.parse.urlsplit(value)
    return (parsed.scheme == 'https' and bool(parsed.hostname)
            and parsed.hostname.lower() not in {'localhost', 'localhost.localdomain'}
            and not parsed.username and not parsed.password and not parsed.fragment)


def unit_active(name):
    try:
        result = subprocess.run(['systemctl', 'is-active', name], capture_output=True,
                                text=True, timeout=4, check=False)
        return result.returncode == 0 and result.stdout.strip() == 'active'
    except (OSError, subprocess.TimeoutExpired):
        return False


def observe(now=None):
    now = time.time() if now is None else now
    checks = {name: unit_active(unit) for name, unit in UNITS.items()}
    try:
        with urllib.request.build_opener(NoRedirect).open(READY_URL, timeout=6) as response:
            checks['apiReadyAndDatabaseQuery'] = response.status == 200 and response.geturl() == READY_URL
    except (OSError, urllib.error.URLError, ValueError):
        checks['apiReadyAndDatabaseQuery'] = False
    try:
        completed = json.loads(HEARTBEAT.read_text())['completedAtUtc']
        completed_at = datetime.datetime.fromisoformat(completed.replace('Z', '+00:00')).timestamp()
        checks['workerCycleRecent'] = 0 <= now - completed_at <= HEARTBEAT_MAX_AGE_SECONDS
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        checks['workerCycleRecent'] = False
    return checks


def notification_plan(previous, failed, now):
    """Compute one transition without sending. State survives restart and channel outage."""
    state = dict(previous)
    state.setdefault('failureStreak', 0)
    state.setdefault('incidentOpen', False)
    state.setdefault('lastAttemptAt', 0)
    state.setdefault('lastDeliveredAt', 0)
    state.setdefault('pendingRecovery', False)
    if failed:
        state['failureStreak'] += 1
        if state['failureStreak'] >= 2:
            state['incidentOpen'] = True
        state['pendingRecovery'] = False
        due = state['incidentOpen'] and (
            not state['lastDeliveredAt'] or now - state['lastDeliveredAt'] >= REPEAT_SECONDS)
        retry = not state['lastAttemptAt'] or now - state['lastAttemptAt'] >= RETRY_SECONDS
        return state, 'failure' if due and retry else None
    state['failureStreak'] = 0
    if state['incidentOpen']:
        state['pendingRecovery'] = bool(state['lastDeliveredAt'])
        state['lastDeliveredAt'] = 0
        state['lastAttemptAt'] = 0
    state['incidentOpen'] = False
    if state['pendingRecovery'] and (
            not state['lastAttemptAt'] or now - state['lastAttemptAt'] >= RETRY_SECONDS):
        return state, 'recovery'
    if not state['pendingRecovery']:
        state['lastDeliveredAt'] = 0
        state['lastAttemptAt'] = 0
    return state, None


def deliver(url, kind, failed, now):
    if not valid_webhook_url(url):
        raise ValueError('EXTERNAL_WEBHOOK_HTTPS_REQUIRED')
    payload = json.dumps({'service': 'CISME production', 'type': kind,
                          'failedChecks': failed, 'observedAtUtc': datetime.datetime.fromtimestamp(
                              now, datetime.timezone.utc).isoformat()}, ensure_ascii=False).encode()
    request = urllib.request.Request(url, data=payload, method='POST',
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=8) as response:
        if response.status < 200 or response.status >= 300:
            raise OSError('EXTERNAL_WEBHOOK_DELIVERY_FAILED')


def run(now=None, checks=None, webhook=None, state_path=STATE):
    now = time.time() if now is None else now
    checks = observe(now) if checks is None else checks
    failed = sorted(name for name, healthy in checks.items() if healthy is not True)
    try:
        previous = json.loads(state_path.read_text())
        if not isinstance(previous, dict):
            raise ValueError('INVALID_STATE')
    except FileNotFoundError:
        previous = {}
    state, kind = notification_plan(previous, failed, now)
    url = os.environ.get('CISME_MONITOR_WEBHOOK_URL', '') if webhook is None else webhook
    delivered = False
    if kind and url:
        state['lastAttemptAt'] = now
        try:
            deliver(url, kind, failed, now)
            state['lastDeliveredAt'] = now
            if kind == 'recovery':
                state['pendingRecovery'] = False
                state['lastDeliveredAt'] = 0
            delivered = True
        except (OSError, urllib.error.URLError, ValueError):
            pass
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_name(state_path.name + '.tmp')
    temporary.write_text(json.dumps(state, sort_keys=True) + '\n')
    os.chmod(temporary, 0o600)
    temporary.replace(state_path)
    print(json.dumps({'healthy': not failed, 'failedChecks': failed,
                      'externalChannelConfigured': valid_webhook_url(url), 'externalNotificationDelivered': delivered,
                      'notificationDue': kind, 'incidentOpen': state['incidentOpen']}))
    # A completed probe returns success so OnUnitInactiveSec schedules the next
    # check even during an outage. The unhealthy fact is in structured output.
    return 0


if __name__ == '__main__':
    try:
        sys.exit(run())
    except (OSError, ValueError, TypeError):
        print(json.dumps({'healthy': False, 'code': 'INDEPENDENT_MONITOR_FAILED',
                          'externalNotificationDelivered': False}))
        sys.exit(1)
