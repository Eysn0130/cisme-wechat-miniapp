#!/usr/bin/env python3
"""Staging-only read-only health observer; sanitized journal, no auto repair."""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

SOURCE = 'ae31437652e2fe3fbb24e7ac493d3b60ad747d27'
INSTANCE = 'lhins-ei4hz4fi'
SCRIPT = pathlib.Path('/opt/cisme/operations/staging-health-20260922.py')
UNIT = pathlib.Path('/etc/systemd/system/cisme-staging-health-20260922.service')
TIMER = UNIT.with_suffix('.timer')


def healthy(snapshot):
    return (snapshot.get('host') == 'VM-4-15-ubuntu' and snapshot.get('sourceHead') == SOURCE
            and snapshot.get('httpsReady') == 200 and snapshot.get('api') == 'active'
            and snapshot.get('worker') == 'active' and snapshot.get('freeBytes', 0) >= 2 * 1024**3)


def probe():
    result = {'environment': 'staging', 'instanceId': INSTANCE, 'host': socket.gethostname(),
              'timeUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    if result['host'] != 'VM-4-15-ubuntu':
        result['failure'] = 'STAGING_HOST_REQUIRED'
    else:
        try:
            result['sourceHead'] = json.loads(pathlib.Path('/opt/cisme/current/release-manifest.json').read_text())['sourceHead']
            result['freeBytes'] = shutil.disk_usage('/opt/cisme').free
            for key in ['api', 'worker']:
                check = subprocess.run(['systemctl', 'is-active', 'cisme-staging-' + key], capture_output=True, text=True, timeout=5)
                result[key] = check.stdout.strip() if check.stdout.strip() in ['active', 'inactive', 'failed'] else 'unknown'
            with urllib.request.urlopen('https://staging-api.cisme.cn/health/ready', timeout=8) as response:
                result['httpsReady'] = response.status
        except Exception:
            result['failure'] = 'READ_ONLY_PROBE_FAILED'
    result['healthy'] = healthy(result)
    print(json.dumps(result))
    return 0 if result['healthy'] else 1


def install():
    if os.geteuid() != 0 or socket.gethostname() != 'VM-4-15-ubuntu':
        raise RuntimeError('STAGING_ROOT_REQUIRED')
    if any(p.exists() for p in [SCRIPT, UNIT, TIMER]):
        raise RuntimeError('EXISTING_MONITOR_PRESERVED')
    if json.loads(pathlib.Path('/opt/cisme/current/release-manifest.json').read_text()).get('sourceHead') != SOURCE:
        raise RuntimeError('CANDIDATE_SOURCE_REQUIRED')
    SCRIPT.parent.mkdir(exist_ok=True)
    SCRIPT.write_bytes(pathlib.Path(__file__).read_bytes())
    SCRIPT.chmod(0o755)
    UNIT.write_text('''[Unit]
Description=CISME staging candidate read-only health observer
After=network-online.target
[Service]
Type=oneshot
User=cisme
Group=cisme
ExecStart=/usr/bin/python3 /opt/cisme/operations/staging-health-20260922.py probe
TimeoutStartSec=25
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictSUIDSGID=true
UMask=0077
''')
    TIMER.write_text('''[Unit]
Description=Observe CISME staging candidate every minute
[Timer]
OnBootSec=30s
OnUnitInactiveSec=60s
AccuracySec=5s
Unit=cisme-staging-health-20260922.service
[Install]
WantedBy=timers.target
''')
    for args in [['systemctl', 'daemon-reload'], ['systemctl', 'start', UNIT.name],
                 ['systemctl', 'enable', '--now', TIMER.name]]:
        result = subprocess.run(args, capture_output=True, timeout=35)
        if result.returncode != 0:
            raise RuntimeError('STAGING_MONITOR_INSTALL_REVIEW_REQUIRED')
    print(json.dumps({'environment': 'staging', 'instanceId': INSTANCE, 'timer': TIMER.name,
                      'automaticRepair': False, 'externalNotificationConfigured': False, 'sourceHead': SOURCE}))


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == 'install':
            install()
        elif len(sys.argv) == 2 and sys.argv[1] == 'probe':
            sys.exit(probe())
        else:
            raise RuntimeError('INSTALL_OR_PROBE_REQUIRED')
    except Exception as error:
        print(json.dumps({'ok': False, 'code': str(error) if type(error) is RuntimeError else 'STAGING_MONITOR_FAILED'}))
        sys.exit(1)
