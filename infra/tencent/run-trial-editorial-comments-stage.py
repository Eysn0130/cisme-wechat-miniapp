#!/usr/bin/env python3
"""Explicit operator execution only. Preparation never calls this trial-only SSH runner."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import zlib

HERE = Path(__file__).resolve().parent
HEAD = None  # FINALIZER_HEAD
TREE = None  # FINALIZER_TREE
COMPATIBILITY_SHA256 = '2f23b820857ce98fcb916e6848adba796522b9a2c81333c069a50631000137ef'
HELPER_SHA256 = '9ac3e49d41cafd634d87b70963eecdc67ae1f425b0edc47509ec8a49c2ef408e'


def need(value):
    if not value:
        raise ValueError('LOCAL_STAGE_BINDING_REQUIRED')


def read_verified(path, limit, expected_sha256=None, expected_size=None):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.geteuid())
             and info.st_mode & 0o022 == 0 and 0 <= info.st_size <= limit)
        need(expected_size is None or info.st_size == expected_size)
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit)
        verified = bytes(data)
        need(len(verified) == info.st_size)
        need(expected_sha256 is None or hashlib.sha256(verified).hexdigest() == expected_sha256)
        return verified
    finally:
        os.close(fd)


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result)
        result[key] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, help='Already authenticated formal-server SSH host/alias')
    parser.add_argument('--identity-file', required=True)
    parser.add_argument('--known-hosts', required=True)
    args = parser.parse_args()
    need(args.host == 'ubuntu@124.223.74.198')
    command = json.loads(read_verified(HERE / 'stage-command.json', 65536), object_pairs_hook=unique)
    need(isinstance(HEAD,str) and re.fullmatch(r'[a-f0-9]{40}',HEAD) and isinstance(TREE,str)
         and re.fullmatch(r'[a-f0-9]{40}',TREE) and command['sourceHead'] == HEAD and command['sourceTree'] == TREE
         and command['helperSha256'] == HELPER_SHA256 and command['compatibilitySha256'] == COMPATIBILITY_SHA256
         and command['serverWriteExecuted'] is False and command['deployed'] is False)
    need(re.fullmatch(r'[a-f0-9]{64}', command['archiveSha256']) is not None
         and type(command['archiveSize']) is int and 0 < command['archiveSize'] <= 512 * 1024 * 1024)
    need(Path(command['stagerPath']) == HERE / 'root-installer-final.py')
    stager = read_verified(HERE / 'root-installer-final.py', 128 * 1024, command['stagerSha256'])
    archive = read_verified(Path(command['archivePath']), 512 * 1024 * 1024,
                            command['archiveSha256'], command['archiveSize'])
    encoded = base64.b64encode(zlib.compress(stager, 9)).decode('ascii')
    bootstrap = "import base64,zlib;exec(compile(zlib.decompress(base64.b64decode(" + repr(encoded) + ")), '<reviewed-root-installer>', 'exec'))"
    remote = ('sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 '
              '/usr/bin/python3 -I -B -c ' + shlex.quote(bootstrap))
    need(len(remote.encode()) < 100000)
    ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'ConnectTimeout=10', '-o', 'PasswordAuthentication=no',
           '-o', 'KbdInteractiveAuthentication=no', '-o', 'IdentitiesOnly=yes',
           '-i', str(Path(args.identity_file).absolute()),
           '-o', 'UserKnownHostsFile=' + str(Path(args.known_hosts).absolute()), args.host, remote]
    # Reuse the already verified buffer: never reopen archivePath for SSH stdin.
    result = subprocess.run(ssh, input=archive, capture_output=True, timeout=600)
    need(result.returncode == 0 and 0 < len(result.stdout) <= 65536)
    receipt = json.loads(result.stdout, object_pairs_hook=unique)
    need(receipt.get('staged') is True and receipt.get('deployed') is False
         and receipt.get('sourceHead') == HEAD and receipt.get('sourceTree') == TREE
         and receipt.get('archiveSha256') == command['archiveSha256']
         and receipt.get('archiveSize') == command['archiveSize']
         and receipt.get('helperSha256') == HELPER_SHA256 and receipt.get('compatibilitySha256') == COMPATIBILITY_SHA256
         and receipt.get('candidateDirectories') == ['/opt/cisme-trial/releases/tencent-release-' + HEAD[:12]]
         and receipt.get('productionChanged') is False and receipt.get('peerFilesChanged') is False
         and receipt.get('manifestSha256') == command['releaseManifestSha256']
         and receipt.get('servicesChanged') is False and receipt.get('databaseChanged') is False
         and receipt.get('configurationChanged') is False
         and receipt.get('dependenciesSha256') == 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
         and receipt.get('migrations') == 99
         and receipt.get('helperPath') == '/opt/cisme-trial/editorial-comment-runners/'+HEAD[:12]+'/trial-editorial-comments-upgrade.py'
         and receipt.get('applicationBindingPath') == '/opt/cisme-trial/editorial-comment-runners/'+HEAD[:12]+'/application-binding.json'
         and all(re.fullmatch(r'[a-f0-9]{64}', receipt.get(k,''))for k in ('applicationBindingSha256','stageReceiptSha256')))

    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'ok': False, 'code': 'SSH_STAGE_REVIEW_REQUIRED', 'deployed': False}))
        raise SystemExit(1)
